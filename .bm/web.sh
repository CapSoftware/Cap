#!/usr/bin/env bash
# Server parity: main's web and #4322's web (scratch MySQL + MinIO, nothing
# shared with any real deployment), the same desktop API replay against both,
# main's web against the #4322-migrated schema (the deploy window), and real
# 0.6.3 / base / head desktop Instant uploads against each.
set -uo pipefail
W=$RUNNER_TEMP/web
mkdir -p "$W"
HEAD_DIR=$GITHUB_WORKSPACE
BASE_DIR=$RUNNER_TEMP/base
KEY=11111111-2222-4333-8444-555555555555
UID_=bmuser000000001
export AWS_ACCESS_KEY_ID=bmadmin AWS_SECRET_ACCESS_KEY=bmminiopwd123 AWS_DEFAULT_REGION=us-east-1
S3="aws --endpoint-url http://127.0.0.1:9000 s3"
SQL="mysql --protocol=TCP -h 127.0.0.1 -u root"

docker run -d --name minio -p 9000:9000 -e MINIO_ROOT_USER=$AWS_ACCESS_KEY_ID \
  -e MINIO_ROOT_PASSWORD=$AWS_SECRET_ACCESS_KEY minio/minio server /data >/dev/null
for _ in $(seq 60); do curl -sf http://127.0.0.1:9000/minio/health/live >/dev/null && break; sleep 1; done
$S3 mb s3://cap

$SQL -e "CREATE DATABASE cap_base; CREATE DATABASE cap_head;"
migrate() { # <dir> <db>
  (cd "$1/packages/database" && DATABASE_URL="mysql://root@127.0.0.1:3306/$2" bun run drizzle-kit migrate --config=drizzle.config.ts) \
    >"$W/migrate-$2.log" 2>&1
  echo "migrate $2 rc=$?"
}
migrate "$BASE_DIR" cap_base
migrate "$HEAD_DIR" cap_head
for db in cap_base cap_head; do
  mysqldump --protocol=TCP -h 127.0.0.1 -u root --no-data --skip-comments "$db" | sed 's/ AUTO_INCREMENT=[0-9]*//' >"$W/schema-$db.sql"
  $SQL -N -e "SELECT hash FROM $db.__drizzle_migrations ORDER BY id" 2>/dev/null | wc -l | sed "s/^/$db migrations: /"
done
diff "$W/schema-cap_base.sql" "$W/schema-cap_head.sql" >"$W/schema.diff"
echo "schema diff (base -> head):"; cat "$W/schema.diff"

seed() {
  $SQL "$1" <<SQL
INSERT INTO users (id, email, name, activeOrganizationId) VALUES ('$UID_', 'bm-test@example.com', 'BM Test', 'bmorg0000000001');
INSERT INTO organizations (id, name, ownerId) VALUES ('bmorg0000000001', 'BM Org', '$UID_');
INSERT INTO organization_members (id, userId, organizationId, role) VALUES ('bmmem0000000001', '$UID_', 'bmorg0000000001', 'owner');
INSERT INTO auth_api_keys (id, userId, source) VALUES ('$KEY', '$UID_', 'desktop');
SQL
  echo "seed $1 rc=$?"
}
seed cap_base
seed cap_head

write_env() { # <dir> <db>
  cat >"$1/.env" <<ENV
NODE_ENV=development
DATABASE_URL=mysql://root@127.0.0.1:3306/$2
WEB_URL=http://localhost:3000
NEXT_PUBLIC_WEB_URL=http://localhost:3000
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
DATABASE_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
CAP_AWS_ACCESS_KEY=$AWS_ACCESS_KEY_ID
CAP_AWS_SECRET_KEY=$AWS_SECRET_ACCESS_KEY
CAP_AWS_BUCKET=cap
CAP_AWS_REGION=us-east-1
S3_PUBLIC_ENDPOINT=http://127.0.0.1:9000
S3_INTERNAL_ENDPOINT=http://127.0.0.1:9000
S3_PATH_STYLE=true
ENV
}

WEB_PID=
start_web() { # <dir> <db> <name>
  write_env "$1" "$2"
  (cd "$1/apps/web" && exec bun run dev) >"$W/web-$3.log" 2>&1 &
  WEB_PID=$!
  for _ in $(seq 300); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" http://localhost:3000/api/desktop/plan)
    [[ $code != 000 ]] && { echo "web $3 up ($code)"; return 0; }
    sleep 2
  done
  echo "web $3 never came up"; tail -50 "$W/web-$3.log"
  return 1
}
stop_web() {
  pkill -P "$WEB_PID" 2>/dev/null; kill "$WEB_PID" 2>/dev/null
  pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null
  for _ in $(seq 30); do curl -s -o /dev/null http://localhost:3000 || break; sleep 1; done
}

export DISPLAY=:79 XDG_SESSION_TYPE=x11
unset WAYLAND_DISPLAY
Xvfb "$DISPLAY" -screen 0 1920x1080x24 >/dev/null 2>&1 &
pulse_dir=$(mktemp -d)
export PULSE_SERVER=unix:$pulse_dir/native
pulseaudio -n --daemonize=no --exit-idle-time=-1 \
  -L "module-native-protocol-unix socket=$pulse_dir/native auth-anonymous=1" \
  -L "module-null-sink sink_name=bm_out" >/dev/null 2>&1 &
A=$RUNNER_TEMP/apps

uploads() { # <web name> <db>
  for tag in old base head; do
    case $tag in
      old) args=(--old "$OLD_BIN") ;;
      base) args=(--base "$A/base/cap-gpui" --base-libs "$A/base/libs") ;;
      head) args=(--head "$A/head/cap-gpui" --head-libs "$A/head/libs") ;;
    esac
    dbus-run-session -- python3 .bm/bm.py "${args[@]}" --mode instant --tag $tag --name "$1-$tag" \
      --out "$W/desk" --server http://localhost:3000 --api-key $KEY --user-id $UID_ >"$W/desk-$1-$tag.txt" 2>&1
    echo "desktop $tag on $1 web rc=$?"
  done
  $SQL -e "SELECT id, ownerId, source, JSON_EXTRACT(metadata,'$.duration') AS dur FROM $2.videos ORDER BY createdAt" >"$W/videos-$1.txt" 2>&1
  $S3 ls --recursive s3://cap/ >"$W/objects-$1.txt" 2>&1
  echo "videos ($1):"; cat "$W/videos-$1.txt"
  echo "objects ($1):"; cat "$W/objects-$1.txt"
}

start_web "$BASE_DIR" cap_base base && {
  python3 .bm/bm_server.py replay http://localhost:3000 $KEY "$W/replay-base.json" >"$W/replay-base.txt" 2>&1
  uploads base cap_base
}
stop_web
grep -E '(GET|POST|PUT|DELETE|PATCH) /api' "$W/web-base.log" >"$W/requests-base.txt" || true

start_web "$HEAD_DIR" cap_head head && {
  python3 .bm/bm_server.py replay http://localhost:3000 $KEY "$W/replay-head.json" >"$W/replay-head.txt" 2>&1
  uploads head cap_head
}
stop_web
grep -E '(GET|POST|PUT|DELETE|PATCH) /api' "$W/web-head.log" >"$W/requests-head.txt" || true

# Deploy window: main's web code on the database #4322's migration produced.
start_web "$BASE_DIR" cap_head base-on-headdb && {
  python3 .bm/bm_server.py replay http://localhost:3000 $KEY "$W/replay-base-headdb.json" >"$W/replay-base-headdb.txt" 2>&1
}
stop_web

echo "== base web vs head web"
python3 .bm/bm_server.py compare "$W/replay-base.json" "$W/replay-head.json" | tee "$W/compare-base-head.txt"
echo "== base web on base db vs base web on head db"
python3 .bm/bm_server.py compare "$W/replay-base.json" "$W/replay-base-headdb.json" | tee "$W/compare-deploy-window.txt"
echo "== requests the real desktop clients made (method path status)"
for n in base head; do sed -E 's/ in [0-9.]+m?s.*//' "$W/requests-$n.txt" | sed -E 's/[A-Za-z0-9_-]{15,}/<id>/g' | sort | uniq -c >"$W/requests-$n-norm.txt"; done
diff "$W/requests-base-norm.txt" "$W/requests-head-norm.txt" && echo "same request/status mix"
exit 0
