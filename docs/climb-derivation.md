# Climb (elevation gain) derivation and its overcount

## Why this exists

Each segment reports a climb figure (`Segment.climb_m`, and the derived
`climb_m_per_km`). The whole-ride summary, by contrast, shows Strava's own
`total_elevation_gain`. When the split-route feature began pooling per-segment
climb into per-pane summaries, the two bases sat side by side and disagreed —
sometimes wildly. This note documents how climb is computed, quantifies the
disagreement across the full local cache, and explains its cause so the fix
(or the decision to leave it) is made with the numbers in hand.

## How climb is computed

`segments._climb_sum` (`src/rando_recap/segments.py`) is a raw sum of positive
altitude deltas over the segment's sample range:

```python
total = 0.0
prev = altitude[lo]
for v in altitude[lo + 1 : hi + 1]:
    if v is None or prev is None:
        prev = v
        continue
    delta = v - prev
    if delta > 0:
        total += delta
    prev = v
```

There is **no smoothing, deadband, or hysteresis**: every upward tick between
consecutive samples is accumulated, however small. Per-pane climb in the split
summary is just `Σ climb_m` over the pane's segments, so it inherits this
behavior exactly.

Strava's `total_elevation_gain` (what the headline summary shows) is *not*
computed this way — it applies smoothing and a minimum-gain threshold to the
barometric/GPS elevation track before accumulating, which is why the two
numbers diverge.

## Methodology

Data source: the locally cached Strava streams for **all 51 cached
activities**, read directly from the cache (no network), each re-fetched so the
streams are current. For every ride we ran the normal analysis pipeline
(`_analyze_core`, `min_stop = 5m`, `merge_within = 100m`) and compared, per
ride:

- **Σ segment `climb_m`** (our raw-delta sum) against Strava's
  `total_elevation_gain`, as a signed percentage error.
- For context, the same comparison for **moving time** (gap-based, the shipped
  method) and **distance**, which share the "stream-derived per segment" basis
  but are expected to be faithful.

Altitude is the stream's native `altitude` series; no resampling.

## Findings — across all 51 cached rides

### Accuracy by metric (|Δ%| vs Strava)

| Metric | Mean \|Δ\| | Median \|Δ\| | Max \|Δ\| | Sign |
| --- | --: | --: | --: | --- |
| Moving (gap-based) | 0.50% | 0.27% | 2.80% | mixed, small |
| Distance (Σ segments) | 0.02% | 0.00% | 0.68% | mixed, ~0 |
| **Climb (Σ segments)** | **38.06%** | **12.64%** | **259.92%** | **positive on all 51 rides** |

Moving and distance confirm the per-segment basis is sound. Climb is the
outlier, and the bias is **one-directional**: every single ride overcounts.
That rules out random noise averaging out — it is a systematic accumulation of
elevation noise, because the algorithm only ever adds positive deltas and never
nets them against the negative jitter that follows.

### The overcount scales inversely with terrain

Flat rides are worst, because on flat ground nearly all altitude movement is
sensor noise and every positive blip is counted as climb:

| Ride | Σ segment climb | Strava climb | Error |
| --- | --: | --: | --: |
| Permanent #03526 – Brooklyn | 893 m | 248 m | +260% |
| Arakawa CR – Enomoto farm | 966 m | 271 m | +256% |
| Kakunodate | 398 m | 138 m | +187% |
| East Windsor 600K (400K leg) | 1883 m | 860 m | +119% |
| Arakawa CR – Kumagaya | 440 m | 213 m | +107% |

(The Arakawa rides are flat river-path rides — their *real* climb is small, so
the noise floor dominates.)

Genuinely hilly brevets still overcount, but proportionally less, because real
climb swamps the noise:

| Ride | Error |
| --- | --: |
| Paris-Brest-Paris 2023 (1227 km) | +11.8% |
| NY-M-NY 2024 (1219 km) | +6.2% |
| BRM506 Four-State 600K | +10.7% |
| Brooklyn to Connecticut 300k | +8.6% |

So the absolute error is roughly a fixed "noise per kilometre" tax: small in
relative terms on big climbing days, dominant on flat ones.

## Why it matters for the split feature

Per-pane climb pools these same per-segment values, so:

- Split-pane climbs **sum to noticeably more** than the whole-ride headline
  Climb (which is Strava's smoothed figure) — egregiously so on flat routes.
- The same raw figures already appear in the existing **Segments table**
  (`climb_m`, `m/km`), so this is a pre-existing issue the split summary merely
  made more visible.

By contrast, the per-pane day/night breakdown, coast, distance, and moving all
pool faithfully (day/night pooled to the whole-ride value exactly on 42/51
rides, the rest within a few seconds at stop boundaries).

## Takeaways

- `_climb_sum` is a **raw positive-delta accumulator with no noise rejection**,
  so it structurally overcounts elevation gain — mean +38%, median +13%, up to
  +260% on flat rides, and positive on every ride measured.
- The error is a per-distance noise tax: minor on big-climb days, dominant on
  flat ones.
- The standard fix is a **deadband / hysteresis**: accumulate gain only once a
  sustained rise clears a small threshold (≈1–3 m) against a running reference,
  as Garmin/Strava do. This would bring both the per-pane summary and the
  Segments table close to Strava's figure while preserving the
  per-pane = sum-of-segments property.
- Implementing it requires retuning tests that currently assert the raw-delta
  result (e.g. `tests/test_segments.py::test_no_stops_yields_one_segment`
  expects `climb_m == 10.0`).

To reproduce: re-run the per-ride comparison over the cached streams (Σ segment
`climb_m` vs `activity["total_elevation_gain"]`) using `_analyze_core`.
