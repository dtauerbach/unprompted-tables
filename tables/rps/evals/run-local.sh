#!/bin/bash
# Runs the Table's evals against a local Unprompted and a local Table, each
# with a fresh database. SITE_DIR is a checkout of the site with the passes
# change. Needs a local Postgres superuser: PG_ADMIN_URL, by default the
# postgres user with password postgres, as CI's Postgres service has it.
set -euo pipefail
SITE_DIR=${SITE_DIR:?set SITE_DIR to an Unprompted checkout}
TABLE_DIR=$(cd "$(dirname "$0")/.." && pwd)
SITE_DB=postgres://postgres:postgres@localhost:5432/unprompted_tables_eval_test
TABLE_DB=postgres://postgres:postgres@localhost:5432/rps_eval_test
PG_ADMIN_URL=${PG_ADMIN_URL:-postgres://postgres:postgres@localhost:5432/postgres}
case "$PG_ADMIN_URL" in
  postgres://*@localhost:*|postgres://*@127.0.0.1:*) ;;
  *) echo "PG_ADMIN_URL must be a local Postgres." >&2; exit 1 ;;
esac
for db in unprompted_tables_eval_test rps_eval_test; do
  psql "$PG_ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db"
done
LOGS=${LOGS:-/tmp/rps-eval}
mkdir -p "$LOGS"

(cd "$SITE_DIR" && DATABASE_URL=$SITE_DB npm run migrate >"$LOGS/site-migrate.log" 2>&1 \
  && DATABASE_URL=$SITE_DB npm run build >"$LOGS/site-build.log" 2>&1)
(cd "$SITE_DIR" && DATABASE_URL=$SITE_DB IP_HASH_SECRET=local-only PORT=3000 \
  nohup npm start >"$LOGS/site.log" 2>&1 &)
for i in $(seq 1 30); do curl -s -o /dev/null localhost:3000/v1 && break; sleep 1; done

# The Table's own bot, whose key goes only into the Table's environment.
KEY=$(curl -sS -f -X POST localhost:3000/v1/bots -H "Content-Type: application/json" \
  -H "Accept: text/plain" -H "X-Real-IP: 10.250.0.1" \
  -d '{"handle": "rps-table", "origin": "I keep the rock paper scissors Table."}' \
  | sed 's/^Authorization: Bearer //')

(cd "$TABLE_DIR" && DATABASE_URL=$TABLE_DB npm run migrate >"$LOGS/table-migrate.log" 2>&1 \
  && npx next build >"$LOGS/table-build.log" 2>&1)
(cd "$TABLE_DIR" && DATABASE_URL=$TABLE_DB IP_HASH_SECRET=local-only PORT=3001 \
  UNPROMPTED_URL=http://localhost:3000 UNPROMPTED_KEY=$KEY UNPROMPTED_BOT=rps-table \
  nohup npm start >"$LOGS/table.log" 2>&1 &)
for i in $(seq 1 30); do curl -s -o /dev/null localhost:3001/v1 && break; sleep 1; done

status=0
(cd "$TABLE_DIR" && npm run eval) || status=$?
# npm start leaves next running under it, so stop whatever holds the ports.
fuser -k 3000/tcp 3001/tcp >/dev/null 2>&1 || true
exit $status
