# @aaronge/iss-tracker

Tracks the International Space Station's current position via Open
Notify's free, unauthenticated `iss-now.json` API, and reports its
great-circle distance from a configured ground location.

**Scope, honestly stated**: `withinRange` is a distance proxy for
"roughly overhead," not a real visibility/pass prediction. True
visibility depends on the ISS's actual altitude, your local horizon, and
whether it's currently sunlit while your sky is dark — none of which this
model computes. This is a fun proximity indicator, not a pass-prediction
tool (see [Heavens-Above](https://www.heavens-above.com/) or similar for
that).

**Upstream API reliability, observed 2026-08-28**: repeated calls to
`api.open-notify.org/iss-now.json` several minutes apart returned the
*exact same* timestamp and position every time — the service appears to
be serving frozen/static data rather than genuinely live-tracking, at
least from this network. Open Notify has a known history of
instability/unmaintained stretches. The model itself works correctly
(verified against both this real captured response and mocked scenarios
in tests) — but before relying on `withinRange`, independently confirm
the API is actually live for you, e.g. `curl
api.open-notify.org/iss-now.json` twice a minute apart and check the
`timestamp` field changes.

## Installation

```sh
swamp extension pull @aaronge/iss-tracker
```

## Usage

```sh
swamp model create @aaronge/iss-tracker my-location \
  --global-arg latitude=51.5074 \
  --global-arg longitude=-0.1278

swamp model method run my-location checkOverhead
```

Set `latitude`/`longitude` to your own location. The method writes one
resource, `position`, with the ISS's current coordinates, distance from
your location, and whether that distance is under `thresholdKm` (default
2200km — see below for what that number does and doesn't mean).

## Global arguments

| Arg           | Default                                    | Notes                                                                                          |
| ------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `latitude`    | _(required)_                                | Your ground location, decimal degrees.                                                          |
| `longitude`   | _(required)_                                | Your ground location, decimal degrees.                                                          |
| `thresholdKm` | `2200`                                      | Distance below which `withinRange` is true — a rule-of-thumb approximation, not a computed line-of-sight radius. |
| `apiUrl`      | `http://api.open-notify.org/iss-now.json`   | Override for testing, or if Open Notify moves. Note: plain `http`, not `https` — that's what this public API actually serves. |

## How it works

- **`checkOverhead`** — fetches the ISS's current lat/lon, computes the
  haversine (great-circle) distance to your configured location, and
  writes `position` with `distanceKm` and `withinRange`. Throws (writing
  nothing) on a non-200 response or an unparseable body — a fake "ISS is
  at 0,0" reading would be worse than an honest failure.

## Workflow

The `@aaronge/iss-tracker` workflow ships in the package, so
`swamp extension pull @aaronge/iss-tracker` brings it along. It carries its
own `trigger.schedule` (`3-59/5 * * * *`, every 5 minutes, offset from
other 5-minute jobs), so a running `swamp serve` runs `checkOverhead` and
then exports `iss_tracker_distance_km` and `iss_tracker_within_range` as a
Prometheus textfile metric (`/var/lib/prometheus/node-exporter/iss-tracker.prom`,
written atomically). The export only runs after a successful check, so an
Open Notify hiccup leaves the last reading in place.

Open Notify's API is free and unauthenticated, but be a reasonable citizen
of someone else's free service (every few minutes is plenty; the ISS moves
about 7.7km/s, so sub-minute polling buys you nothing meaningful).

The consuming repo needs a `my-location` model instance with your
coordinates:

```bash
swamp model create @aaronge/iss-tracker my-location
swamp workflow run @aaronge/iss-tracker   # one manual run
```

To change the cadence without editing the package:
`swamp workflow trigger set @aaronge/iss-tracker --schedule "*/15 * * * *"`.

The old `run-via-serve.sh` wrapper, which ran the same check from a
systemd timer through a throwaway `swamp serve` and wrote the textfile with
inline Python, was removed on 2026-11-05. The shipped workflow replaces it.

## License

MIT — see LICENSE for details.
