#!/usr/bin/env python3
"""Stagehand guard hook (PreToolUse, Bash). Standard for every environment; the values come from $STAGEHAND_RULES.

Blocks (exit 2, reason on stderr) git commits with a non-conforming message, commits/pushes/PR creation when the
environment forbids them, badly named branches, and history rewrites. Anything else passes (exit 0).
"""
import json
import os
import re
import shlex
import sys


def load_rules():
    path = os.environ.get("STAGEHAND_RULES")
    if not path or not os.path.exists(path):
        return {}
    with open(path) as f:
        return json.load(f)


def block(reason: str) -> None:
    sys.stderr.write(f"[stagehand guard] {reason}\n")
    sys.exit(2)


def commit_messages(argv):
    """Messages given with -m/--message (possibly several) or a -F/--file file."""
    out, i = [], 0
    while i < len(argv):
        a = argv[i]
        if a in ("-m", "--message") and i + 1 < len(argv):
            out.append(argv[i + 1]); i += 2; continue
        if a.startswith("--message="):
            out.append(a[len("--message="):]); i += 1; continue
        if a.startswith("-m") and len(a) > 2:
            out.append(a[2:]); i += 1; continue
        if a in ("-F", "--file") and i + 1 < len(argv):
            try:
                with open(argv[i + 1]) as f:
                    out.append(f.read())
            except OSError:
                out.append("")
            i += 2; continue
        i += 1
    return out


def check_segment(words, rules):
    if not words:
        return
    prog = words[0]
    if prog == "git" and len(words) > 1:
        sub = words[1]
        rest = words[2:]
        if sub == "commit":
            if not rules.get("allowCommit", True):
                block("commits are not allowed in this environment — leave the changes uncommitted and say so in your notes")
            if "--amend" in rest:
                block("history rewrite (--amend) is not allowed")
            msgs = commit_messages(rest)
            if not msgs and "--no-edit" not in rest:
                block("give the commit message inline with -m so it can be checked")
            pattern = rules.get("commitPattern") or ""
            forbid = rules.get("commitForbid") or []
            hint = rules.get("commitHint") or ""
            full = "\n".join(msgs)
            first_line = msgs[0].strip().split("\n")[0] if msgs else ""
            if pattern and not re.search(pattern, first_line):
                block(f"commit message '{first_line}' does not match {pattern}. {hint}")
            for f in forbid:
                if re.search(f, full, flags=re.MULTILINE | re.IGNORECASE):
                    block(f"commit message contains forbidden pattern {f!r}. {hint}")
        elif sub == "push":
            if not rules.get("allowPush", True) and "--dry-run" not in rest:
                block("pushing is not allowed in this environment")
            if any(a in rest for a in ("-f", "--force", "--force-with-lease")):
                block("force-push is not allowed")
        elif sub in ("rebase",) and any(a in rest for a in ("-i", "--interactive")):
            block("interactive rebase is not allowed")
        elif sub == "reset" and "--hard" in rest:
            block("git reset --hard is not allowed")
        elif sub in ("checkout", "switch", "branch"):
            name = None
            if sub == "checkout" and "-b" in rest:
                name = rest[rest.index("-b") + 1] if rest.index("-b") + 1 < len(rest) else None
            elif sub == "switch" and "-c" in rest:
                name = rest[rest.index("-c") + 1] if rest.index("-c") + 1 < len(rest) else None
            elif sub == "branch":
                positional = [a for a in rest if not a.startswith("-")]
                if positional and not any(a in rest for a in ("-d", "-D", "--delete", "-m", "--move", "--list", "-a", "-r", "--show-current")):
                    name = positional[0]
            if name:
                prefix = rules.get("branchPrefix") or ""
                pattern = rules.get("branchPattern") or ""
                bare = name[len(prefix):] if prefix and name.startswith(prefix) else name
                if prefix and not name.startswith(prefix):
                    block(f"branch '{name}' must start with '{prefix}'. {rules.get('branchHint') or ''}")
                if pattern and not re.search(pattern, bare):
                    block(f"branch '{name}' does not match {pattern} after the prefix. {rules.get('branchHint') or ''}")
    elif prog == "gh" and len(words) > 2 and words[1] == "pr" and words[2] in ("create", "merge"):
        if not rules.get("allowPrCreate", True):
            block("creating or merging pull requests is not allowed in this environment — draft only; the human creates it")


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    if payload.get("tool_name") not in (None, "Bash"):
        sys.exit(0)
    command = (payload.get("tool_input") or {}).get("command") or ""
    if not command.strip():
        sys.exit(0)
    rules = load_rules()
    # Split on shell separators so `cd x && git commit -m ...` is checked per segment.
    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        tokens = command.split()
    segment = []
    for tok in tokens + ["&&"]:
        if tok in ("&&", "||", ";", "|"):
            check_segment(segment, rules)
            segment = []
        else:
            segment.append(tok)
    sys.exit(0)


if __name__ == "__main__":
    main()
