#!/bin/bash
# Brings up the datastores every task app on this Mac needs, when they are not already up — nothing here survives a
# reboot by itself (Docker Desktop has AutoStart off, its containers have no restart policy, the native Postgres is
# not a brew service). Prefixed onto every env's BE / setup / worker command in Stagehand, so a task's Start heals
# the host instead of failing with "connection refused":
#   1. Docker Desktop                        → open -a Docker, wait for `docker info`
#   2. Postgres 5432 = backend-postgres-1    (DualEntry compose; also Core's dev/audit)   → docker compose up postgres
#   3. Postgres 5433 = native postgresql@14  (Deal's ns_deal + a copy of Core's dev)      → pg_ctl -o "-p 5433"
#   4. Redis 6389    = ns-redis              (Core compose redis-stack; Deal and Core cfgs point at it) → docker start
#   5. RustFS 9000   = backend-rustfs-1      (DualEntry's local S3) + its bucket from backend/.env        → docker compose up rustfs, aws s3api create-bucket
# Every step is skipped when its check passes, so the happy path costs four probes (< 1 s). Exit non-zero, with the
# reason on stderr, when something cannot be brought up in time.
#
#   scripts/ensure-datastores.sh            everything
#   scripts/ensure-datastores.sh status     probes only, no starts
set -u

DUALENTRY_COMPOSE="${DUALENTRY_COMPOSE:-/Users/stepanburlakov/code/dualentry/backend/docker-compose.yml}"
CORE_REPO="${CORE_REPO:-/Users/stepanburlakov/code/northspyre/northspyre}"
PG14_BIN=/opt/homebrew/opt/postgresql@14/bin
PG14_DATA=/opt/homebrew/var/postgresql@14
PG14_LOG="${STAGEHAND_HOME:-$HOME/.stagehand}/pg14.log"

say() { echo "ensure-datastores: $*"; }
fail() { echo "ensure-datastores: $*" >&2; exit 1; }
wait_for() { # wait_for <seconds> <command…>
    local n=$1; shift
    for _ in $(seq 1 "$n"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
    return 1
}
redis_up() { redis-cli -p 6389 ping 2>/dev/null | grep -q PONG; }
rustfs_up() { curl -sf http://localhost:9000/health >/dev/null 2>&1; }
# The local S3 (RustFS) and its bucket, read from the backend's .env: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / S3_BUCKET_NAME.
DUALENTRY_ENV="$(dirname "$DUALENTRY_COMPOSE")/.env"
s3_var() { grep "^$1=" "$DUALENTRY_ENV" 2>/dev/null | head -1 | cut -d= -f2-; }
s3() { AWS_ACCESS_KEY_ID="$(s3_var AWS_ACCESS_KEY_ID)" AWS_SECRET_ACCESS_KEY="$(s3_var AWS_SECRET_ACCESS_KEY)" AWS_DEFAULT_REGION=us-east-1 aws --endpoint-url http://localhost:9000 "$@"; }
bucket_up() { [ -n "$(s3_var S3_BUCKET_NAME)" ] && s3 s3api head-bucket --bucket "$(s3_var S3_BUCKET_NAME)" >/dev/null 2>&1; }

status() {
    docker info >/dev/null 2>&1 && echo "docker: up" || echo "docker: down"
    pg_isready -q -h localhost -p 5432 && echo "postgres 5432 (backend-postgres-1): up" || echo "postgres 5432 (backend-postgres-1): down"
    pg_isready -q -h localhost -p 5433 && echo "postgres 5433 (native pg14): up" || echo "postgres 5433 (native pg14): down"
    redis_up && echo "redis 6389 (ns-redis): up" || echo "redis 6389 (ns-redis): down"
    rustfs_up && echo "rustfs 9000 (backend-rustfs-1): up" || echo "rustfs 9000 (backend-rustfs-1): down"
    bucket_up && echo "s3 bucket $(s3_var S3_BUCKET_NAME): present" || echo "s3 bucket $(s3_var S3_BUCKET_NAME): missing"
}
[ "${1:-}" = "status" ] && { status; exit 0; }

# 1. Docker Desktop
if ! docker info >/dev/null 2>&1; then
    say "Docker is down — starting Docker Desktop"
    open -ga Docker || fail "could not open Docker Desktop"
    wait_for 120 docker info || fail "Docker did not come up within 120 s"
fi

# 2. Postgres 5432 (container)
if ! pg_isready -q -h localhost -p 5432; then
    say "Postgres 5432 is down — docker compose up postgres ($DUALENTRY_COMPOSE)"
    docker compose -f "$DUALENTRY_COMPOSE" up -d --no-deps postgres >/dev/null 2>&1 || fail "docker compose up postgres failed"
    wait_for 60 pg_isready -q -h localhost -p 5432 || fail "Postgres 5432 did not answer within 60 s"
fi

# 3. Postgres 5433 (native postgresql@14)
if ! pg_isready -q -h localhost -p 5433; then
    say "Postgres 5433 is down — pg_ctl start (postgresql@14 on 5433)"
    "$PG14_BIN/pg_ctl" -D "$PG14_DATA" -o "-p 5433" -l "$PG14_LOG" start >/dev/null 2>&1 || true
    wait_for 60 pg_isready -q -h localhost -p 5433 || fail "Postgres 5433 did not answer within 60 s — see $PG14_LOG"
fi

# 4. Redis 6389 (ns-redis container)
if ! redis_up; then
    say "Redis 6389 is down — starting ns-redis"
    docker start ns-redis >/dev/null 2>&1 || (cd "$CORE_REPO" && docker compose --profile datastores up -d --no-deps redis >/dev/null 2>&1) || fail "could not start ns-redis"
    wait_for 60 redis_up || fail "Redis 6389 did not answer within 60 s"
fi

# 5. RustFS 9000 (local S3) and the bucket every upload needs (INV-133 QA, 2026-09-22 and 09-24: NoSuchBucket / container stopped)
if ! rustfs_up; then
    say "RustFS 9000 is down — docker compose up rustfs ($DUALENTRY_COMPOSE)"
    docker compose -f "$DUALENTRY_COMPOSE" up -d --no-deps rustfs >/dev/null 2>&1 || fail "docker compose up rustfs failed"
    wait_for 60 rustfs_up || fail "RustFS 9000 did not answer within 60 s"
fi
if command -v aws >/dev/null 2>&1 && [ -n "$(s3_var S3_BUCKET_NAME)" ] && ! bucket_up; then
    say "S3 bucket $(s3_var S3_BUCKET_NAME) is missing — creating it in RustFS"
    s3 s3api create-bucket --bucket "$(s3_var S3_BUCKET_NAME)" >/dev/null 2>&1 || fail "could not create bucket $(s3_var S3_BUCKET_NAME)"
fi

exit 0
