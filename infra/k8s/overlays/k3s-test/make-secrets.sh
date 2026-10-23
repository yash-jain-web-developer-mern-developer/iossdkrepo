#!/usr/bin/env bash
# Generates secrets.env for the test overlay with RANDOM secrets (never committed; see .gitignore). Re-run to rotate.
set -eu
cd "$(dirname "$0")"
rnd() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }
cat > secrets.env <<EOF
MOBIAD_SECRET=$(rnd)
METRICS_TOKEN=$(rnd | cut -c1-32)
DATABASE_URL=postgres://postgres:dev@postgres.mobiad-deps.svc.cluster.local:5432/mobiad
REDIS_URL=redis://redis.mobiad-deps.svc.cluster.local:6379
KAFKA_BROKERS=redpanda.mobiad-deps.svc.cluster.local:9092
SMTP_URL=smtp://mailpit.mobiad-deps.svc.cluster.local:1025
EOF
echo "wrote $(pwd)/secrets.env"
