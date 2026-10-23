#!/usr/bin/env bash
# Runs the production journey (and optionally load) as a pod inside a k3s test cluster. Usage:
#   KUBECONFIG=... bash scripts/k3s-e2e.sh [journey|load] [secs] [conc] [max_failures]
set -u
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
MODE="${1:-journey}"; SECS="${2:-60}"; CONC="${3:-20}"; MAXF="${4:-}"
docker build -q -t mobiad:local . >/dev/null && docker save mobiad:local | docker exec -i mobiad-k3s ctr -n k8s.io images import - >/dev/null 2>&1
MT=$(kubectl -n mobiad get secret mobiad-secrets -o jsonpath='{.data.METRICS_TOKEN}' | base64 -d)
RND=$(date +%s%N | tail -c 7); ADMIN="ops-$RND@k8s.test"; PASS="Pw-$(od -An -N12 -tx1 /dev/urandom | tr -d ' 
')-Zq"
kubectl -n mobiad exec deploy/mobiad -- env ADMIN_EMAIL="$ADMIN" ADMIN_PASSWORD="$PASS" node scripts/create-admin.js >/dev/null 2>&1 || { echo "admin creation failed"; exit 1; }
kubectl -n kube-system delete pod e2e --ignore-not-found >/dev/null 2>&1
ENVS=(--env=BASE=http://mobiad.mobiad.svc.cluster.local --env=MAILPIT_API=http://mailpit.mobiad-deps.svc.cluster.local:8025 --env=ADMIN_EMAIL="$ADMIN"
      --env=ADMIN_PASSWORD="$PASS" --env=REWRITE_TRACKING=1 --env=E2E_RESET=1 --env=METRICS_TOKEN="$MT" --env=MODE="$MODE" --env=SECS="$SECS" --env=CONC="$CONC")
[ -n "$MAXF" ] && ENVS+=(--env=MAX_FAILURES="$MAXF")
# load mode: tiny price and a big budget so sustained traffic does not exhaust the campaign mid-test
[ "$MODE" = load ] && ENVS+=(--env=FLOOR=1 --env=BUDGET=4000 --env=CREDIT=5000)
kubectl -n kube-system run e2e --image=mobiad:local --image-pull-policy=Never --restart=Never "${ENVS[@]}" --command -- node scripts/prod-e2e.mjs >/dev/null 2>&1
echo "e2e pod started ($MODE)"
