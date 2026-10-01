#!/bin/bash
# Runs a migrate-up command; when it fails only because the database is AHEAD of this branch's code — the env's
# tasks share one database (docs/shared-databases.md), so another checkout may have applied a newer revision — it
# warns and succeeds, as the BE ran before migrations were a step of their own. Any other failure stays a failure.
#   migrate-up-tolerant.sh <command…>
out=$("$@" 2>&1); code=$?
printf '%s\n' "$out"
[ $code -eq 0 ] && exit 0
if printf '%s' "$out" | grep -qE "Can't locate revision identified by|No such revision or branch"; then
    echo "migrate-up-tolerant: the shared database is ahead of this branch (a revision this code does not know) — not migrated; the BE runs against the newer schema"
    exit 0
fi
exit $code
