# Coasting and zero-valued samples in segment averages

## Why this exists

Segment statistics report average cadence and average power per leg. A naive
arithmetic mean over the stream counts every recorded sample equally —
including the many samples where the rider is **coasting** (freewheeling, not
pedaling), which the head unit logs as `cadence = 0` and `watts = 0`.

Counting those zeros answers "average including coasting," which reads far
lower than the "average while actually pedaling / putting down power" a rider
expects — and lower than what the head unit itself displays. So
`build_segments` excludes zero samples from the cadence and power means
(`_slice_mean(..., skip_zero=True)`). Heart rate keeps the plain mean (HR is
never zero on a live rider), and average speed is unaffected because it is
derived as `distance / duration`, not as a sample mean.

This note quantifies how much that choice matters, using one representative
ride, and documents the method so it can be re-run on any cached activity.

## Methodology

Data source: the locally cached Strava streams for a single activity, read
directly from the cache (no network). All series are sampled at the device's
native rate.

Definitions:

- **Coasting** — a sample with `cadence == 0`. This is the cleanest signal:
  the rider is not turning the cranks.
- **Zero power** — a sample with `watts == 0`. This is a *broader* set than
  coasting: it includes coasting **plus** soft-pedaling below the power
  meter's floor and brief power-meter dropouts, where the cranks are still
  turning (`cadence != 0`).
- **Recording gap** — an inter-sample time delta above
  `max(5 s, 5 x median delta)`. These are device pauses (stops, signal loss,
  overnight gaps between stitched multi-day uploads), excluded from riding
  time. This threshold is cadence-derived and independent of the user's
  stop-detection setting, so the figures are stable regardless of how stops
  are tuned. See `daynight._gap_threshold`.

Measures computed:

1. Share of samples with `cadence == 0` and with `watts == 0`, and the overlap
   between them (how much of `watts == 0` is genuine coasting vs.
   soft-pedal/dropout).
2. Time-weighted coasting: each inter-sample interval is attributed to its end
   sample and summed, with recording-gap intervals excluded, so coasting is
   expressed as a fraction of true riding time rather than raw sample count.
3. Streak-length distribution of consecutive `cadence == 0` runs, to separate
   brief freewheel blips from sustained descents.
4. The per-segment effect: average cadence and power computed both with and
   without zero exclusion, alongside each segment's coasting fraction.

## Findings — a sample 310 km randonnée

The ride logs at **1 Hz** (median sample interval 1 s), so sample counts and
seconds are effectively interchangeable. ~49,000 samples, all streams complete
(cadence, power, heart rate, altitude, distance, position) with no missing
values.

### Time budget

| Quantity | Value |
| --- | --- |
| Total elapsed span | ~16.2 h |
| Recording-gap time (stops, pauses) | ~2.54 h |
| Actual riding time | ~13.63 h |

### Zero-sample prevalence

| Condition | Share of samples |
| --- | --- |
| `cadence == 0` (coasting) | **16.7%** |
| `watts == 0` | **23.1%** |
| `cadence == 0` **and** `watts == 0` | 16.6% |
| `watts == 0` but `cadence != 0` (soft-pedal / dropout) | 6.5% |
| `cadence == 0` but `watts != 0` | 0.0% |

About **1 in 6 riding-seconds is true coasting** (16.7% of riding time, ~2.27
h). The `watts == 0` measure is ~6.5 points higher because it also captures
soft-pedaling and meter dropouts — pedaling samples that read zero power.
Coasting almost never occurs with non-zero power (0.0%), confirming
`cadence == 0` as the faithful coasting definition.

### Coasting streak structure

Consecutive `cadence == 0` runs, ~1,180 runs total:

| Run length | Runs | Samples (~s) |
| --- | --- | --- |
| 1 s | ~210 | ~210 |
| 2–5 s | ~480 | ~1,600 |
| 6–10 s | ~260 | ~2,000 |
| 11–30 s | ~200 | ~3,300 |
| 31–60 s | ~25 | ~960 |
| > 60 s | 1 | ~110 |

Two populations are visible: many short 1–10 s blips (junction soft-pedals,
brief freewheels) and a heavier tail of sustained 11 s+ coasts (~54% of all
coasting time) — genuine descents and freewheel stretches. Longest single
coast: ~107 s.

### Effect on segment averages

Per-leg averages, computed both ways, with each leg's coasting fraction:

| Segment | Cadence incl. 0 | Cadence excl. 0 | Watts incl. 0 | Watts excl. 0 | Coasting % |
| --- | --: | --: | --: | --: | --: |
| Leg 1 | 56.5 | **66.3** | 120.8 | **153.9** | ~15–22% |
| Leg 2 | 64.3 | **73.1** | 136.8 | **164.3** | ~12–17% |
| Leg 3 | 66.3 | **74.6** | 132.1 | **156.6** | ~11–16% |
| Leg 4 | 60.0 | **71.5** | 123.2 | **154.9** | ~16–20% |
| Leg 5 | 54.5 | **68.6** | 109.0 | **147.9** | ~21–26% |
| Leg 6 | 55.2 | **69.0** | 106.7 | **144.8** | ~20–26% |
| Leg 7 | 50.7 | **63.9** | 87.3 | **126.9** | ~21–31% |

Excluding zeros raises cadence by **~9–14 rpm** and power by **~30–46 W** per
leg — material corrections, not rounding. The size of each correction scales
with the leg's coasting fraction: the final, descent-heavy run-in (highest
coasting share) shows the largest jump (+46% power). This scaling with coasting
fraction — rather than with stop count — confirms the cause is pervasive
freewheeling, not stops.

## Takeaways

- Roughly **one sixth of riding time is spent coasting**, rising to ~one
  quarter by the `watts == 0` measure once soft-pedaling is folded in.
- Including those zeros understates segment cadence and power by amounts large
  enough to mislead (tens of watts, ~10 rpm).
- `cadence == 0` is the more precise coasting definition; `watts == 0` is
  broader and conflates coasting with soft-pedaling and dropouts.
- Excluding zeros for cadence and power (but not HR, and not speed) yields
  averages that reflect active effort and align with head-unit displays.
