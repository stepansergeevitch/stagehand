import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { EnvRow } from "./db.js";
import { envRepos, repoPaths } from "./git.js";

// Per-environment working rules. The same standard skills + one guard hook are generated for every env; only the values differ.
export const Rules = z.object({
    commitPattern: z.string().default("^[^\\n]{1,72}$"),
    commitForbid: z.array(z.string()).default(["Co-Authored-By", "^(feat|fix|chore|docs|refactor|test|style|perf|build|ci)(\\(.*\\))?!?:"]),
    commitHint: z.string().default("Short one-line message in plain words, no conventional-commit prefix, no Co-Authored-By trailer."),
    branchPattern: z.string().default("^[a-z0-9][a-z0-9.-]*$"),
    branchHint: z.string().default("lowercase ticket id, a hyphen, then a short kebab-case slug of the ticket title (e.g. eng-21986-fix-recoverables-ws)."),
    allowCommit: z.boolean().default(true),
    allowPush: z.boolean().default(true),
    allowPrCreate: z.boolean().default(true),
    prRules: z.string().default(
        [
            "Description = one or two plain sentences in product words: what the change adds/changes/fixes. At most one or two code identifiers in backticks (the main class or component) — never a list of call sites, methods, files or tests. A companion PR in another repo gets one sentence with its link.",
            "No sub-headings, tables, decision essays, rationale paragraphs, test lists, notes for reviewer, out-of-scope or follow-up sections. A decision the ticket explicitly asks to record gets ONE short sentence.",
            "Checkboxes: exactly one Type of change (refactors and data-layer work are Internal Update), the applicable Development Setup items, one Risk Level, Regular Deploy unless the diff needs otherwise; Mobile Impact one tick (reason line only for 'unaffected — reason below'); Reviewer Checklist untouched except 'covered with tests'.",
            "QA Instructions: leave the template's `1. ` line exactly as it is, empty.",
        ].join("\n"),
    ),
    prTemplatePath: z.string().nullable().default(null),
});
export type Rules = z.infer<typeof Rules>;

export const rulesOf = (env: Pick<EnvRow, "rules">): Rules => {
    try {
        return Rules.parse(env.rules ? JSON.parse(env.rules) : {});
    } catch {
        return Rules.parse({});
    }
};

const STAGEHAND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const GUARD_HOOK = join(STAGEHAND_ROOT, "hooks", "guard.py");

// ---------- PR template auto-detection ----------

const PR_TEMPLATE_CANDIDATES = [
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md",
    "PULL_REQUEST_TEMPLATE.md",
    "docs/pull_request_template.md",
    "docs/PULL_REQUEST_TEMPLATE.md",
];

export const detectPrTemplate = (repoPath: string): string | null => {
    for (const rel of PR_TEMPLATE_CANDIDATES) if (existsSync(join(repoPath, rel))) return rel;
    for (const dir of [".github/PULL_REQUEST_TEMPLATE", "docs/PULL_REQUEST_TEMPLATE"]) {
        const full = join(repoPath, dir);
        if (!existsSync(full)) continue;
        const md = readdirSync(full).filter((f) => f.toLowerCase().endsWith(".md")).sort()[0];
        if (md) return `${dir}/${md}`;
    }
    return null;
};

// One entry per checkout the env owns (the repo itself, or each sub-repo).
export const prTemplates = (env: EnvRow): Array<{ dir: string; path: string | null; overridden: boolean }> => {
    const rules = rulesOf(env);
    const subs = envRepos(env);
    const dirs = subs.length ? subs : ["."];
    return dirs.map((dir, i) => {
        const repo = repoPaths(env)[i]!;
        const detected = rules.prTemplatePath && existsSync(join(repo, rules.prTemplatePath)) ? rules.prTemplatePath : detectPrTemplate(repo);
        return { dir, path: detected, overridden: !!rules.prTemplatePath };
    });
};

// ---------- materialization: hook settings + skills for one run ----------

export interface Materialized {
    settingsPath: string;
    systemPrompt: string;
}

const skillCommit = (r: Rules): string => `---
name: git-commit
description: How to write a commit in this environment (Stagehand rule; enforced by a hook on every git commit). Use before any git commit.
---

# Committing in this environment

${r.allowCommit ? "Commits are allowed." : "**Commits are NOT allowed here.** Leave your changes uncommitted (staged is fine) and say so in your notes; the human commits."}

- Message must match \`${r.commitPattern}\`. ${r.commitHint}
${r.commitForbid.length ? `- Never include: ${r.commitForbid.map((f) => `\`${f}\``).join(", ")}.` : ""}
- Commit in small steps. Never rewrite history (\`--amend\`, \`rebase -i\`, \`reset --hard\`).
- ${r.allowPush ? "Pushing the task branch is allowed when a stage asks for it." : "**Never push.** The orchestrator or the human pushes."}

The guard hook rejects a \`git commit\` that breaks these rules and tells you why; fix the message and commit again.
`;

const skillBranch = (r: Rules, prefix: string | null): string => `---
name: git-branch
description: Branch naming rule for this environment (Stagehand rule; enforced by a hook on git checkout -b / switch -c). Use when creating or naming a branch.
---

# Branch names in this environment

- Format: ${prefix ? `\`${prefix}<name>\` where \`<name>\`` : "the name"} must match \`${r.branchPattern}\`. ${r.branchHint}
${prefix ? `- The prefix \`${prefix}\` is added by the orchestrator; when you propose a name, propose only the part after it.` : ""}
- Never work on or push to the base branch.
`;

const skillPr = (r: Rules, templates: Array<{ dir: string; path: string | null }>): string => `---
name: pr-description
description: How pull request titles and descriptions are written in this environment (Stagehand rule). Use when drafting or editing a PR.
---

# Pull requests in this environment

${r.allowPrCreate ? "Creating the PR is done by the orchestrator after the human approves the draft." : "**Do not create pull requests.** Draft only; the human creates the PR."}

Title: \`<TICKET-ID> <imperative phrase>\`, under 70 characters, no adjectives.

${r.prRules}

Template${templates.length > 1 ? "s" : ""}: ${templates.map((t) => `${t.dir === "." ? "" : `${t.dir}: `}${t.path ?? "none (write the description only)"}`).join("; ")}.
`;

const guardSettings = (rulesPath: string): string =>
    JSON.stringify(
        {
            hooks: {
                PreToolUse: [
                    {
                        matcher: "Bash",
                        hooks: [{ type: "command", command: `STAGEHAND_RULES=${JSON.stringify(rulesPath)} python3 ${JSON.stringify(GUARD_HOOK)}` }],
                    },
                ],
            },
        },
        null,
        2,
    );

// Writes ~/.stagehand/envs/<env>/{rules.json,settings.json} and the three skills into <worktree>/.claude/skills (git-excluded).
export const materializeRules = (env: EnvRow, worktree: string | null, dataDir: string): Materialized => {
    const rules = rulesOf(env);
    const dir = join(dataDir, "envs", env.id);
    mkdirSync(dir, { recursive: true });
    const rulesPath = join(dir, "rules.json");
    writeFileSync(rulesPath, JSON.stringify({ ...rules, branchPrefix: env.branch_prefix ?? "" }, null, 2));
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, guardSettings(rulesPath));

    const templates = prTemplates(env);
    if (worktree && existsSync(worktree)) {
        const skillsDir = join(worktree, ".claude", "skills");
        const files: Record<string, string> = {
            "git-commit": skillCommit(rules),
            "git-branch": skillBranch(rules, env.branch_prefix),
            "pr-description": skillPr(rules, templates),
        };
        for (const [name, body] of Object.entries(files)) {
            mkdirSync(join(skillsDir, name), { recursive: true });
            writeFileSync(join(skillsDir, name, "SKILL.md"), body);
        }
        // Keep the generated skills out of git in every checkout the worktree contains.
        const checkouts = envRepos(env).length ? envRepos(env).map((d) => join(worktree, d)) : [worktree];
        for (const c of checkouts) excludeFromGit(c, Object.keys(files).map((n) => `.claude/skills/${n}/`));
    }

    const systemPrompt = [
        "Environment rules (a guard hook enforces the git ones; the /git-commit, /git-branch and /pr-description skills explain them):",
        `- commits: ${rules.allowCommit ? `allowed; message must match ${rules.commitPattern}; ${rules.commitHint}` : "NOT allowed — leave changes uncommitted and say so"}`,
        `- push: ${rules.allowPush ? "allowed when a stage asks for it" : "NOT allowed"}`,
        `- pull requests: ${rules.allowPrCreate ? "created by the orchestrator after human approval" : "never created by you; draft only"}`,
        `- branch names: ${env.branch_prefix ? `prefix ${env.branch_prefix} + ` : ""}${rules.branchPattern}`,
    ].join("\n");
    return { settingsPath, systemPrompt };
};

const excludeFromGit = (checkout: string, patterns: string[]): void => {
    try {
        const gitDir = readGitDir(checkout);
        if (!gitDir) return;
        const infoDir = join(gitDir, "info");
        mkdirSync(infoDir, { recursive: true });
        const file = join(infoDir, "exclude");
        const current = existsSync(file) ? readFileSync(file, "utf8") : "";
        const missing = patterns.filter((p) => !current.split("\n").includes(p));
        if (missing.length) writeFileSync(file, `${current.replace(/\n?$/, "\n")}${missing.join("\n")}\n`);
    } catch {
        /* not a git checkout — nothing to exclude */
    }
};

// Resolves the common git dir for a checkout or a linked worktree (".git" file → "gitdir: …/.git/worktrees/x"; common dir is its parent's parent).
const readGitDir = (checkout: string): string | null => {
    const dotGit = join(checkout, ".git");
    if (!existsSync(dotGit)) return null;
    if (statSync(dotGit).isDirectory()) return dotGit;
    const stat = readFileSync(dotGit, "utf8").trim();
    if (stat.startsWith("gitdir:")) {
        const wtGit = stat.slice(7).trim();
        return wtGit.includes("/worktrees/") ? wtGit.split("/worktrees/")[0]! : wtGit;
    }
    return null;
};
