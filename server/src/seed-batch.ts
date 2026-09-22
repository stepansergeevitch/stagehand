// Django-shell seed steps (`… manage.py shell -c "<python>"`) run in ONE Django process per pass instead of one per
// step: every start of `manage.py shell` boots Django (10–30 s), and a pass has a teardown and a seed per scenario.
// The same wrapper dry-runs the steps at design time (each inside transaction.atomic() and rolled back), so a wrong
// import, model or field fails the design contract instead of blocking a 20-minute QA pass.

export interface DjangoShellCall {
    // The command up to and including `manage.py shell` (working directory, env assignments, `poetry run python …`).
    prefix: string;
    // The Python source the step passes to -c, with the shell's double-quote escapes removed.
    code: string;
}

// `cd backend && AWS_PROFILE=x poetry run python dualentry/manage.py shell -c "<code>"` → { prefix, code }; null for
// anything else (psql, curl, a script). The code must be the last thing on the line, in double quotes.
export const parseDjangoShellCall = (cmd: string): DjangoShellCall | null => {
    const m = /^([\s\S]*?\bmanage\.py\s+shell)\s+-c\s+"([\s\S]*)"\s*$/.exec(cmd.trim());
    if (!m) return null;
    const code = m[2]!.replace(/\\(["\\$`])/g, "$1");
    if (!code.trim()) return null;
    return { prefix: m[1]!.trim(), code };
};

export interface SeedItem {
    label: string;
    code: string;
}

// One unit of a seed plan: a batch of Django-shell steps that share a prefix, or a single plain shell step.
export type SeedUnit = { kind: "django"; prefix: string; items: Array<SeedItem & { cmd: string }> } | { kind: "plain"; label: string; cmd: string };

// Groups consecutive Django-shell steps with the same prefix into one unit, in order; other steps stay single.
export const planSeedUnits = (steps: Array<{ label: string; cmd: string }>): SeedUnit[] => {
    const units: SeedUnit[] = [];
    for (const s of steps) {
        const call = parseDjangoShellCall(s.cmd);
        const last = units[units.length - 1];
        if (call && last && last.kind === "django" && last.prefix === call.prefix) {
            last.items.push({ label: s.label, code: call.code, cmd: s.cmd });
        } else if (call) {
            units.push({ kind: "django", prefix: call.prefix, items: [{ label: s.label, code: call.code, cmd: s.cmd }] });
        } else {
            units.push({ kind: "plain", label: s.label, cmd: s.cmd });
        }
    }
    return units;
};

export const BEGIN_MARK = "@@STAGEHAND-SEED-BEGIN ";
export const END_MARK = "@@STAGEHAND-SEED-END ";

// The Python the batch runs: items come base64-encoded in STAGEHAND_SEEDS_B64, the mode ("run" | "dryrun") in
// STAGEHAND_SEED_MODE. Each item executes in its own globals; output is captured per item between markers, so the
// orchestrator can report every step as if it had run alone. A dry run wraps the item in transaction.atomic() and
// raises to roll it back. SystemExit(0) from a seed that ends with sys.exit() counts as success.
export const SEED_RUNNER_PY = [
    "import base64, contextlib, io, json, os, sys, traceback",
    "from django.db import transaction",
    "items = json.loads(base64.b64decode(os.environ['STAGEHAND_SEEDS_B64']).decode())",
    "mode = os.environ.get('STAGEHAND_SEED_MODE', 'run')",
    "class _Rollback(Exception):",
    "    pass",
    "for it in items:",
    "    buf = io.StringIO(); ok = True; err = ''",
    "    try:",
    "        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):",
    "            code = compile(it['code'], '<' + it['label'] + '>', 'exec')",
    "            if mode == 'dryrun':",
    "                try:",
    "                    with transaction.atomic():",
    "                        exec(code, {'__name__': '__main__'})",
    "                        raise _Rollback()",
    "                except _Rollback:",
    "                    pass",
    "            else:",
    "                exec(code, {'__name__': '__main__'})",
    "    except SystemExit as e:",
    "        if e.code not in (None, 0):",
    "            ok = False; err = 'SystemExit: ' + str(e.code)",
    "    except BaseException as e:",
    "        ok = False; err = ''.join(traceback.format_exception_only(type(e), e)).strip()",
    "        buf.write(''.join(traceback.format_exception(type(e), e, e.__traceback__))[-1500:])",
    "    sys.__stdout__.write(" + JSON.stringify(BEGIN_MARK) + " + it['label'] + '@@\\n')",
    "    sys.__stdout__.write(buf.getvalue().rstrip() + '\\n')",
    "    sys.__stdout__.write(" + JSON.stringify(END_MARK) + " + it['label'] + ' ' + ('OK' if ok else 'FAILED ' + err.replace('\\n', ' ')[:300]) + '@@\\n')",
    "    sys.__stdout__.flush()",
].join("\n");

// The shell command for a batch: the shared prefix with the runner passed through the environment (no quoting).
export const djangoBatchCommand = (prefix: string): string => `${prefix} -c "$STAGEHAND_SEED_RUNNER"`;

export const djangoBatchEnv = (items: SeedItem[], mode: "run" | "dryrun"): Record<string, string> => ({
    STAGEHAND_SEED_RUNNER: SEED_RUNNER_PY,
    STAGEHAND_SEEDS_B64: Buffer.from(JSON.stringify(items.map((i) => ({ label: i.label, code: i.code }))), "utf8").toString("base64"),
    STAGEHAND_SEED_MODE: mode,
});

export interface SeedItemResult {
    label: string;
    ok: boolean;
    output: string;
    error: string;
}

// Splits the batch's stdout back into one result per item. Items missing from the output (the process died before
// reaching them) are reported as failed with the process's last lines.
export const parseBatchOutput = (stdout: string, labels: string[]): SeedItemResult[] => {
    const out: SeedItemResult[] = [];
    const lines = stdout.split("\n");
    for (const label of labels) {
        const begin = lines.findIndex((l) => l === `${BEGIN_MARK}${label}@@`);
        const end = lines.findIndex((l, i) => i > begin && l.startsWith(`${END_MARK}${label} `));
        if (begin < 0 || end < 0) {
            out.push({ label, ok: false, output: "", error: `the seed process ended before this step ran: ${lines.filter((l) => l.trim() && !l.startsWith("@@STAGEHAND")).slice(-3).join(" ").slice(0, 300)}` });
            continue;
        }
        const status = lines[end]!.slice(END_MARK.length + label.length + 1).replace(/@@$/, "");
        const ok = status === "OK";
        out.push({ label, ok, output: lines.slice(begin + 1, end).join("\n").trim(), error: ok ? "" : status.replace(/^FAILED\s*/, "") });
    }
    return out;
};
