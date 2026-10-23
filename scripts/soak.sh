#!/usr/bin/env bash
# Soak: constant load for N seconds through the LB while sampling container memory/CPU every 30 s.
#   scripts/soak.sh [seconds=600] [clients=20]
SECS=${1:-600}; CLIENTS=${2:-20}; OUT=${3:-soak-results.txt}
( while true; do echo "$(date +%T) $(docker stats --no-stream --format '{{.Name}} mem={{.MemUsage}} cpu={{.CPUPerc}}' | grep -E 'app[123]|redpanda|postgres' | tr '\n' ' ')"; sleep 30; done ) > "$OUT.samples" 2>&1 &
SAMPLER=$!
node scripts/loadtest.js http://127.0.0.1:8088 "$CLIENTS" "$SECS" > "$OUT" 2>&1
kill $SAMPLER 2>/dev/null
echo "--- memory samples" >> "$OUT"; cat "$OUT.samples" >> "$OUT"; rm -f "$OUT.samples"; echo SOAK_DONE >> "$OUT"
