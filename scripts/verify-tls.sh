#!/usr/bin/env bash
# Verifies that the app's TLS settings work against REAL TLS-only Postgres and Redis with a self-signed CA:
#   1. plaintext connections are refused          2. an untrusted certificate is rejected (no silent downgrade)
#   3. with the CA trusted, connections succeed   4. the session really is encrypted (pg_stat_ssl / rediss)
# Requires Docker. Usage: bash scripts/verify-tls.sh
set -u
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
WORK="$(mktemp -d)"; trap 'docker rm -f mobiad-tls-pg mobiad-tls-redis >/dev/null 2>&1; rm -rf "$WORK"' EXIT
WIN="$(cygpath -w "$WORK" 2>/dev/null || echo "$WORK")"
fail=0; ok() { echo "  ✓ $1"; }; bad() { echo "  ✗ $1"; fail=1; }

echo "== generating a throwaway CA + server certificate (CN/SAN=localhost)"
docker run --rm -v "$WIN:/certs" postgres:16 sh -c '
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -keyout /certs/ca.key -out /certs/ca.crt -subj "/CN=mobiad-test-ca" 2>/dev/null &&
  openssl req -newkey rsa:2048 -nodes -keyout /certs/server.key -out /certs/server.csr -subj "/CN=localhost" 2>/dev/null &&
  printf "subjectAltName=DNS:localhost,IP:127.0.0.1" > /certs/san.cnf &&
  openssl x509 -req -in /certs/server.csr -CA /certs/ca.crt -CAkey /certs/ca.key -CAcreateserial -days 2 -out /certs/server.crt -extfile /certs/san.cnf 2>/dev/null &&
  chmod 644 /certs/*.crt && chmod 644 /certs/server.key' || { echo "cert generation failed"; exit 1; }

echo "== starting TLS-only Postgres (hostssl) and TLS-only Redis"
docker run -d --name mobiad-tls-pg -p 55433:5432 -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=mobiad -v "$WIN:/certs:ro" postgres:16 \
  sh -c 'cp /certs/server.key /var/lib/postgresql/server.key && chown postgres:postgres /var/lib/postgresql/server.key && chmod 600 /var/lib/postgresql/server.key &&
         exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/var/lib/postgresql/server.key' >/dev/null
docker run -d --name mobiad-tls-redis -p 56380:6380 -v "$WIN:/certs:ro" redis:7 \
  redis-server --port 0 --tls-port 6380 --tls-cert-file /certs/server.crt --tls-key-file /certs/server.key --tls-ca-cert-file /certs/ca.crt --tls-auth-clients no >/dev/null
for _ in $(seq 1 40); do docker exec mobiad-tls-pg pg_isready -U postgres -d mobiad >/dev/null 2>&1 && break; sleep 2; done

CA="$WIN/ca.crt"
run() { node --input-type=module -e "$1" 2>&1; }

echo "== Postgres"
# Postgres only offers TLS if the client asks (hostssl rule in pg_hba is the enforcement point), so enforce it:
docker exec mobiad-tls-pg sh -c "sed -i 's/^host all all all scram-sha-256/hostssl all all all scram-sha-256/' /var/lib/postgresql/data/pg_hba.conf && psql -U postgres -c 'select pg_reload_conf()' >/dev/null"
PGURL="postgres://postgres:dev@localhost:55433/mobiad"
out=$(run "import {createPool} from './src/db/repo.js'; const p=await createPool('$PGURL'); try{await p.query('select 1'); console.log('CONNECTED')}catch(e){console.log('REFUSED:'+e.message)}; process.exit(0)")
echo "$out" | grep -q "REFUSED" && ok "plaintext connection refused by the server ($out)" || bad "plaintext connection was accepted: $out"
out=$(DATABASE_SSL=1 run "import {createPool} from './src/db/repo.js'; const p=await createPool('$PGURL',{ssl:{rejectUnauthorized:true}}); try{await p.query('select 1'); console.log('CONNECTED')}catch(e){console.log('REJECTED:'+e.message)}; process.exit(0)")
echo "$out" | grep -qE "REJECTED:.*(self.signed|unable to|certificate)" && ok "untrusted certificate rejected ($out)" || bad "untrusted cert not rejected: $out"
out=$(NODE_EXTRA_CA_CERTS="$CA" run "import {createPool,Repo} from './src/db/repo.js'; const p=await createPool('$PGURL',{ssl:{rejectUnauthorized:true}}); const r=new Repo(p); await r.migrate(); const s=(await p.query('select ssl, version from pg_stat_ssl where pid=pg_backend_pid()')).rows[0]; console.log('SSL='+s.ssl+' '+s.version); process.exit(0)")
echo "$out" | grep -q "SSL=true" && ok "trusted CA: connected, migrated, session encrypted ($out)" || bad "TLS session not established: $out"

echo "== Redis"
out=$(run "import Redis from 'ioredis'; const r=new Redis('redis://localhost:56380',{maxRetriesPerRequest:0,enableOfflineQueue:false,retryStrategy:()=>null,lazyConnect:true}); r.on('error',()=>{}); try{await r.connect(); console.log('PING '+await r.ping())}catch(e){console.log('REFUSED')}; process.exit(0)")
echo "$out" | grep -q "REFUSED" && ok "plaintext redis:// against the TLS port refused" || bad "plaintext accepted: $out"
out=$(run "import Redis from 'ioredis'; const r=new Redis('rediss://localhost:56380',{maxRetriesPerRequest:0,retryStrategy:()=>null,lazyConnect:true}); r.on('error',()=>{}); try{await r.connect(); console.log('PING '+await r.ping())}catch(e){console.log('REJECTED:'+e.message)}; process.exit(0)")
echo "$out" | grep -qE "REJECTED" && ok "untrusted certificate rejected ($out)" || bad "untrusted redis cert accepted: $out"
out=$(NODE_EXTRA_CA_CERTS="$CA" run "import {createHotState} from './src/core/ports.js'; const h=await createHotState('rediss://localhost:56380'); console.log('DEDUPE '+await h.deduper.firstTime('tls-'+Date.now())+' status='+h.status().redis); await h.close(); process.exit(0)")
echo "$out" | grep -q "DEDUPE true status=ok" && ok "trusted CA: app hot-state works over rediss:// ($out)" || bad "app over rediss failed: $out"

[ $fail -eq 0 ] && echo "ALL TLS CHECKS PASSED" || echo "TLS CHECKS FAILED"
exit $fail
