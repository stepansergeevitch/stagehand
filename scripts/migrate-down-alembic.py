#!/usr/bin/env python3
"""Rolls an Alembic (or Flask-Migrate) database back to the head of the base commit, when the branch added revisions.
Run from the repository, on the branch's code — the branch's revisions carry their own downgrade().

  migrate-down-alembic.py --base <sha> --versions <dir> [--repo <dir>] -- <downgrade command…>
  e.g. migrate-down-alembic.py --base "$STAGEHAND_BASE_REF" --versions migrations/versions -- uv run python manage.py db downgrade

The command gets the base head revision as its last argument. A revision the branch edited (not added), or a base
with more than one head, stops the script before it changes anything.
"""
import argparse
import re
import subprocess
import sys

REV = re.compile(r"^revision\s*(?::\s*str\s*)?=\s*['\"]([0-9A-Za-z_]+)['\"]", re.M)
DOWN = re.compile(r"^down_revision\s*(?::[^=]+)?=\s*(.+)$", re.M)


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, text=True).stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--versions", required=True)
    ap.add_argument("--repo", default=".")
    ap.add_argument("--dry-run", action="store_true", help="print the plan, change nothing")
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd
    if not a.base or not cmd:
        sys.exit("usage: migrate-down-alembic.py --base <sha> --versions <dir> [--repo <dir>] -- <downgrade command…>")
    vdir = a.versions.rstrip("/")
    in_versions = lambda p: p.startswith(vdir + "/") and p.endswith(".py")

    lines = git(a.repo, "diff", "--name-status", f"{a.base}..HEAD", "--", vdir).splitlines() + git(a.repo, "diff", "--name-status", "HEAD", "--", vdir).splitlines()
    lines += [f"A\t{p}" for p in git(a.repo, "ls-files", "--others", "--exclude-standard", "--", vdir).splitlines()]
    added, edited = set(), set()
    for line in lines:
        status, _, path = line.partition("\t")
        path = path.split("\t")[-1]
        if not in_versions(path):
            continue
        (added if status.startswith("A") else edited).add(path)
    edited -= added
    if edited:
        sys.exit(f"the branch edits revisions the base already has: {', '.join(sorted(edited))} — a rollback cannot restore the base's schema")
    if not added:
        print("no revisions added on this branch — nothing to roll back")
        return

    revs, downs = set(), set()
    for name in git(a.repo, "ls-tree", "--name-only", f"{a.base}:{vdir}/").splitlines():
        if not name.endswith(".py"):
            continue
        src = git(a.repo, "show", f"{a.base}:{vdir}/{name}")
        r = REV.search(src)
        d = DOWN.search(src)
        if r:
            revs.add(r.group(1))
        if d:
            downs.update(re.findall(r"['\"]([0-9A-Za-z_]+)['\"]", d.group(1)))
    heads = sorted(revs - downs)
    if len(heads) != 1:
        sys.exit(f"the base has {len(heads)} heads ({', '.join(heads) or 'none'}) — cannot pick the revision to go back to")
    print(f"back to the base head {heads[0]} (the branch added {len(added)} revision(s))", flush=True)
    if not a.dry_run:
        subprocess.run([*cmd, heads[0]], cwd=a.repo, check=True)


if __name__ == "__main__":
    main()
