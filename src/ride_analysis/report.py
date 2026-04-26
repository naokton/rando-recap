"""Rendering: rich terminal report and JSON dump."""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any

from rich import box
from rich.console import Console
from rich.table import Table

if TYPE_CHECKING:
    from collections.abc import Callable

    from .segments import Segment
    from .stops import Control


def _fmt_dur(seconds: int | float | None) -> str:
    if seconds is None:
        return "-"
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h{m:02d}m"
    if m:
        return f"{m}m{s:02d}s"
    return f"{s}s"


def _make_clock_fmt(start_iso: str, utc_offset_s: int) -> Callable[[int], str]:
    start = datetime.fromisoformat(start_iso.replace("Z", "+00:00"))
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
        lines.append("rest 0m" if rest_s == 0 else f"rest {_fmt_dur(rest_s)}")
    return lines


def _segment_cells(s: Segment) -> tuple[str, str, str, str, str, str, str, str]:
    speed = f"{s.avg_speed_mps * 3.6:.1f} km/h" if s.avg_speed_mps else "-"
    return (
        f"{s.distance_m / 1000.0:.1f} km",
        _fmt_dur(s.duration_s),
        speed,
        f"{_fmt_num(s.avg_hr, 0)} bpm",
        f"{_fmt_num(s.avg_cadence, 0)} rpm",
        f"{_fmt_num(s.avg_watts, 0)} W",
        f"{_fmt_num(s.climb_m, 0)} m↑",
        f"{_fmt_num(s.climb_m_per_km, 1)} ‰↑",
    )


def _segment_lines(s: Segment | None) -> list[str]:
    if s is None:
        return ["(no movement)"]
    return list(_segment_cells(s))


def _end_seconds(controls: list[Control], ordered_segs: list[Segment | None]) -> int:
    if controls:
        last_seg = ordered_segs[-1]
        return controls[-1].time_after_s + (last_seg.duration_s if last_seg else 0)
    return ordered_segs[0].duration_s if ordered_segs[0] else 0


def _stops_segments_cumkm(
    controls: list[Control], segments: list[Segment]
) -> tuple[list[str], list[Segment | None], list[float]]:
    # Stable lookup so zero-length segments (skipped by build_segments) become None slots.
    n = len(controls)
    seg_by_label = {s.label: s for s in segments}
    stop_labels = ["Start"] + [f"C{i + 1}" for i in range(n)] + ["End"]
    seg_labels = [f"{stop_labels[i]} → {stop_labels[i + 1]}" for i in range(n + 1)]
    ordered_segs = [seg_by_label.get(lab) for lab in seg_labels]
    cum_km = [0.0]
    for s in ordered_segs:
        cum_km.append(cum_km[-1] + (s.distance_m / 1000.0 if s else 0.0))
    return stop_labels, ordered_segs, cum_km


def render_chart(
    console: Console,
    activity: dict[str, Any],
    controls: list[Control],
    segments: list[Segment],
) -> None:
    """Horizontal stop/segment diagram. Stops above the track, segments below."""
    start_iso = activity.get("start_date") or activity.get("start_date_local") or ""
    fmt_clock = _make_clock_fmt(start_iso, activity.get("utc_offset", 0))
    n = len(controls)
    stop_labels, ordered_segs, cum_km = _stops_segments_cumkm(controls, segments)
    end_s = _end_seconds(controls, ordered_segs)

    stop_blocks: list[list[str]] = []
    for i, label in enumerate(stop_labels):
        if label == "Start":
            arrive, depart, rest = None, fmt_clock(0), 0
        elif label == "End":
            arrive, depart, rest = fmt_clock(end_s), None, 0
        else:
            c = controls[i - 1]
            arrive = fmt_clock(c.time_before_s)
            depart = fmt_clock(c.time_after_s)
            rest = c.rest_s
        stop_blocks.append(_stop_lines(label, cum_km[i], arrive, depart, rest))

    seg_blocks = [_segment_lines(s) for s in ordered_segs]

    stop_widths = [max(len(line) for line in b) for b in stop_blocks]
    seg_widths = [max(len(line) for line in b) for b in seg_blocks]

    # Interleave: stop, seg, stop, seg, ..., stop
    col_widths: list[int] = []
    for i in range(n + 1):
        col_widths.append(stop_widths[i])
        col_widths.append(seg_widths[i])
    col_widths.append(stop_widths[-1])

    top_h = max(len(b) for b in stop_blocks)
    bot_h = max(len(b) for b in seg_blocks)

    def _emit(s: str) -> None:
        console.print(s, no_wrap=True, crop=False, overflow="ignore")

    _emit("")
    # Top block: stop content right-aligned (sits just above the track line).
    for row in range(top_h):
        line: list[str] = []
        for ci, w in enumerate(col_widths):
            if ci % 2 == 0:
                content = stop_blocks[ci // 2]
                pad = top_h - len(content)
                text = content[row - pad] if row >= pad else ""
            else:
                text = ""
            line.append(text.center(w))
        _emit("".join(line))

    # Track line: ─ everywhere, ● centered in stop columns, connecting through segment columns.
    track_parts = []
    for ci, w in enumerate(col_widths):
        if ci % 2 == 0:
            track_parts.append("●".center(w, "─"))
        else:
            track_parts.append("─" * w)
    _emit("[bold]" + "".join(track_parts) + "[/bold]")

    # Bottom block: segment content top-aligned.
    for row in range(bot_h):
        line: list[str] = []
        for ci, w in enumerate(col_widths):
            if ci % 2 == 1:
                content = seg_blocks[ci // 2]
                text = content[row] if row < len(content) else ""
            else:
                text = ""
            line.append(text.center(w))
        _emit("".join(line))
    _emit("")


def render_chart_vertical(
    console: Console,
    activity: dict[str, Any],
    controls: list[Control],
    segments: list[Segment],
) -> None:
    """Vertical stop/segment diagram with per-metric column alignment.

    Stop metrics (cumulative km, time info, rest) sit in fixed-width columns
    to the left of the track. The stop name itself (Start, C1, …, End) acts
    as the track marker; segment metrics appear next to the connecting `│`
    on the rows in between. All metrics are placed in fixed-width columns
    so each metric reads cleanly down its own column.
    """
    start_iso = activity.get("start_date") or activity.get("start_date_local") or ""
    fmt_clock = _make_clock_fmt(start_iso, activity.get("utc_offset", 0))
    stop_labels, ordered_segs, cum_km = _stops_segments_cumkm(controls, segments)
    end_s = _end_seconds(controls, ordered_segs)

    # Build all cell text first so we can size columns from the data.
    stop_cells: list[tuple[str, str, str, str]] = []
    for i, label in enumerate(stop_labels):
        if label == "Start":
            time_info = fmt_clock(0)
            rest_text = "0m"
        elif label == "End":
            time_info = fmt_clock(end_s)
            rest_text = "0m"
        else:
            c = controls[i - 1]
            time_info = f"{fmt_clock(c.time_before_s)} → {fmt_clock(c.time_after_s)}"
            rest_text = f"{_fmt_dur(c.rest_s)}"
        stop_cells.append((label, f"{cum_km[i]:.1f} km", time_info, rest_text))

    # Single-row segment metrics: dist, dur, speed, HR, cad, W, climb, m/km.
    SEG_EMPTY = ("(no movement)", "", "", "", "", "", "", "")
    seg_cells: list[tuple[str, ...]] = [SEG_EMPTY if s is None else _segment_cells(s) for s in ordered_segs]

    # Stop column order on each line: dist, time_info, rest, then label.
    # Cell tuple order: (label, dist, time_info, rest).
    STOP_HEADERS = ("Stop", "Tot dist", "Stay", "")
    SEG_HEADERS = ("Dist", "Dur", "Speed", "HR", "Cad", "Power", "Climb", "Cl. rate")

    def _col_widths(rows: list[tuple], n_cols: int) -> list[int]:
        return [max(len(r[j]) for r in rows) for j in range(n_cols)]

    stop_w = _col_widths([STOP_HEADERS, *stop_cells], 4)
    seg_w = _col_widths([SEG_HEADERS, *seg_cells], 8)

    sep = "   "

    # Width of the stop-data block to the left of the track. Segment rows
    # are indented by this same amount so `│` aligns with the stop name.
    left_block_width = stop_w[1] + len(sep) + stop_w[2] + len(sep) + stop_w[3] + len(sep)
    gutter = " " * left_block_width

    def _emit(s: str) -> None:
        console.print(s, no_wrap=True, crop=False, overflow="ignore")

    def _fmt_seg(cells: tuple[str, ...], bold: bool = False) -> str:
        parts: list[str] = []
        for j, c in enumerate(cells):
            padded = c.rjust(seg_w[j])
            parts.append(f"[bold]{padded}[/bold]" if bold else padded)
        return sep.join(parts)

    _emit("")
    _emit(
        f"[bold]{STOP_HEADERS[1].rjust(stop_w[1])}[/bold]"
        + sep
        + f"[bold]{STOP_HEADERS[2].ljust(stop_w[2])}[/bold]"
        + sep
        + f"[bold]{STOP_HEADERS[3].ljust(stop_w[3])}[/bold]"
        + sep
        + f"[bold]{STOP_HEADERS[0]}[/bold]"
        + _fmt_seg(SEG_HEADERS, bold=True)
    )
    _emit("")

    for i, _ in enumerate(stop_labels):
        label, dist, time_info, rest = stop_cells[i]
        left = dist.rjust(stop_w[1]) + sep + time_info.ljust(stop_w[2]) + sep + rest.ljust(stop_w[3])
        _emit(left + sep + f"[bold]{label}[/bold]")

        if i < len(stop_labels) - 1:
            _emit(gutter + "│")
            _emit(gutter + "│" + sep + _fmt_seg(seg_cells[i]))
            _emit(gutter + "│")
    _emit("")


def render_terminal(
    activity: dict[str, Any],
    controls: list[Control],
    segments: list[Segment],
    layout: str = "horizontal",
) -> None:
    console = Console()
    start_iso = activity.get("start_date") or activity.get("start_date_local") or ""
    fmt_clock = _make_clock_fmt(start_iso, activity.get("utc_offset", 0))
    name = activity.get("name", "(unnamed ride)")
    elapsed = activity.get("elapsed_time", 0)
    moving = activity.get("moving_time", 0)
    dist_km = activity.get("distance", 0) / 1000.0
    climb = activity.get("total_elevation_gain", 0)

    console.rule(f"[bold]{name}[/bold]  ({start_iso[:10]})")
    console.print(
        f"Distance: [bold]{dist_km:.1f} km[/bold]   "
        f"Elapsed: [bold]{_fmt_dur(elapsed)}[/bold]   "
        f"Moving: [bold]{_fmt_dur(moving)}[/bold]   "
        f"Climb: [bold]{climb:.0f} m[/bold]"
    )

    if layout in ("horizontal", "both"):
        render_chart(console, activity, controls, segments)
    if layout in ("vertical", "both"):
        render_chart_vertical(console, activity, controls, segments)

    if controls:
        _, _, cum_km = _stops_segments_cumkm(controls, segments)

        ct = Table(title="Controls", box=box.HORIZONTALS)
        ct.add_column("#")
        ct.add_column("Dist (km)", justify="right")
        ct.add_column("Arrive")
        ct.add_column("Depart")
        ct.add_column("Rest", justify="right")
        for i, c in enumerate(controls, start=1):
            ct.add_row(
                f"C{i}",
                f"{cum_km[i]:.1f}",
                fmt_clock(c.time_before_s),
                fmt_clock(c.time_after_s),
                _fmt_dur(c.rest_s),
            )
        console.print(ct)
    else:
        console.print("[dim]No stops above threshold detected.[/dim]")

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
    console.print(st)


def render_json(
    activity: dict[str, Any],
    controls: list[Control],
    segments: list[Segment],
) -> str:
    return json.dumps(
        {
            "activity": {
                "id": activity.get("id"),
                "name": activity.get("name"),
                "start_date": activity.get("start_date"),
                "distance_m": activity.get("distance"),
                "elapsed_time_s": activity.get("elapsed_time"),
                "moving_time_s": activity.get("moving_time"),
                "total_elevation_gain_m": activity.get("total_elevation_gain"),
            },
            "controls": [asdict(c) for c in controls],
            "segments": [asdict(s) for s in segments],
        },
        indent=2,
    )
