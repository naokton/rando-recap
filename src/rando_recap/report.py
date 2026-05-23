"""Rendering: rich terminal report and JSON dump."""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any

from rich import box
from rich.console import Console
from rich.padding import Padding
from rich.panel import Panel
from rich.table import Table

LEFT_PAD = 2
_PAD = (0, 0, 0, LEFT_PAD)
_PAD_PREFIX = " " * LEFT_PAD

if TYPE_CHECKING:
    from collections.abc import Callable

    from .app import AnalysisResult
    from .segments import Segment
    from .stops import Stop


def _fmt_dur(seconds: int | float | None) -> str:
    if seconds is None:
        return "-"
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m:02d}m"
    if m:
        return f"{m}m {s:02d}s"
    return f"{s}s"


def _make_clock_fmt(start_iso: str, utc_offset_s: int) -> Callable[[int], str]:
    start = datetime.fromisoformat(start_iso)
    tz = timezone(timedelta(seconds=int(utc_offset_s)))

    def fmt(offset_s: int) -> str:
        return (start + timedelta(seconds=offset_s)).astimezone(tz).strftime("%H:%M")

    return fmt


def _fmt_kmh(mps: float | None) -> str:
    return "-" if mps is None else f"{mps * 3.6:.1f}"


def _fmt_num(v: float | None, digits: int = 0) -> str:
    if v is None:
        return "-"
    return f"{v:.{digits}f}"


def _fmt_unit(v: float | None, unit: str, digits: int = 0) -> str:
    return "-" if v is None else f"{v:.{digits}f} {unit}"


def _stop_lines(
    label: str,
    cumulative_km: float,
    arrive: str | None,
    depart: str | None,
    rest_s: int | None,
) -> list[str]:
    lines = [label, f"{cumulative_km:.1f} km"]
    if arrive and depart:
        lines.append(f"{arrive} → {depart}")
    elif depart:
        lines.append(depart)
    elif arrive:
        lines.append(arrive)
    if rest_s is not None:
        lines.append("0m" if rest_s == 0 else _fmt_dur(rest_s))
    return lines


def _segment_cells(s: Segment) -> tuple[str, str, str, str, str, str, str, str]:
    kmh = s.avg_speed_mps * 3.6 if s.avg_speed_mps is not None else None
    return (
        f"{s.distance_m / 1000.0:.1f} km",
        _fmt_dur(s.duration_s),
        _fmt_unit(kmh, "km/h", 1),
        _fmt_unit(s.avg_hr, "bpm"),
        _fmt_unit(s.avg_cadence, "rpm"),
        _fmt_unit(s.avg_watts, "W"),
        _fmt_unit(s.climb_m, "m↑"),
        _fmt_unit(s.climb_m_per_km, "‰↑", 1),
    )


def _segment_lines(s: Segment | None) -> list[str]:
    if s is None:
        return ["(no movement)"]
    return list(_segment_cells(s))


def _end_seconds(stops: list[Stop], ordered_segs: list[Segment | None]) -> int:
    if stops:
        last_seg = ordered_segs[-1]
        return stops[-1].time_after_s + (last_seg.duration_s if last_seg else 0)
    return ordered_segs[0].duration_s if ordered_segs[0] else 0


def _stops_segments_cumkm(
    stops: list[Stop], segments: list[Segment]
) -> tuple[list[str], list[Segment | None], list[float]]:
    # Stable lookup so zero-length segments (skipped by build_segments) become None slots.
    n = len(stops)
    seg_by_label = {s.label: s for s in segments}
    stop_labels = ["Start"] + [f"S{i + 1}" for i in range(n)] + ["End"]
    seg_labels = [f"{stop_labels[i]} → {stop_labels[i + 1]}" for i in range(n + 1)]
    ordered_segs = [seg_by_label.get(lab) for lab in seg_labels]
    cum_km = [0.0]
    for s in ordered_segs:
        cum_km.append(cum_km[-1] + (s.distance_m / 1000.0 if s else 0.0))
    return stop_labels, ordered_segs, cum_km


def render_chart(
    console: Console,
    fmt_clock: Callable[[int], str],
    stops: list[Stop],
    stop_labels: list[str],
    ordered_segs: list[Segment | None],
    cum_km: list[float],
) -> None:
    """Horizontal stop/segment diagram. Stops above the track, segments below."""
    n = len(stops)
    end_s = _end_seconds(stops, ordered_segs)

    stop_blocks: list[list[str]] = []
    for i, label in enumerate(stop_labels):
        if label == "Start":
            arrive, depart, rest = None, fmt_clock(0), 0
        elif label == "End":
            arrive, depart, rest = fmt_clock(end_s), None, 0
        else:
            c = stops[i - 1]
            arrive = fmt_clock(c.time_before_s)
            depart = fmt_clock(c.time_after_s)
            rest = c.rest_s
        stop_blocks.append(_stop_lines(label, cum_km[i], arrive, depart, rest))

    seg_blocks = [_segment_lines(s) for s in ordered_segs]

    stop_widths = [max(len(line) for line in b) for b in stop_blocks]
    seg_widths = [max(len(line) for line in b) for b in seg_blocks]

    top_h = max(len(b) for b in stop_blocks)
    bot_h = max(len(b) for b in seg_blocks)

    def _emit(s: str) -> None:
        console.print(_PAD_PREFIX + s, no_wrap=True, crop=False, overflow="ignore")

    # Greedy pack columns into rows that fit the terminal width. The first row
    # starts at stop 0; each subsequent row starts with the segment going out of
    # the previous row's last stop (no stop duplication).
    target = console.width - LEFT_PAD
    n_stops = n + 2
    chunks: list[list[tuple[str, int]]] = []
    start_stop = 0
    while start_stop < n_stops:
        if start_stop == 0:
            tokens: list[tuple[str, int]] = [("stop", 0)]
            cur_w = stop_widths[0]
        else:
            tokens = [("seg", start_stop - 1), ("stop", start_stop)]
            cur_w = seg_widths[start_stop - 1] + stop_widths[start_stop]
        last_stop = start_stop
        while last_stop + 1 < n_stops:
            added = seg_widths[last_stop] + stop_widths[last_stop + 1]
            if cur_w + added > target and last_stop > start_stop:
                break
            tokens.append(("seg", last_stop))
            tokens.append(("stop", last_stop + 1))
            cur_w += added
            last_stop += 1
        chunks.append(tokens)
        if last_stop + 1 >= n_stops:
            break
        start_stop = last_stop + 1

    def _render_chunk(tokens: list[tuple[str, int]]) -> None:
        col_widths = [stop_widths[idx] if kind == "stop" else seg_widths[idx] for kind, idx in tokens]

        for row in range(top_h):
            line: list[str] = []
            for (kind, idx), w in zip(tokens, col_widths, strict=True):
                if kind == "stop":
                    content = stop_blocks[idx]
                    pad = top_h - len(content)
                    text = content[row - pad] if row >= pad else ""
                else:
                    text = ""
                line.append(text.center(w))
            _emit("".join(line))

        track_parts = []
        for (kind, _), w in zip(tokens, col_widths, strict=True):
            track_parts.append("●".center(w, "─") if kind == "stop" else "─" * w)
        _emit("[bold]" + "".join(track_parts) + "[/bold]")

        for row in range(bot_h):
            line = []
            for (kind, idx), w in zip(tokens, col_widths, strict=True):
                if kind == "seg":
                    content = seg_blocks[idx]
                    text = content[row] if row < len(content) else ""
                else:
                    text = ""
                line.append(text.center(w))
            _emit("".join(line))

    _emit("")
    for ci, tokens in enumerate(chunks):
        if ci > 0:
            _emit("")
        _render_chunk(tokens)
    _emit("")


def render_terminal(
    activity: dict[str, Any],
    stops: list[Stop],
    segments: list[Segment],
) -> None:
    console = Console()
    start_iso = activity.get("start_date") or activity.get("start_date_local") or ""
    fmt_clock = _make_clock_fmt(start_iso, activity.get("utc_offset", 0))
    name = activity.get("name", "(unnamed ride)")
    elapsed = activity.get("elapsed_time", 0)
    moving = activity.get("moving_time", 0)
    dist_km = activity.get("distance", 0) / 1000.0
    climb = activity.get("total_elevation_gain", 0)

    console.print(
        Padding(
            Panel.fit(f"[bold green]{name}[/bold green]  ({start_iso[:10]})", style="green"),
            _PAD,
        )
    )
    console.print(
        Padding(
            f"Distance: [bold]{dist_km:.1f} km[/bold]   "
            f"Elapsed: [bold]{_fmt_dur(elapsed)}[/bold]   "
            f"Moving: [bold]{_fmt_dur(moving)}[/bold]   "
            f"Climb: [bold]{climb:.0f} m[/bold]",
            _PAD,
        )
    )

    stop_labels, ordered_segs, cum_km = _stops_segments_cumkm(stops, segments)
    render_chart(console, fmt_clock, stops, stop_labels, ordered_segs, cum_km)

    if stops:
        ct = Table(title="Stops", box=box.HORIZONTALS)
        ct.add_column("#")
        ct.add_column("Dist (km)", justify="right")
        ct.add_column("Arrive")
        ct.add_column("Depart")
        ct.add_column("Rest", justify="right")
        for i, c in enumerate(stops, start=1):
            ct.add_row(
                f"S{i}",
                f"{cum_km[i]:.1f}",
                fmt_clock(c.time_before_s),
                fmt_clock(c.time_after_s),
                _fmt_dur(c.rest_s),
            )
        console.print(Padding(ct, _PAD))
    else:
        console.print(Padding("[dim]No stops above threshold detected.[/dim]", _PAD))

    st = Table(title="Segments", box=box.HORIZONTALS)
    st.add_column("Segment")
    st.add_column("Dist (km)", justify="right")
    st.add_column("Time", justify="right")
    st.add_column("Avg km/h", justify="right")
    st.add_column("Avg HR", justify="right")
    st.add_column("Avg Cad", justify="right")
    st.add_column("Avg W", justify="right")
    st.add_column("Climb (m)", justify="right")
    st.add_column("m/km", justify="right")
    for s in segments:
        st.add_row(
            s.label,
            f"{s.distance_m / 1000.0:.2f}",
            _fmt_dur(s.duration_s),
            _fmt_kmh(s.avg_speed_mps),
            _fmt_num(s.avg_hr, 0),
            _fmt_num(s.avg_cadence, 0),
            _fmt_num(s.avg_watts, 0),
            _fmt_num(s.climb_m, 0),
            _fmt_num(s.climb_m_per_km, 1),
        )
    console.print(Padding(st, _PAD))


def build_payload(result: AnalysisResult, *, include_latlng: bool = True) -> dict[str, Any]:
    activity = result.activity
    payload: dict[str, Any] = {
        "activity": {
            "id": activity.get("id"),
            "name": activity.get("name"),
            "start_date": activity.get("start_date"),
            "start_date_local": activity.get("start_date_local"),
            "utc_offset_s": int(activity.get("utc_offset") or 0),
            "distance_m": activity.get("distance"),
            "elapsed_time_s": activity.get("elapsed_time"),
            "moving_time_s": activity.get("moving_time"),
            "total_elevation_gain_m": activity.get("total_elevation_gain"),
        },
        "stops": [{**asdict(c), "rest_s": c.rest_s} for c in result.stops],
        "segments": [asdict(s) for s in result.segments],
        "daynight": [asdict(s) for s in result.daynight],
        "turnaround": asdict(result.turnaround) if result.turnaround else None,
    }
    if include_latlng:
        payload["latlng"] = result.streams["latlng"]["data"]
    return payload


def render_json(result: AnalysisResult) -> str:
    return json.dumps(build_payload(result, include_latlng=False), indent=2)
