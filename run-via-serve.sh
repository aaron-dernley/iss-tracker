#!/bin/bash
# Starts swamp serve just long enough to run one method call through it,
# then tears it down — avoids the ~400MB idle RSS cost of a persistent
# swamp serve daemon (see MIGRATION.md/memory for why that matters on
# this 8GB Pi) while still going through swamp serve as requested.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=9091
INSTANCE=my-location
METHOD=checkOverhead

cd "$REPO_DIR"
swamp serve --repo-dir "$REPO_DIR" --port "$PORT" --host 127.0.0.1 --no-schedule \
  >/tmp/iss-tracker-serve.log 2>&1 &
SERVE_PID=$!
trap 'kill "$SERVE_PID" 2>/dev/null || true' EXIT

# Wait for the server to actually be listening rather than a fixed sleep.
for _ in $(seq 1 20); do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

swamp model method run "$INSTANCE" "$METHOD" --server "ws://127.0.0.1:${PORT}"

# Export a small Prometheus textfile snippet for the Fun Stuff Grafana
# dashboard. Written atomically (tmp file + mv) since node_exporter may
# be scraping the textfile directory concurrently.
PROM_DIR=/var/lib/prometheus/node-exporter
PROM_TMP="$(mktemp "${PROM_DIR}/.iss-tracker.prom.XXXXXX")"
swamp data get "$INSTANCE" position --server "ws://127.0.0.1:${PORT}" --json | python3 -c "
import json, sys
d = json.load(sys.stdin)['content']
print('# HELP iss_tracker_distance_km Great-circle distance from the configured location to the ISS.')
print('# TYPE iss_tracker_distance_km gauge')
print(f\"iss_tracker_distance_km {d['distanceKm']}\")
print('# HELP iss_tracker_within_range 1 if distance is under the configured threshold (a proximity proxy, not a real pass prediction).')
print('# TYPE iss_tracker_within_range gauge')
print(f\"iss_tracker_within_range {1 if d['withinRange'] else 0}\")
" > "$PROM_TMP"
chmod 644 "$PROM_TMP"
mv "$PROM_TMP" "${PROM_DIR}/iss-tracker.prom"
