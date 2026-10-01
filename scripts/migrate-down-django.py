#!/usr/bin/env python3
"""Rolls a Django database back to the migrations of the base commit: every app whose migrations the branch added
goes back to the last migration it has at the base (or to zero). Run from the repository, on the branch's code — the
branch's code knows how to reverse its own migrations.

  migrate-down-django.py --base <sha> [--repo <dir>] -- <manage.py command…>
  e.g. migrate-down-django.py --base "$STAGEHAND_BASE_REF_BACKEND" --repo backend -- poetry run python dualentry/manage.py

A migration the branch edited (not added) cannot be rolled back safely: the script stops before it changes anything.
"""
import argparse
import re
import subprocess
import sys

MIGRATION = re.compile(r"^(?P<dir>(?:.*/)?(?P<app>[^/]+))/migrations/(?P<name>\d{4}_[^/]+)\.py$")


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, text=True).stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--repo", default=".")
    ap.add_argument("--dry-run", action="store_true", help="print the plan, change nothing")
    ap.add_argument("manage", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    manage = [x for x in a.manage if x != "--"] if a.manage and a.manage[0] == "--" else a.manage
    if not a.base or not manage:
        sys.exit("usage: migrate-down-django.py --base <sha> [--repo <dir>] -- <manage.py command…>")

    committed = git(a.repo, "diff", "--name-status", f"{a.base}..HEAD").splitlines()
    untracked = git(a.repo, "ls-files", "--others", "--exclude-standard").splitlines()
    changed = git(a.repo, "diff", "--name-status", "HEAD").splitlines()
    added, edited = {}, []
    for line in committed + changed + [f"A\t{p}" for p in untracked]:
        status, _, path = line.partition("\t")
        path = path.split("\t")[-1]
        m = MIGRATION.match(path)
        if not m:
            continue
        if status.startswith("A"):
            added.setdefault((m["dir"], m["app"]), set()).add(m["name"])
        elif status[0] in "MDR" and m["name"] not in added.get((m["dir"], m["app"]), set()):
            edited.append(path)
    if edited:
        sys.exit(f"the branch edits migrations the base already has: {', '.join(sorted(set(edited)))} — a rollback cannot restore the base's schema")
    if not added:
        print("no migrations added on this branch — nothing to roll back")
        return
    for (dir_, app), names in sorted(added.items()):
        listing = git(a.repo, "ls-tree", "--name-only", f"{a.base}:{dir_}/migrations/").splitlines() if subprocess.run(["git", "-C", a.repo, "cat-file", "-e", f"{a.base}:{dir_}/migrations"], capture_output=True).returncode == 0 else []
        base_names = sorted(n[:-3] for n in listing if re.match(r"^\d{4}_.*\.py$", n))
        target = base_names[-1] if base_names else "zero"
        print(f"{app}: back to {target} (the branch added {', '.join(sorted(names))})", flush=True)
        if not a.dry_run:
            subprocess.run([*manage, "migrate", app, target, "--noinput"], cwd=a.repo, check=True)


if __name__ == "__main__":
    main()
