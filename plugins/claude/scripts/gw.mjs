#!/usr/bin/env node
// Groundwork by Stackrift - deterministic commands.
// help | version | doctor | status | list | cost | stats | verify | context | config | classify | refinement | ready | answers | refine-comment | new-questions | summary
// | diff | fingerprint | snapshot | check-scope | check-refined | check-context | check-plan | check-explore | check-gate | check-build
// | groups | run-tests | review-input | check-review | deliver-input | check-deliver | deliver | pr-status | feedback | cleanup | check-tune | tune-apply | tune-deliver
// | worktree | task | history | refs
// No dependencies. This script runs on Node.js 18+ (also in CI, from .groundwork/bin/gw.mjs); `doctor` asks for 20.19+ because
// OpenSpec needs it.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { homedir, tmpdir } from "node:os";

const GW_VERSION = "0.2.3";

const STAGES = ["explore", "plan", "build", "review", "deliver"];
const CURRENT_VALUES_V1 = [
  "explore", "plan", "awaiting-approval", "build", "review",
  // awaiting-delivery-approval: a format 1 run at deliver or later is delivered through gate 2 (phase 5 ruling R6), and deliver
  // commits run.md in that state, so CI's verify must accept it.
  "deliver", "awaiting-delivery-approval", "awaiting-merge", "archive", "done", "cancelled",
];
const CURRENT_VALUES_V2 = [
  "explore", "plan", "awaiting-approval", "build", "review",
  "deliver", "awaiting-delivery-approval", "awaiting-merge", "done", "cancelled",
];
const HANDOFFS = { explore: "explore.md", build: "build.md", review: "review.md", deliver: "deliver.md" };

// ---------- arguments ----------

const argv = process.argv.slice(2);
const command = (argv[0] || "help").toLowerCase();
const rest = argv.slice(1);
const flags = new Set(rest.filter((a) => a.startsWith("--") && !a.includes("=")));
const opt = (name) => {
  const i = rest.indexOf(`--${name}`);
  if (i >= 0 && rest[i + 1] && !rest[i + 1].startsWith("--")) return rest[i + 1];
  const eq = rest.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.split("=").slice(1).join("=") : undefined;
};
const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--change", "--root", "--gate", "--expect", "--refinement", "--audit", "--kind", "--ref", "--max", "--label", "--level", "--base", "--round", "--source", "--text", "--text-file"].includes(rest[i - 1])));
const asJson = flags.has("--json");

// ---------- helpers ----------

// On Windows, tools such as openspec are .cmd shims and need cmd.exe. An args array together with shell:true triggers Node's DEP0190,
// so the command line is built here: every argument is double-quoted, embedded quotes doubled. Callers pass fixed arguments.
// Every git call is made with fsmonitor off and hooks pointed at an empty directory, so nothing configured in .git/config
// (which a stage may have rewritten) can run while we inspect the worktree. core.hooksPath to an empty temp folder is the portable
// way to disable hooks: it works the same on Windows, macOS and Linux. The folder is created on the first git call (never for help or version) and removed on exit.
let GIT_SAFE_FLAGS = null;
function gitSafeFlags() {
  if (!GIT_SAFE_FLAGS) {
    let dir;
    try { dir = fs.mkdtempSync(path.join(tmpdir(), "gw-nohooks-")); } catch (e) { throw new Error(`cannot create a temporary folder in ${tmpdir()}: ${e.code || e.message}`); }
    process.on("exit", () => { try { fs.rmdirSync(dir); } catch {} });
    GIT_SAFE_FLAGS = ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${dir.split("\\").join("/")}`];
  }
  return GIT_SAFE_FLAGS;
}
const gitArgs = (args) => [...gitSafeFlags(), ...args];

function run(cmd, args, cwd, { noHooksDir = false } = {}) {
  if (cmd === "git") args = noHooksDir ? ["-c", "core.fsmonitor=false", ...args] : gitArgs(args);
  const opts = { cwd, encoding: "utf8" };
  let r;
  if (process.platform === "win32") {
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    r = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${[cmd, ...args].map(q).join(" ")}"`], { ...opts, windowsVerbatimArguments: true });
  } else r = spawnSync(cmd, args, opts);
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function repoRoot() {
  const given = opt("root");
  if (given) return path.resolve(given);
  // rev-parse runs no hooks, so it needs no hooks folder; this keeps module load free of temp-folder writes.
  const r = run("git", ["rev-parse", "--show-toplevel"], process.cwd(), { noHooksDir: true });
  return r.ok && r.out ? path.resolve(r.out) : process.cwd();
}

const ROOT = repoRoot();
const GW_DIR = path.join(ROOT, ".groundwork");
const CHANGES_DIR = path.join(GW_DIR, "changes");
const REF_DIR = path.join(GW_DIR, "refinements");

const exists = (p) => fs.existsSync(p);
const read = (p) => (exists(p) ? fs.readFileSync(p, "utf8") : null);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/") || ".";
const approxTokens = (text) => Math.ceil(text.length / 4);

const DEFAULT_KEY_PATTERNS = {
  jira: "^[A-Z][A-Z0-9]+-[0-9]+$",
  github: "^([\\w.-]+/[\\w.-]+)?#[0-9]+$",
  "azure-devops": "^(AB)?#[0-9]+$",
};

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Objects merge key by key; arrays and scalars from the override replace the base.
function deepMerge(base, over) {
  if (over === undefined || (over === null && isPlainObject(base))) return base;
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
  return out;
}

function configDefaults() {
  return {
    version: 2,
    models: {
      intake: "haiku", refine: "sonnet", explore: "haiku", plan: "opus", planFast: "sonnet",
      build: "sonnet", review: "opus", securityReview: "opus", deliver: "haiku", auditor: "sonnet",
    },
    tracker: { type: "none" },
    refine: { required: false, readyMarker: { type: "label", value: "ready" } },
    context: { trustedDomains: [] },
    codeGraph: { type: "none" },
    commands: { unit: "", integration: "", e2e: "", lint: "", timeoutMinutes: 30 },
    build: { parallel: false, maxBuilders: 3, groupThreshold: 3 },
    review: { maxBuildReviewLoops: 2 },
    deliver: { openPullRequest: false, requireApproval: true, codeHost: "github", baseBranch: "main" },
    contextBudgetTokens: 3000,
    contextFiles: ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md"],
    pricing: {},
  };
}

// Version 1 (or unversioned) -> version 2: jira.keyPattern becomes tracker.
function migrateConfig(user) {
  if (!isPlainObject(user) || (user.version !== undefined && user.version !== 1)) return { user, from: undefined };
  const { jira, ...restUser } = user;
  const out = { ...restUser, version: 2 };
  if (!out.tracker) out.tracker = { type: "jira", ...(jira && jira.keyPattern ? { keyPattern: jira.keyPattern } : {}) };
  return { user: out, from: 1 };
}

function finishConfig(cfg) {
  if (cfg.tracker && !cfg.tracker.keyPattern && DEFAULT_KEY_PATTERNS[cfg.tracker.type]) cfg.tracker.keyPattern = DEFAULT_KEY_PATTERNS[cfg.tracker.type];
  return cfg;
}

function loadConfig() {
  const defaults = configDefaults();
  const raw = read(path.join(GW_DIR, "config.json"));
  if (!raw) return { ...finishConfig(defaults), _missing: true };
  let user;
  try {
    user = JSON.parse(raw);
  } catch (e) {
    return { ...finishConfig(defaults), _error: `config.json is not valid JSON: ${e.message}` };
  }
  if (!isPlainObject(user)) return { ...finishConfig(defaults), _error: "config.json must be a JSON object" };
  const m = migrateConfig(user);
  const cfg = finishConfig(deepMerge(defaults, m.user));
  if (m.from) cfg._migratedFrom = m.from;
  if (isPlainObject(cfg.tracker) && cfg.tracker.keyPattern !== undefined) {
    try { new RegExp(cfg.tracker.keyPattern); } catch (e) { cfg._error = `tracker.keyPattern is not a valid regular expression: ${e.message}`; }
  }
  return cfg;
}

function headerValue(text, key) {
  const m = text.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "mi"));
  return m ? m[1].trim() : null;
}

function tableRows(text, heading) {
  const start = text.search(new RegExp(`^##\\s+${heading}\\s*$`, "mi"));
  if (start < 0) return [];
  const after = text.slice(start).split(/\r?\n/).slice(1);
  const rows = [];
  for (const line of after) {
    if (/^##\s/.test(line)) break;
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^-+$/.test(c) || c === "")) continue;
    rows.push(cells);
  }
  return rows.slice(1); // drop header row
}

function parseRun(change) {
  const file = path.join(CHANGES_DIR, change, "run.md");
  const text = read(file);
  if (text === null) return null;
  const stages = tableRows(text, "Stages").map((c) => ({
    stage: (c[0] || "").toLowerCase(), status: (c[1] || "").toLowerCase(), agent: c[2] || "",
    model: c[3] || "", tokens: c[4] || "", started: c[5] || "", finished: c[6] || "",
  }));
  const approvals = tableRows(text, "Approvals").map((c) => ({
    gate: (c[0] || "").toLowerCase(), decision: (c[1] || "").toLowerCase(), by: c[2] || "", date: c[3] || "", fingerprint: c[4] || "",
  }));
  const prRaw = headerValue(text, "PR");
  const sensitiveRaw = (headerValue(text, "Sensitive") || "").toLowerCase();
  return {
    change, file, text,
    format: Number(headerValue(text, "Format")) || 1,
    sensitive: sensitiveRaw === "yes" || sensitiveRaw === "no" ? sensitiveRaw : null,
    flag: (headerValue(text, "Flag") || "none").toLowerCase(),
    refs: (() => { const v = (headerValue(text, "Refs") || "").trim(); return !v || v.toLowerCase() === "none" ? [] : v.split(/\s+/); })(),
    pr: prRaw && prRaw.toLowerCase() !== "none" ? prRaw : null,
    source: headerValue(text, "Source"),
    path: (headerValue(text, "Path") || "").toLowerCase(),
    current: (headerValue(text, "Current") || "").toLowerCase(),
    created: headerValue(text, "Created"),
    updated: headerValue(text, "Updated"),
    stages, approvals,
  };
}

function listChanges() {
  if (!exists(CHANGES_DIR)) return [];
  return fs.readdirSync(CHANGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function nextStep(r) {
  switch (r.current) {
    case "awaiting-approval":
      if (r.format >= 2 && r.stages.some((s) => s.stage === "build")) {
        return `The build stopped here. /groundwork resume ${r.change} runs check-gate and continues the build if the plan still matches its approval; /groundwork resume ${r.change} "<feedback>" re-plans; /groundwork approve ${r.change} approves a changed plan`;
      }
      return `Review the plan, then /groundwork approve ${r.change}  (add --accept-open-questions if the plan lists open questions), or /groundwork resume ${r.change} "<feedback>"`;
    case "awaiting-delivery-approval": {
      // With deliver.openPullRequest false (the default), deliver commits and prints the push and pull request commands.
      const publish = loadConfig().deliver?.openPullRequest === true ? "commit, push and open the pull request" : "commit and print the push and pull request commands";
      return `Open delivery-summary.html, then /groundwork approve ${r.change} to ${publish}, /groundwork resume ${r.change} "<feedback>" to change the text or the code, or /groundwork cancel ${r.change}`;
    }
    case "awaiting-merge":
      // status never calls the code host (offline and fast); resume checks the pull request.
      return `${r.pr ? `Pull request ${r.pr}. ` : ""}Run /groundwork resume ${r.change} to check for feedback or a merge`;
    case "done":
    case "cancelled":
      return "None";
    default:
      return `Stage "${r.current}" is in progress or was interrupted: /groundwork resume ${r.change}`;
  }
}

function openspecChangeDir(change) {
  const live = path.join(ROOT, "openspec", "changes", change);
  if (exists(live)) return live;
  const archive = path.join(ROOT, "openspec", "changes", "archive");
  if (exists(archive)) {
    const re = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${change.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
    const hit = fs.readdirSync(archive).find((d) => re.test(d));
    if (hit) return path.join(archive, hit);
  }
  return null;
}

// Where a change's OpenSpec folder is now (ruling R12): openspec/changes/<change>/, or its archive folder once step 5 archived it
// before delivery; null when there is none. Agents read this path from the input packs instead of assuming the live folder.
function openspecChangeRel(change) {
  const dir = openspecChangeDir(change);
  return dir ? `${rel(dir)}/` : null;
}

function walk(dir, out = [], limit = 20000) {
  if (out.length >= limit || !exists(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", "bin", "obj", "dist", "build", ".venv", "target"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, limit);
    else out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

function print(obj, text) {
  if (asJson) console.log(JSON.stringify(obj, null, 2));
  else console.log(text);
}

// ---------- summary ----------

const htmlEscape = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Opens a file with the platform's default handler. No shell is involved, so the path is never re-parsed.
// Windows uses explorer.exe, which exits 1 even on success, so success means the spawn itself did not fail.
function openFile(absPath) {
  try {
    const [cmd, args] = process.platform === "win32" ? ["explorer.exe", [absPath]] : process.platform === "darwin" ? ["open", [absPath]] : ["xdg-open", [absPath]];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    let failed = !child.pid;
    child.on("error", () => { failed = true; });
    child.unref();
    return !failed;
  } catch { return false; }
}

function renderRefinementSummary(key) {
  const dir = path.join(REF_DIR, key);
  const ticket = read(path.join(dir, "ticket.md")) || "";
  const ref = parseRefinement(key) || { key, source: "", tracker: "", status: "drafting", questions: [] };
  let src = null;
  try { src = readSource(key); } catch { src = null; }
  const problems = readyProblems(key);
  const ready = ref.status === "ready";
  const e = htmlEscape;
  const title = (ticket.split(/\r?\n/).find((l) => /^#\s/.test(l)) || "").replace(/^#\s+/, "").trim();
  const statusText = ready ? "ready" : ref.status === "waiting-for-answers" ? "waiting for the product owner" : "drafting";
  const tracker = (src && src.tracker) || ref.tracker || "none";
  const url = src && src.url ? String(src.url) : "";
  const link = /^https?:\/\//i.test(url) ? `<a href="${e(url)}">${e(url)}</a>` : url ? e(url) : "";
  const acs = acceptanceCriteria(ticket);
  const section = (h) => (markdownSection(ticket, h) || "").trim();
  const text = (t) => t ? `<p>${e(t).replace(/\n/g, "<br>")}</p>` : "<p class=\"muted\">None.</p>";
  const openQs = ref.questions.filter((q) => q.status === "open");
  const attention = [];
  for (const owner of ["you", "product-owner"]) for (const q of openQs.filter((x) => x.owner === owner)) attention.push(`Open question for ${owner === "you" ? "you" : "the product owner"}: ${q.id} ${q.question}`);
  for (const q of openQs.filter((x) => x.owner !== "you" && x.owner !== "product-owner")) attention.push(`Open question: ${q.id} ${q.question}`);
  attention.push(...problems.filter((p) => !p.startsWith("open question in refinement.md")));
  const rules = [
    ["Acceptance criteria present and numbered", acs.length > 0 && acs.every((c, i) => c.id === `AC${i + 1}`)],
    ["Every criterion has WHEN and THEN", acs.length > 0 && acs.every((c) => c.when && c.then)],
    ["No open questions", !openQs.length && !problems.some((p) => /^open questions listed/.test(p))],
    ["Out of scope listed", !problems.includes("out of scope is empty")],
  ];
  const next = ready ? `/groundwork start ${ref.source && ref.source !== "prompt" ? ref.source : key}` : `/groundwork refine ${key}`;
  const qrows = ref.questions.map((q) => `<tr><td>${e(q.id)}</td><td>${e(q.owner)}</td><td>${e(q.question)}</td><td>${e(q.answer)}</td><td>${e(q.answeredBy)}</td><td>${e(q.status)}</td></tr>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Refinement ${e(key)}</title>
<style>
${SUMMARY_CSS}
</style></head><body>
<header><h1>${e(title || key)}</h1>
<p class="muted">${e(key)} &middot; Status: <strong>${e(statusText)}</strong> &middot; Tracker: ${e(tracker)}${link ? " &middot; Ticket: " + link : ""}</p></header>
${attention.length ? `<section class="attention"><h2>Needs attention</h2><ul>${attention.map((a) => `<li>${e(a)}</li>`).join("")}</ul></section>` : ""}
<section><h2>Definition of Ready</h2><ul>${rules.map(([n, ok]) => `<li class="${ok ? "ok" : "bad"}">${ok ? "Passed" : "Failed"}: ${e(n)}</li>`).join("")}</ul></section>
<section><h2>Description</h2>${text(section("Description"))}</section>
<section><h2>Acceptance criteria</h2>${acs.length ? `<table><tr><th>ID</th><th>WHEN</th><th>THEN</th></tr>${acs.map((c) => `<tr><td>${e(c.id)}</td><td>${e(c.when)}</td><td>${e(c.then)}</td></tr>`).join("")}</table>` : '<p class="muted">None.</p>'}</section>
<section><h2>Out of scope</h2>${text(section("Out of scope"))}<h2>Dependencies</h2>${text(section("Dependencies"))}</section>
<section><h2>Questions</h2>${ref.questions.length ? `<table><tr><th>ID</th><th>Owner</th><th>Question</th><th>Answer</th><th>Answered by</th><th>Status</th></tr>${qrows}</table>` : '<p class="muted">None.</p>'}</section>
<section><h2>Next step</h2><p><code>${e(next)}</code></p></section>
</body></html>
`;
}

// Escaped paragraphs and bullet lists only. Nothing from the source text is ever passed through as markup.
function plainBlocks(text) {
  const e = htmlEscape;
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n").map((l) => l.trim());
  let html = "", para = [], list = [];
  const flush = () => {
    if (para.length) html += `<p>${para.map(e).join("<br>")}</p>`;
    if (list.length) html += `<ul>${list.map((i) => `<li>${e(i)}</li>`).join("")}</ul>`;
    para = []; list = [];
  };
  for (const l of lines) {
    const m = /^[-*+]\s+(.*)$/.exec(l);
    if (!l) flush();
    else if (m) { if (para.length) flush(); list.push(m[1]); }
    else { if (list.length) flush(); para.push(l); }
  }
  flush();
  return html || "<p class=\"muted\">None.</p>";
}

const SUMMARY_CSS = `:root{--bg:#fff;--fg:#1c1f24;--muted:#5b6470;--line:#d6dae0;--ok:#146c2e;--bad:#b3261e;--warn:#fdf3d8}
@media (prefers-color-scheme:dark){:root{--bg:#14171b;--fg:#e6e8eb;--muted:#9aa3ae;--line:#323840;--ok:#5fd07f;--bad:#ff8a80;--warn:#3a3217}}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;max-width:52rem;margin:0 auto;padding:1rem}
h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1.1rem;margin:1.5rem 0 .5rem;border-bottom:1px solid var(--line)}
.muted{color:var(--muted)}.attention{background:var(--warn);padding:.5rem 1rem;border-radius:4px}
.ok{color:var(--ok)}.bad{color:var(--bad)}
table{border-collapse:collapse;width:100%}th,td{border:1px solid var(--line);padding:.25rem .5rem;text-align:left;vertical-align:top}
a{color:inherit}code{font-family:ui-monospace,monospace}`;

function renderPlanSummary(change) {
  const e = htmlEscape;
  const run = parseRun(change);
  const { problems, openQuestions } = planProblems(change);
  const base = path.join(CHANGES_DIR, change);
  const task = read(path.join(base, "task.md")) || "";
  const source = ((/^Source:[ \t]*(.*)$/m.exec(task.slice(0, 2000)) || [])[1] || "").trim() || "unknown";
  const summary = read(planBriefPath(base)) || "";
  const section = (h) => markdownSection(summary, h);
  const acs = taskAcs(change);
  const fast = run.path === "fast";
  const dir = fast ? null : openspecChangeDir(change);
  const reqs = dir ? specRequirements(dir) : [];
  const tests = fast ? fastTests(read(path.join(base, "plan.md")) || "") : [];
  const coverOf = (id) => fast
    ? tests.filter((t) => t.covers.includes(id)).map((t) => t.raw.replace(/^[-*]\s+/, ""))
    : reqs.filter((r) => r.covers !== null && acIdsIn(r.covers).includes(id)).map((r) => r.name);
  const counts = Object.fromEntries(PLAN_LEVELS.map((l) => [l, 0]));
  if (fast) for (const t of tests) { if (t.level) counts[t.level]++; }
  else for (const r of reqs) for (const s of r.scenarios) { const l = (s.level || "").toLowerCase(); if (l in counts) counts[l]++; }
  const files = [rel(path.join(base, "task.md")), rel(planBriefPath(base))];
  if (fast) files.push(rel(path.join(base, "plan.md")));
  else if (dir) {
    for (const f of ["proposal.md", "design.md", "tasks.md"]) if (exists(path.join(dir, f))) files.push(rel(path.join(dir, f)));
    files.push(...walk(path.join(dir, "specs")).filter((f) => path.basename(f) === "spec.md").sort().map(rel));
  }
  const attention = [...problems, ...openQuestions.map((q) => `Open question: ${q}`)];
  const clean = !problems.length && !openQuestions.length;
  const next = clean ? `/groundwork approve ${change}` : `/groundwork resume ${change} "<answers>"\nor /groundwork approve ${change} --accept-open-questions`;
  const acRows = acs.map((a) => {
    const cov = coverOf(a.id);
    return `<tr><td>${e(a.id)}</td><td>${e(a.text).replace(/\n/g, "<br>")}</td><td>${cov.length ? `<ul>${cov.map((c) => `<li>${e(c)}</li>`).join("")}</ul>` : '<span class="bad">not covered</span>'}</td></tr>`;
  }).join("");
  const sens = run.sensitive || "unknown";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plan ${e(change)}</title>
<style>
:root{--bg:#fff;--fg:#1c1f24;--muted:#5b6470;--line:#d6dae0;--ok:#146c2e;--bad:#b3261e;--warn:#fdf3d8}
@media (prefers-color-scheme:dark){:root{--bg:#14171b;--fg:#e6e8eb;--muted:#9aa3ae;--line:#323840;--ok:#5fd07f;--bad:#ff8a80;--warn:#3a3217}}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;max-width:52rem;margin:0 auto;padding:1rem}
h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1.1rem;margin:1.5rem 0 .5rem;border-bottom:1px solid var(--line)}
.muted{color:var(--muted)}.attention{background:var(--warn);padding:.5rem 1rem;border-radius:4px}
.ok{color:var(--ok)}.bad{color:var(--bad)}
table{border-collapse:collapse;width:100%}th,td{border:1px solid var(--line);padding:.25rem .5rem;text-align:left;vertical-align:top}
a{color:inherit}code,pre{font-family:ui-monospace,monospace}pre{white-space:pre-wrap;margin:0}
</style></head><body>
<header><h1>${e(change)}</h1>
<p class="muted">Path: <strong>${e(run.path || "unknown")}</strong> &middot; Source: ${e(source)} &middot; Sensitive: <strong>${e(sens)}</strong></p></header>
${attention.length ? `<section class="attention"><h2>Needs attention</h2><ul>${attention.map((a) => `<li>${e(a)}</li>`).join("")}</ul></section>` : ""}
<section><h2>Why</h2>${plainBlocks(section("Why"))}<h2>What changes</h2>${plainBlocks(section("What changes"))}</section>
<section><h2>Acceptance criteria</h2>${acs.length ? `<table><tr><th>ID</th><th>Criterion</th><th>Covered by</th></tr>${acRows}</table>` : '<p class="muted">None.</p>'}</section>
<section><h2>Tests by level</h2><table><tr><th>Level</th><th>${fast ? "Test lines" : "Scenarios"}</th></tr>${PLAN_LEVELS.map((l) => `<tr><td>${e(l)}</td><td>${counts[l]}</td></tr>`).join("")}</table></section>
<section><h2>Risks</h2>${plainBlocks(section("Risks"))}</section>
<section><h2>Plan files</h2><ul>${files.map((f) => `<li><code>${e(f)}</code></li>`).join("")}</ul></section>
<section><h2>Next step</h2><pre><code>${e(next)}</code></pre></section>
</body></html>
`;
}

function cmdSummary() {
  const usage = "Usage: summary --refinement <key> [--no-open] [--json]\n       summary <change> --gate plan|deliver [--no-open] [--json]";
  const gate = opt("gate");
  if (opt("refinement") === undefined && (positional[0] || gate)) return cmdPlanSummary(usage, gate);
  const key = opt("refinement");
  if (!key || !validRefinementKey(key)) {
    console.error(usage + (key ? "  (key: lowercase letters, digits and hyphens)" : ""));
    process.exitCode = 2;
    return;
  }
  if (read(path.join(REF_DIR, key, "ticket.md")) === null) {
    const msg = `no ticket.md for refinement "${key}"`;
    print({ error: msg }, msg);
    process.exitCode = 1;
    return;
  }
  const rel = path.posix.join(".groundwork", "refinements", key, "refinement-summary.html");
  const abs = path.join(REF_DIR, key, "refinement-summary.html");
  fs.writeFileSync(abs, renderRefinementSummary(key));
  const opened = flags.has("--no-open") ? false : openFile(abs);
  print({ path: rel, opened }, `${rel}${opened ? " (opened)" : ""}`);
}

function cmdPlanSummary(usage, gate) {
  const change = positional[0];
  if ((gate !== "plan" && gate !== "deliver") || !change || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(change) || change.includes("..")) {
    console.error(usage + (gate && gate !== "plan" && gate !== "deliver" ? `  (unknown gate "${gate}")` : ""));
    process.exitCode = 2;
    return;
  }
  const fail = (msg) => { print({ error: msg }, msg); process.exitCode = 1; };
  if (!parseRun(change)) return fail(`No change named "${change}". Run /groundwork list.`);
  if (gate === "deliver") return cmdDeliverySummary(change, fail);
  if (!exists(planBriefPath(path.join(CHANGES_DIR, change)))) return fail(`no ${PLAN_BRIEF} for change "${change}"`);
  const relPath = path.posix.join(".groundwork", "changes", change, "plan-summary.html");
  const abs = path.join(CHANGES_DIR, change, "plan-summary.html");
  fs.writeFileSync(abs, renderPlanSummary(change));
  const opened = flags.has("--no-open") ? false : openFile(abs);
  print({ path: relPath, opened }, `${relPath}${opened ? " (opened)" : ""}`);
}

// ---------- delivery summary (gate 2) ----------

// A screenshot named in a build report, as a data: URI. Only a .png file under the change's evidence/ folder is read (no "..",
// no symlink out of it, at most 5 MB, PNG signature checked). Returns { data } or { reason }.
function embedScreenshot(change, name) {
  const prefix = `.groundwork/changes/${change}/`;
  const relName = name.startsWith(prefix) ? name.slice(prefix.length) : name;
  if (!relName.startsWith("evidence/") || /[\\\0-\x1f]/.test(relName) || relName.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) return { reason: "not a file under evidence/" };
  if (!/\.png$/i.test(relName)) return { reason: "not a .png file" };
  try {
    const dir = fs.realpathSync(path.join(CHANGES_DIR, change, "evidence"));
    const file = fs.realpathSync(path.join(CHANGES_DIR, change, relName));
    if (!file.startsWith(dir + path.sep)) return { reason: "outside evidence/" };
    const st = fs.statSync(file);
    if (!st.isFile()) return { reason: "not a file" };
    if (st.size > 5 * 1024 * 1024) return { reason: "larger than 5 MB" };
    const bytes = fs.readFileSync(file);
    if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { reason: "not a PNG image" };
    return { data: `data:image/png;base64,${bytes.toString("base64")}`, size: bytes.length, rel: relName };
  } catch { return { reason: "file not found" }; }
}

// The delivery approval page (spec 8.6.3): { html, problems }. The caller has checked that deliver.md exists.
// Every string from a file is escaped; screenshots are embedded only through embedScreenshot.
function renderDeliverySummary(change) {
  const e = htmlEscape;
  const run = parseRun(change);
  const cfg = loadConfig();
  const base = path.join(CHANGES_DIR, change);
  const names = (() => { try { return fs.readdirSync(base); } catch { return []; } })();
  const num = (re) => names.map((f) => re.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
  const dl = deliverProblems(change);

  let warnings = [];
  const problems = [];
  try { const b = buildProblems(change); warnings = b.warnings; if (run.format >= 2) problems.push(...b.problems); } catch (err) { problems.push(`build check unavailable: ${err.message}`); }
  const unplanned = new Set(warnings.filter((w) => w.startsWith("unplanned file: ")).map((w) => w.slice("unplanned file: ".length)));
  problems.push(...warnings);
  // A dispute is a problem until the next round's reviewer accepts it (verdict dispute-accepted); then it is listed as accepted.
  const acceptedDisputes = [];
  for (const k of num(/^build-review-(\d+)\.md$/)) {
    const verdicts = new Map();
    for (const f of [`review-${k + 1}.md`, `security-review-${k + 1}.md`]) {
      for (const c of roundTables(read(path.join(base, f)) || "").previous || []) verdicts.set(c[0], (c[2] || "").toLowerCase());
    }
    for (const a of reviewAnswers(change, k)) {
      if (a.kind !== "disputed") continue;
      if (verdicts.get(a.id) === "dispute-accepted") acceptedDisputes.push({ id: a.id, reason: a.text });
      else problems.push(`build-review-${k}.md: finding ${a.id} disputed${a.text ? `: ${a.text}` : ""}`);
    }
  }
  const tests = testComparison(change, "after-build");
  for (const l of tests.levels) if (!["passed", "not-configured", "missing"].includes(l.afterBuild)) problems.push(`${l.level} tests ${l.afterBuild} after the build`);
  if (run.format >= 2) for (const l of tests.levels) if (l.afterBuild === "missing" && l.baseline !== "missing" && l.baseline !== "not-configured") problems.push(`${l.level} tests have no after-build result`);
  const shots = evidenceScreenshots(change, { format: run.format }).map((s) => ({ s, r: embedScreenshot(change, s) }));
  // Screenshots are inlined until 20 MB in total; later ones are links to the file beside the page.
  let inlined = 0;
  for (const shot of shots) {
    if (!shot.r.data) continue;
    if (inlined + shot.r.size > 20 * 1024 * 1024) shot.r = { link: shot.r.rel };
    else inlined += shot.r.size;
  }
  for (const { s, r } of shots) {
    if (r.data || r.link) continue;
    // One line per path: the embed reason replaces check-build's "screenshot not found" line.
    const dup = problems.indexOf(`screenshot not found: ${s}`);
    if (dup >= 0) problems.splice(dup, 1);
    problems.push(`screenshot ${s} not embedded: ${r.reason}`);
  }
  problems.push(...dl.problems);

  const reviews = num(/^review-(\d+)\.md$/);
  // Format 2: the approving round deliver-input uses; format 1: review.md.
  const reviewText = run.format >= 2 ? read(path.join(base, `review-${reviewRound(change)}.md`)) || "" : read(path.join(base, "review.md")) || "";
  const acRows = (roundTables(reviewText).acs || []).map((c) => ({ ac: c[0] || "", verdict: c[1] || "", evidence: c[2] || "" }));
  const summary = read(planBriefPath(base)) || "";
  const link = (() => { try { return trackerLink(run, cfg); } catch { return { type: "none", key: null }; } })();
  let files = [];
  try { files = changedFiles().files; } catch (err) { problems.push(`changed files unavailable: ${err.message}`); }
  const kind = { A: "Added", M: "Modified", D: "Deleted" };
  const fileSection = ["A", "M", "D"].map((st) => {
    const list = files.filter((f) => f.status === st);
    return `<h3>${kind[st]} (${list.length})</h3>${list.length ? `<ul>${list.map((f) => `<li><code>${e(f.path)}</code>${unplanned.has(f.path) ? ' <span class="bad">unplanned</span>' : ""}</li>`).join("")}</ul>` : '<p class="muted">None.</p>'}`;
  }).join("");
  const shotHtml = shots.map(({ s, r }) => {
    if (r.link) return `<p><a href="${e(r.link.split("/").map(encodeURIComponent).join("/"))}"><code>${e(s)}</code></a> <span class="muted">(not inlined: page size limit)</span></p>`;
    return r.data
      ? `<figure><img src="${r.data}" alt="${e(s)}" style="max-width:100%"><figcaption class="muted">${e(s)}</figcaption></figure>`
      : `<p><code>${e(s)}</code> <span class="muted">not embedded: ${e(r.reason)}</span></p>`;
  });
  const roundRows = [];
  for (const [prefix, label] of [["review", "Review"], ["security-review", "Security review"]]) {
    for (const k of num(new RegExp(`^${prefix}-(\\d+)\\.md$`))) {
      const text = read(path.join(base, `${prefix}-${k}.md`)) || "";
      const found = roundFindings(text) || [];
      const blocking = found.filter((f) => f.severity.toLowerCase() === "blocking").length;
      roundRows.push(`<tr><td>${label}</td><td>${k}</td><td>${e(headerValue(text, "Status") || "unknown")}</td><td>${found.length} (${blocking} blocking)</td></tr>`);
    }
  }
  if (!reviews.length && reviewText) roundRows.push(`<tr><td>Review</td><td>1</td><td>${e(headerValue(reviewText, "Status") || "unknown")}</td><td>-</td></tr>`);
  const { parsed } = dl;
  const ticket = link.key ? `${link.type} ${link.key}` : "none";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Delivery ${e(change)}</title>
<style>
${SUMMARY_CSS}
</style></head><body>
<section id="problems" class="${problems.length ? "attention" : ""}"><h2>Problems</h2>${problems.length ? `<ul>${problems.map((p) => `<li>${e(p)}</li>`).join("")}</ul>` : '<p class="ok">None.</p>'}</section>
<header><h1>${e(change)}</h1>
<p class="muted">Ticket: <strong>${e(ticket)}</strong> &middot; Path: <strong>${e(run.path || "unknown")}</strong> &middot; Base branch: <strong>${e(cfg.deliver.baseBranch)}</strong> &middot; Branch: <strong>${e(`groundwork/${change}`)}</strong></p></header>
<section><h2>What and why</h2><h3>Why</h3>${plainBlocks(markdownSection(summary, "Why"))}<h3>What changes</h3>${plainBlocks(markdownSection(summary, "What changes"))}</section>
<section><h2>Acceptance criteria</h2>${acRows.length ? `<table><tr><th>AC</th><th>Verdict</th><th>Tests and evidence</th></tr>${acRows.map((r) => `<tr><td>${e(r.ac)}</td><td>${e(r.verdict)}</td><td>${e(r.evidence)}</td></tr>`).join("")}</table>` : '<p class="muted">Not recorded.</p>'}</section>
<section><h2>Tests by level</h2><table><tr><th>Level</th><th>Baseline</th><th>After build</th></tr>${tests.levels.map((l) => `<tr><td>${e(l.level)}</td><td>${e(l.baseline)}</td><td>${e(l.afterBuild)}</td></tr>`).join("")}</table></section>
<section><h2>Screenshots</h2>${shotHtml.length ? shotHtml.join("") : '<p class="muted">None.</p>'}</section>
<section><h2>Files</h2>${fileSection}</section>
<section><h2>Review</h2>${roundRows.length ? `<table><tr><th>Kind</th><th>Round</th><th>Status</th><th>Findings</th></tr>${roundRows.join("")}</table>` : '<p class="muted">None.</p>'}</section>
<section><h2>Accepted disputes</h2>${acceptedDisputes.length ? `<table><tr><th>ID</th><th>Reason</th></tr>${acceptedDisputes.map((a) => `<tr><td>${e(a.id)}</td><td>${e(a.reason || "-")}</td></tr>`).join("")}</table>` : '<p class="muted">None.</p>'}</section>
<section><h2>Pull request preview</h2><h3>Title</h3><pre>${e(parsed.title ?? "")}</pre><h3>Description</h3><pre>${e(parsed.description ?? "")}</pre><h3>Commit message</h3><pre>${e(parsed.subject ?? "")}${parsed.body ? e(`

${parsed.body}`) : ""}</pre><h3>Changelog entry</h3><pre>${e(parsed.changelog ?? "")}</pre></section>
<section><h2>Next commands</h2><pre><code>${e(`/groundwork approve ${change}\n/groundwork resume ${change} "<feedback>"\n/groundwork cancel ${change}`)}</code></pre></section>
</body></html>
`;
  return { html, problems };
}

function cmdDeliverySummary(change, fail) {
  if (!exists(path.join(CHANGES_DIR, change, "deliver.md"))) return fail(`deliver.md is missing for change "${change}"`);
  const { html, problems } = renderDeliverySummary(change);
  const relPath = path.posix.join(".groundwork", "changes", change, "delivery-summary.html");
  const abs = path.join(CHANGES_DIR, change, "delivery-summary.html");
  fs.writeFileSync(abs, html);
  const opened = flags.has("--no-open") ? false : openFile(abs);
  print({ path: relPath, opened, problems }, `${relPath}${opened ? " (opened)" : ""}${problems.length ? `\n${problems.length} problem(s) listed first on the page.` : ""}`);
}

// ---------- help ----------

function cmdHelp() {
  const text = `Groundwork ${GW_VERSION} by Stackrift - spec-driven agentic workflow

Usage: /groundwork <command> [args]

Workflow
  start "<task or Jira key>" [--full|--fast] [--ref <url> ...]
                                               Explore and plan a change; stops at the approval gate
  refine "<ticket or prompt>"                  Refine a ticket or idea until it meets the Definition of Ready
  approve <change> [--accept-open-questions]   Approve the plan or the delivery; build, review and deliver
  resume [<change> ["<feedback>"]]             Continue a change or revise it; without a change, close merged ones
  cancel <change>                              Stop a change (keeps code and files)
  status [change]                              Current stage, approvals and next step
  list                                         All changes and their stage
  cost [change]                                Tokens used per stage and model

Setup and quality
  init                                         Set up OpenSpec, config, AGENTS.md and the CI check
  audit                                        Assess the agent setup; writes .groundwork/audit/audit-result.md
  tune [R1 R2 ...]                             Propose fixes from the audit; writes .groundwork/tune/proposal.md
  approve tune                                 Apply the tune proposal
  verify [--change <name>] [--strict]          Deterministic checks (same as CI)
  doctor                                       Check the installation
  version                                      Groundwork and OpenSpec versions
  help                                         This list

Internal (used by the orchestrator)
  config [--json]                              Effective config after version 1 migration
  stats [--json] [--now <YYYY-MM-DD>]          Review findings, loops, tokens and stuck changes (facts for the audit)
  context [--json]                             Always-loaded context per file, its token total and stale references
  classify "<arg>" [--json]                    Ticket, refinement or prompt
  refinement <key> [--json]                    Parsed refinement record
  ready <key> [--json]                         Definition of Ready check for a refinement
  answers <key> [--json]                       Product-owner replies found in a refinement's ticket comments
  refine-comment <key> --kind questions|ready [--json]
                                               Exact tracker comment text to post
  new-questions <key> [--json]                 Open questions in ticket.md without a Q id, with the next free ids
  check-context <change> [--json]              Validate the shape of each context/*.md file
  check-plan <change> [--json]                 Check AC coverage, test levels and task markers in the plan
  check-gate <change> --gate plan [--json]     Whether the plan approval still matches the plan on disk
  check-build <change> [--json]                Check the build reports: scenario tests, screenshots and planned files
  groups <change> [--json]                     Task groups ordered into waves by their Depends on lines
  run-tests <change> --label <label> [--level unit|integration|e2e|all] [--json]
                                               Run the repository's configured test commands; writes tests/<label>.json
  review-input <change> --round <n> [--json]   Write the reviewer's input pack: inputs/review-<n>.md and its patches
  review-input <change> --next-round [--json]  The next review round and its reviewer files; writes nothing
  check-review <change> --round <n> [--json]   Check a review round's files: problems, approval and open findings
  worktree create <change> <group> [--json]    Worktree of the main tree (untracked files included) for a parallel builder
  worktree collect <change> <group> --base <sha> [--json]
                                               Apply a worktree's changes to the main tree if in build scope and conflict-free
  deliver-input <change> [--json]              Write the deliver agent's facts: inputs/deliver.md (needs an approved review)
  check-deliver <change> [--json]              Check deliver.md: sections, branch, commit subject, tracker links, ACs
  deliver <change> [--json]                    Commit the approved files, push groundwork/<change>, open or update the PR
  pr-status <change> [--bodies] [--json]       The pull request's state, new comments and failed checks, from the code host
  feedback <change> --source pr|user [--text <t> | --text-file <path>] [--json]
                                               Write PR or user feedback as a new review round (Mode: feedback)
  cleanup <change> [--force] [--json]          After a merge: remove worktrees, switch to and pull the base branch, delete the branch
  worktree prune <change> [--json]             Remove the change's leftover worktrees
  check-explore <change> [--json]              Check explore.md: path, sensitivity and required headings
  check-tune [--json]                          Check .groundwork/tune/proposal.md: status, changes, actions, blocks and paths
  fingerprint --tune [--json]                  Fingerprint of the tune proposal (its Status line does not count)
  tune-apply [--json]                          Apply exactly the proposal's changes, if it is the one shown; lists what it skipped
  tune-deliver [--json]                        Commit the applied proposal on groundwork/tune-<date>, push, open or update the pull request
  check-refined <change> [--json]              Whether the change's ticket has a ready, unchanged refinement
  task <change> [--json]                       Write task.md (refined ticket, or rendered from source.json)
  history <change> [--max <n>] [--json]        Write history.md (recent commits and their files)
  refs <change> [--ref <url> ...] [--json]     Vetted reference URLs: how to fetch each, and which were rejected
  summary --refinement <key> [--no-open] [--json]
                                               One-page HTML summary of a refinement
  summary <change> --gate plan|deliver [--no-open] [--json]
                                               One-page HTML summary of a gate (plan or delivery)
  diff <change> [--json]                       Changed, added, deleted and untracked files vs the base branch
  fingerprint <change> --gate plan|deliver [--json]
  fingerprint --refinement <key> --gate ticket [--json]
                                               SHA-256 of a gate's content
  snapshot <change> <stage>                    Record file state before a stage; prints its SHA-256
  snapshot --refinement <key> <stage>          Same, for a refinement (stages: intake, refine)
  snapshot --audit <audit|tune>                Same, for the auditor
  check-scope <change> <stage> [--expect <sha256>] [--json]
  check-scope --refinement <key> <stage> [--expect <sha256>] [--json]
  check-scope --audit <audit|tune> [--expect <sha256>] [--json]
                                               Fail if the stage changed files outside its scope

Flow: refine -> start -> (review plan) -> approve -> build -> review -> deliver (gate 2) -> merge -> resume`;
  print({ version: GW_VERSION, help: text }, text);
}

// ---------- config ----------

function cmdConfig() {
  const { _missing, _error, ...cfg } = loadConfig();
  print(cfg, JSON.stringify(cfg, null, 2));
}

// ---------- classify ----------

// Refinement folder name for a tracker key: lowercase, non-alphanumerics become "-".
function refinementKey(tracker, key) {
  let k = String(key);
  if (tracker === "github") k = `gh-${k.replace(/^#/, "")}`;
  else if (tracker === "azure-devops") k = k.replace(/^(AB)?#/i, "ab-");
  return k.toLowerCase().replace(/[^a-z0-9]/g, "-");
}

// ---------- refinements ----------

const validRefinementKey = (k) => typeof k === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(k);

function listRefinements() {
  if (!exists(REF_DIR)) return [];
  return fs.readdirSync(REF_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && validRefinementKey(d.name))
    .map((d) => d.name)
    .sort();
}

function parseRefinement(key) {
  if (!validRefinementKey(key)) return null;
  const text = read(path.join(REF_DIR, key, "refinement.md"));
  if (text === null) return null;
  const fp = headerValue(text, "Ticket fingerprint");
  const start = text.search(/^##\s+Questions\s*$/mi);
  let qtext = "";
  if (start >= 0) {
    const after = text.slice(start).split(/\r?\n/).slice(1);
    const end = after.findIndex((l) => /^##\s/.test(l));
    qtext = (end < 0 ? after : after.slice(0, end)).join("\n");
  }
  const questions = qtext.split(/^###\s+/m).slice(1).map((block) => ({
    id: block.split(/\r?\n/)[0].trim(),
    owner: (headerValue(block, "Owner") || "").toLowerCase(),
    status: (headerValue(block, "Status") || "").toLowerCase(),
    question: headerValue(block, "Question") || "",
    answer: headerValue(block, "Answer") || "",
    answeredBy: headerValue(block, "Answered by") || "",
  }));
  const approvals = tableRows(text, "Approvals").map((c) => ({
    gate: (c[0] || "").toLowerCase(), decision: (c[1] || "").toLowerCase(), by: c[2] || "", date: c[3] || "", fingerprint: c[4] || "",
  }));
  return {
    key: headerValue(text, "Key") || key,
    source: headerValue(text, "Source") || "",
    tracker: (headerValue(text, "Tracker") || "").toLowerCase(),
    status: (headerValue(text, "Status") || "").toLowerCase(),
    ticketFingerprint: !fp || fp.toLowerCase() === "none" ? null : fp,
    questions,
    approvals,
  };
}

function cmdRefinement() {
  const key = positional[0];
  if (!key || !validRefinementKey(key)) {
    console.error("Usage: refinement <key> [--json]  (key: lowercase letters, digits and hyphens)");
    process.exitCode = 2;
    return;
  }
  const r = parseRefinement(key);
  if (!r) {
    const msg = `No refinement named "${key}".`;
    print({ error: msg }, msg);
    process.exitCode = 1;
    return;
  }
  const text = [
    `${r.key}  ${r.status}  (source: ${r.source})`,
    ...r.questions.map((q) => `${q.id}  ${q.owner}  ${q.status}  ${q.question}`),
  ].join("\n");
  print(r, text);
}

// Body under "## <heading>" up to the next "## " heading, or null when the heading is absent.
function markdownSection(text, heading) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => l.replace(/\s+$/, "") === "## " + heading);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").replace(/\s+$/, "");
}

function readyProblems(key) {
  const ticket = read(path.join(REF_DIR, key, "ticket.md")) || "";
  const problems = [];
  const ac = markdownSection(ticket, "Acceptance criteria") || "";
  const blocks = ac.split(/^###\s+/m).slice(1).map((b) => ({ title: b.split(/\r?\n/)[0].trim(), body: b }));
  if (!blocks.length) problems.push("no acceptance criteria");
  for (const b of blocks) {
    const label = b.title || "AC";
    if (!b.body.includes("**WHEN**")) problems.push(`${label}: missing WHEN`);
    if (!b.body.includes("**THEN**")) problems.push(`${label}: missing THEN`);
  }
  if (blocks.length && !blocks.every((b, i) => b.title === `AC${i + 1}`)) problems.push("acceptance criteria must be numbered AC1..ACn in order");
  if (!/^# +\S/m.test(ticket)) problems.push("ticket has no title");
  const ref = parseRefinement(key);
  for (const q of ref ? ref.questions : []) {
    if (q.status === "open") problems.push(`open question in refinement.md: ${q.id}`);
    if (q.status === "answered" && (!q.answer.trim() || !q.answeredBy.trim())) problems.push(`${q.id}: answered without answer or answered by`);
  }
  const open = markdownSection(ticket, "Open questions");
  if (open && open.trim() && open.trim() !== "None") problems.push("open questions listed in ticket.md");
  const out = markdownSection(ticket, "Out of scope");
  if (!out || !/^\s*- /m.test(out)) problems.push("out of scope is empty");
  return problems;
}

function cmdReady() {
  const key = positional[0];
  if (!key || !validRefinementKey(key)) {
    console.error("Usage: ready <key> [--json]  (key: lowercase letters, digits and hyphens)");
    process.exitCode = 2;
    return;
  }
  if (read(path.join(REF_DIR, key, "ticket.md")) === null) {
    const msg = `no ticket.md for refinement "${key}"`;
    print({ error: msg }, msg);
    process.exitCode = 1;
    return;
  }
  const problems = readyProblems(key);
  print({ ready: problems.length === 0, problems }, problems.length ? `Not ready:\n${problems.map((p) => `- ${p}`).join("\n")}` : "Ready.");
  if (problems.length) process.exitCode = 1;
}

// Acceptance criteria of a ticket.md as [{ id, when, then }]; continuation lines of a WHEN/THEN join with a space.
function acceptanceCriteria(ticket) {
  return (markdownSection(ticket, "Acceptance criteria") || "").split(/^###\s+/m).slice(1).map((b) => {
    const bl = b.split(/\r?\n/);
    const at = (w) => {
      const k = bl.findIndex((l) => l.includes("**" + w + "**"));
      if (k < 0) return "";
      const parts = [bl[k].slice(bl[k].indexOf("**" + w + "**") + w.length + 4).replace(/^\s*[:\-–]/, "")];
      for (let n = k + 1; n < bl.length && bl[n].trim() && !/^\s*- /.test(bl[n]) && !bl[n].includes("**") && !/^#/.test(bl[n]); n++) parts.push(bl[n]);
      return parts.join(" ").replace(/\s+/g, " ").trim();
    };
    return { id: bl[0].trim(), when: at("WHEN"), then: at("THEN") };
  });
}

// The exact comment text to post to the tracker, printed without a trailing newline.
function cmdRefineComment() {
  const key = positional[0];
  const kind = opt("kind");
  if (!key || !validRefinementKey(key) || (kind !== "questions" && kind !== "ready")) {
    console.error("Usage: refine-comment <key> --kind questions|ready [--json]  (key: lowercase letters, digits and hyphens)");
    process.exitCode = 2;
    return;
  }
  const fail = (msg) => { print({ error: msg }, msg); process.exitCode = 1; };
  const ref = parseRefinement(key);
  if (!ref) return fail("No refinement named \"" + key + "\".");
  const num = (q) => Number(String(q.id).replace(/\D/g, "")) || 0;
  let lines;
  if (kind === "questions") {
    const open = ref.questions.filter((q) => q.owner === "product-owner" && q.status === "open").sort((a, b) => num(a) - num(b));
    if (!open.length) return fail("no open product-owner questions");
    lines = ["Groundwork refinement: questions for the product owner", "", ...open.map((q) => q.id + " " + q.question), "",
      ref.source === "prompt" ? `Reply with "${open[0].id}: <answer>" for each question.` : `Reply in a comment as "${open[0].id}: <answer>".`];
  } else {
    if (readyProblems(key).length) return fail("not ready: run gw.mjs ready " + key);
    const ticket = read(path.join(REF_DIR, key, "ticket.md")) || "";
    const title = (ticket.split(/\r?\n/).find((l) => /^#\s/.test(l)) || "").replace(/^#\s+/, "").trim();
    const ac = acceptanceCriteria(ticket).map((c) => c.id + " WHEN " + c.when + " THEN " + c.then);
    const out = (markdownSection(ticket, "Out of scope") || "").split(/\r?\n/).filter((l) => /^\s*- /.test(l)).map((l) => l.trim());
    lines = ["Groundwork refinement: ready", "", title, "", "Acceptance criteria", ...ac, "", "Out of scope", ...out];
    if (ref.questions.length) lines.push("", "Questions", ...ref.questions.map((q) => q.id + " " + q.question + " — " + q.answer + " (answered by " + q.answeredBy + ")"));
  }
  const text = lines.join("\n");
  if (asJson) console.log(JSON.stringify({ kind, text }, null, 2));
  else process.stdout.write(text);
}

// Open questions in ticket.md that have no Q<n> id yet, each with the next free id (after the highest in refinement.md).
function cmdNewQuestions() {
  const key = positional[0];
  if (!key || !validRefinementKey(key)) {
    console.error("Usage: new-questions <key> [--json]  (key: lowercase letters, digits and hyphens)");
    process.exitCode = 2;
    return;
  }
  const fail = (msg) => { print({ error: msg }, msg); process.exitCode = 1; };
  const ticket = read(path.join(REF_DIR, key, "ticket.md"));
  if (ticket === null) return fail(`no ticket.md for refinement "${key}"`);
  const ref = parseRefinement(key);
  let next = 1 + Math.max(0, ...(ref ? ref.questions : []).map((q) => Number(String(q.id).replace(/\D/g, "")) || 0));
  const known = new Set((ref ? ref.questions : []).map((q) => q.id));
  const questions = [];
  for (const raw of (markdownSection(ticket, "Open questions") || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === "None") continue;
    const m = /^-\s+\[(you|product-owner)\]\s+(.*)$/.exec(line);
    if (!m) return fail(`unrecognised open question line: ${line}`);
    const idm = /^\(?(Q\d+)\)?:?(\s|$)/.exec(m[2]);
    if (idm) {
      if (!known.has(idm[1])) return fail(`unknown question id in ticket.md: ${idm[1]}`);
      continue;
    }
    questions.push({ owner: m[1], question: m[2].trim(), id: `Q${next++}` });
  }
  print({ questions }, questions.length ? questions.map((q) => `${q.id}  ${q.owner}  ${q.question}`).join("\n") : "No new questions.");
}

// Structured ticket snapshot written by gw-intake. Throws "source.json is not valid: <reason>".
function readSource(key) {
  return readSourceAt(path.join(REF_DIR, key, "source.json"), `refinement "${key}"`);
}

// Same, for any source.json path; `what` names the owner in the "no source.json" message.
function readSourceAt(absPath, what) {
  const text = read(absPath);
  if (text === null) throw new Error(`no source.json for ${what}`);
  const bad = (why) => new Error(`source.json is not valid: ${why}`);
  let s;
  try { s = JSON.parse(text); } catch (e) { throw bad(`invalid JSON (${e.message})`); }
  if (!isPlainObject(s)) throw bad("top level must be an object");
  if (s.format !== 1) throw bad("format must be 1");
  if (s.kind !== "ticket" && s.kind !== "prompt") throw bad('kind must be "ticket" or "prompt"');
  const required = s.kind === "ticket"
    ? ["key", "tracker", "url", "fetched", "summary", "description", "acceptanceCriteria"]
    : ["key", "tracker", "prompt", "fetched"];
  for (const f of required) if (typeof s[f] !== "string") throw bad(`${f} must be a string`);
  if (s.kind === "prompt") {
    if (s.tracker !== "none") throw bad('tracker must be "none" for a prompt');
  }
  if (s.url !== undefined && typeof s.url !== "string") throw bad("url must be a string");
  s.url = s.url && s.url !== "none" ? s.url : null;
  if (s.comments === undefined) s.comments = [];
  if (!Array.isArray(s.comments)) throw bad("comments must be an array");
  s.comments.forEach((c, i) => {
    if (!isPlainObject(c)) throw bad(`comment ${i + 1} must be an object`);
    for (const f of ["author", "date", "body"]) if (typeof c[f] !== "string") throw bad(`comment ${i + 1}: ${f} must be a string`);
  });
  return s;
}

// Reply lines of one comment body, as Map of "q<n>" -> answer text (last reply to a question wins).
// Accepted false positive: a line such as "Q4-2026 roadmap: ..." reads as a reply to Q4 when Q4 is open.
function commentReplies(body) {
  let lines = String(body).split(/\r?\n/);
  const first = lines.find((l) => l.trim());
  if (first !== undefined && /^Groundwork refinement:/.test(first.trim())) {
    // A pasted copy of our question comment: ignore up to its instruction line, parse what follows.
    const at = lines.findIndex((l) => /^(Reply in a comment as|Reply with)/.test(l.trim()));
    if (at < 0) return new Map();
    lines = lines.slice(at + 1);
  }
  const replies = new Map();
  let curId = null;
  let fenced = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced || /^\s*>/.test(line)) continue;
    const m = /^\s*(?:(?:[-*+•]|\d+[.)])\s+)?(?:\*\*\s*)?q(\d+)\s*(?:\*\*\s*)?[:.)\-–]\s*(?:\*\*\s*)?(.*)$/i.exec(line);
    if (m) { curId = `q${Number(m[1])}`; replies.set(curId, m[2]); }
    else if (curId) replies.set(curId, `${replies.get(curId)} ${line}`);
  }
  return replies;
}

// Product-owner replies ("Q<n>: ...") for questions still open, last reply in array order wins.
function cmdAnswers() {
  const key = positional[0];
  if (!key || !validRefinementKey(key)) {
    console.error("Usage: answers <key> [--json]  (key: lowercase letters, digits and hyphens)");
    process.exitCode = 2;
    return;
  }
  const fail = (msg) => { print({ error: msg }, msg); process.exitCode = 1; };
  const ref = parseRefinement(key);
  if (!ref) return fail(`no refinement.md for refinement "${key}"`);
  let source;
  try { source = readSource(key); } catch (e) { return fail(e.message); }
  const open = new Map();
  for (const q of ref.questions) if (q.owner === "product-owner" && q.status === "open") open.set(q.id.toLowerCase(), q.id);
  const found = new Map();
  for (const c of source.comments) {
    for (const [id, raw] of commentReplies(c.body)) {
      const real = open.get(id);
      const answer = raw.replace(/\s+/g, " ").trim();
      if (real && answer) found.set(real, { id: real, answer, author: c.author, date: c.date });
    }
  }
  const answers = [...found.values()];
  print({ answers }, answers.length ? answers.map((a) => `${a.id}  ${a.answer}  (${a.author}, ${a.date})`).join("\n") : "No answers.");
}

function cmdClassify() {
  const arg = (positional[0] || "").trim();
  if (!arg) {
    console.error('Usage: classify "<ticket key, refinement key or prompt>" [--json]');
    process.exitCode = 2;
    return;
  }
  const refDir = (name) => path.join(REF_DIR, name);
  const { tracker } = loadConfig();
  if (validRefinementKey(arg) && parseRefinement(arg)?.source === "prompt") {
    print({ kind: "refinement", key: arg }, `refinement ${arg}`);
    return;
  }
  if (tracker.type !== "none" && tracker.keyPattern) {
    let re;
    try { re = new RegExp(tracker.keyPattern); } catch (e) {
      const msg = `tracker.keyPattern is not a valid regular expression: ${e.message}`;
      print({ error: msg }, msg);
      process.exitCode = 1;
      return;
    }
    const key = re.test(arg) ? arg : tracker.type === "jira" && re.test(arg.toUpperCase()) ? arg.toUpperCase() : null;
    if (key) {
      const rk = refinementKey(tracker.type, key);
      const out = { kind: "ticket", tracker: tracker.type, key, refinementKey: rk };
      if (exists(refDir(rk))) out.refinement = rk;
      print(out, `ticket ${tracker.type} ${key}`);
      return;
    }
  }
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(arg) && !arg.includes("..") && exists(refDir(arg))) {
    print({ kind: "refinement", key: arg }, `refinement ${arg}`);
    return;
  }
  print({ kind: "prompt" }, "prompt");
}

// ---------- diff ----------

// Raw git stdout for -z parsing: no shell, no trimming.
function gitRaw(args) {
  const r = spawnSync("git", gitArgs(args), { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout || "" };
}

// Like gitRaw, but a failing git command throws instead of looking like "no changes".
function gitMust(args) {
  const r = spawnSync("git", gitArgs(args), { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.error ? r.error.message : (r.stderr || "").trim()) || "exit " + r.status}`);
  return { ok: true, out: r.stdout || "" };
}

// The commit a change is compared against: the merge base of HEAD with deliver.baseBranch, or HEAD when that branch or a merge
// base is missing (fallback: true). base is null when the repository has no commit.
function diffBase() {
  const baseBranch = loadConfig().deliver.baseBranch;
  if (gitRaw(["rev-parse", "--verify", "--quiet", `${baseBranch}^{commit}`]).ok) {
    const mb = gitRaw(["merge-base", "HEAD", baseBranch]);
    if (mb.ok && mb.out.trim()) return { base: mb.out.trim(), baseBranch, fallback: false };
  }
  const head = gitRaw(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  return { base: head.ok && head.out.trim() ? head.out.trim() : null, baseBranch, fallback: true };
}

// Files changed in the working tree against the merge base with deliver.baseBranch (or HEAD).
function changedFiles({ includeGroundwork = false, base: fixedBase } = {}) {
  const base = fixedBase !== undefined ? fixedBase : diffBase().base;
  const byPath = new Map();
  const split = (out) => out.split("\0").filter(Boolean);
  if (base) {
    const parts = split(gitMust(["diff", "--name-status", "-z", "--no-renames", base]).out);
    for (let i = 0; i + 1 < parts.length; i += 2) byPath.set(parts[i + 1], parts[i][0] === "D" ? "D" : parts[i][0] === "A" ? "A" : "M");
    for (const p of split(gitMust(["ls-files", "--others", "--exclude-standard", "-z"]).out)) byPath.set(p, "A");
  } else {
    for (const p of split(gitMust(["ls-files", "-z", "--others", "--cached", "--exclude-standard"]).out)) {
      if (exists(path.join(ROOT, p))) byPath.set(p, "A");
    }
  }
  const files = [...byPath]
    .map(([p, status]) => ({ status, path: p.split("\\").join("/") }))
    .filter((f) => includeGroundwork || !(f.path === ".groundwork" || f.path.startsWith(".groundwork/")))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { base, files };
}

function cmdDiff() {
  const change = positional[0];
  if (!change) {
    console.error("Usage: diff <change> [--json]");
    process.exitCode = 2;
    return;
  }
  if (!parseRun(change)) { print({ error: "not found" }, `No change named "${change}". Run /groundwork list.`); process.exitCode = 1; return; }
  let changed;
  try {
    changed = changedFiles();
  } catch (e) {
    print({ error: e.message }, e.message);
    process.exitCode = 1;
    return;
  }
  const { base, files } = changed;
  const n = (s) => files.filter((f) => f.status === s).length;
  const counts = { added: n("A"), modified: n("M"), deleted: n("D") };
  const lines = files.map((f) => `${f.status} ${f.path}`);
  lines.push(`${counts.added} added, ${counts.modified} modified, ${counts.deleted} deleted`);
  print({ base, files, counts }, lines.join("\n"));
}

// ---------- fingerprint ----------

// CRLF becomes LF; in tasks.md, ticked boxes count as unticked, so progress never changes a fingerprint.
function normalizeForHash(name, content) {
  let text = content.replace(/\r\n/g, "\n");
  if (name === "tasks.md" || name.endsWith("/tasks.md")) text = text.replace(/- \[[xX]\]/g, "- [ ]");
  return text;
}

// Bytes with a NUL are binary and hashed as is; anything else is text, so CRLF becomes LF (byte-safe via latin1).
function normalizeBytes(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  if (buf.includes(0)) return buf;
  return Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
}

function fingerprintOf(entries) {
  const h = createHash("sha256");
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of sorted) h.update(`${e.name}\0`).update(normalizeBytes(e.content)).update("\0");
  return `sha256:${h.digest("hex")}`;
}

function filesUnder(dir, prefix = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...filesUnder(path.join(dir, e.name), `${prefix}${e.name}/`));
    else if (e.isFile()) out.push(`${prefix}${e.name}`);
  }
  return out;
}

// Symlinks under dir (not followed), as { name, target }.
function linksUnder(dir, prefix = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) out.push({ name: `${prefix}${e.name}`, target: fs.readlinkSync(path.join(dir, e.name)) });
    else if (e.isDirectory()) out.push(...linksUnder(path.join(dir, e.name), `${prefix}${e.name}/`));
  }
  return out;
}

// Marker bytes for a directory in the file list: a gitlink sha (submodule or nested repo), else "dir". Never reads the directory as a file.
// The checked-out HEAD comes first, so a submodule whose HEAD moves changes the marker even though the index sha does not.
function dirMarker(rel, abs) {
  if (exists(path.join(abs, ".git"))) {
    const head = gitRaw(["-C", abs, "rev-parse", "HEAD"]);
    if (head.ok && head.out.trim()) return `gitlink:${head.out.trim()}`;
  }
  const ls = gitRaw(["ls-files", "-s", "--", rel]);
  const first = ls.ok ? ls.out.split(/\r?\n/).find(Boolean) : null;
  const m = first && first.match(/^160000 ([0-9a-f]+) /);
  if (m) return `gitlink:${m[1]}`;
  return "dir";
}

// Bytes that stand for a working-tree path without following links: file content, "link:<target>", a gitlink marker, or "special:<type>".
// Errors name the path.
function worktreeBytes(relPath) {
  const clean = relPath.replace(/\/+$/, "");
  const abs = path.join(ROOT, clean);
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return Buffer.from(`link:${fs.readlinkSync(abs)}`);
    if (st.isFile()) return fs.readFileSync(abs);
    if (st.isDirectory()) return Buffer.from(dirMarker(clean, abs));
    return Buffer.from(`special:${st.isFIFO() ? "fifo" : st.isSocket() ? "socket" : st.isCharacterDevice() ? "char" : st.isBlockDevice() ? "block" : "other"}`);
  } catch (e) {
    throw new Error(`cannot read ${relPath}: ${e.message}`);
  }
}

// Normalized hash entries for the plan gate; empty when there is nothing to approve.
function planFiles(run) {
  const entries = [];
  const dir = path.join(CHANGES_DIR, run.change);
  if (run.path === "fast") {
    const plan = read(path.join(dir, "plan.md"));
    if (plan !== null) entries.push({ name: "plan.md", content: normalizeForHash("plan.md", plan) });
  } else {
    const os = openspecChangeDir(run.change);
    if (os) {
      for (const f of filesUnder(os)) entries.push({ name: `openspec/${f}`, content: normalizeForHash(f, fs.readFileSync(path.join(os, f), "utf8")) });
      // A symlink is recorded by its target, never followed, so retargeting it changes the fingerprint.
      for (const l of linksUnder(os)) entries.push({ name: `openspec/${l.name}`, content: `link:${l.target}` });
    }
  }
  if (entries.length) {
    const task = read(path.join(dir, "task.md"));
    if (task !== null) entries.push({ name: "task.md", content: normalizeForHash("task.md", task) });
  }
  return entries;
}

// The last `plan | approved` row of run.md, or undefined.
function lastPlanApproval(run) {
  return run.approvals.filter((a) => a.gate === "plan" && a.decision === "approved").pop();
}

function planFingerprint(run) {
  return fingerprintOf(planFiles(run));
}

// Throws when git fails (changedFiles) or deliver.md is missing; returns null-free entries otherwise.
function deliverFiles(change) {
  const entries = changedFiles().files.map((f) => {
    const content = f.status === "D" ? "" : worktreeBytes(f.path);
    return { name: `${f.status} ${f.path}`, content };
  });
  const deliver = read(path.join(CHANGES_DIR, change, "deliver.md"));
  if (deliver !== null) entries.push({ name: "deliver.md", content: deliver });
  return { entries, hasDeliver: deliver !== null };
}

function deliverFingerprint(change) {
  return fingerprintOf(deliverFiles(change).entries);
}

// Ticket gate: the fetched ticket's own text from source.json (never comments), normalized and trimmed.
function ticketFiles(key) {
  return ticketEntries(readSource(key));
}

function ticketFingerprintOf(s) {
  return fingerprintOf(ticketEntries(s));
}

function ticketEntries(s) {
  const norm = (v) => v.replace(/\r\n/g, "\n").trim();
  if (s.kind === "prompt") return [{ name: "prompt", content: norm(s.prompt) }];
  return [
    { name: "summary", content: norm(s.summary) },
    { name: "description", content: norm(s.description) },
    { name: "acceptance-criteria", content: norm(s.acceptanceCriteria) },
  ];
}

function cmdFingerprint() {
  const gate = opt("gate");
  if (flags.has("--tune")) {
    if (gate !== undefined || positional.length || rest.some((x) => x === "--refinement" || x.startsWith("--refinement="))) {
      console.error("Usage: fingerprint --tune [--json]");
      process.exitCode = 2;
      return;
    }
    const fingerprint = tuneFingerprint();
    if (!fingerprint) { print({ error: "no proposal" }, "No tune proposal. Run /groundwork tune."); process.exitCode = 1; return; }
    print({ gate: "tune", fingerprint, report: tuneReportHash(), files: ["proposal.md"] }, fingerprint);
    return;
  }
  const refKey = opt("refinement");
  const hasRef = rest.some((x) => x === "--refinement" || x.startsWith("--refinement="));
  if (hasRef || gate === "ticket") {
    if (gate !== "ticket" || !validRefinementKey(refKey)) {
      console.error("Usage: fingerprint --refinement <key> --gate ticket [--json]  (key: lowercase letters, digits and hyphens)");
      process.exitCode = 2;
      return;
    }
    if (!parseRefinement(refKey)) { print({ error: "not found" }, `No refinement named "${refKey}".`); process.exitCode = 1; return; }
    let entries;
    try { entries = ticketFiles(refKey); } catch (e) { print({ error: e.message }, e.message); process.exitCode = 1; return; }
    const fingerprint = fingerprintOf(entries);
    print({ gate, fingerprint, files: entries.map((e) => e.name).sort() }, fingerprint);
    return;
  }
  const change = positional[0];
  if (!change || (gate !== "plan" && gate !== "deliver")) {
    console.error("Usage: fingerprint <change> --gate plan|deliver [--json]");
    process.exitCode = 2;
    return;
  }
  const run = parseRun(change);
  if (!run) { print({ error: "not found" }, `No change named "${change}". Run /groundwork list.`); process.exitCode = 1; return; }
  let entries;
  try {
    if (gate === "plan") {
      entries = planFiles(run);
      if (!entries.length) { print({ error: "no plan files" }, `No plan files for "${change}".`); process.exitCode = 1; return; }
    } else {
      const d = deliverFiles(change);
      if (!d.hasDeliver) { print({ error: "no deliver.md" }, `No deliver.md for "${change}".`); process.exitCode = 1; return; }
      entries = d.entries;
    }
  } catch (e) {
    print({ error: e.message }, e.message);
    process.exitCode = 1;
    return;
  }
  const fingerprint = fingerprintOf(entries);
  const files = entries.map((e) => e.name).sort();
  print({ gate, fingerprint, files }, fingerprint);
}

// ---------- start inputs: check-refined, task, history, refs ----------

// Change name argument whose run.md parses; prints the error and sets the exit code otherwise. Returns the change name or null.
function changeArg(usage) {
  const change = positional[0];
  if (!change || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(change) || change.includes("..")) {
    console.error(usage);
    process.exitCode = 2;
    return null;
  }
  if (!parseRun(change)) { print({ error: "not found" }, `No change named "${change}". Run /groundwork list.`); process.exitCode = 1; return null; }
  return change;
}

const changeSource = (change) => readSourceAt(path.join(CHANGES_DIR, change, "source.json"), `change "${change}"`);

// { refinement, ready, unchanged } for a change's source. Throws when source.json is missing or invalid.
function refinedState(change) {
  const s = changeSource(change);
  if (s.kind !== "ticket" && s.kind !== "prompt") return { refinement: null, ready: false, unchanged: null };
  const key = s.kind === "prompt" ? String(s.key) : refinementKey(s.tracker, s.key);
  const ref = parseRefinement(key);
  if (!ref || (s.kind === "prompt" && ref.source !== "prompt")) return { refinement: null, ready: false, unchanged: null };
  const ready = ref.status === "ready" && ref.approvals.some((a) => a.gate === "ready" && (a.decision === "approved" || a.decision === "approved-local"));
  return { refinement: key, ready, unchanged: ref.ticketFingerprint !== null && ref.ticketFingerprint === ticketFingerprintOf(s) };
}

// A context file is either a fetched page (header, then exactly one marker pair, nothing after the end marker) or a failure file.
const CTX_START = "<!-- groundwork:untrusted:start -->", CTX_END = "<!-- groundwork:untrusted:end -->";
function contextProblem(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (!/^Source: \S/.test(lines[0])) return "line 1 must be `Source: <url>`";
  const count = (s) => text.split(s).length - 1;
  const hasMarker = count(CTX_START) + count(CTX_END) > 0;
  if (!hasMarker) return lines.slice(1).some((l) => l.startsWith("Fetch failed:")) ? null : "no untrusted markers and no `Fetch failed:` line";
  if (lines[1] !== "") return "line 2 must be blank";
  if (count(CTX_START) !== 1 || count(CTX_END) !== 1) return "must contain exactly one start and one end marker";
  const s = text.indexOf(CTX_START), e = text.indexOf(CTX_END);
  if (s > e) return "end marker before start marker";
  if (text.slice(e + CTX_END.length).trim() !== "") return "text after the end marker";
  if (text.slice(text.indexOf("\n"), s).trim() !== "") return "text between the header and the start marker";
  return null;
}

function cmdCheckContext() {
  const change = changeArg("Usage: check-context <change> [--json]");
  if (!change) return;
  const dir = path.join(CHANGES_DIR, change, "context");
  const problems = [];
  if (exists(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
      let text;
      try { text = fs.readFileSync(path.join(dir, f), "utf8"); } catch (e) { problems.push(`context/${f}: unreadable`); continue; }
      const why = contextProblem(text);
      if (why) problems.push(`context/${f}: ${why}`);
    }
  }
  print({ ok: problems.length === 0, problems }, problems.length ? problems.join("\n") : "Context files ok.");
  if (problems.length) process.exitCode = 1;
}

// Plan checks that must give the same answer every time: AC coverage, test levels, task markers.
const PLAN_LEVELS = ["unit", "integration", "e2e"];
const acIdsIn = (text) => [...String(text).matchAll(/\bAC\d+\b/g)].map((m) => m[0]);

// ACs of task.md as [{ id, text }]. Only "### AC<n>" headings under "## Acceptance criteria" count; escaped (\###) lines are body text.
function taskAcs(change) {
  const task = read(path.join(CHANGES_DIR, change, "task.md"));
  const ac = task === null ? null : markdownSection(task, "Acceptance criteria");
  if (!ac) return [];
  const out = [];
  for (const line of ac.split(/\r?\n/)) {
    const m = /^###[ \t]+(AC\d+)[ \t]*$/.exec(line);
    if (m) out.push({ id: m[1], lines: [] });
    else if (out.length) out[out.length - 1].lines.push(line);
  }
  return out.map((a) => ({ id: a.id, text: a.lines.join("\n").trim() }));
}
const taskAcIds = (change) => taskAcs(change).map((a) => a.id);

// Non-removed requirements of every spec.md under a change folder: { name, spec (folder name), covers (text or null), scenarios: [{ name, level (text or null), text }] }.
function specRequirements(dir) {
  const out = [];
  for (const f of walk(path.join(dir, "specs")).filter((x) => path.basename(x) === "spec.md").sort()) {
    const text = (read(f) || "").replace(/\r\n/g, "\n");
    for (const sec of text.split(/^(?=##(?!#)\s)/m)) {
      if (/^##[ \t]+REMOVED Requirements/i.test(sec)) continue; // a removal has no behavior to cover or test
      for (const body of sec.split(/^(?=###[ \t]+Requirement:)/m).filter((x) => /^###[ \t]+Requirement:/.test(x))) {
        const name = body.split("\n")[0].replace(/^###[ \t]+Requirement:[ \t]*/, "").trim();
        const [head, ...scs] = body.split(/^(?=####[ \t]+Scenario:)/m);
        const cov = /^Covers:[ \t]*(.*)$/mi.exec(head);
        out.push({
          name, spec: path.basename(path.dirname(f)), covers: cov ? cov[1] : null,
          scenarios: scs.map((sc) => {
            const lv = /^Level:[ \t]*(.*)$/mi.exec(sc);
            return { name: sc.split("\n")[0].replace(/^####[ \t]+Scenario:[ \t]*/, "").trim(), level: lv ? lv[1].trim() : null, text: sc };
          }),
        });
      }
    }
  }
  return out;
}

// Lines of a fast plan's Tests section: { raw, level (lowercase, or null when the line has none), covers: [AC ids] }.
function fastTests(plan) {
  const out = [];
  for (const raw of (markdownSection(plan, "Tests") || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const lv = /^[-*]\s+(unit|integration|e2e)\s*:/i.exec(line);
    const cov = /\bcovers\s+([^)]*)/i.exec(line);
    out.push({ raw: line, level: lv ? lv[1].toLowerCase() : null, covers: cov ? acIdsIn(cov[1]) : [] });
  }
  return out;
}

// Task groups of a change, ordered into waves. Full path: the `## <n>. <name>` blocks of tasks.md. Fast path: one group.
// groups: [{ n, name, dependsOn, files, tasks, done, built, blocked }]; done = every task ticked (fast: build-fast.md is Done);
// built = its build report exists; blocked = that report says Status: Blocked. A group needs a build unless it is done, built
// and not blocked. waves: the group numbers that need a build, in dependency order;
// structure: [{ n, hasDepends, hasFiles }] (full path only, for check-plan).
function taskGroups(change) {
  const run = parseRun(change);
  const fast = !!run && run.path === "fast";
  const groups = [];
  const structure = [];
  if (fast) {
    const plan = read(path.join(CHANGES_DIR, change, "plan.md")) || "";
    const files = (markdownSection(plan, "Where") || "").split(/\r?\n/)
      .map((l) => /^\s*[-*]\s+(.*\S)\s*$/.exec(l)).filter(Boolean)
      .map((m) => { const i = m[1].indexOf(" - "); return (i < 0 ? m[1] : m[1].slice(0, i)).trim(); }).filter(Boolean);
    const build = read(path.join(CHANGES_DIR, change, "build-fast.md"));
    const status = build === null ? "" : (headerValue(build, "Status") || "");
    groups.push({ n: 1, name: "fast path", dependsOn: [], files, tasks: 0, done: /^done$/i.test(status), built: build !== null, blocked: /^blocked$/i.test(status) });
  } else {
    const dir = openspecChangeDir(change);
    const tasks = dir ? read(path.join(dir, "tasks.md")) : null;
    for (const block of (tasks || "").replace(/\r\n/g, "\n").split(/^(?=##(?!#)\s)/m).filter((b) => /^##[ \t]+\d+\./.test(b))) {
      const head = /^##[ \t]+(\d+)\.[ \t]*(.*)$/m.exec(block);
      const dep = /^Depends on:[ \t]*(.*)$/m.exec(block);
      const fil = /^Files:[ \t]*(.*)$/m.exec(block);
      const boxes = block.split("\n").map((l) => /^\s*[-*]\s+\[([ xX])\]/.exec(l)).filter(Boolean);
      structure.push({ n: head[1], hasDepends: !!dep, hasFiles: !!fil, tasks: boxes.length });
      groups.push({
        n: Number(head[1]), name: head[2].trim(),
        dependsOn: dep ? (dep[1].match(/\d+/g) || []).map(Number) : [],
        files: fil ? fil[1].split(",").map((f) => f.trim()).filter(Boolean) : [],
        tasks: boxes.length,
        done: boxes.length > 0 && boxes.every((b) => b[1] !== " "),
        built: false, blocked: false,
      });
      const report = read(path.join(CHANGES_DIR, change, `build-g${head[1]}.md`));
      const last = groups[groups.length - 1];
      last.built = report !== null;
      last.blocked = report !== null && /^blocked$/i.test(headerValue(report, "Status") || "");
    }
  }
  const needs = (g) => !g.done || !g.built || g.blocked;
  const problems = [];
  if (!fast && groups.length === 0) problems.push("no task groups found");
  const known = new Set(groups.map((g) => g.n));
  const counted = new Set();
  for (const g of groups) {
    if (counted.has(g.n)) problems.push(`duplicate group ${g.n}`);
    counted.add(g.n);
    if (!fast && g.tasks === 0) problems.push(`group ${g.n} has no tasks`);
    if (!needs(g)) continue;
    for (const d of g.dependsOn) if (!known.has(d)) problems.push(`group ${g.n} depends on unknown group ${d}`);
    if (!fast && g.files.length === 0) problems.push(`group ${g.n} has no Files line`);
  }
  // Kahn-style layering over the groups that need a build; a dependency that does not is satisfied.
  const waves = [];
  let rest = groups.filter(needs);
  const placed = new Set(groups.filter((g) => !needs(g)).map((g) => g.n));
  while (rest.length) {
    const wave = rest.filter((g) => g.dependsOn.every((d) => placed.has(d)));
    if (!wave.length) break;
    waves.push(wave.map((g) => g.n));
    wave.forEach((g) => placed.add(g.n));
    rest = rest.filter((g) => !wave.includes(g));
  }
  // What is left is blocked by an unknown group or sits on or behind a cycle. A depth-first search over every
  // remaining dependency reports each cycle once, even when a group also depends on an unknown group.
  const left = new Map(rest.map((g) => [g.n, g]));
  const state = new Map();
  const trail = [];
  const visit = (n) => {
    state.set(n, 1);
    trail.push(n);
    for (const d of left.get(n).dependsOn) {
      if (!left.has(d)) continue;
      if (state.get(d) === 1) problems.push(`dependency cycle: ${[...trail.slice(trail.indexOf(d)), d].join(" -> ")}`);
      else if (!state.has(d)) visit(d);
    }
    trail.pop();
    state.set(n, 2);
  };
  for (const g of rest) if (!state.has(g.n)) visit(g.n);
  return { groups, waves, problems, structure };
}

function cmdGroups() {
  const change = changeArg("Usage: groups <change> [--json]");
  if (!change) return;
  const { groups, waves, problems } = taskGroups(change);
  const text = [...waves.map((w, i) => `wave ${i + 1}: ${w.join(", ")}`), ...problems].join("\n") || "No groups left to build.";
  print({ ok: problems.length === 0, groups, waves, problems }, text);
  if (problems.length) process.exitCode = 1;
}

function planProblems(change) {
  const run = parseRun(change);
  const problems = [];
  let openQuestions = [];
  const counts = { acs: 0, requirements: 0, tests: 0, scenarios: { unit: 0, integration: 0, e2e: 0 } };
  const acs = taskAcIds(change);
  counts.acs = acs.length;
  const base = path.join(CHANGES_DIR, change);
  if (run.path === "fast") {
    const plan = read(path.join(base, "plan.md"));
    if (plan === null) problems.push("plan.md is missing");
    else {
      const sections = {};
      for (const h of ["What", "Where", "Tests", "Risk", "Open questions"]) {
        sections[h] = markdownSection(plan, h);
        if (sections[h] === null) problems.push(`plan.md has no ${h} section`);
      }
      const covered = new Set();
      for (const t of fastTests(plan)) {
        counts.tests++;
        if (t.level) counts.scenarios[t.level]++;
        if (!t.level) { problems.push(`test line has no level: ${t.raw}`); continue; }
        t.covers.forEach((a) => covered.add(a));
      }
      for (const a of acs) if (!covered.has(a)) problems.push(`${a} is not covered by any test`);
      const lines = (sections["Open questions"] || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      openQuestions = lines.length === 1 && /^(?:[-*]\s+)?none$/i.test(lines[0]) ? [] : lines.map((l) => l.replace(/^[-*]\s+/, ""));
    }
  } else {
    const dir = openspecChangeDir(change);
    if (!dir) problems.push("openspec change folder is missing");
    const covered = new Set();
    for (const { name, covers, scenarios } of dir ? specRequirements(dir) : []) {
      counts.requirements++;
      for (const sc of scenarios) if (sc.level && PLAN_LEVELS.includes(sc.level.toLowerCase())) counts.scenarios[sc.level.toLowerCase()]++;
      if (covers === null) problems.push(`requirement "${name}" has no Covers line`);
      else acIdsIn(covers).forEach((a) => covered.add(a));
      if (!scenarios.length) problems.push(`requirement "${name}" has no scenario`);
      for (const sc of scenarios) {
        if (sc.level === null) problems.push(`scenario "${sc.name}" has no Level line`);
        else if (!PLAN_LEVELS.includes(sc.level.toLowerCase())) problems.push(`scenario "${sc.name}" has an invalid level "${sc.level}"`);
      }
    }
    for (const a of acs) if (!covered.has(a)) problems.push(`${a} is not covered by any requirement`);
    const structure = taskGroups(change).structure;
    const seenGroups = new Set();
    for (const g of structure) {
      if (!g.hasDepends) problems.push(`task group ${g.n} has no Depends on line`);
      if (!g.hasFiles) problems.push(`task group ${g.n} has no Files line`);
      if (g.tasks === 0) problems.push(`task group ${g.n} has no tasks`);
      if (seenGroups.has(g.n)) problems.push(`duplicate task group ${g.n}`);
      seenGroups.add(g.n);
    }
    if (dir && structure.length === 0) problems.push("tasks.md has no task groups");
    const proposal = dir ? read(path.join(dir, "proposal.md")) : null;
    const oq = proposal === null ? null : markdownSection(proposal, "Open Questions");
    openQuestions = (oq || "").split(/\r?\n/).map((l) => /^\s*[-*]\s+(.*\S)\s*$/.exec(l)).filter(Boolean).map((m) => m[1]).filter((t) => !/^none$/i.test(t));
  }
  if (!exists(planBriefPath(base))) problems.push(`${PLAN_BRIEF} is missing`);
  return { problems, openQuestions, counts };
}

function cmdCheckPlan() {
  const change = changeArg("Usage: check-plan <change> [--json]");
  if (!change) return;
  const { problems, openQuestions, counts } = planProblems(change);
  const text = problems.length ? problems.join("\n") : "Plan ok." + openQuestions.map((q) => "\nopen question: " + q).join("");
  print({ ok: problems.length === 0, problems, openQuestions, counts }, text);
  if (problems.length) process.exitCode = 1;
}

// ---------- check-build ----------

// Build report files of a change in reading order: groups by number, then the fast path, then review rounds by number.
function buildReports(dir) {
  const rank = (f) => { const m = /^build-(?:g(\d+)|(fast)|review-(\d+))\.md$/.exec(f); return m ? (m[1] ? [0, Number(m[1])] : m[2] ? [1, 0] : [2, Number(m[3])]) : null; };
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* no change folder */ }
  return names.filter((f) => rank(f)).sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1]; });
}

// Rows of a report's Scenario coverage table: [{ scenario, level, test, screenshot }]. "\|" inside a cell is a literal pipe.
function coverageRows(text) {
  const rows = [];
  for (const line of (markdownSection(text, "Scenario coverage") || "").split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
    if (cells.length < 4 || /^:?-+:?$/.test(cells[0]) || cells[0].toLowerCase() === "scenario") continue;
    const unquote = (c) => c.replace(/^`+|`+$/g, "").trim();
    rows.push({ scenario: cells[0], level: cells[1].toLowerCase(), test: unquote(cells[2]), screenshot: unquote(cells[3]) });
  }
  return rows;
}

const TEST_DIRS = ["test", "tests", "__tests__", "spec"];
const isTestFile = (p) => p.split("/").slice(0, -1).some((d) => TEST_DIRS.includes(d)) || /\.(test|spec)\./.test(path.posix.basename(p)) || /_test\./.test(path.posix.basename(p));
const MOCK_CALLS = ["jest.mock", "jest.fn", "jest.spyOn", "vi.mock", "vi.fn", "vi.spyOn", "sinon", "unittest.mock", "mock.patch", "mock.Mock", "MagicMock", "Mockito", "Moq", "NSubstitute", "gomock", "nock", "@MockBean", "mockk"];

// Mock calls found in a test file, each once. unittest.mock covers its own mock.patch and mock.Mock.
function mockCalls(body) {
  const found = MOCK_CALLS.filter((c) => new RegExp("(?<![\\w])" + c.replace(/[.+?^${}()|[\]\\@]/g, "\\$&") + "(?![\\w])").test(body));
  return found.includes("unittest.mock") ? found.filter((c) => c !== "mock.patch" && c !== "mock.Mock") : found;
}

// Whether a changed file is listed by a Files: entry (or a `## Where` bullet): the first path-like token of the entry, as
// the file itself, a folder holding it, or a glob ("*" within a folder, "**" across folders).
function plannedFile(p, entry) {
  const t = entry.trim();
  const tok = t.startsWith("`") ? t.slice(1).split("`")[0] : (/^[^\s:(]+/.exec(t) || [""])[0];
  const e = tok.split("\\").join("/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!e) return false;
  if (p === e || p.startsWith(e + "/")) return true;
  if (!e.includes("*")) return false;
  const re = e.split("**").map((part) => part.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*");
  return new RegExp("^" + re + "$").test(p);
}

// Real path of root/rel when it is a regular file that stays inside root after links are resolved, else null.
function fileInside(root, rel) {
  try {
    const real = fs.realpathSync.native(path.resolve(root, rel));
    const top = fs.realpathSync.native(root);
    return real.startsWith(top + path.sep) && fs.statSync(real).isFile() ? real : null;
  } catch { return null; }
}

// Checks the build reports of a change against the plan. Problems fail the build; warnings only inform.
// A report row names its scenario "<spec> / <requirement> / <scenario>" (full path) or "fast / <test name> / -" (fast path);
// matching ignores case. Later reports replace earlier rows for the same scenario. Throws when git fails (changedFiles).
function buildProblems(change) {
  const run = parseRun(change);
  const base = path.join(CHANGES_DIR, change);
  const fast = run.path === "fast";
  const problems = [];
  const scopeOf = new Map(); // problem -> every report file it came from
  const add = (msg, file) => { problems.push(msg); if (!scopeOf.has(msg)) scopeOf.set(msg, new Set()); if (file) scopeOf.get(msg).add(file); };
  const warnings = [];
  const planned = [];
  if (fast) {
    for (const t of fastTests(read(path.join(base, "plan.md")) || "")) {
      if (!t.level) continue;
      const name = t.raw.replace(/^[-*]\s+(?:unit|integration|e2e)\s*:\s*/i, "").replace(/\s*\(\s*covers[^)]*\)\s*$/i, "").trim();
      planned.push({ name, key: name.toLowerCase(), level: t.level, text: t.raw });
    }
  } else {
    const dir = openspecChangeDir(change);
    for (const req of dir ? specRequirements(dir) : []) {
      for (const sc of req.scenarios) planned.push({ name: sc.name, key: `${req.spec} / ${req.name} / ${sc.name}`.toLowerCase(), req: `${req.spec} / ${req.name}`.toLowerCase(), level: (sc.level || "").toLowerCase(), text: sc.text });
    }
  }
  const norm = (x) => x.replace(/\s+/g, " ").trim().toLowerCase();
  const matches = (row, sc) => {
    const k = norm(row.scenario);
    return fast ? k.replace(/^fast \/ /, "").replace(/ \/ -$/, "") === norm(sc.key) : k === norm(sc.key) || k.endsWith(" / " + norm(sc.key));
  };
  const rows = [];
  for (const file of buildReports(base)) {
    const text = read(path.join(base, file)) || "";
    rows.push(...coverageRows(text).map((r) => ({ ...r, file })));
    if (/^blocked$/i.test(headerValue(text, "Status") || "")) {
      const m = /^build-(?:g(\d+)|(fast)|(review-\d+))\.md$/.exec(file);
      add(`${m[1] ? `group ${m[1]}` : m[2] ? "fast" : m[3]} build is blocked`, file);
    }
  }
  if (!fast) {
    const reported = new Set(buildReports(base));
    for (const g of taskGroups(change).groups) if (g.done && !reported.has(`build-g${g.n}.md`)) add(`group ${g.n} has no build report`, `build-g${g.n}.md`);
  }

  // The latest fix round must answer every blocking R/S finding of its review round (ruling R9 b), so the retry fixes it
  // before the next review instead of round k+1's check-review failing on every re-run.
  const fixRounds = buildReports(base).map((f) => /^build-review-(\d+)\.md$/.exec(f)).filter(Boolean).map((m) => Number(m[1]));
  if (fixRounds.length) {
    const k = Math.max(...fixRounds);
    const file = `build-review-${k}.md`;
    const answered = new Set(reviewAnswers(change, k).map((a) => a.id));
    for (const [name, fits] of [[`review-${k}.md`, REVIEW_ID], [`security-review-${k}.md`, SECURITY_ID]]) {
      for (const f of roundFindings(read(path.join(base, name)) || "") || []) {
        if (fits.test(f.id) && f.severity.toLowerCase() === "blocking" && !answered.has(f.id)) add(`${file}: blocking finding ${f.id} of review-${k} has no answer`, file);
      }
    }
  }

  // Full path: the group reports with a row for some scenario of each requirement, so a scenario with no row can go to them.
  const reqGroups = new Map();
  if (!fast) {
    for (const sc of planned) {
      for (const r of rows.filter((x) => /^build-g\d+\.md$/.test(x.file) && matches(x, sc))) {
        if (!reqGroups.has(sc.req)) reqGroups.set(sc.req, new Set());
        reqGroups.get(sc.req).add(r.file);
      }
    }
  }
  for (const sc of planned) {
    const row = rows.filter((r) => matches(r, sc)).pop();
    if (!row) {
      const msg = `scenario "${sc.name}" has no test`;
      add(msg, null);
      for (const file of reqGroups.get(sc.req) || []) scopeOf.get(msg).add(file);
      continue;
    }
    if (sc.level && row.level !== sc.level) add(`scenario "${sc.name}" test at level ${row.level}, planned ${sc.level}`, row.file);
    const at = row.test.indexOf("::");
    const file = at < 0 ? "" : row.test.slice(0, at).trim();
    const name = at < 0 ? "" : row.test.slice(at + 2).trim();
    if (!file || !name) add(`scenario "${sc.name}" test cell is not <path>::<name>`, row.file);
    else {
      const abs = fileInside(ROOT, file);
      if (!abs) add(`test file not found: ${file}`, row.file);
      else {
        const body = read(abs) || "";
        if (!name.split("::").every((part) => part.trim() && body.includes(part.trim()))) add(`test "${name}" not found in ${file}`, row.file);
        if (sc.level === "integration" || sc.level === "e2e") for (const call of mockCalls(body)) warnings.push(`mocking in ${sc.level} test: ${file} (${call})`);
      }
    }
    if (row.screenshot && row.screenshot !== "-") {
      const prefix = `.groundwork/changes/${change}/`;
      const rel = row.screenshot.startsWith(prefix) ? row.screenshot.slice(prefix.length) : row.screenshot;
      if (!rel.startsWith("evidence/") || !/\.png$/i.test(rel) || !fileInside(path.join(base, "evidence"), rel.slice("evidence/".length))) add(`screenshot not found: ${row.screenshot}`, row.file);
    } else if (sc.level === "e2e" && (/\bscreens?\b/i.test(sc.text) || /\bpages?\b/i.test(sc.text) || /\bUI\b/.test(sc.text))) add(`e2e scenario "${sc.name}" has no screenshot`, row.file);
  }

  const listed = taskGroups(change).groups.flatMap((g) => g.files);
  for (const f of changedFiles().files) {
    // openspec/ holds the plan and, after the pre-delivery archive, the merged specs and the archive folder (ruling R12 c).
    if (f.status === "D" || isTestFile(f.path) || f.path.startsWith("openspec/")) continue;
    if (!listed.some((e) => plannedFile(f.path, e))) warnings.push(`unplanned file: ${f.path}`);
  }
  // Where a retry goes: each group, the fast path or review round whose report produced a problem, with its own problems
  // (a message two reports produced goes to both). A scenario with no test goes, on the full path, to the groups whose reports
  // cover another scenario of its requirement, and on the fast path to fast. A problem left without a report is unmapped.
  const retry = { groups: [], fast: null, reviews: [], unmapped: [] };
  const entry = (list, key, id) => { let e = list.find((x) => x[key] === id); if (!e) { e = { [key]: id, problems: [] }; list.push(e); } return e; };
  for (const msg of new Set(problems)) {
    const files = [...scopeOf.get(msg)];
    if (!files.length) {
      if (fast) (retry.fast = retry.fast || { problems: [] }).problems.push(msg);
      else retry.unmapped.push(msg);
    }
    for (const file of files) {
      const m = /^build-(?:g(\d+)|(fast)|review-(\d+))\.md$/.exec(file);
      if (m[1]) entry(retry.groups, "n", Number(m[1])).problems.push(msg);
      else if (m[2]) (retry.fast = retry.fast || { problems: [] }).problems.push(msg);
      else entry(retry.reviews, "round", Number(m[3])).problems.push(msg);
    }
  }
  retry.groups.sort((x, y) => x.n - y.n);
  retry.reviews.sort((x, y) => x.round - y.round);
  return { problems: [...new Set(problems)], warnings: [...new Set(warnings)], retry };
}

function cmdCheckBuild() {
  const change = changeArg("Usage: check-build <change> [--json]");
  if (!change) return;
  const { problems, warnings, retry } = buildProblems(change);
  const lines = [...problems.map((p) => `error: ${p}`), ...warnings.map((w) => `warning: ${w}`)];
  print({ ok: problems.length === 0, problems, warnings, retry }, problems.length ? lines.join("\n") : ["Build ok.", ...lines].join("\n"));
  if (problems.length) process.exitCode = 1;
}

// Re-checks the plan approval before build: the last approved plan row must carry the fingerprint of the plan as it is now.
function cmdCheckGate() {
  const change = changeArg("Usage: check-gate <change> --gate plan [--json]");
  if (!change) return;
  if (opt("gate") !== "plan") {
    console.error("Usage: check-gate <change> --gate plan [--json]  (only the plan gate exists)");
    process.exitCode = 2;
    return;
  }
  const run = parseRun(change);
  const fail = (reason) => { print({ ok: false, reason }, reason); process.exitCode = 1; };
  const row = lastPlanApproval(run);
  if (!row) return fail("no plan approval");
  if (!row.fingerprint) return fail("plan approval has no fingerprint");
  let fp;
  try { fp = planFingerprint(run); } catch (e) { return fail(`cannot compute plan fingerprint: ${e.message}`); }
  if (fp !== row.fingerprint) return fail("plan changed after approval");
  print({ ok: true, reason: "" }, "Plan approval is current.");
}

const EXPLORE_HEADINGS = ["Task", "Path recommendation", "Sensitive", "Affected specs", "Relevant code", "Impact", "Patterns to follow", "Constraints", "Tests", "History", "Open questions"];

// Header of explore.md (the lines before the first "## " heading): path "full"|"fast"|null from `Path: <p> (recommended)`,
// sensitive true|false|null from `Sensitive: yes|no`; lines are all lines of the file.
function exploreHeader(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const hi = lines.findIndex((l) => l.startsWith("## "));
  const header = hi < 0 ? lines : lines.slice(0, hi);
  const pm = header.map((l) => /^Path: (full|fast) \(recommended\)$/.exec(l)).find(Boolean);
  const sm = header.map((l) => /^Sensitive: (yes|no)$/.exec(l)).find(Boolean);
  return { lines, path: pm ? pm[1] : null, sensitive: sm ? sm[1] === "yes" : null };
}

function cmdCheckExplore() {
  const change = changeArg("Usage: check-explore <change> [--json]");
  if (!change) return;
  const text = read(path.join(CHANGES_DIR, change, "explore.md"));
  if (text === null) {
    const msg = `no explore.md for change "${change}"`;
    print({ path: null, sensitive: null, problems: [msg] }, msg);
    process.exitCode = 1;
    return;
  }
  const { lines, path: recommended, sensitive } = exploreHeader(text);
  const problems = [];
  if (!recommended) problems.push("header line must be exactly `Path: full (recommended)` or `Path: fast (recommended)`");
  if (sensitive === null) problems.push("header line must be exactly `Sensitive: yes` or `Sensitive: no`");
  for (const h of EXPLORE_HEADINGS) if (!lines.includes(`## ${h}`)) problems.push(`missing heading: ## ${h}`);
  const out = { path: recommended, sensitive, problems };
  print(out, problems.length ? problems.join("\n") : `Path: ${out.path}  Sensitive: ${sensitive ? "yes" : "no"}`);
  if (problems.length) process.exitCode = 1;
}

function cmdCheckRefined() {
  const change = changeArg("Usage: check-refined <change> [--json]");
  if (!change) return;
  try {
    const r = refinedState(change);
    print(r, r.refinement ? `${r.refinement}  ready: ${r.ready}  unchanged: ${r.unchanged}` : "No refinement.");
  } catch (e) { print({ error: e.message }, e.message); process.exitCode = 1; }
}

// Acceptance criteria text as a list: list lines are separate criteria (continuation lines join the previous one), else the whole trimmed text is one.
function criteriaOf(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const marker = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
  if (!lines.some((l) => marker.test(l))) return { pre: [], items: text.trim() ? [text.trim()] : [] };
  const pre = [];
  const items = [];
  for (const l of lines) {
    const m = marker.exec(l);
    if (m) items.push([m[1].trim()]);
    else if (l.trim()) (items.length ? items[items.length - 1] : pre).push(l.trim());
  }
  return { pre, items: items.map((parts) => parts.filter(Boolean).join("\n")).filter(Boolean) };
}

// Ticket text is untrusted: a line that starts with "#" must not become a heading in task.md.
const escapeHeadings = (text) => String(text).replace(/^([ \t]*#)/gm, "\\$1");

function renderTask(s) {
  if (s.kind === "prompt") {
    const title = (s.prompt.split(/\r?\n/).find((l) => l.trim()) || "").trim().slice(0, 80);
    return `Source: prompt\n\n# ${title}\n\n## Description\n${escapeHeadings(s.prompt.trim())}\n`;
  }
  const c = criteriaOf(s.acceptanceCriteria);
  const pre = c.pre.length ? `${escapeHeadings(c.pre.join("\n"))}\n` : "";
  const acs = c.items.map((t, i) => `### AC${i + 1}\n${escapeHeadings(t)}\n`).join("");
  const summary = s.summary.replace(/\s+/g, " ").trim();
  return `Source: ticket ${s.key}\nURL: ${s.url || "none"}\n\n# ${summary}\n\n## Description\n${escapeHeadings(s.description.trim())}\n\n## Acceptance criteria\n${pre}${acs}`;
}

function cmdTask() {
  const change = changeArg("Usage: task <change> [--json]");
  if (!change) return;
  try {
    const st = refinedState(change);
    const ticket = st.ready && st.unchanged ? read(path.join(REF_DIR, st.refinement, "ticket.md")) : null;
    const text = ticket !== null ? `Source: refinement ${st.refinement}\n\n${ticket}` : renderTask(changeSource(change));
    const file = path.join(CHANGES_DIR, change, "task.md");
    fs.writeFileSync(file, text);
    print({ path: rel(file) }, rel(file));
  } catch (e) { print({ error: e.message }, e.message); process.exitCode = 1; }
}

function cmdHistory() {
  const usage = "Usage: history <change> [--max <n>] [--json]  (n: a positive number)";
  const change = changeArg(usage);
  if (!change) return;
  const maxRaw = opt("max");
  const max = maxRaw === undefined ? 100 : /^[0-9]+$/.test(maxRaw) ? Number(maxRaw) : 0;
  if (max < 1) { console.error(usage); process.exitCode = 2; return; }
  const file = path.join(CHANGES_DIR, change, "history.md");
  const head = gitRaw(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  let text = "No commits yet.\n";
  if (head.ok && head.out.trim()) {
    // Each commit starts at \x01; with -z the file names follow the format line, separated by NUL.
    let log;
    try { log = gitMust(["log", "-z", "--name-only", `-n${max}`, "--date=short", "--format=%x01%h%x02%ad%x02%an%x02%s"]).out; } catch (e) { print({ error: e.message }, e.message); process.exitCode = 1; return; }
    text = log.split("\x01").filter(Boolean).map((chunk) => {
      const [first, ...files] = chunk.split("\0");
      const [sha, date, author, ...subject] = first.split("\x02");
      const paths = files.map((f) => f.replace(/^\n+/, "")).filter(Boolean);
      return `## ${sha} ${date} ${author}\n${subject.join("\x02").trim()}\nFiles:\n${paths.map((p) => `- ${p}\n`).join("")}`;
    }).join("\n");
  }
  fs.writeFileSync(file, text);
  print({ path: rel(file) }, rel(file));
}

const PRIVATE_V4 = [[0, 0, 8], [127, 0, 8], [10, 0, 8], [172, 16, 12], [192, 168, 16], [169, 254, 16]];

// Reason a URL must not be fetched, or null. Looks at the parsed host only; DNS is never resolved.
function refRejection(u) {
  if (u.protocol !== "http:" && u.protocol !== "https:") return `scheme ${u.protocol.replace(":", "")} is not http or https`;
  if (u.username || u.password) return "URL contains credentials";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return "localhost";
  const v4 = (n) => {
    const ip = ((n[0] << 24) | (n[1] << 16) | (n[2] << 8) | n[3]) >>> 0;
    return PRIVATE_V4.some(([a, b, bits]) => ((ip & ((0xffffffff << (32 - bits)) >>> 0)) >>> 0) === ((a << 24) | (b << 16)) >>> 0);
  };
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (m && v4(m.slice(1).map(Number))) return "private or link-local address";
  if (host.startsWith("[")) {
    // WHATWG normalises IPv6 to compressed hex groups; expand to 8 groups.
    const body = host.slice(1, -1);
    const [head, tail] = body.split("::");
    const hs = head ? head.split(":") : [];
    const ts = tail === undefined ? [] : tail ? tail.split(":") : [];
    const groups = (tail === undefined ? hs : [...hs, ...Array(8 - hs.length - ts.length).fill("0"), ...ts]).map((g) => parseInt(g, 16));
    if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return "unrecognised IPv6 address";
    if (groups.every((g) => g === 0)) return "unspecified address";
    if (groups[0] === 0x2002) return "6to4 address";
    if (groups[0] === 0x2001 && groups[1] === 0) return "Teredo address";
    if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 1) return "NAT64 local-use address";
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return "loopback address";
    if (groups.slice(0, 6).every((g) => g === 0)) return "IPv4-compatible address";
    if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) return "NAT64 address";
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff && v4([groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255])) return "private or link-local address";
    if ((groups[0] & 0xffc0) === 0xfe80) return "link-local address";
    if ((groups[0] & 0xfe00) === 0xfc00) return "unique-local address";
  }
  return null;
}

function cmdRefs() {
  const change = changeArg("Usage: refs <change> [--ref <url> ...] [--json]");
  if (!change) return;
  const cfg = loadConfig();
  const trusted = ((cfg.context && cfg.context.trustedDomains) || []).filter((d) => typeof d === "string" && d.trim()).map((d) => d.trim().toLowerCase().replace(/^\*\./, "").replace(/^\./, "")).filter(Boolean);
  const candidates = [];
  rest.forEach((a, i) => {
    if (a === "--ref" && rest[i + 1] && !rest[i + 1].startsWith("--")) candidates.push({ url: rest[i + 1].trim(), reason: "given with --ref" });
    else if (a.startsWith("--ref=")) candidates.push({ url: a.slice(6).trim(), reason: "given with --ref" });
  });
  const task = read(path.join(CHANGES_DIR, change, "task.md")) || "";
  for (const raw of task.match(/https?:\/\/[^\s<>"')\]]+/gi) || []) {
    const url = raw.replace(/[.,;:!?]+$/, "");
    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch { continue; }
    const d = trusted.find((t) => host === t || host.endsWith(`.${t}`));
    if (d) candidates.push({ url, reason: `link in task.md on trusted domain ${d}` });
  }
  const refs = [];
  const rejected = [];
  const seen = new Set();
  for (const c of candidates) {
    let u;
    try { u = new URL(c.url); } catch { u = null; }
    const id = u ? u.href : c.url;
    if (seen.has(id)) continue;
    seen.add(id);
    if (!u) { rejected.push({ url: c.url, reason: "not a valid URL" }); continue; }
    const why = refRejection(u);
    if (why) { rejected.push({ url: c.url, reason: why }); continue; }
    if (refs.length >= 10) { rejected.push({ url: c.url, reason: "more than 10 references" }); continue; }
    const via = cfg.tracker && cfg.tracker.type === "jira" && u.hostname.toLowerCase().endsWith(".atlassian.net") && u.pathname.startsWith("/wiki/") ? "intake" : "fetch";
    refs.push({ url: c.url, via, reason: c.reason });
  }
  print({ refs, rejected }, [...refs.map((r) => `${r.via}  ${r.url}`), ...rejected.map((r) => `rejected  ${r.url}  (${r.reason})`)].join("\n") || "No references.");
}

// ---------- snapshot and check-scope ----------

// Allowed paths per change stage (spec 9.2). <c> is .groundwork/changes/<change>/; "/**" matches by prefix, "*" matches within a segment.
const STAGE_SCOPE = {
  intake: ["<c>source.json", "<c>context/**"],
  fetch: ["<c>context/**"],
  explore: ["<c>explore.md"],
  plan: ["openspec/changes/<change>/**", "<c>plan.md", "<c>gate-plan.md"],
  build: ["<c>build-*.md", "<c>evidence/**"],
  review: ["<c>review-*.md", "<c>security-review-*.md"],
  deliver: ["<c>deliver.md"],
};

// The plan's one-page brief. Claude Code refuses a subagent's Write of a .md file whose name starts with report, summary,
// findings or analysis, so gw-plan writes gate-plan.md; a change planned before 0.2.3 keeps its summary.md, which is read
// (and fingerprinted under its own name) while no gate-plan.md exists.
const PLAN_BRIEF = "gate-plan.md", PLAN_BRIEF_V022 = "summary.md";
function planBriefPath(base) {
  const now = path.join(base, PLAN_BRIEF), old = path.join(base, PLAN_BRIEF_V022);
  return !exists(now) && exists(old) ? old : now;
}

// Allowed paths per refinement stage. <r> is .groundwork/refinements/<key>/.
const REFINEMENT_SCOPE = {
  intake: ["<r>source.json"],
  refine: ["<r>ticket.md"],
};

// The audit report: audit-result.md (a subagent cannot Write a report*.md, see tuneReport()); report.md before 0.2.3.
const AUDIT_RESULT = ".groundwork/audit/audit-result.md", AUDIT_REPORT_V022 = ".groundwork/audit/report.md";

// The one file each auditor stage may write. Its snapshots live at .groundwork/audit/snapshots/<stage>.json.
const AUDIT_SCOPE = {
  audit: AUDIT_RESULT,
  tune: ".groundwork/tune/proposal.md",
};

const sha256 = (b) => `sha256:${createHash("sha256").update(b).digest("hex")}`;

// Segment glob: "*" matches within one path segment.
function globMatch(pat, p) {
  return new RegExp("^" + pat.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$").test(p);
}

// Files changed against `base` (as recorded by the snapshot), hashed. The snapshots folder is the gate's own and never counts.
function scopeFiles(target, base) {
  const paths = new Map(changedFiles({ includeGroundwork: true, base }).files.map((f) => [f.path, f.status]));
  if (target.kind === "change") {
    const tasks = `openspec/changes/${target.key}/tasks.md`;
    if (exists(path.join(ROOT, tasks))) paths.set(tasks, "M");
  }
  const skip = `${target.rel}snapshots/`;
  // The audit target shares .groundwork/ with everything else, so only gw.mjs's own two snapshot files are left out.
  const isSnapshot = (p) => (target.kind === "audit" ? Object.keys(AUDIT_SCOPE).some((s) => p === `${skip}${s}.json`) : p.startsWith(skip));
  const files = {};
  for (const [p, status] of paths) {
    if (isSnapshot(p)) continue;
    if (status === "D") { files[p] = { hash: "deleted" }; continue; }
    const buf = worktreeBytes(p);
    const entry = { hash: sha256(normalizeBytes(buf)) };
    if (p === "tasks.md" || p.endsWith("/tasks.md")) entry.norm = sha256(normalizeBytes(normalizeForHash(p, buf.toString("utf8"))));
    files[p] = entry;
  }
  return files;
}

// Writes git cannot see in the working-tree diff: hooks, info/exclude, config, and index flags that hide files.
// Limitations: gitignored files are out of scope; a stage can write them unnoticed. Edits inside an untracked nested repository
// are not detected; only a commit there is (its HEAD changes the marker).
function gitState() {
  // rev-parse only prints a path here. It is called without the hooksPath override so that the real hooks folder is the one hashed.
  const gitPath = (p) => {
    const r = spawnSync("git", ["rev-parse", "--git-path", p], { cwd: ROOT, encoding: "utf8" });
    if (r.error || r.status !== 0) throw new Error(`git rev-parse --git-path ${p} failed: ${(r.error ? r.error.message : (r.stderr || "").trim()) || "exit " + r.status}`);
    return path.resolve(ROOT, r.stdout.trim());
  };
  const files = {};
  // lstat, never following links: a symlink is recorded by its target, other non-regular entries by type.
  const entryHash = (abs) => {
    try {
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) return sha256(Buffer.from(`link:${fs.readlinkSync(abs)}`));
      if (st.isFile()) return sha256(fs.readFileSync(abs));
      if (st.isDirectory()) return null;
      return sha256(Buffer.from(`special:${st.isFIFO() ? "fifo" : st.isSocket() ? "socket" : "other"}`));
    } catch (e) {
      if (e.code === "ENOENT") return undefined;
      throw Object.assign(new Error(`cannot read ${abs}: ${e.message}`), { code: e.code });
    }
  };
  const hookTree = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) hookTree(abs, `${prefix}${e.name}/`);
      else { const h = entryHash(abs); if (h) files[`${prefix}${e.name}`] = h; }
    }
  };
  const hooks = gitPath("hooks");
  const hooksTop = entryHash(hooks);
  if (hooksTop) files[".git/hooks"] = hooksTop;
  if (exists(hooks) && fs.statSync(hooks).isDirectory()) hookTree(hooks, ".git/hooks/");
  for (const [name, p] of [[".git/info/exclude", "info/exclude"], [".git/config", "config"], [".git/config.worktree", "config.worktree"], [".git/info/attributes", "info/attributes"]]) {
    const h = entryHash(gitPath(p));
    if (h) files[name] = h;
  }
  // Agent and harness config that git may ignore or that lives outside the repository. ~/.claude.json is left out: Claude Code rewrites it constantly.
  // Home entries (outside the repository) record an unreadable file as "error: <code>" instead of failing the snapshot.
  const cfgHash = (abs, key) => {
    let h;
    try { h = entryHash(abs); } catch (e) { if (!key.startsWith("home:")) throw e; h = `error: ${e.code || "unreadable"}`; }
    if (h) files[key] = h;
  };
  const cfgTree = (dir, prefix) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) cfgTree(abs, `${prefix}${e.name}/`);
      else cfgHash(abs, `${prefix}${e.name}`);
    }
  };
  const cfgSet = (base, label, names, dirs) => {
    for (const n of names) cfgHash(path.join(base, n), `${label}:${n}`);
    for (const d of dirs) cfgTree(path.join(base, d), `${label}:${d}/`);
  };
  cfgSet(ROOT, "config", [".claude/settings.json", ".claude/settings.local.json", ".mcp.json"], [".claude/agents", ".claude/commands", ".claude/skills", ".claude/hooks"]);
  cfgSet(process.env.GW_HOME_OVERRIDE || homedir(), "home", [".claude/settings.json", ".claude/settings.local.json", ".claude/CLAUDE.md"], [".claude/agents", ".claude/commands", ".claude/skills"]);
  // Git config and attributes outside the repository can define filters that the next git call runs. They are home: entries,
  // so a change asks the user. Recorded, with "absent" for a missing file:
  // - every file `git config --list --show-origin` reports (system, global, XDG, include files that exist);
  // - the default global locations, the system locations git would use, and $GIT_CONFIG_SYSTEM / $GIT_CONFIG_GLOBAL when set;
  // - every include.path / includeIf.<cond>.path target of any of these files or of the repository's own config, whatever the
  //   condition and whether or not the target exists, followed up to 10 levels deep.
  // A listing git fails to produce is an "error: ..." entry, never silently left out. GW_HOME_OVERRIDE also replaces
  // XDG_CONFIG_HOME, so tests never read the real home.
  const home = process.env.GW_HOME_OVERRIDE || homedir();
  const xdg = process.env.GW_HOME_OVERRIDE ? path.join(home, ".config") : (process.env.XDG_CONFIG_HOME || path.join(home, ".config"));
  const inside = (abs, dir) => { const r = path.relative(dir, abs); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
  const homeLabel = (abs) => `home:${inside(abs, home) ? path.relative(home, abs).split(path.sep).join("/") : abs.split(path.sep).join("/")}`;
  const gitDir = path.dirname(gitPath("config"));
  // git config with its exit status: 1 means "nothing found" (or, with --file, a missing file); anything else non-zero failed.
  const gitConfig = (args) => {
    const r = spawnSync("git", gitArgs(["config", ...args]), { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { status: r.error ? -1 : r.status, out: r.stdout || "", err: (r.error ? r.error.message : String(r.stderr || "")).trim().split(/\r?\n/)[0] };
  };
  // Labels of files git reads as config or attributes, wherever they are: a change to one can define a filter the next git call runs.
  const gitSources = new Set();
  const source = (label, value) => { files[label] = value; gitSources.add(label); };
  const failed = (label, r) => source(label, `error: ${r.err || `exit ${r.status}`}`);
  // Outside the repository a file we cannot read (EACCES, EPERM, ENOTDIR, ...) is recorded as "error: <code>", so one odd
  // path on a machine never fails every snapshot; a change to or from it is still a violation. Inside the repository or its
  // git dir (an include target there), the error still fails the snapshot.
  const hashAt = (abs, recordAbsent) => {
    let h;
    try { h = entryHash(abs); } catch (e) {
      if (inside(abs, gitDir) || inside(abs, ROOT)) throw e;
      source(homeLabel(abs), `error: ${e.code || "unreadable"}`);
      return;
    }
    if (h) source(homeLabel(abs), h);
    else if (h === undefined && recordAbsent) source(homeLabel(abs), "absent");
  };
  const sources = [];
  const origins = gitConfig(["--list", "--show-origin", "-z"]);
  if (origins.status === 0) {
    const parts = origins.out.split("\0");
    for (let i = 0; i < parts.length; i += 2) {
      if (!parts[i].startsWith("file:")) continue;
      const abs = path.resolve(ROOT, parts[i].slice(5));
      sources.push(abs);
      if (!inside(abs, gitDir)) hashAt(abs, false); // the repository's own config files are hashed above
    }
  } else failed("home:(git config --list)", origins);
  const attributesFile = gitConfig(["--path", "--get", "core.attributesFile"]);
  if (attributesFile.status === 0 && attributesFile.out.trim()) hashAt(path.resolve(ROOT, attributesFile.out.trim()), true);
  else if (attributesFile.status !== 1 && attributesFile.status !== 0) failed("home:(core.attributesFile)", attributesFile);
  const execPath = gitRaw(["--exec-path"]).out.trim();
  const defaults = [path.join(home, ".gitconfig"), path.join(xdg, "git", "config"), path.join(xdg, "git", "attributes")];
  if (execPath) defaults.push(path.resolve(execPath, "..", "..", "etc", "gitconfig"));
  if (process.platform === "win32") {
    if (execPath) defaults.push(path.resolve(execPath, "..", "..", "..", "etc", "gitconfig"));
    if (process.env.PROGRAMDATA) defaults.push(path.join(process.env.PROGRAMDATA, "Git", "config"));
  } else defaults.push("/etc/gitconfig");
  for (const v of ["GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL"]) if (process.env[v]) defaults.push(path.resolve(ROOT, process.env[v]));
  for (const p of defaults) { hashAt(p, true); sources.push(p); }
  sources.push(gitPath("config"), gitPath("config.worktree"));
  const followed = new Set();
  const followIncludes = (file, depth) => {
    const key = canonPath(file);
    if (depth > 10 || followed.has(key)) return;
    followed.add(key);
    const r = gitConfig(["--file", file, "--no-includes", "-z", "--get-regexp", "^include(if\\..*)?\\.path$"]);
    if (r.status === 1) return; // no includes, or the file does not exist
    if (r.status !== 0) return failed(`${homeLabel(file)} (includes)`, r);
    for (const rec of r.out.split("\0").filter(Boolean)) {
      const nl = rec.indexOf("\n");
      const v = nl < 0 ? "" : rec.slice(nl + 1).trim();
      if (!v) continue;
      const target = /^~[\\/]/.test(v) ? path.join(home, v.slice(2)) : path.resolve(path.dirname(file), v);
      hashAt(target, true);
      followIncludes(target, depth + 1);
    }
  };
  for (const s of sources) followIncludes(s, 0);
  const flagged = gitMust(["ls-files", "-v", "-z"]).out.split("\0").filter(Boolean)
    .filter((e) => e[0] === "S" || e[0] !== e[0].toUpperCase())
    .map((e) => e.slice(2).split("\\").join("/")).sort();
  return { files, indexFlags: flagged, gitSources: [...gitSources].sort() };
}

function gitHead() {
  const r = gitRaw(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  return r.ok && r.out.trim() ? r.out.trim() : null;
}

function inScope(stage, target, p) {
  if (target.kind === "audit") return p === AUDIT_SCOPE[stage];
  const change = target.key;
  const c = target.rel;
  if (target.kind === "refinement") {
    return REFINEMENT_SCOPE[stage].some((pat0) => p === pat0.split("<r>").join(c));
  }
  if (stage === "build" && !(p === ".groundwork" || p.startsWith(".groundwork/") || p === "openspec" || p.startsWith("openspec/"))) return true;
  for (const pat0 of STAGE_SCOPE[stage]) {
    const pat = pat0.split("<c>").join(c).split("<change>").join(change);
    if (pat.endsWith("/**")) { if (p.startsWith(pat.slice(0, -2))) return true; }
    else if (pat.includes("*")) { if (globMatch(pat, p)) return true; }
    else if (p === pat) return true;
  }
  return false;
}

// Returns { target: { kind, key, dir, rel }, stage }, or null after printing the error.
function scopeArgs(usage) {
  const hasRef = rest.some((x) => x === "--refinement" || x.startsWith("--refinement="));
  if (rest.some((x) => x === "--audit" || x.startsWith("--audit="))) {
    const stage = opt("audit");
    if (!stage || positional.length || hasRef || !Object.hasOwn(AUDIT_SCOPE, stage)) {
      console.error(stage && !positional.length && !hasRef ? `Unknown stage "${stage}". Stages: ${Object.keys(AUDIT_SCOPE).join(", ")}` : usage);
      process.exitCode = 2;
      return null;
    }
    return { target: { kind: "audit", key: stage, dir: path.join(GW_DIR, "audit"), rel: ".groundwork/audit/" }, stage };
  }
  const key = hasRef ? opt("refinement") : positional[0];
  const stage = hasRef ? positional[0] : positional[1];
  const stages = hasRef ? REFINEMENT_SCOPE : STAGE_SCOPE;
  if (!key || !stage || !stages[stage] || (hasRef && !validRefinementKey(key))) {
    console.error(key && stage && (!hasRef || validRefinementKey(key)) ? `Unknown stage "${stage}". Stages: ${Object.keys(stages).join(", ")}` : usage);
    process.exitCode = 2;
    return null;
  }
  if (hasRef) {
    if (!parseRefinement(key)) { print({ error: "not found" }, `No refinement named "${key}".`); process.exitCode = 1; return null; }
    return { target: { kind: "refinement", key, dir: path.join(REF_DIR, key), rel: `.groundwork/refinements/${key}/` }, stage };
  }
  if (!parseRun(key)) { print({ error: "not found" }, `No change named "${key}". Run /groundwork list.`); process.exitCode = 1; return null; }
  return { target: { kind: "change", key, dir: path.join(CHANGES_DIR, key), rel: `.groundwork/changes/${key}/` }, stage };
}

function cmdSnapshot() {
  const a = scopeArgs("Usage: snapshot <change> <stage> [--json]  or  snapshot --refinement <key> <stage> [--json]  or  snapshot --audit <audit|tune> [--json]");
  if (!a) return;
  let body;
  try {
    const base = changedFiles({ includeGroundwork: true }).base;
    body = JSON.stringify({ stage: a.stage, base, head: gitHead(), git: gitState(), files: scopeFiles(a.target, base) }, null, 2) + "\n";
  } catch (e) {
    print({ error: e.message }, e.message);
    process.exitCode = 1;
    return;
  }
  const dir = path.join(a.target.dir, "snapshots");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${a.stage}.json`);
  fs.writeFileSync(file, body);
  const hash = sha256(Buffer.from(body, "utf8"));
  print({ stage: a.stage, path: rel(file), sha256: hash }, `snapshot ${a.stage}: ${hash}`);
}

function cmdCheckScope() {
  const usage = "Usage: check-scope <change> <stage> [--expect sha256:<hex>] [--json]  or  check-scope --refinement <key> <stage> [--expect sha256:<hex>] [--json]  or  check-scope --audit <audit|tune> [--expect sha256:<hex>] [--json]";
  const hasExpect = rest.some((x) => x === "--expect" || x.startsWith("--expect="));
  const expect = opt("expect");
  if (hasExpect && !/^sha256:[0-9a-f]{64}$/.test(expect || "")) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  const a = scopeArgs(usage);
  if (!a) return;
  const { target, stage } = a;
  const change = target.key;
  const fail = (msg) => { print({ error: msg }, msg); process.exitCode = 1; };
  const snapFile = path.join(target.dir, "snapshots", `${stage}.json`);
  const raw = fs.existsSync(snapFile) ? fs.readFileSync(snapFile) : null;
  if (raw === null) return fail(`no snapshot for stage "${stage}": run gw.mjs snapshot first`);
  if (hasExpect && sha256(raw) !== expect) return fail("snapshot was modified");
  let snap = null;
  try { snap = JSON.parse(raw.toString("utf8")); } catch {}
  if (!isPlainObject(snap) || !isPlainObject(snap.files) || !isPlainObject(snap.git)) return fail(`snapshot for stage "${stage}" is unreadable`);
  const violations = [];
  try {
    // Git state first: a rewritten .git/config or hook must be reported before any worktree git command runs.
    const g = gitState();
    for (const p of new Set([...Object.keys(snap.git.files || {}), ...Object.keys(g.files)])) {
      if ((snap.git.files || {})[p] !== g.files[p]) violations.push(p);
    }
    if (JSON.stringify(g.indexFlags) !== JSON.stringify(snap.git.indexFlags || [])) violations.push("git-index-flags");
    if (violations.some((v) => !/^(config|home):/.test(v))) return reportScope(stage, violations);
    // config: and home: violations are merged with the worktree's, so the "did you make this change?" question never hides a source
    // write. The exception: a changed file git reads as config or attributes, wherever it is, can define a filter that the next worktree
    // git command runs, so none runs. "worktree-not-checked" is neither config: nor home:, so that question does not apply and the stage stops.
    const sources = new Set([...(snap.git.gitSources || []), ...g.gitSources]);
    const changedSources = violations.filter((v) => sources.has(v));
    if (changedSources.length) {
      return reportScope(stage, [...violations, "worktree-not-checked"],
        `worktree-not-checked means no worktree file was checked, because git could run a filter that a changed git config file defines. Revert ${changedSources.join(", ")}, then run the stage again.`);
    }
    if (gitHead() !== (snap.head ?? null)) return fail(`HEAD moved during stage "${stage}"`);
    const state = [...violations];
    const now = scopeFiles(target, snap.base ?? null);
    for (const p of new Set([...Object.keys(snap.files), ...Object.keys(now)])) {
      const before = snap.files[p];
      const after = now[p];
      if (before && after && before.hash === after.hash) continue;
      if (inScope(stage, target, p)) continue;
      const isTasks = target.kind === "change" && p === `openspec/changes/${change}/tasks.md`;
      if (stage === "build" && isTasks && before && after && before.norm && before.norm === after.norm) continue;
      // A config file git also sees is one violation, under gitState's config: name, so the question about config changes still applies
      // to it. A worktree path is never taken for such a name: one that starts like it is shown as ./<path>.
      if (state.includes(`config:${p}`)) continue;
      violations.push(/^(config|home):/i.test(p) ? `./${p}` : p);
    }
  } catch (e) {
    return fail(e.message);
  }
  reportScope(stage, violations);
}

function reportScope(stage, violations, note) {
  violations.sort();
  const ok = violations.length === 0;
  print({ stage, ok, violations, ...(note ? { note } : {}) }, ok ? `Scope ok for stage "${stage}".` : `Out of scope for stage "${stage}":\n` + violations.map((v) => `  ${v}`).join("\n") + (note ? `\n${note}` : ""));
  if (!ok) process.exitCode = 1;
}

// ---------- version ----------

function cmdVersion() {
  const os = run("openspec", ["--version"], ROOT);
  const openspec = os.ok ? os.out.split(/\s+/).pop() : null;
  print(
    { groundwork: GW_VERSION, openspec, node: process.versions.node },
    `Groundwork ${GW_VERSION}\nOpenSpec   ${openspec || "not installed"}\nNode.js    ${process.versions.node}`,
  );
}

// True when the first token of a configured command resolves: a file relative to the repository root (or absolute), or an
// executable on PATH. On Windows each name is also tried with the PATHEXT extensions (./gradlew runs gradlew.bat), and a bare token
// is also looked up in the repository root with those extensions, or as it is when it already ends in one, as cmd does.
const NL = /\r?\n/;
function executableExists(token) {
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const win = process.platform === "win32";
  const pathExt = win ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [];
  const exts = ["", ...pathExt];
  const inRoot = (abs) => { const rel = path.relative(ROOT, abs); return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel); };
  if (/[\\/]/.test(token) || token.startsWith(".")) {
    const abs = path.resolve(ROOT, token);
    return inRoot(abs) && exts.some((x) => isFile(abs + x));
  }
  if (pathExt.some((x) => isFile(path.join(ROOT, token + x)))) return true;
  // A token that already ends in one of those extensions (gradlew.bat) runs from the root as it is.
  if (pathExt.some((x) => token.toLowerCase().endsWith(x.toLowerCase())) && isFile(path.join(ROOT, token))) return true;
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some((d) => exts.some((x) => isFile(path.join(d.replace(/^"|"$/g, ""), token + x))));
}

// The program a configured command runs: skips leading NAME=value assignments; null for a shell builtin (not a file to check).
const SHELL_BUILTINS = new Set(["cd", "export", "set", "source", ".", "exit", "echo", "test", "[", "true", "false", "eval", "exec", "unset", "pushd", "popd", "alias", "ulimit", "umask", "wait", "type", "command", "builtin"]);
function commandProgram(cmd) {
  let rest = cmd.trim();
  for (;;) {
    const m = rest.match(/^"([^"]*)"|^'([^']*)'|^\S+/);
    if (!m) return null;
    const tok = m[1] ?? m[2] ?? m[0];
    rest = rest.slice(m[0].length).trimStart();
    if (m[1] === undefined && m[2] === undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;
    return SHELL_BUILTINS.has(tok) ? null : tok;
  }
}

// ---------- doctor ----------

function cmdDoctor() {
  const checks = [];
  const add = (name, ok, detail, level = "error") => checks.push({ name, ok, detail, level: ok ? "ok" : level });

  const [maj, min] = process.versions.node.split(".").map(Number);
  add("Node.js 20.19+ (needed by OpenSpec)", maj > 20 || (maj === 20 && min >= 19), process.versions.node);
  const git = run("git", ["rev-parse", "--is-inside-work-tree"], ROOT);
  add("Git repository", git.ok, git.ok ? ROOT : "not a git repository");
  const os = run("openspec", ["--version"], ROOT);
  add("OpenSpec CLI installed", os.ok, os.ok ? os.out : "run: npm install -g @fission-ai/openspec@1.16.0");
  add("OpenSpec initialised (openspec/)", exists(path.join(ROOT, "openspec")), "run: /groundwork init");
  const cfg = loadConfig();
  add(".groundwork/config.json", !cfg._missing && !cfg._error, cfg._error || (cfg._missing ? "run: /groundwork init" : "ok"));
  const vendored = path.join(GW_DIR, "bin", "gw.mjs");
  const vText = read(vendored);
  const vVer = vText ? (vText.match(/GW_VERSION = "([^"]+)"/) || [])[1] : null;
  add("CI script .groundwork/bin/gw.mjs", !!vText, vText ? `version ${vVer}` : "run: /groundwork init", "warn");
  if (vText && vVer !== GW_VERSION) add("CI script version matches", false, `repo ${vVer}, plugin ${GW_VERSION}: run /groundwork init to update`, "warn");
  add("CI workflow", exists(path.join(ROOT, ".github", "workflows", "groundwork-verify.yml")), "optional: .github/workflows/groundwork-verify.yml", "warn");
  const agentsMd = read(path.join(ROOT, "AGENTS.md"));
  add("AGENTS.md has the Groundwork block", !!agentsMd && agentsMd.includes("groundwork:start"), "run: /groundwork init", "warn");
  const claudeMd = read(path.join(ROOT, "CLAUDE.md"));
  add("CLAUDE.md imports AGENTS.md", !!claudeMd && /^@AGENTS\.md\s*$/m.test(claudeMd), "run: /groundwork init", "warn");

  // Read only the server names from these files; they hold secrets.
  const mcpNames = () => {
    const names = (o) => (isPlainObject(o) && isPlainObject(o.mcpServers) ? Object.keys(o.mcpServers) : []);
    const parse = (f) => { try { return JSON.parse(read(f) || "null"); } catch { return null; } };
    const user = parse(path.join(process.env.GW_HOME_OVERRIDE || homedir(), ".claude.json"));
    return [
      ...names(user),
      ...(isPlainObject(user) && isPlainObject(user.projects) ? Object.values(user.projects).flatMap(names) : []),
      ...names(parse(path.join(ROOT, ".mcp.json"))),
    ];
  };
  if (cfg.codeGraph && cfg.codeGraph.type === "graphify") {
    add("Code graph MCP server (graphify)", mcpNames().includes("graphify"), 'codeGraph.type is "graphify" but no MCP server named "graphify" is in ~/.claude.json or .mcp.json', "warn");
    add("Graphify output", exists(path.join(ROOT, "graphify-out")), "graphify-out/ is missing at the repository root: run graphify to build the code graph", "warn");
  }

  const tracker = isPlainObject(cfg.tracker) ? cfg.tracker : {};
  let patternOk = true, patternErr = "";
  try { new RegExp(tracker.keyPattern ?? ""); } catch (e) { patternOk = false; patternErr = e.message; }
  add("Tracker settings", patternOk, patternOk ? `type ${tracker.type || "(none)"}, keyPattern ${tracker.keyPattern || "(none)"}, mcpServer ${tracker.mcpServer || "(none)"}` : `tracker.keyPattern does not compile: ${patternErr}`);
  if (tracker.mcpServer) add(`Tracker MCP server (${tracker.mcpServer})`, mcpNames().includes(tracker.mcpServer), "may be a claude.ai connector; confirmed at the first fetch", "warn");

  const host = cfg.deliver && cfg.deliver.codeHost === "azure-repos" ? { tool: "az", args: ["account", "show"] } : { tool: "gh", args: ["auth", "status"] };
  const hr = hostRun(host.tool, host.args, {}, 20000);
  add(`Code host CLI (${host.tool})`, hr.code === 0, (hr.stderr || hr.stdout || `${host.tool} ${host.args.join(" ")} failed`).split(NL).find((l) => l.trim()) || `${host.tool} ${host.args.join(" ")} failed`, "warn");

  const commands = isPlainObject(cfg.commands) ? cfg.commands : {};
  if (typeof commands.integration === "string" && commands.integration.trim()) {
    const dr = hostRun("docker", ["info"], {}, 20000);
    add("Docker", dr.code === 0, (dr.stderr || dr.stdout || "docker info failed").split(NL).find((l) => l.trim()) || "docker info failed", "warn");
  }
  for (const level of ["unit", "integration", "e2e", "lint"]) {
    const cmd = typeof commands[level] === "string" ? commands[level].trim() : "";
    if (!cmd) continue;
    const first = commandProgram(cmd);
    if (first === null) continue;
    add(`Command ${level} executable`, executableExists(first), `"${first}" (first token of commands.${level}) is not on PATH or in the repository`, "warn");
  }

  const bad = (Array.isArray(cfg.context && cfg.context.trustedDomains) ? cfg.context.trustedDomains : []).filter((d) => typeof d !== "string" || !/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(d));
  add("Trusted domains", bad.length === 0, bad.length === 0 ? `${(cfg.context && cfg.context.trustedDomains || []).length} trusted domain(s)` : `context.trustedDomains entries must be lowercase hostnames (no scheme, path, port or wildcard): ${bad.map((d) => JSON.stringify(d)).join(", ")}`);

  // Plugin self-check: only when running from the plugin, not the vendored CI copy.
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const agentsDir = path.join(pluginRoot, "agents");
  if (exists(agentsDir)) {
    const expected = {
      "gw-explore": { tools: ["Read", "Grep", "Glob", "Write", "mcp__graphify__*"] },
      "gw-plan": { tools: ["Read", "Grep", "Glob", "Write", "Edit"] },
      "gw-build": { tools: ["Read", "Grep", "Glob", "Write", "Edit", "Bash", "PowerShell"] },
      "gw-review": { tools: ["Read", "Grep", "Glob", "Write"] },
      "gw-deliver": { tools: ["Read", "Grep", "Glob", "Write"] },
      "gw-auditor": { tools: ["Read", "Grep", "Glob", "Write"] },
      "gw-intake": { disallowed: ["Grep", "Glob", "Edit", "Bash", "PowerShell", "Monitor", "Workflow", "Agent", "NotebookEdit", "WebFetch", "WebSearch", "RemoteTrigger", "CronCreate", "CronDelete", "CronList", "EnterWorktree", "Skill"] },
      "gw-refine": { tools: ["Read", "Grep", "Glob", "Write"] },
      "gw-fetch": { tools: ["WebFetch", "Write"] },
    };
    const list = (fm, key) => ((fm.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m")) || [])[1] || "").split(",").map((x) => x.trim()).filter(Boolean).sort();
    for (const [name, exp] of Object.entries(expected)) {
      const t = read(path.join(agentsDir, `${name}.md`));
      if (!t) { add(`Agent ${name}`, false, "missing from the plugin"); continue; }
      const fm = (t.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || "";
      const want = (a) => JSON.stringify([...(a || [])].sort());
      const tools = list(fm, "tools"), dis = list(fm, "disallowedTools");
      const toolsOk = JSON.stringify(tools) === want(exp.tools) && (exp.tools || !/^tools:/m.test(fm));
      const disOk = JSON.stringify(dis) === want(exp.disallowed);
      const ok = toolsOk && disOk;
      const found = `tools: ${tools.join(", ") || "(none)"}; disallowedTools: ${dis.join(", ") || "(none)"}`;
      const wanted = `tools: ${(exp.tools || []).join(", ") || "(none)"}; disallowedTools: ${(exp.disallowed || []).join(", ") || "(none)"}`;
      add(`Agent ${name} permissions`, ok, ok ? found : `expected ${wanted}, found ${found}`);
    }
  }

  const failed = checks.filter((c) => c.level === "error");
  const text = [
    `Groundwork doctor (${GW_VERSION}) - ${ROOT}`,
    "",
    ...checks.map((c) => `${c.level === "ok" ? "OK  " : c.level === "warn" ? "WARN" : "FAIL"}  ${c.name}${c.level === "ok" ? "" : `  -> ${c.detail}`}`),
    "",
    failed.length ? `${failed.length} problem(s) to fix.` : "Ready.",
  ].join("\n");
  print({ root: ROOT, checks, ready: failed.length === 0 }, text);
  if (failed.length) process.exitCode = 1;
}

// ---------- status / list ----------

function cmdStatus() {
  const change = positional[0];
  if (!change) {
    const runs = listChanges().map(parseRun).filter(Boolean);
    const open = runs.filter((r) => !["done", "cancelled"].includes(r.current));
    if (!open.length) return print({ open: [] }, "No open changes. Start one with /groundwork start \"<task or Jira key>\".");
    const text = open.map((r) => `${r.change}\n  stage: ${r.current}   path: ${r.path}\n  next:  ${nextStep(r)}`).join("\n\n");
    return print({ open: open.map((r) => ({ change: r.change, current: r.current, path: r.path, next: nextStep(r) })) }, text);
  }
  const r = parseRun(change);
  if (!r) { print({ error: "not found" }, `No change named "${change}". Run /groundwork list.`); process.exitCode = 1; return; }
  const stageLines = r.stages.length ? r.stages.map((s) => `  ${s.stage.padEnd(8)} ${s.status.padEnd(8)} ${s.model.padEnd(7)} ${s.tokens}`) : ["  (none yet)"];
  const apprLines = r.approvals.length ? r.approvals.map((a) => `  ${a.gate}: ${a.decision} by ${a.by} on ${a.date}`) : ["  (none)"];
  const text = [
    `${r.change}`,
    `  source:  ${r.source}`,
    `  path:    ${r.path}`,
    `  stage:   ${r.current}`,
    ...(r.pr ? [`  pr:      ${r.pr}`] : []),
    `  updated: ${r.updated}`,
    "Stages:", ...stageLines,
    "Approvals:", ...apprLines,
    `Next: ${nextStep(r)}`,
  ].join("\n");
  print({ ...r, text: undefined, next: nextStep(r) }, text);
}

function cmdList() {
  const runs = listChanges().map(parseRun).filter(Boolean);
  const refs = listRefinements().map(parseRefinement).filter(Boolean).map((r) => ({
    key: r.key, status: r.status, openQuestions: r.questions.filter((q) => q.status === "open").length,
  }));
  if (!runs.length && !refs.length) return print({ changes: [] }, "No changes yet. Start one with /groundwork start \"<task or Jira key>\".");
  const refText = refs.length ? [
    "", "Refinements",
    ...refs.map((r) => `${r.key}  ${r.status}  ${r.openQuestions} open question${r.openQuestions === 1 ? "" : "s"}`),
  ].join("\n") : "";
  if (!runs.length) return print({ changes: [], refinements: refs }, `No changes yet.\n${refText}`);
  const w = Math.max(6, ...runs.map((r) => r.change.length));
  const text = [
    `${"CHANGE".padEnd(w)}  ${"STAGE".padEnd(17)}  ${"PATH".padEnd(4)}  UPDATED`,
    ...runs.map((r) => `${r.change.padEnd(w)}  ${r.current.padEnd(17)}  ${r.path.padEnd(4)}  ${r.updated || ""}`),
  ].join("\n");
  print({
    changes: runs.map((r) => ({ change: r.change, current: r.current, path: r.path, updated: r.updated })),
    ...(refs.length ? { refinements: refs } : {}),
  }, text + (refText ? "\n" + refText : ""));
}

// ---------- cost ----------

function cmdCost() {
  const cfg = loadConfig();
  const only = positional[0];
  const runs = (only ? [only] : listChanges()).map(parseRun).filter(Boolean);
  if (!runs.length) return print({ total: 0 }, only ? `No change named "${only}".` : "No changes yet.");
  const byStage = {}, byModel = {}, byChange = {};
  let total = 0, unknown = 0;
  for (const r of runs) {
    for (const s of r.stages) {
      const n = parseInt(String(s.tokens).replace(/[^0-9]/g, ""), 10);
      if (!Number.isFinite(n)) { unknown++; continue; }
      total += n;
      byStage[s.stage] = (byStage[s.stage] || 0) + n;
      byModel[s.model || "?"] = (byModel[s.model || "?"] || 0) + n;
      byChange[r.change] = (byChange[r.change] || 0) + n;
    }
  }
  const price = (model, n) => {
    const p = cfg.pricing && cfg.pricing[model];
    return p && typeof p.perMTok === "number" ? (n / 1e6) * p.perMTok : null;
  };
  let cost = 0, priced = true;
  for (const [m, n] of Object.entries(byModel)) { const c = price(m, n); if (c === null) priced = false; else cost += c; }
  const fmt = (n) => n.toLocaleString("en-US");
  const lines = [
    `Tokens used${only ? ` by ${only}` : ` across ${runs.length} change(s)`} (as reported by each stage run; approximate)`,
    "",
    "By stage:", ...Object.entries(byStage).map(([k, v]) => `  ${k.padEnd(10)} ${fmt(v)}`),
    "By model:", ...Object.entries(byModel).map(([k, v]) => `  ${k.padEnd(10)} ${fmt(v)}`),
  ];
  if (!only) lines.push("By change:", ...Object.entries(byChange).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}  ${fmt(v)}`));
  lines.push("", `Total: ${fmt(total)} tokens`);
  if (unknown) lines.push(`${unknown} stage run(s) had no token figure.`);
  lines.push(priced && total ? `Estimated cost: ${cost.toFixed(2)} (from pricing in .groundwork/config.json)` : "No cost estimate: add per-model prices to \"pricing\" in .groundwork/config.json, e.g. {\"sonnet\": {\"perMTok\": 6}}.");
  print({ total, byStage, byModel, byChange, unknownRuns: unknown, estimatedCost: priced ? cost : null }, lines.join("\n"));
}

// ---------- stats ----------

// Facts for the auditor (phase 7 decision 2): counts, ids, areas, severities, file areas, dates, stage and model names from
// structured fields only. No Finding, Suggested fix or ticket text is ever read into the output.
// Why a run cannot be read, or null. A run without its Current line, or with a value its format does not know, is malformed.
function runProblem(run) {
  if (!run) return "run.md is missing";
  if (!run.current) return "run.md has no Current line";
  if (!(run.format >= 2 ? CURRENT_VALUES_V2 : CURRENT_VALUES_V1).includes(run.current)) return "run.md has an unknown Current value";
  return null;
}

// First path segment of a File:line cell (decision 3): "-" when absent or not a plain name, "." for a file in the root.
function fileArea(cellText) {
  let v = String(cellText || "").trim().replace(/^`+|`+$/g, "").replace(/^(\.\/)+/, "").replace(/\\/g, "/");
  if (!v || v === "-" || /^n\/?a$/i.test(v)) return "-";
  v = v.replace(/:\d+(?:[-:]\d+)*$/, "");
  const seg = v.includes("/") ? v.split("/")[0] : /^[A-Za-z0-9._@+-]+\.[A-Za-z0-9]+$/.test(v) ? "." : "-";
  return /^[A-Za-z0-9._@+-]{1,32}$/.test(seg) ? seg : "-";
}

// Last date a change moved: the newest Log timestamp, else Updated:, else Created: (YYYY-MM-DD), or null.
function lastActivity(run) {
  const dates = [];
  for (const l of (markdownSection(run.text, "Log") || "").split(/\r?\n/)) {
    const m = /^\s*[-*]\s+(\d{4}-\d{2}-\d{2})\b/.exec(l);
    if (m) dates.push(m[1]);
  }
  if (dates.length) return dates.sort().pop();
  for (const v of [run.updated, run.created]) {
    const m = /^(\d{4}-\d{2}-\d{2})\b/.exec(v || "");
    if (m) return m[1];
  }
  return null;
}

const dayNumber = (ymd) => Math.floor(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / 86400000);

// One change's facts, or null when its run.md is missing or malformed.
function changeStats(change, now) {
  const run = parseRun(change);
  if (runProblem(run)) return null;
  const dir = path.join(CHANGES_DIR, change);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* no change folder */ }
  const byArea = {}, byFileArea = {}, bySeverity = { blocking: 0, "should-fix": 0, nit: 0 };
  let reviewRounds = 0, prFeedbackLoops = 0;
  for (const f of names.slice().sort()) {
    const m = /^review-(\d+)\.md$/.exec(f);
    if (m) { reviewRounds++; if (isFeedbackRound(change, Number(m[1]))) prFeedbackLoops++; }
    if (!m && !/^review-\d+-g\d+\.md$/.test(f) && !/^security-review-\d+\.md$/.test(f)) continue;
    const rows = roundTables(read(path.join(dir, f)) || "").findings || [];
    const seen = new Set();
    for (const c of rows) {
      const id = c[0] || "";
      if (!looksLikeId(id) || seen.has(id)) continue;
      seen.add(id);
      const area = (c[2] || "").toLowerCase(), severity = (c[1] || "").toLowerCase();
      const a = REVIEW_AREAS.includes(area) ? area : "other";
      byArea[a] = (byArea[a] || 0) + 1;
      const fa = fileArea(c[3]);
      byFileArea[fa] = (byFileArea[fa] || 0) + 1;
      if (REVIEW_SEVERITIES.includes(severity)) bySeverity[severity]++;
    }
  }
  let stuck = null;
  const since = lastActivity(run);
  if (run.current !== "done" && run.current !== "cancelled" && since) {
    const days = dayNumber(now) - dayNumber(since);
    if (days > 7) stuck = { change, current: run.current, since, days };
  }
  return { run, byArea, byFileArea, bySeverity, round: { change, reviewRounds, buildReviewLoops: reviewLoops(change), prFeedbackLoops }, stuck };
}

function cmdStats() {
  let now = new Date().toISOString().slice(0, 10);
  const given = opt("now");
  if (flags.has("--now") && given === undefined) { print({ error: "usage" }, "Usage: stats [--json] [--now <YYYY-MM-DD>]"); process.exitCode = 2; return; }
  if (given !== undefined) {
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(given);
    if (!d || new Date(`${given}T00:00:00Z`).toISOString().slice(0, 10) !== given) { print({ error: "usage" }, `--now must be a date, YYYY-MM-DD (got "${given}").`); process.exitCode = 2; return; }
    now = given;
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const sortedObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => cmp(a, b)));
  const skipped = [], rounds = [], stuck = [];
  const byArea = {}, byFileArea = {}, bySeverity = { blocking: 0, "should-fix": 0, nit: 0 };
  const tok = new Map();
  let changes = 0;
  let invalid = 0;
  for (const change of listChanges()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(change) || change.includes("..")) { invalid++; skipped.push(`.groundwork/changes/(entry ${invalid}): invalid change name`); continue; }
    const s = changeStats(change, now);
    if (!s) { skipped.push(`${rel(path.join(CHANGES_DIR, change, "run.md"))}: ${runProblem(parseRun(change))}`); continue; }
    changes++;
    for (const [k, v] of Object.entries(s.byArea)) byArea[k] = (byArea[k] || 0) + v;
    for (const [k, v] of Object.entries(s.byFileArea)) byFileArea[k] = (byFileArea[k] || 0) + v;
    for (const k of REVIEW_SEVERITIES) bySeverity[k] += s.bySeverity[k];
    rounds.push(s.round);
    if (s.stuck) stuck.push(s.stuck);
    for (const st of s.run.stages) {
      const stage = STAGES.includes(st.stage) ? st.stage : "other";
      const lm = st.model.toLowerCase();
      const model = /^[a-z0-9][a-z0-9._-]{0,40}$/.test(lm) ? lm : "other";
      const key = `${stage}\0${model}`;
      const e = tok.get(key) || { stage, model, tokens: 0, runs: 0 };
      e.runs++;
      const t = String(st.tokens).trim();
      if (/^\d[\d,]*$/.test(t)) e.tokens += parseInt(t.replace(/,/g, ""), 10);
      tok.set(key, e);
    }
  }
  const tokens = [...tok.values()].sort((a, b) => (STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage)) || cmp(a.stage, b.stage) || cmp(a.model, b.model));
  const out = { changes, skipped, findings: { byArea: sortedObj(byArea), byFileArea: sortedObj(byFileArea), bySeverity }, rounds, tokens, stuck };
  const table = (head, rows) => {
    if (!rows.length) return ["  none"];
    const all = [head, ...rows];
    const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
    return all.map((r) => "  " + r.map((c, i) => (i === r.length - 1 ? String(c) : String(c).padEnd(w[i] + 2))).join(""));
  };
  print(out, [
    `Groundwork stats (${now}): ${changes} change(s)${skipped.length ? `, ${skipped.length} skipped` : ""}`,
    ...skipped.map((s) => `  skipped ${s}`),
    "", "Findings by area:", ...table(["Area", "Count"], Object.entries(out.findings.byArea)),
    "", "Findings by file area:", ...table(["File area", "Count"], Object.entries(out.findings.byFileArea)),
    "", "Findings by severity:", ...table(["Severity", "Count"], Object.entries(bySeverity)),
    "", "Review rounds:", ...table(["Change", "Rounds", "Build-review loops", "PR feedback loops"], rounds.map((r) => [r.change, r.reviewRounds, r.buildReviewLoops, r.prFeedbackLoops])),
    "", "Tokens:", ...table(["Stage", "Model", "Tokens", "Runs"], tokens.map((t) => [t.stage, t.model, t.tokens, t.runs])),
    "", "Stuck for more than 7 days:", ...table(["Change", "Current", "Since", "Days"], stuck.map((s) => [s.change, s.current, s.since, s.days])),
  ].join("\n"));
}

// ---------- context ----------

function contextReport(cfg) {
  const files = [];
  const seen = new Set();
  const visit = (relPath, via) => {
    const abs = path.resolve(ROOT, relPath);
    if (seen.has(abs)) return;
    seen.add(abs);
    const text = read(abs);
    if (text === null) return;
    files.push({ file: rel(abs), via, tokens: approxTokens(text), text });
    for (const m of text.matchAll(/^@(\S+)\s*$/gm)) {
      const target = m[1].startsWith("~") ? null : path.resolve(path.dirname(abs), m[1]);
      if (target) visit(path.relative(ROOT, target), rel(abs));
    }
  };
  for (const f of cfg.contextFiles || []) visit(f, null);
  const total = files.reduce((a, f) => a + f.tokens, 0);
  return { files, total, budget: cfg.contextBudgetTokens };
}

function staleReferences(files) {
  const all = walk(ROOT).map((p) => rel(p));
  const basenames = new Set(all.map((p) => p.split("/").pop()));
  const findings = [];
  for (const f of files) {
    const dir = path.dirname(path.resolve(ROOT, f.file));
    const lines = f.text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const imp = line.match(/^@(\S+)\s*$/);
      if (imp && !imp[1].startsWith("~") && !exists(path.resolve(dir, imp[1]))) {
        findings.push({ level: "error", file: f.file, line: i + 1, ref: imp[1], why: "imported file does not exist" });
      }
      for (const m of line.matchAll(/`([^`\s]+)`/g)) {
        const ref = m[1].replace(/[:,.;]+$/, "");
        if (/^(https?:|mailto:|#|-|@|\$)/.test(ref) || /[<>*{}|()=\[\]$]/.test(ref)) continue;
        const looksLikePath = ref.includes("/") || /\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(ref);
        if (!looksLikePath) continue;
        const clean = ref.replace(/^\.\//, "").replace(/\/$/, "");
        if (exists(path.resolve(ROOT, clean)) || exists(path.resolve(dir, clean))) continue;
        if (!clean.includes("/") && basenames.has(clean)) continue;
        findings.push({ level: "warn", file: f.file, line: i + 1, ref, why: "path not found" });
      }
    });
  }
  return findings;
}

function cmdContext() {
  const cfg = loadConfig();
  const ctx = contextReport(cfg);
  const stale = staleReferences(ctx.files);
  const text = [
    `Always-loaded context (approx. tokens, budget ${ctx.budget})`,
    ...ctx.files.map((f) => `  ${String(f.tokens).padStart(7)}  ${f.file}${f.via ? `  (imported by ${f.via})` : ""}`),
    `  ${String(ctx.total).padStart(7)}  total${ctx.total > ctx.budget ? "  OVER BUDGET" : ""}`,
    "",
    stale.length ? `References not found (${stale.length}):` : "No stale references found.",
    ...stale.map((s) => `  ${s.file}:${s.line}  ${s.ref}  (${s.why})`),
  ].join("\n");
  print({ files: ctx.files.map(({ text: _t, ...f }) => f), total: ctx.total, budget: ctx.budget, stale }, text);
}

// ---------- verify ----------

function cmdVerify() {
  const strict = flags.has("--strict");
  const only = opt("change");
  const cfg = loadConfig();
  const problems = [];
  const add = (level, where, msg) => problems.push({ level, where, msg });

  if (cfg._error) add("error", ".groundwork/config.json", cfg._error);

  // 1. Run state and gates for every change.
  const changes = only ? [only] : listChanges();
  for (const change of changes) {
    const dir = path.join(CHANGES_DIR, change);
    const where = `.groundwork/changes/${change}`;
    if (!exists(dir)) { add("error", where, "change not found"); continue; }
    const r = parseRun(change);
    if (!r) {
      const stray = [...Object.values(HANDOFFS), ...buildReports(dir)].filter((f) => exists(path.join(dir, f)));
      add("error", where, `no run.md${stray.length ? ` but handoff files exist (${stray.join(", ")}): stages ran outside the orchestrator` : ""}`);
      continue;
    }
    if (!(r.format >= 2 ? CURRENT_VALUES_V2 : CURRENT_VALUES_V1).includes(r.current)) add("error", `${where}/run.md`, `invalid Current "${r.current}"`);
    if (!["full", "fast"].includes(r.path)) add("error", `${where}/run.md`, `invalid Path "${r.path}"`);

    const reviewRounds = r.format >= 2 ? fs.readdirSync(dir).map((f) => ({ f, m: f.match(/^(?:security-)?review-(\d+)(?:-g\d+)?\.md$/) })).filter((x) => x.m) : [];
    const reports = r.format >= 2 ? buildReports(dir) : [];
    const handoffs = [...Object.entries(HANDOFFS), ...reports.map((f) => ["build", f]), ...reviewRounds.map((x) => ["review", x.f])];
    for (const [stage, file] of handoffs) {
      if (!exists(path.join(dir, file))) continue;
      const row = r.stages.find((s) => s.stage === stage && ["done", "running"].includes(s.status));
      if (!row) add("error", `${where}/${file}`, `no "${stage}" stage recorded in run.md: written outside the orchestrator`);
    }

    const approved = r.approvals.some((a) => a.gate === "plan" && a.decision === "approved");
    const builtAt = r.stages.some((s) => s.stage === "build") || exists(path.join(dir, "build.md")) || reports.length > 0;
    if (builtAt && !approved) add("error", `${where}`, "build ran without an approved plan gate");

    if (r.format >= 2) {
      const planRow = lastPlanApproval(r);
      if (planRow && !planRow.fingerprint) add("error", `${where}/run.md`, "plan approval has no fingerprint");
      else if (planRow && builtAt && !["plan", "awaiting-approval"].includes(r.current)) {
        let fp = null;
        try { fp = planFingerprint(r); } catch (e) { add("error", `${where}/run.md`, `cannot compute plan fingerprint: ${e.message}`); }
        if (fp !== null && fp !== planRow.fingerprint) add("error", `${where}/run.md`, "plan changed after approval");
      }
      if (r.pr && cfg.deliver.requireApproval !== false && !r.approvals.some((a) => a.gate === "deliver" && a.decision === "approved" && a.fingerprint)) {
        add("error", `${where}/run.md`, "PR opened without a delivery approval");
      }
    }

    if (r.format >= 2 && ["build", "review", "deliver", "awaiting-delivery-approval", "awaiting-merge", "done"].includes(r.current)) {
      for (const p of planProblems(change).problems) if (/^AC[0-9]+ is not covered/.test(p)) add("error", where, p);
    }

    if (r.format >= 2 && ["review", "deliver", "awaiting-delivery-approval", "awaiting-merge", "done"].includes(r.current)) {
      try {
        const b = buildProblems(change);
        for (const p of b.problems) add("error", where, p);
        for (const w of b.warnings) add("warn", where, w);
      } catch (e) { add("error", where, `cannot check the build: ${e.message}`); }
    }

    // The latest round is the highest n with review-<n>.md that is not a feedback round (ruling R8(d): PR or user feedback after a
    // delivery does not undo the review that approved it). In format 2 the whole round (security and group files included)
    // decides delivery, through reviewProblems.
    let latest = "review.md", latestN = 0;
    if (r.format >= 2) {
      const n = reviewRounds.filter((x) => /^review-\d+\.md$/.test(x.f)).map((x) => Number(x.m[1])).filter((k) => !isFeedbackRound(change, k));
      if (n.length) { latestN = Math.max(...n); latest = `review-${latestN}.md`; }
    }
    const review = read(path.join(dir, latest));
    if (exists(path.join(dir, "deliver.md"))) {
      if (!review) add("error", `${where}/deliver.md`, "delivered without a review");
      else if (r.format >= 2 && latestN) {
        let round = null;
        try { round = reviewProblems(change, latestN); } catch (e) { add("error", where, `cannot check the review: ${e.message}`); }
        if (round && !round.approved) add("error", `${where}/deliver.md`, `delivered without an approved review${round.problems.length ? ` (${round.problems.join("; ")})` : ""}`);
      } else if ((headerValue(review, "Status") || "").toLowerCase() !== "approved") add("error", `${where}/deliver.md`, "delivered without an approved review");
    }

    // A round followed by another must have its blocking findings (R and S ids) answered in build-review-<n>.md.
    if (r.format >= 2) {
      const rounds = new Set(reviewRounds.map((x) => Number(x.m[1])));
      // Every earlier round must pass check-review too (ruling R4), so a round written outside the gate is caught. Its test run
      // may be gone or relabelled, so "tests were not run" is not reported for it; a later fix loop rewrote
      // tests/after-build.json, so neither is a test mismatch (ruling R10). A regression is against the baseline and stays.
      // Feedback rounds above latestN are complete when written, so they are checked too.
      for (const n of [...rounds].filter((k) => k < latestN || (k > latestN && isFeedbackRound(change, k))).sort((a, b) => a - b)) {
        try {
          for (const p of reviewProblems(change, n).problems) if (!/: tests were not run$|: approved with tests mismatched at /.test(p)) add("error", where, p);
        } catch (e) { add("error", where, `cannot check review round ${n}: ${e.message}`); }
      }
      try {
        for (const n of [...rounds].sort((a, b) => a - b)) {
          if (!rounds.has(n + 1)) continue;
          const answered = new Set(reviewAnswers(change, n).map((a) => a.id));
          for (const [name, fits] of [[`review-${n}.md`, REVIEW_ID], [`security-review-${n}.md`, SECURITY_ID]]) {
            for (const f of roundFindings(read(path.join(dir, name)) || "") || []) {
              if (fits.test(f.id) && f.severity.toLowerCase() === "blocking" && !answered.has(f.id)) add("error", where, `review-${n}: blocking finding ${f.id} has no answer in build-review-${n}.md`);
            }
          }
        }
      } catch (e) { add("error", where, `cannot check the review answers: ${e.message}`); }
    }

    if (r.path === "full" && ["plan", "awaiting-approval", "build", "review", "deliver", "awaiting-delivery-approval", "awaiting-merge", "archive", "done"].includes(r.current)) {
      const osDir = openspecChangeDir(change);
      if (!osDir) { add("error", where, `OpenSpec change "${change}" not found under openspec/changes/`); continue; }
      const tasks = read(path.join(osDir, "tasks.md")) || "";
      const open = (tasks.match(/^\s*- \[ \]/gm) || []).length;
      if (exists(path.join(dir, "deliver.md")) && open) add("error", rel(path.join(osDir, "tasks.md")), `${open} unchecked task(s) after delivery`);

      const build = read(path.join(dir, "build.md"));
      const buildDone = r.stages.some((s) => s.stage === "build" && s.status === "done");
      if (r.format < 2 && build && buildDone) {
        const specFiles = walk(path.join(osDir, "specs")).filter((p) => p.endsWith(".md"));
        const scenarios = specFiles.flatMap((p) => [...(read(p) || "").matchAll(/^####\s+Scenario:\s*(.+)$/gm)].map((m) => m[1].trim()));
        const missing = scenarios.filter((s) => !build.toLowerCase().includes(s.toLowerCase()));
        for (const s of missing) add("error", `${where}/build.md`, `scenario without a mapped test: "${s}"`);
      }
    }
  }

  // 2. Context budget and stale references (repo-wide; skipped with --change).
  if (!only) {
    const ctx = contextReport(cfg);
    if (ctx.total > ctx.budget) add("error", "context", `always-loaded context is ~${ctx.total} tokens, over the budget of ${ctx.budget}`);
    for (const s of staleReferences(ctx.files)) add(s.level === "error" || strict ? "error" : "warn", `${s.file}:${s.line}`, `${s.ref}: ${s.why}`);
  }

  const errors = problems.filter((p) => p.level === "error");
  const warns = problems.filter((p) => p.level === "warn");
  const text = [
    `Groundwork verify (${GW_VERSION}) - ${changes.length} change(s) checked${only ? "" : ", context checked"}`,
    ...problems.map((p) => `${p.level === "error" ? "FAIL" : "WARN"}  ${p.where}  ${p.msg}`),
    "",
    errors.length ? `${errors.length} error(s), ${warns.length} warning(s).` : `Passed${warns.length ? ` with ${warns.length} warning(s)` : ""}.`,
  ].join("\n");
  print({ passed: errors.length === 0, errors, warnings: warns }, text);
  if (errors.length) process.exitCode = 1;
}

// ---------- run-tests ----------

const TEST_LEVELS = ["unit", "integration", "e2e"];
const TAIL_LINES = 200;

// Runs a configured command line through the platform shell in the repo root. The line comes from the repository's own
// config (same trust as CI). Resolves { status, exitCode, durationMs, tail } and never rejects.
function runCommand(cmdline, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const win = process.platform === "win32";
    const tailLines = [];
    const addLine = (l) => { tailLines.push(l); if (tailLines.length > TAIL_LINES) tailLines.shift(); };
    // One line splitter per stream: a bare CR (progress bars) breaks a line, and an unterminated line keeps its last 64 KB.
    const streams = [];
    const lineSink = () => {
      const st = { partial: "", dec: new StringDecoder("utf8") };
      streams.push(st);
      return (chunk) => {
        const parts = (st.partial + (typeof chunk === "string" ? chunk : st.dec.write(chunk))).split(/\r\n|\r|\n/);
        st.partial = parts.pop();
        if (st.partial.length > 65536) st.partial = st.partial.slice(-65536);
        for (const l of parts) addLine(l.length > 65536 ? l.slice(-65536) : l);
      };
    };
    const pushOut = lineSink();
    const pushErr = lineSink();
    const finish = (status, exitCode) => {
      for (const st of streams) { const rest = st.partial + st.dec.end(); st.partial = ""; if (rest) addLine(rest.slice(-65536)); }
      resolve({ status, exitCode, durationMs: Date.now() - started, tail: tailLines.slice(-TAIL_LINES).join("\n") });
    };
    let child;
    try {
      child = win
        ? spawn("cmd.exe", ["/d", "/s", "/c", `"${cmdline}"`], { cwd: ROOT, windowsVerbatimArguments: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
        : spawn("/bin/sh", ["-c", cmdline], { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { pushErr(String(e.message)); return finish("failed", null); }
    child.stdout.on("data", pushOut);
    child.stderr.on("data", pushErr);
    let done = false;
    let timedOut = false;
    let timer;
    const end = (status, exitCode) => { if (done) return; done = true; clearTimeout(timer); finish(status, exitCode); };
    child.on("error", (e) => { pushErr(String(e.message)); end("failed", null); });
    child.on("close", (code) => end(timedOut ? "timed-out" : code === 0 ? "passed" : "failed", timedOut ? null : code));
    timer = setTimeout(() => {
      timedOut = true;
      try {
        if (win) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
        else process.kill(-child.pid, "SIGKILL");
      } catch { /* already gone */ }
      setTimeout(() => {
        try { child.stdout.destroy(); child.stderr.destroy(); child.unref(); } catch { /* ignore */ }
        end("timed-out", null);
      }, 1000).unref();
    }, timeoutMs);
  });
}

async function cmdRunTests() {
  const usage = "Usage: run-tests <change> --label <label> [--level unit|integration|e2e|all] [--json]";
  const label = opt("label");
  const level = opt("level") || "all";
  if (!label || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(label) || (level !== "all" && !TEST_LEVELS.includes(level))) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  const change = changeArg(usage);
  if (!change) return;
  const cfg = loadConfig();
  const commandsCfg = cfg.commands || {};
  const minutes = Number(commandsCfg.timeoutMinutes);
  const timeoutMs = Math.max(1, (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60000);
  const dir = path.join(CHANGES_DIR, change, "tests");
  fs.mkdirSync(dir, { recursive: true });
  const levels = {};
  for (const lv of level === "all" ? TEST_LEVELS : [level]) {
    const line = typeof commandsCfg[lv] === "string" ? commandsCfg[lv].trim() : "";
    if (!line) { levels[lv] = { command: "", status: "not-configured", exitCode: null, durationMs: 0, log: null }; continue; }
    const res = await runCommand(line, timeoutMs);
    const log = `tests/${label}-${lv}.log`;
    fs.writeFileSync(path.join(CHANGES_DIR, change, log), res.tail + (res.tail ? "\n" : ""));
    levels[lv] = { command: line, status: res.status, exitCode: res.exitCode, durationMs: res.durationMs, log };
  }
  const record = { label, ranAt: new Date().toISOString(), levels };
  fs.writeFileSync(path.join(dir, `${label}.json`), JSON.stringify(record, null, 2) + "\n");
  print(record, [`Test run "${label}" for ${change}:`, ...Object.entries(levels).map(([k, v]) => `  ${k}: ${v.status}${v.exitCode !== null && v.status === "failed" ? ` (exit ${v.exitCode})` : ""}${v.durationMs ? ` ${v.durationMs}ms` : ""}`)].join("\n"));
}

// ---------- worktree ----------

// Hardened git (fsmonitor off, empty hooksPath) in any folder. Inherited GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR / GIT_INDEX_FILE
// are dropped, so `env` alone decides the repository and the index. With raw, stdout is a Buffer (patches can hold any bytes).
function gitEnv(env = {}) {
  const base = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete base[k];
  return { ...base, ...env };
}
function gitAt(cwd, args, { env = {}, raw = false } = {}) {
  const r = spawnSync("git", gitArgs(args), { cwd, env: gitEnv(env), encoding: raw ? "buffer" : "utf8", maxBuffer: 1024 * 1024 * 1024 });
  const err = r.error ? r.error.message : String(r.stderr || "").trim();
  return { ok: !r.error && r.status === 0, status: r.error ? null : r.status, out: r.stdout ?? (raw ? Buffer.alloc(0) : ""), err };
}
function gitAtMust(cwd, args, o) {
  const r = gitAt(cwd, args, o);
  if (!r.ok) throw new Error(`git ${args.filter((a) => !a.startsWith("-")).slice(0, 2).join(" ")} failed: ${r.err.split(/\r?\n/).slice(-3).join(" ") || "no output"}`);
  return r;
}

const WORKTREES_DIR = path.join(GW_DIR, "worktrees");
const WORKTREE_IDENT = { GIT_AUTHOR_NAME: "Groundwork", GIT_AUTHOR_EMAIL: "groundwork@localhost", GIT_COMMITTER_NAME: "Groundwork", GIT_COMMITTER_EMAIL: "groundwork@localhost" };

// A path compared the way the file system does: real parent folder, case-folded on Windows.
function canonPath(p) {
  let s = path.resolve(p);
  try { s = path.join(fs.realpathSync.native(path.dirname(s)), path.basename(s)); } catch { /* parent gone: compare as given */ }
  return process.platform === "win32" ? s.toLowerCase() : s;
}

// Absolute paths of every worktree git has registered for this repository (a missing folder included).
function listedWorktrees() {
  return gitAtMust(ROOT, ["worktree", "list", "--porcelain"]).out.split(/\r?\n/)
    .filter((l) => l.startsWith("worktree ")).map((l) => path.resolve(l.slice(9)));
}

// The main repository's common git folder, found from ROOT (never from inside a worktree).
let COMMON_DIR = null;
function gitCommonDir() {
  if (!COMMON_DIR) COMMON_DIR = path.resolve(ROOT, gitAtMust(ROOT, ["rev-parse", "--git-common-dir"]).out.trim());
  return COMMON_DIR;
}

// The admin folder <common>/worktrees/<basename(dir)> when its gitdir file points back at dir/.git and no other admin folder
// does; otherwise null. The worktree's own .git file is never read: a builder can rewrite it.
function worktreeAdminDir(dir) {
  const parent = path.join(gitCommonDir(), "worktrees");
  const own = path.join(parent, path.basename(dir));
  let entries = [];
  try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch { return null; }
  const want = canonPath(path.join(dir, ".git"));
  const back = entries.filter((e) => e.isDirectory()).map((e) => path.join(parent, e.name)).filter((d) => {
    const g = read(path.join(d, "gitdir"));
    return g !== null && g.trim() !== "" && canonPath(path.resolve(d, g.trim())) === want;
  });
  // Exactly one admin dir may point back, and it must be the one named after the worktree.
  return back.length === 1 && canonPath(back[0]) === canonPath(own) ? own : null;
}

// Git environment pinned to a worktree: no repository discovery, so a planted .git file or git folder inside it is never used.
const worktreeEnv = (admin, dir) => ({ GIT_DIR: admin, GIT_COMMON_DIR: gitCommonDir(), GIT_WORK_TREE: dir });

// Tree object of a folder's working files (tracked, plus untracked files that are not ignored), built in a temporary index so
// the folder's real index is never read or written. The temporary index starts from `from` (or HEAD), so tracked files that
// match an ignore rule stay in. .groundwork/worktrees is left out because create requires it to be ignored.
function snapshotTree(cwd, indexFile, { env: pinned = {}, from = null } = {}) {
  const env = { ...pinned, GIT_INDEX_FILE: indexFile };
  const start = from || (gitAt(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { env: pinned }).ok ? "HEAD" : null);
  if (start) gitAtMust(cwd, ["read-tree", start], { env });
  gitAtMust(cwd, ["add", "-A"], { env });
  return gitAtMust(cwd, ["write-tree"], { env }).out.trim();
}

// Agent and harness configuration (checked case-insensitively: Windows and macOS file systems fold case). A patch never
// delivers it: the group is built again sequentially on the main tree, where check-scope asks the user about config: changes.
const isAgentConfig = (p) => /^\.claude(\/|$)/i.test(p) || /^\.mcp\.json$/i.test(p) || /(^|\/)CLAUDE(\.local)?\.md$/i.test(p);

// Names a file system may read as another path: backslash or colon (Windows separators, NTFS streams), a component ending in
// "." or space (Windows strips them), or one containing ~<digit> (an 8.3 short name such as GROUND~1). Such names are legal on
// some systems (data~1.ts), so they are not refused: they send the group to a sequential build on the main tree, where
// check-scope sees what was really written.
const isAmbiguousPath = (p) => /[\\:]/.test(p) || p.split("/").some((c) => /[. ]$/.test(c) || /~\d/.test(c));

const blobAt = (rev, p) => { const r = gitAt(ROOT, ["cat-file", "blob", `${rev}:${p}`]); return r.ok ? r.out : null; };

// Whether a collected tasks.md change is anything other than ticks inside group n: its text (checkboxes ignored) must equal both
// the base and the main tree's, and every changed line must sit under the group's "## <n>." heading.
function tasksChangeRefused(tasks, n, base, tree) {
  const now = read(path.join(ROOT, tasks));
  const before = blobAt(base, tasks);
  const after = blobAt(tree, tasks);
  if (now === null || before === null || after === null) return true;
  const after0 = normalizeForHash(tasks, after);
  if (after0 !== normalizeForHash(tasks, now) || after0 !== normalizeForHash(tasks, before)) return true;
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  if (a.length !== b.length) return true;
  let group = null;
  for (let i = 0; i < b.length; i++) {
    const h = /^##[ \t]+(\d+)\./.exec(b[i]);
    if (h) group = Number(h[1]);
    if (a[i] !== b[i] && group !== n) return true;
  }
  return false;
}

// Splits a collected change into violations (out of build scope for group n), paths that need a sequential build (links,
// submodules, ignore/attribute/module files that change how git reads the tree, agent configuration, and ambiguous names) and the rest. Paths are compared NFC- and
// case-folded, so a variant spelling of a protected path is protected; the own report and tasks.md pass only in exact case.
function classifyCollect(change, n, entries, base, tree) {
  const c = `.groundwork/changes/${change}/`;
  const tasks = `openspec/changes/${change}/tasks.md`;
  const ownReport = `${c}build-g${n}.md`;
  const violations = [];
  const sequential = [];
  for (const { path: p, modes } of entries) {
    const lower = p.normalize("NFC").toLowerCase();
    const parts = lower.split("/");
    if (parts.includes(".git")) { violations.push(p); continue; }
    if (parts[0] === ".groundwork" || parts[0] === "openspec") {
      if (p === tasks) { if (tasksChangeRefused(tasks, n, base, tree)) violations.push(p); }
      else if (p !== ownReport && !p.startsWith(`${c}evidence/`)) { violations.push(p); continue; }
    }
    if (isAgentConfig(lower) || isAmbiguousPath(p) || modes.some((m) => m === "120000" || m === "160000") || [".gitignore", ".gitattributes", ".gitmodules"].includes(parts[parts.length - 1])) sequential.push(p);
  }
  return { violations: violations.sort(), sequential: sequential.sort() };
}

// Removes a worktree folder and its registration; falls back to deleting the folder when git cannot (a locked file, a broken link,
// a .git file that no longer points back).
function removeWorktree(dir) {
  gitAt(ROOT, ["worktree", "remove", "--force", "--force", dir]);
  if (exists(dir)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* reported by the caller */ } }
  gitAt(ROOT, ["worktree", "prune"]);
}

// Byte-exact copies of the given working-tree paths; the returned function puts them back, so a refused patch leaves no trace.
function backupPaths(names) {
  const saved = names.map((p) => {
    const abs = path.join(ROOT, p);
    try {
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) return { abs, link: fs.readlinkSync(abs) };
      if (st.isFile()) return { abs, bytes: fs.readFileSync(abs), mode: st.mode };
      return { abs, keep: true };
    } catch { return { abs, absent: true }; }
  });
  const newDirs = [];
  for (const p of names) {
    let d = path.dirname(path.join(ROOT, p));
    while (d.length > ROOT.length && !exists(d)) { newDirs.push(d); d = path.dirname(d); }
  }
  return () => {
    for (const s of saved) {
      if (s.keep) continue;
      try { fs.rmSync(s.abs, { force: true }); } catch { /* a folder now: leave it */ }
      if (s.absent) continue;
      fs.mkdirSync(path.dirname(s.abs), { recursive: true });
      if (s.link !== undefined) fs.symlinkSync(s.link, s.abs);
      else { fs.writeFileSync(s.abs, s.bytes); try { fs.chmodSync(s.abs, s.mode & 0o7777); } catch { /* Windows */ } }
    }
    for (const d of [...new Set(newDirs)].sort((a, b) => b.length - a.length)) { try { fs.rmdirSync(d); } catch { /* not empty */ } }
  };
}

// Whether a commit is the base worktree create made for this change and group: Groundwork identity and the exact message.
function createdBase(base, change, n) {
  const r = gitAt(ROOT, ["cat-file", "commit", base]);
  if (!r.ok) return false;
  const text = r.out.replace(/\r\n/g, "\n");
  const split = text.indexOf("\n\n");
  if (split < 0) return false;
  const header = text.slice(0, split);
  const who = `${WORKTREE_IDENT.GIT_AUTHOR_NAME} <${WORKTREE_IDENT.GIT_AUTHOR_EMAIL}>`;
  const author = /^author (.*>) \d+ [+-]\d{4}$/m.exec(header);
  const committer = /^committer (.*>) \d+ [+-]\d{4}$/m.exec(header);
  return !!author && author[1] === who && !!committer && committer[1] === who && text.slice(split + 2).trim() === `groundwork: ${change} group ${n} base`;
}

function worktreeCreate(change, n, dir) {
  const fail = (msg) => { print({ error: msg }, msg); process.exitCode = 1; };
  if (exists(dir)) return fail(`worktree folder exists: ${rel(dir)}. Run worktree prune ${change} first.`);
  if (listedWorktrees().some((w) => canonPath(w) === canonPath(dir))) return fail(`git still lists a worktree at ${rel(dir)}. Run worktree prune ${change} first.`);
  if (!gitAt(ROOT, ["check-ignore", "-q", "--no-index", `.groundwork/worktrees/${path.basename(dir)}/x`]).ok) {
    return fail(".groundwork/worktrees/ is not ignored: add it to .gitignore (/groundwork init does this), or build sequentially.");
  }
  const tmp = fs.mkdtempSync(path.join(tmpdir(), "gw-worktree-"));
  try {
    const tree = snapshotTree(ROOT, path.join(tmp, "index"));
    const head = gitHead();
    const base = gitAtMust(ROOT, ["commit-tree", ...(head ? ["-p", head] : []), "--no-gpg-sign", "-m", `groundwork: ${change} group ${n} base`, tree], { env: WORKTREE_IDENT }).out.trim();
    fs.mkdirSync(WORKTREES_DIR, { recursive: true });
    gitAtMust(ROOT, ["worktree", "add", "--detach", dir, base]);
    print({ path: dir, base }, `Worktree for group ${n}: ${dir} (base ${base})`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Applies a worktree's changes to the main tree. Every git call on the worktree side is pinned to its admin folder (GIT_DIR,
// GIT_COMMON_DIR, GIT_WORK_TREE), so only the user's own git config, which check-scope guards, can run filters. The base comes
// from the orchestrator (--base), never from a file the builder could write. Any refusal or error removes the worktree and
// leaves the main tree byte-for-byte as it was.
function worktreeCollect(change, n, dir, base) {
  if (!exists(dir)) {
    print({ applied: false, reason: "no worktree", error: `no worktree for group ${n}: run worktree create first` }, `No worktree for group ${n} of ${change}.`);
    process.exitCode = 1;
    return;
  }
  const tasks = `openspec/changes/${change}/tasks.md`;
  const refuse = (obj, text) => { removeWorktree(dir); print({ applied: false, ...obj }, text); process.exitCode = 1; };
  const tmp = fs.mkdtempSync(path.join(tmpdir(), "gw-collect-"));
  let restore = null;
  try {
    if (!gitAt(ROOT, ["cat-file", "-e", `${base}^{commit}`]).ok) throw new Error(`base ${base} is not a commit in this repository`);
    if (!createdBase(base, change, n)) {
      const v = `--base ${base}`;
      return refuse({ reason: "base not created by worktree create", violations: [v] }, `Group ${n}: base ${base} was not created by worktree create for this group; nothing applied.`);
    }
    const admin = worktreeAdminDir(dir);
    if (!admin) throw new Error(`expected exactly one admin folder, ${path.basename(dir)}, pointing back at ${rel(dir)}`);
    if (exists(path.join(admin, "config.worktree"))) {
      const v = rel(path.join(admin, "config.worktree"));
      return refuse({ reason: "out of scope for stage build", violations: [v] }, `Group ${n}: out of scope for stage build, nothing applied:\n  ${v}`);
    }
    const tree = snapshotTree(dir, path.join(tmp, "worktree-index"), { env: worktreeEnv(admin, dir), from: base });
    const raw = gitAtMust(ROOT, ["diff-tree", "-r", "-z", "--no-renames", "--raw", base, tree]).out.split("\0");
    const entries = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      if (!raw[i].startsWith(":")) { i -= 1; continue; }
      const m = raw[i].slice(1).split(" ");
      entries.push({ path: raw[i + 1], modes: [m[0], m[1]] });
    }
    const names = entries.map((e) => e.path);
    const { violations, sequential } = classifyCollect(change, n, entries, base, tree);
    if (violations.length) {
      return refuse({ reason: "out of scope for stage build", violations }, `Group ${n}: out of scope for stage build, nothing applied:\n` + violations.map((v) => `  ${v}`).join("\n"));
    }
    if (sequential.length) {
      return refuse({ reason: `needs sequential: ${sequential.join(", ")}`, sequential }, `Group ${n} needs a sequential build (${sequential.join(", ")}); nothing applied.`);
    }
    if (!names.length) { removeWorktree(dir); print({ applied: true, files: [] }, `Group ${n}: no changes.`); return; }
    const patch = gitAtMust(ROOT, ["diff-tree", "-p", "--binary", "--full-index", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", base, tree], { raw: true }).out;
    const patchFile = path.join(tmp, "group.patch");
    fs.writeFileSync(patchFile, patch);
    // Every apply runs against a temporary index built from the main working tree: --3way needs index == working tree,
    // and the user's real index is never read or written.
    const env = { GIT_INDEX_FILE: path.join(tmp, "main-index") };
    snapshotTree(ROOT, env.GIT_INDEX_FILE);
    const tasksBefore = read(path.join(ROOT, tasks));
    restore = backupPaths([...new Set([...names, tasks])]);
    const apply = (extra) => gitAt(ROOT, ["apply", "--whitespace=nowarn", ...extra, patchFile], { env });
    const res = apply(["--check"]).ok ? apply([]) : apply(["--3way"]);
    if (!res.ok) {
      restore();
      restore = null;
      const conflicted = [...res.err.matchAll(/Applied patch to '(.+?)' with conflicts/g)].map((m) => m[1]);
      const reason = conflicted.length ? `conflict in ${conflicted.join(", ")}`
        : `conflict: ${res.err.split(/\r?\n/).filter((l) => /^error:/.test(l)).slice(0, 5).join("; ") || "patch does not apply"}`;
      return refuse({ reason }, `Group ${n}: ${reason}. Nothing applied.`);
    }
    const tasksAfter = read(path.join(ROOT, tasks));
    if ((tasksBefore === null) !== (tasksAfter === null) || (tasksBefore !== null && normalizeForHash(tasks, tasksBefore) !== normalizeForHash(tasks, tasksAfter))) {
      restore();
      restore = null;
      return refuse({ reason: "out of scope for stage build", violations: [tasks] }, `Group ${n}: tasks.md changed beyond its checkboxes; nothing applied.`);
    }
    restore = null;
    removeWorktree(dir);
    print({ applied: true, files: names }, `Group ${n}: applied ${names.length} file(s):\n` + names.map((p) => `  ${p}`).join("\n"));
  } catch (e) {
    let msg = e.message;
    if (restore) { try { restore(); } catch (r) { msg += `; restoring the main tree failed: ${r.message}`; } }
    removeWorktree(dir);
    print({ applied: false, reason: "collect failed", error: msg }, `Group ${n}: collect failed, nothing applied: ${msg}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function worktreePrune(change) {
  const { removed, left } = pruneChangeWorktrees(change);
  if (left.length) { print({ removed: removed.filter((d) => !exists(d)), error: `could not remove: ${left.join(", ")}` }, `Could not remove: ${left.join(", ")}`); process.exitCode = 1; return; }
  print({ removed }, removed.length ? `Removed ${removed.length} worktree(s) of ${change}.` : `No worktrees of ${change}.`);
}

// Removes the change's worktrees (<change>-g<n> under .groundwork/worktrees/, registered or left over). { removed, left }:
// every folder found, and those still there afterwards.
function pruneChangeWorktrees(change) {
  const pattern = new RegExp(`^${change.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}-g\\d+$`, process.platform === "win32" ? "i" : "");
  const parent = canonPath(path.join(WORKTREES_DIR, "x"));
  const found = new Set();
  for (const w of listedWorktrees()) {
    if (canonPath(path.join(path.dirname(w), "x")) === parent && pattern.test(path.basename(w))) found.add(path.join(WORKTREES_DIR, path.basename(w)));
  }
  if (exists(WORKTREES_DIR)) for (const e of fs.readdirSync(WORKTREES_DIR)) if (pattern.test(e)) found.add(path.join(WORKTREES_DIR, e));
  const removed = [...found].sort();
  for (const dir of removed) removeWorktree(dir);
  gitAt(ROOT, ["worktree", "prune"]);
  return { removed, left: removed.filter((d) => exists(d)) };
}

function cmdWorktree() {
  const usage = "Usage: worktree create <change> <group> [--json]  |  worktree collect <change> <group> --base <sha> [--json]  |  worktree prune <change> [--json]";
  const [sub, change, group] = positional;
  const needsGroup = sub === "create" || sub === "collect";
  const base = opt("base");
  if (!["create", "collect", "prune"].includes(sub) || !change || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(change) || change.includes("..")
    || (needsGroup && !/^[1-9]\d{0,5}$/.test(group || "")) || (!needsGroup && group !== undefined)
    || (sub === "collect" && !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(base || ""))) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  if (!parseRun(change)) { print({ error: "not found" }, `No change named "${change}". Run /groundwork list.`); process.exitCode = 1; return; }
  if (sub === "prune") return worktreePrune(change);
  const n = Number(group);
  const dir = path.join(WORKTREES_DIR, `${change}-g${n}`);
  return sub === "create" ? worktreeCreate(change, n, dir) : worktreeCollect(change, n, dir, base);
}

// ---------- review-input ----------

// Round number of the next review: 1 + the highest k with build-review-<k>.md (ruling R1). A round keeps its number until its fix
// dispatch exists, so an interrupted round is re-run under the same number and its IDs and since-patch line up.
// A feedback round waiting for its fix (pendingFeedbackRound) is the current round when it is higher (phase 6 ruling R9(a)):
// approved round m, feedback m+1, build-review-(m+1), next normal round m+2.
function reviewRound(change) {
  const { normal, pending } = roundState(change);
  return Math.max(normal, pending);
}

// normal: 1 + the highest build-review-<k>.md; pending: the feedback round waiting for its fix, or 0.
function roundState(change) {
  let names = [];
  try { names = fs.readdirSync(path.join(CHANGES_DIR, change)); } catch { /* no change folder */ }
  const normal = 1 + names.reduce((max, f) => { const m = /^build-review-(\d+)\.md$/.exec(f); return m ? Math.max(max, Number(m[1])) : max; }, 0);
  return { names, normal, pending: pendingFeedbackRound(change, names, normal) };
}

// The highest feedback round k (at or above the normal round) without build-review-<k>.md, or 0.
function pendingFeedbackRound(change, names, normal) {
  return names.map((f) => /^review-(\d+)\.md$/.exec(f)).filter(Boolean).map((m) => Number(m[1]))
    .filter((k) => k >= normal && !names.includes(`build-review-${k}.md`) && isFeedbackRound(change, k)).reduce((a, b) => Math.max(a, b), 0);
}

// Fix loops counted against review.maxBuildReviewLoops (phase 6 ruling R2): the build-review-<k>.md files whose review-<k>.md
// is not a feedback round. PR and user feedback rounds are driven by people and do not use up the limit.
function reviewLoops(change) {
  let names = [];
  try { names = fs.readdirSync(path.join(CHANGES_DIR, change)); } catch { /* no change folder */ }
  return names.map((f) => /^build-review-(\d+)\.md$/.exec(f)).filter(Boolean).filter((m) => !isFeedbackRound(change, Number(m[1]))).length;
}

// Per test level, the statuses of tests/baseline.json, tests/after-build.json and tests/<label>.json ("missing" when the file
// or level is absent). Mismatch: review status differs from after-build. Regression: not passed in review, passed at baseline.
// A level not configured on the compared side is neither.
function testComparison(change, label) {
  const record = (name) => { try { const j = JSON.parse(read(path.join(CHANGES_DIR, change, "tests", `${name}.json`)) ?? "null"); return isPlainObject(j) ? j : null; } catch { return null; } };
  const status = (rec, lv) => (rec && isPlainObject(rec.levels) && isPlainObject(rec.levels[lv]) && typeof rec.levels[lv].status === "string" ? rec.levels[lv].status : "missing");
  const baseline = record("baseline"), afterBuild = record("after-build"), review = record(label);
  const levels = TEST_LEVELS.map((level) => ({ level, baseline: status(baseline, level), afterBuild: status(afterBuild, level), review: status(review, level) }));
  const nc = "not-configured";
  const mismatches = levels.filter((l) => l.review !== nc && l.afterBuild !== nc && l.review !== l.afterBuild).map((l) => l.level);
  const regressions = levels.filter((l) => l.review !== nc && l.review !== "passed" && l.baseline === "passed").map((l) => l.level);
  return { levels, mismatches, regressions, ran: review !== null };
}

// ---------- check-review ----------

const REVIEW_SEVERITIES = ["blocking", "should-fix", "nit"];
const REVIEW_AREAS = ["acceptance", "spec", "tasks", "correctness", "tests", "consistency", "security", "maintainability"];
const REVIEW_VERDICTS = ["resolved", "open", "dispute-accepted"];
const FINDINGS_HEADER = "| ID | Severity | Area | File:line | Finding | Suggested fix |";

// Cells of a markdown table line; "\|" inside a cell is a literal pipe.
const tableCells = (line) => line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
// A markdown table cell: "|" escaped, line breaks collapsed.
const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
const isSeparator = (cells) => cells.every((c) => /^:?-+:?$/.test(c) || c === "");

// Finding ids (decision 2): R<k> in review files, S<k> in security files, G<k>.<m> in group k files; numbers start at 1.
const REVIEW_ID = /^R[1-9]\d*$/, SECURITY_ID = /^S[1-9]\d*$/;
const groupIdPattern = (k) => new RegExp(`^G${k}\\.[1-9]\\d*$`);
const looksLikeId = (cell) => /^(?:[RSG]\d+(?:\.\d+)?)$/.test(cell || "");

// The tables a round file may have, by exact header line (spacing ignored).
const ROUND_TABLES = { findings: FINDINGS_HEADER, previous: "| ID | Builder answer | Verdict |", acs: "| AC | Verdict | Evidence |" };

// Tables of a round file, read strictly (ruling R3): every line starting with "|" must belong to a known table, which is its
// exact header, a separator line right after it, then contiguous rows. Returns { findings, previous, acs } (cell rows of the
// first table of each kind, or null when absent) and shape problems (without the file prefix), in file order:
// "unexpected table line <k>" once per stray block of "|" lines (plus "finding row <id> is outside the findings table" for
// each row in it that looks like a finding), "table at line <k> has no separator line", "more than one findings table".
// A second Previous findings or Acceptance criteria table is a stray block.
// Ruling R4: a known table must be followed by a blank line, a "#" heading or the end of the file (a pipe-less GFM row would
// otherwise continue it unread); a GFM delimiter row outside a known table, with or without a leading "|", starts a stray
// table; fenced code blocks (``` or ~~~) are skipped, and one left open is "unclosed code block at line <k>".
// Ruling R5: blockquote markers are stripped before the row and delimiter tests, so a quoted table is a stray table and a
// quoted row an outside row (a known table is never quoted); a fence opener may directly follow a known table; a line
// holding "<table" anywhere (any case, outside fences and known tables) is "unexpected table line <k>" (ruling R10).
const GFM_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;
function roundTables(text) {
  const norm = (l) => l.trim().replace(/\s+/g, " ");
  const unquote = (l) => l.replace(/^\s*(>\s?)+/, "");
  const isRow = (l) => unquote(l).trim().startsWith("|");
  const isPlainRow = (l) => l.trim().startsWith("|");
  // GFM: a backtick fence opener has no backtick in its info string; a tilde opener may (ruling R10). fm[1] is the fence.
  const fenceOpen = (l) => { const m = /^\s{0,3}(?:(`{3,})(?!.*`)|(~{3,}))/.exec(l); return m && [m[0], m[1] || m[2]]; };
  const lines = String(text).split(/\r?\n/);
  const tables = { findings: null, previous: null, acs: null };
  const problems = [];
  // One "unexpected table line <k>" per line, even when a known table's end and a stray block both point at it.
  const stray = (k) => { const p = `unexpected table line ${k}`; if (problems[problems.length - 1] !== p) problems.push(p); };
  let i = 0;
  let fence = null; // { char, len, line } of the open fence
  while (i < lines.length) {
    const fm = fenceOpen(lines[i]);
    if (fence) {
      if (fm && fm[1][0] === fence.char && fm[1].length >= fence.len && lines[i].trim() === fm[1]) fence = null;
      i++;
      continue;
    }
    if (fm) { fence = { char: fm[1][0], len: fm[1].length, line: i + 1 }; i++; continue; }
    if (!isRow(lines[i])) {
      const q = unquote(lines[i]);
      if (GFM_DELIMITER.test(q) || /<table\b/i.test(q)) stray(i + 1);
      i++;
      continue;
    }
    const start = i;
    const kind = isPlainRow(lines[i]) && Object.keys(ROUND_TABLES).find((k) => norm(lines[i]) === ROUND_TABLES[k]);
    if (kind && (tables[kind] === null || kind === "findings")) {
      i++;
      if (i < lines.length && isPlainRow(lines[i]) && isSeparator(tableCells(lines[i]))) i++;
      else problems.push(`table at line ${start + 1} has no separator line`);
      const rows = [];
      for (; i < lines.length && isPlainRow(lines[i]); i++) rows.push(tableCells(lines[i]));
      if (tables[kind] === null) tables[kind] = rows;
      else problems.push("more than one findings table");
      if (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("#") && !fenceOpen(lines[i])) stray(i + 1);
      continue;
    }
    stray(start + 1);
    for (; i < lines.length && isRow(lines[i]); i++) {
      const id = tableCells(unquote(lines[i]))[0];
      if (looksLikeId(id)) problems.push(`finding row ${id} is outside the findings table`);
    }
  }
  if (fence) problems.push(`unclosed code block at line ${fence.line}`);
  return { ...tables, problems };
}

// Findings of a round file: [{ id, severity, area }] (raw cells), or null without a findings table.
const findingsOf = (rows) => rows && rows.map((c) => ({ id: c[0] || "", severity: c[1] || "", area: c[2] || "" }));
const roundFindings = (text) => findingsOf(roundTables(text).findings);

// Builder answers of build-review-<n>.md: [{ id, kind: "fixed"|"disputed" }] from its "## Review answers" lines.
function reviewAnswers(change, n) {
  const text = read(path.join(CHANGES_DIR, change, `build-review-${n}.md`));
  if (text === null) return [];
  return (markdownSection(text, "Review answers") || "").split(/\r?\n/)
    .map((l) => /^\s*[-*]\s+([A-Z]\d+(?:\.\d+)?)\s+(fixed|disputed)\s*:(.*)$/i.exec(l)).filter(Boolean)
    .map((m) => ({ id: m[1].toUpperCase(), kind: m[2].toLowerCase(), text: m[3].trim() }));
}

// A feedback round (phase 6 decision 5): review-<n>.md written by `gw.mjs feedback` from PR or user feedback, Mode: feedback.
// It counts only with its provenance (rulings R9(c) and R10): feedback-<n>.json in the change's folder holds the sha256 of the
// review file feedback wrote (CRLF read as LF, so a checkout with autocrlf still matches). It is committed with the change, so
// CI's verify checks the same hash, and it matches no STAGE_SCOPE pattern, so check-scope fails any agent that writes it: no
// agent can declare its own round a feedback round.
const feedbackRecord = (n) => `feedback-${n}.json`;
function isFeedbackRound(change, n) {
  const dir = path.join(CHANGES_DIR, change);
  let bytes;
  try { bytes = fs.readFileSync(path.join(dir, `review-${n}.md`)); } catch { return false; }
  if ((headerValue(bytes.toString("utf8"), "Mode") || "").toLowerCase() !== "feedback") return false;
  let recorded = null;
  try { recorded = JSON.parse(fs.readFileSync(path.join(dir, feedbackRecord(n)), "utf8")); } catch { return false; }
  if (!isPlainObject(recorded) || recorded.sha256 !== sha256(normalizeBytes(bytes))) return false;
  // An ignored record is never committed, so CI could not check it: it does not count (ruling R11). check-ignore refuses
  // literal pathspecs, so every pathspec variable is pinned off (an inherited one cannot make it fail); the path holds only the
  // validated change name and digits. Only exit 1 means "not ignored": exit 0 or any error and the record does not count.
  const ci = gitAt(ROOT, ["check-ignore", "-q", "--", rel(path.join(dir, feedbackRecord(n)))],
    { env: { GIT_LITERAL_PATHSPECS: "0", GIT_GLOB_PATHSPECS: "0", GIT_NOGLOB_PATHSPECS: "0", GIT_ICASE_PATHSPECS: "0" } });
  return ci.status === 1;
}

// Keys of the PR comments earlier feedback rounds recorded (ruling R11), from the records of real feedback rounds only.
function recordedComments(change) {
  const dir = path.join(CHANGES_DIR, change);
  const keys = new Set();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* no change folder */ }
  for (const f of names) {
    const m = /^feedback-(\d+)\.json$/.exec(f);
    if (!m || !isFeedbackRound(change, Number(m[1]))) continue;
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    for (const k of Array.isArray(rec.comments) ? rec.comments : []) if (typeof k === "string") keys.add(k);
  }
  return keys;
}

// Files a round must have (decisions 1 and 4): [{ file, mode, kind: "review"|"security"|"group", group, feedback }].
// The security file is required unless run.md's Sensitive value is exactly `no`, and whenever explore.md says `Sensitive: yes`
// (ruling R2: an unclear or missing value fails closed). A feedback round expects only review-<n>.md (phase 6 decision 5);
// normal: true lists the files of a normal round even then.
function roundFiles(change, n, { normal = false } = {}) {
  if (!normal && isFeedbackRound(change, n)) return [{ file: `review-${n}.md`, mode: "feedback", kind: "review", feedback: true }];
  const run = parseRun(change);
  const cfg = loadConfig();
  const groups = run.path === "full" ? taskGroups(change).groups : [];
  const threshold = Number(cfg.build && cfg.build.groupThreshold);
  const split = run.path === "full" && groups.length > 0 && Number.isFinite(threshold) && groups.length >= threshold;
  const explore = read(path.join(CHANGES_DIR, change, "explore.md"));
  const sensitive = headerValue(run.text, "Sensitive") !== "no" || (explore !== null && exploreHeader(explore).sensitive === true);
  const files = [{ file: `review-${n}.md`, mode: split ? "overall" : "full", kind: "review" }];
  if (sensitive) files.push({ file: `security-review-${n}.md`, mode: "security", kind: "security" });
  if (split) for (const g of groups) files.push({ file: `review-${n}-g${g.n}.md`, mode: `group ${g.n}`, kind: "group", group: g.n });
  return files;
}

// Decides review round n of a change. problems: the round's files are incomplete or inconsistent; approved: no problems and
// every expected file says Status: Approved; findings: every finding of the round's files; open: the R/S ids still open
// (this round's findings, then previous findings with verdict open).
function reviewProblems(change, n) {
  const dir = path.join(CHANGES_DIR, change);
  const problems = [];
  const findings = [];
  const open = [];
  const addOpen = (id) => { if (!open.includes(id)) open.push(id); };
  const expected = roundFiles(change, n);
  const acs = taskAcIds(change);
  // R and S ids of earlier rounds, by prefix: the latest earlier severity of each id, and the blocking ids of round n-1.
  const earlier = { R: new Map(), S: new Map() };
  const lastBlocking = { R: [], S: [] };
  for (let k = 1; k < n; k++) {
    for (const [prefix, name, fits] of [["R", `review-${k}.md`, REVIEW_ID], ["S", `security-review-${k}.md`, SECURITY_ID]]) {
      for (const f of roundFindings(read(path.join(dir, name)) || "") || []) {
        if (!fits.test(f.id)) continue;
        earlier[prefix].set(f.id, f.severity.toLowerCase());
        if (k === n - 1 && f.severity.toLowerCase() === "blocking" && !lastBlocking[prefix].includes(f.id)) lastBlocking[prefix].push(f.id);
      }
    }
  }
  const highest = (ids) => Math.max(0, ...[...ids.keys()].map((id) => Number(id.slice(1))));
  const answers = n >= 2 ? reviewAnswers(change, n - 1) : [];
  let allApproved = true;
  let reviewApproved = false;
  const groupsRequesting = [];
  const feedbackRound = expected.some((f) => f.feedback);
  for (const { file, mode, kind, group, feedback } of expected) {
    const text = read(path.join(dir, file));
    if (text === null) { problems.push(`${file} is missing`); allApproved = false; continue; }
    const field = {};
    for (const f of ["Change", "Stage", "Round", "Mode", "Status"]) {
      field[f] = headerValue(text, f);
      if (field[f] === null) problems.push(`${file}: no ${f} line`);
      else if ((text.match(new RegExp(`^${f}:`, "gmi")) || []).length > 1) problems.push(`${file}: more than one ${f} line`);
    }
    const status = (field.Status || "").toLowerCase();
    const approved = status === "approved";
    if (field.Status !== null && !["approved", "changes requested"].includes(status)) problems.push(`${file}: Status must be Approved or Changes requested`);
    else if (feedback && approved) problems.push(`${file}: a feedback round must say Status: Changes requested`);
    if (!approved) allApproved = false;
    if (kind === "review") reviewApproved = approved;
    if (kind === "group" && status === "changes requested") groupsRequesting.push(file);
    if (field.Round !== null && field.Round !== String(n)) problems.push(`${file}: Round is ${field.Round}, expected ${n}`);
    if (field.Mode !== null && field.Mode.replace(/\s+/g, " ").toLowerCase() !== mode) problems.push(`${file}: Mode is ${field.Mode}, expected ${mode}`);

    const tables = roundTables(text);
    const rows = findingsOf(tables.findings);
    if (rows === null) problems.push(`${file}: no findings table`);
    for (const p of tables.problems) problems.push(`${file}: ${p}`);
    const fits = kind === "group" ? groupIdPattern(group) : kind === "security" ? SECURITY_ID : REVIEW_ID;
    const prefix = kind === "security" ? "S" : "R";
    const seen = new Set();
    for (const f of rows || []) {
      const severity = f.severity.toLowerCase(), area = f.area.toLowerCase();
      if (!REVIEW_SEVERITIES.includes(severity)) problems.push(`${file}: finding ${f.id} has severity ${f.severity}`);
      if (!REVIEW_AREAS.includes(area)) problems.push(`${file}: finding ${f.id} has area ${f.area}`);
      if (!fits.test(f.id)) problems.push(`${file}: finding id ${f.id} does not fit this file`);
      else if (kind !== "group" && !earlier[prefix].has(f.id) && Number(f.id.slice(1)) <= highest(earlier[prefix])) problems.push(`${file}: new finding ${f.id} must be above ${highest(earlier[prefix])}`);
      if (seen.has(f.id)) problems.push(`${file}: finding id ${f.id} is used twice`);
      seen.add(f.id);
      const blocking = severity === "blocking";
      if (approved && blocking) problems.push(`${file}: approved with blocking finding ${f.id}`);
      findings.push({ id: f.id, file, severity, area, blocking });
      if (kind !== "group") addOpen(f.id);
    }

    // A feedback round has no Previous findings and no Acceptance criteria table (decision 5).
    if (feedback) {
      if (tables.previous !== null) problems.push(`${file}: a feedback round has no previous findings table`);
      if (tables.acs !== null) problems.push(`${file}: a feedback round has no acceptance criteria table`);
    }

    if (n >= 2 && kind !== "group" && !feedback) {
      const previous = tables.previous || [];
      // Every blocking finding of round n-1 needs an answer (ruling R2); every answer needs a verdict.
      for (const id of lastBlocking[prefix]) {
        if (!answers.some((a) => a.id === id)) problems.push(`${file}: blocking finding ${id} of round ${n - 1} has no answer in build-review-${n - 1}.md`);
      }
      for (const a of answers.filter((x) => fits.test(x.id))) {
        const row = previous.filter((c) => c[0] === a.id).pop();
        const verdict = row ? (row[2] || "").toLowerCase() : "";
        if (!REVIEW_VERDICTS.includes(verdict)) problems.push(`${file}: answer for ${a.id} in build-review-${n - 1}.md has no verdict`);
      }
      for (const c of previous) {
        if ((c[2] || "").toLowerCase() !== "open" || !fits.test(c[0])) continue;
        addOpen(c[0]);
        // A reused id is the same finding, still open (decision 2), so it must be re-listed; the round-to-round blocking
        // checks then carry it forward (ruling R3).
        if (!seen.has(c[0])) problems.push(`${file}: open finding ${c[0]} is not in the findings table`);
        // An earlier blocking finding still open blocks approval, like one in this round's table (ruling R2, C1).
        if (approved && earlier[prefix].get(c[0]) === "blocking") problems.push(`${file}: approved with blocking finding ${c[0]}`);
      }
    }

    if (kind === "review" && !feedback) {
      const table = tables.acs || [];
      for (const ac of acs) {
        const row = table.filter((c) => c[0] === ac).pop();
        if (!row) problems.push(`${file}: ${ac} is not in the acceptance criteria table`);
        else if (approved && (row[1] || "").toLowerCase() !== "met") problems.push(`${file}: approved with ${ac} not met`);
      }
    }
  }
  // The fix loop reads only review-<n>.md (and the security file), so the overall file cannot approve while a group file
  // requests changes: its findings would reach no builder (ruling R10).
  if (reviewApproved) for (const g of groupsRequesting) problems.push(`review-${n}.md: approved while ${g} requests changes`);
  const tests = testComparison(change, `review-${n}`);
  // A feedback round runs no tests: its fix loop and the next normal round do.
  if (feedbackRound) { /* no test run expected */ } else if (!tests.ran) problems.push(`review-${n}: tests were not run`);
  else if (reviewApproved) {
    for (const lv of tests.mismatches) problems.push(`review-${n}: approved with tests mismatched at ${lv}`);
    for (const lv of tests.regressions) problems.push(`review-${n}: approved with a regression at ${lv}`);
  }
  const unique = [...new Set(problems)];
  return { round: n, approved: unique.length === 0 && allApproved, problems: unique, findings, open };
}

function cmdCheckReview() {
  const usage = "Usage: check-review <change> --round <n> [--json]";
  const roundArg = opt("round");
  if (!/^[1-9]\d{0,5}$/.test(roundArg || "")) { console.error(usage); process.exitCode = 2; return; }
  const change = changeArg(usage);
  if (!change) return;
  const r = reviewProblems(change, Number(roundArg));
  const text = r.problems.length ? r.problems.join("\n")
    : `Review round ${r.round}: ${r.approved ? "approved" : "changes requested"}${r.open.length ? ` (open: ${r.open.join(", ")})` : ""}.`;
  print({ ok: r.problems.length === 0, ...r }, text);
  if (r.problems.length) process.exitCode = 1;
}

// Tree object of the main working tree (tracked files plus untracked, not ignored ones), built in a throwaway index: the user's
// index is never read or written.
function snapshotTreeOfWorkingTree() {
  const tmp = fs.mkdtempSync(path.join(tmpdir(), "gw-review-"));
  try { return snapshotTree(ROOT, path.join(tmp, "index")); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// The empty tree of this repository's hash algorithm, written from an empty throwaway index.
function emptyTree() {
  const tmp = fs.mkdtempSync(path.join(tmpdir(), "gw-review-"));
  try { return gitAtMust(ROOT, ["write-tree"], { env: { GIT_INDEX_FILE: path.join(tmp, "index") } }).out.trim(); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

const REVIEW_LARGE_LINES = 1500;
const OUTSIDE_GROUNDWORK = ["--", ".", ":(exclude).groundwork"];

// Text diff between two trees, one chunk per file, .groundwork/ left out. A file whose diff has more than 1500 lines is left out
// of the patch and marked large. Binary files show git's "Binary files ... differ" line. Returns { files, patch (Buffer) }.
function treeDiff(from, to) {
  const split = (out) => out.split("\0");
  const status = new Map();
  const ns = split(gitAtMust(ROOT, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to, ...OUTSIDE_GROUNDWORK]).out);
  for (let i = 0; i + 1 < ns.length; i += 2) if (ns[i]) status.set(ns[i + 1], ns[i][0] === "A" ? "A" : ns[i][0] === "D" ? "D" : "M");
  const counts = new Map();
  for (const e of split(gitAtMust(ROOT, ["diff-tree", "-r", "-z", "--no-renames", "--numstat", from, to, ...OUTSIDE_GROUNDWORK]).out)) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(e);
    if (m) counts.set(m[3], { added: m[1] === "-" ? null : Number(m[1]), deleted: m[2] === "-" ? null : Number(m[2]) });
  }
  const files = [];
  const chunks = [];
  for (const p of [...status.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const c = counts.get(p) || { added: null, deleted: null };
    const chunk = gitAtMust(ROOT, ["-c", "core.quotePath=false", "diff-tree", "-p", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", from, to, "--", `:(literal)${p}`], { raw: true }).out;
    let lines = 0;
    for (const byte of chunk) if (byte === 10) lines++;
    const large = lines > REVIEW_LARGE_LINES;
    if (!large) chunks.push(chunk);
    files.push({ status: status.get(p), path: p, added: c.added, deleted: c.deleted, note: large ? "large: read the file" : c.added === null ? "binary" : "" });
  }
  return { files, patch: Buffer.concat(chunks) };
}

// Screenshot paths under evidence/ named in the build reports' Scenario coverage tables, in report order, without repeats.
// A format 1 run's single build.md is read too.
function evidenceScreenshots(change, { format = 2 } = {}) {
  const dir = path.join(CHANGES_DIR, change);
  const screenshots = [];
  const prefix = `.groundwork/changes/${change}/`;
  for (const file of [...(format === 1 ? ["build.md"] : []), ...buildReports(dir)]) {
    for (const row of coverageRows(read(path.join(dir, file)) || "")) {
      const s = row.screenshot;
      if (s && s !== "-" && (s.startsWith(prefix) ? s.slice(prefix.length) : s).startsWith("evidence/") && !screenshots.includes(s)) screenshots.push(s);
    }
  }
  return screenshots;
}

function cmdReviewInput() {
  const usage = "Usage: review-input <change> --round <n> [--json] | review-input <change> --next-round [--json]";
  const roundArg = opt("round");
  if (flags.has("--next-round")) {
    // Read-only (ruling R9): the round the next review runs under and the exact reviewer files it needs, so no prompt derives them.
    if (rest.includes("--round") || roundArg !== undefined) { console.error(usage); process.exitCode = 2; return; }
    const change = changeArg(usage);
    if (!change) return;
    const n = reviewRound(change);
    const expected = roundFiles(change, n, { normal: true });
    const files = expected.map(({ file, mode }) => ({ file, mode }));
    const split = expected.some((f) => f.kind === "group");
    const sensitive = expected.some((f) => f.kind === "security");
    const loops = reviewLoops(change);
    // A feedback round waiting for its fix: its number is the current round, and the fix runs before any review.
    const pendingFeedback = isFeedbackRound(change, n) && !exists(path.join(CHANGES_DIR, change, `build-review-${n}.md`));
    print({ ok: true, nextRound: n, split, sensitive, files, loops, pendingFeedback },
      pendingFeedback ? `Round ${n} of ${change} is a feedback round waiting for its fix (Review: review-${n}.md). Fix loops so far: ${loops}`
        : `Next review round for ${change}: round ${n}${split ? ", split" : ""}${sensitive ? ", sensitive" : ""}. Reviewers: ${files.map((f) => `${f.file} (${f.mode})`).join(", ")}. Fix loops so far: ${loops}`);
    return;
  }
  if (!/^[1-9]\d{0,5}$/.test(roundArg || "")) { console.error(usage); process.exitCode = 2; return; }
  const change = changeArg(usage);
  if (!change) return;
  const n = Number(roundArg);
  const dir = path.join(CHANGES_DIR, change);
  const inputs = path.join(dir, "inputs");
  const { base: mergeBase, baseBranch, fallback } = diffBase();
  const base = mergeBase || emptyTree();
  const baseLabel = !mergeBase ? "no commit" : fallback ? "HEAD fallback" : baseBranch;
  const tree = snapshotTreeOfWorkingTree();
  const main = treeDiff(base, tree);

  // Since: the Tree of the highest earlier round k < n whose input pack has a valid one, when that tree object still exists.
  // Feedback rounds have no input pack, so the review after a feedback fix compares against the last reviewed tree.
  let since = null, sinceLine = "none", sincePatch = null, sinceLarge = [];
  if (n >= 2) {
    let packs = [];
    try { packs = fs.readdirSync(inputs).map((f) => /^review-(\d+)\.md$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).filter((k) => k < n).sort((a, b) => b - a); } catch { /* no inputs/ yet */ }
    let prev = null;
    for (const k of packs) {
      const t = headerValue(read(path.join(inputs, `review-${k}.md`)) || "", "Tree");
      if (t && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(t)) { prev = t; break; }
    }
    if (prev && gitAt(ROOT, ["cat-file", "-e", `${prev}^{tree}`]).ok) {
      since = prev;
      sinceLine = prev;
      const d = treeDiff(prev, tree);
      sincePatch = d.patch;
      sinceLarge = d.files.filter((f) => f.note.startsWith("large")).map((f) => f.path);
    } else sinceLine = "none (previous tree not found)";
  }

  // The plan the reviewers read (ruling R12 a): plan.md on the fast path, else the OpenSpec folder, live or archived.
  const run = parseRun(change);
  const plan = run && run.path === "fast" ? `.groundwork/changes/${change}/plan.md` : openspecChangeRel(change) || "none";
  const tests = testComparison(change, `review-${n}`);
  const { problems, warnings } = buildProblems(change);
  const screenshots = evidenceScreenshots(change);
  const patches = [`inputs/review-${n}.patch`, ...(since ? [`inputs/review-${n}-since.patch`] : [])];
  const list = (xs) => (xs.length ? xs.join(", ") : "none");
  const md = [
    `Change: ${change}`, `Round: ${n}`, `Base: ${base} (${baseLabel})`, `Tree: ${tree}`, `Since: ${sinceLine}`, `Plan: ${plan}`, "",
    "## Files", "| Status | Path | + | - | Note |", "|--------|------|---|---|------|",
    ...main.files.map((f) => `| ${f.status} | ${cell(f.path)} | ${f.added ?? "-"} | ${f.deleted ?? "-"} | ${f.note} |`), "",
    "## Tests", "| Level | Baseline | After build | Review |", "|-------|----------|-------------|--------|",
    ...tests.levels.map((l) => `| ${l.level} | ${l.baseline} | ${l.afterBuild} | ${l.review} |`), "",
    `Mismatches: ${list(tests.mismatches)}   Regressions: ${list(tests.regressions)}`, "",
    "## Build check", ...(problems.length || warnings.length ? [...problems.map((p) => `error: ${p}`), ...warnings.map((w) => `warning: ${w}`)] : ["none"]), "",
    "## Screenshots", ...(screenshots.length ? screenshots.map((s) => `- ${s}`) : ["none"]), "",
    "## Patches", ...patches.map((p) => `- ${p}`),
    // The Files table marks large files of the full patch; this line names those the since-patch leaves out (ruling R10).
    ...(sinceLarge.length ? [`Left out of since-patch (large): ${sinceLarge.join(", ")}`] : []), "",
  ].join("\n");

  fs.mkdirSync(inputs, { recursive: true });
  fs.writeFileSync(path.join(inputs, `review-${n}.patch`), main.patch);
  const sinceFile = path.join(inputs, `review-${n}-since.patch`);
  if (since) fs.writeFileSync(sinceFile, sincePatch);
  else fs.rmSync(sinceFile, { force: true });
  fs.writeFileSync(path.join(inputs, `review-${n}.md`), md);
  print({ round: n, nextRound: reviewRound(change), base, tree, since, files: main.files, tests, buildCheck: { problems, warnings }, patches },
    `Review input for ${change} round ${n}: ${rel(path.join(inputs, `review-${n}.md`))} (${main.files.length} file(s), ${patches.length} patch(es))`);
}

// ---------- deliver-input ----------

// How a change links to its ticket (spec 8.6): { type, key, title, description }. key: the ticket key from source.json (null for
// a prompt or no ticket); title: the form for the commit subject and PR title; description: the form for the PR description.
// Jira PROJ-123 everywhere; GitHub #42, and "Closes #42" in the description; Azure DevOps AB#123 everywhere. type is config
// tracker.type, or source.json's tracker when the config says none. A format 1 run without source.json takes the key from the
// first word of its Source line when that word matches tracker.keyPattern. Throws when source.json exists but is not valid.
// A key or type holding whitespace or a control or format character is refused (no key; type "none"), so neither can forge
// a line of inputs/deliver.md or deliver.md.
const ONE_WORD = /^[^\s\p{Cc}\p{Cf}\p{Z}]+$/u;
function trackerLink(run, cfg) {
  const file = path.join(CHANGES_DIR, run.change, "source.json");
  const source = exists(file) ? readSourceAt(file, `change "${run.change}"`) : null;
  const configured = cfg.tracker && typeof cfg.tracker.type === "string" ? cfg.tracker.type.trim() : "none";
  const picked = configured === "none" && source && source.kind === "ticket" ? source.tracker.trim() : configured;
  const type = ONE_WORD.test(picked) ? picked : "none";
  let key = null;
  if (source) key = source.kind === "ticket" && source.key.trim() ? source.key.trim() : null;
  else if (run.format === 1 && run.source && cfg.tracker && cfg.tracker.keyPattern) {
    const word = run.source.trim().split(/\s+/)[0] || "";
    try { if (new RegExp(cfg.tracker.keyPattern).test(word)) key = word; } catch { /* invalid pattern: no key */ }
  }
  if (key !== null && !ONE_WORD.test(key)) key = null;
  if (!key) return { type, key: null, title: null, description: null };
  if (type === "github") return { type, key, title: key, description: `Closes ${key}` };
  if (type === "azure-devops") {
    const m = /(\d+)$/.exec(key);
    const ab = m ? `AB#${m[1]}` : key;
    return { type, key, title: ab, description: ab };
  }
  return { type, key, title: key, description: key };
}

function cmdDeliverInput() {
  const usage = "Usage: deliver-input <change> [--json]";
  const change = changeArg(usage);
  if (!change) return;
  const run = parseRun(change);
  const cfg = loadConfig();
  const dir = path.join(CHANGES_DIR, change);
  const fail = (msg) => { print({ ok: false, error: msg }, msg); process.exitCode = 1; };

  // The review that approves delivery: format 2, the latest round's files; format 1, review.md.
  let review, acs = null;
  if (run.format >= 2) {
    const n = reviewRound(change);
    const r = reviewProblems(change, n);
    if (!r.approved) return fail(`deliver-input: review round ${n} of ${change} is not approved${r.problems.length ? `: ${r.problems.join("; ")}` : ""}`);
    review = roundFiles(change, n).filter((f) => f.kind !== "group").map((f) => f.file);
    acs = (roundTables(read(path.join(dir, `review-${n}.md`)) || "").acs || []).map((c) => ({ ac: c[0] || "", verdict: c[1] || "", evidence: c[2] || "" }));
  } else {
    const status = headerValue(read(path.join(dir, "review.md")) || "", "Status");
    if ((status || "").toLowerCase() !== "approved") return fail(`deliver-input: review.md of ${change} is not approved`);
    review = ["review.md"];
  }

  const link = trackerLink(run, cfg);
  // --no-show-signature: log.showSignature would add gpg lines. Subjects are written as "- <subject>" lines, so none can open a
  // heading or a table row in inputs/deliver.md (ruling R3).
  const commits = gitMust(["log", "-20", "--no-show-signature", "--format=%s"]).out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  const { files } = changedFiles();
  const tests = testComparison(change, "after-build").levels.map(({ level, baseline, afterBuild }) => ({ level, baseline, afterBuild }));
  const screenshots = evidenceScreenshots(change, { format: run.format });
  const base = cfg.deliver.baseBranch;
  const branch = `groundwork/${change}`;
  // The OpenSpec change folder, live or archived (step 5 archives it before this runs; ruling R12 d). Fast path: none.
  const openspec = run.path === "fast" ? null : openspecChangeRel(change);

  const md = [
    `Change: ${change}`, `Path: ${run.path}`, `Format: ${run.format >= 2 ? 2 : 1}`, `Base: ${base}`, `Branch: ${branch}`,
    `Tracker: ${link.type} ${link.key ?? "none"}`, `Link in title: ${link.title ?? "none"}`, `Link in description: ${link.description ?? "none"}`,
    `Review: ${review.join(", ")}`, `OpenSpec: ${openspec ?? "none"}`, "",
    "## Recent commit subjects", ...commits.map((s) => `- ${s}`),
    "## Files", "| Status | Path |", "|--------|------|", ...files.map((f) => `| ${f.status} | ${cell(f.path)} |`),
    "## Acceptance criteria", ...(acs === null ? ["not recorded"] : ["| AC | Verdict | Evidence |", "|----|---------|----------|", ...acs.map((a) => `| ${cell(a.ac)} | ${cell(a.verdict)} | ${cell(a.evidence)} |`)]),
    "## Tests", "| Level | Baseline | After build |", "|-------|----------|-------------|", ...tests.map((t) => `| ${t.level} | ${t.baseline} | ${t.afterBuild} |`),
    "## Screenshots", ...(screenshots.length ? screenshots.map((s) => `- ${s}`) : ["none"]), "",
  ].join("\n");
  const inputs = path.join(dir, "inputs");
  fs.mkdirSync(inputs, { recursive: true });
  fs.writeFileSync(path.join(inputs, "deliver.md"), md);
  print({ ok: true, change, path: run.path, format: run.format >= 2 ? 2 : 1, base, branch, tracker: { type: link.type, key: link.key },
    link: { title: link.title, description: link.description }, review, openspec, commits, files, acs, tests, screenshots },
  `Deliver input for ${change}: ${rel(path.join(inputs, "deliver.md"))} (${files.length} file(s), ${commits.length} commit subject(s))`);
}

// ---------- check-deliver ----------

// deliver.md sections, in order; and the headings the pull request description must have.
const DELIVER_SECTIONS = ["Branch", "Commit message", "Pull request title", "Pull request description", "Changelog"];
const DESCRIPTION_HEADINGS = ["What", "Why", "Acceptance criteria", "Tests", "Screenshots", "Spec changes", "Review notes"];
// The placeholder texts of gw-deliver's skeleton (agents/gw-deliver.md), as they start a line or its bullet.
const DELIVER_PLACEHOLDERS = ["<subject line:", "<body: optional", "<one line, with the Link in title text>", "<one or two sentences>", "<from proposal.md",
  "<AC<k>>", "<level>", "<each path from the Screenshots section", "<spec>", "<the OpenSpec line of inputs/deliver.md>",
  "<from the review files of the Review line>", "<the Link in description text", "<entry in the repository's changelog format"];

// True when text holds form as a whole token, not glued to a letter or digit (PROJ-123 is not in PROJ-1234, AC2 not in AC22).
function hasForm(text, form) {
  const esc = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "u").test(text);
}

// The AC ids of inputs/deliver.md, read strictly: the first cells of the rows of the exact table directly under its
// "## Acceptance criteria" line. deliver-input writes commit subjects as "- " lines and paths as table cells, so neither can
// open that heading or add a row. [] when the file says "not recorded" (format 1).
function deliverInputAcs(text) {
  const lines = String(text).split(/\r?\n/);
  const at = lines.indexOf("## Acceptance criteria");
  if (at < 0 || lines[at + 1] !== "| AC | Verdict | Evidence |" || !isSeparator(tableCells(lines[at + 2] || "x"))) return [];
  const acs = [];
  for (let i = at + 3; i < lines.length && lines[i].startsWith("|"); i++) {
    const id = tableCells(lines[i])[0];
    if (id && !acs.includes(id)) acs.push(id);
  }
  return acs;
}

// Per line of markdown text: true when it is prose, false for a code fence line or a line inside a fenced code block.
function outsideFences(lines) {
  let fence = null;
  return lines.map((l) => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(l);
    if (f) { if (!fence) fence = f[1]; else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; return false; }
    return !fence;
  });
}

// "## <heading>" lines of markdown text outside fenced code blocks: Map heading -> line index.
function markdownHeadings(lines) {
  const found = new Map();
  const prose = outsideFences(lines);
  lines.forEach((l, i) => {
    const m = prose[i] && /^##[ \t]+(.+?)[ \t]*$/.exec(l);
    if (m && !found.has(m[1])) found.set(m[1], i);
  });
  return found;
}

// Checks deliver.md, written by gw-deliver: { problems, parsed: { branch, subject, body, title, description, changelog } }.
// Sections are found in order; Changelog is the last "## Changelog" line, so the description may hold any heading of its own.
function deliverProblems(change) {
  const dir = path.join(CHANGES_DIR, change);
  const parsed = { branch: null, subject: null, body: null, title: null, description: null, changelog: null };
  const text = read(path.join(dir, "deliver.md"));
  if (text === null) return { problems: ["deliver.md is missing"], parsed };
  const problems = [];
  const lines = text.split(/\r?\n/);
  const isHeading = (i, h) => lines[i].replace(/\s+$/, "") === `## ${h}`;
  const at = {};
  let from = 0;
  for (const h of DELIVER_SECTIONS) {
    let i = -1;
    if (h === "Changelog") { for (let k = lines.length - 1; k >= from; k--) if (isHeading(k, h)) { i = k; break; } }
    else for (let k = from; k < lines.length; k++) if (isHeading(k, h)) { i = k; break; }
    if (i >= 0) { at[h] = i; from = i + 1; }
  }
  const starts = Object.values(at).sort((a, b) => a - b);
  // A section's lines, without leading and trailing blank lines; null when the heading is missing or the section is empty.
  const body = (h) => {
    if (at[h] === undefined) return null;
    const end = starts.find((s) => s > at[h]) ?? lines.length;
    const b = lines.slice(at[h] + 1, end);
    while (b.length && !b[0].trim()) b.shift();
    while (b.length && !b[b.length - 1].trim()) b.pop();
    return b.length ? b : null;
  };
  const sec = Object.fromEntries(DELIVER_SECTIONS.map((h) => [h, body(h)]));
  for (const h of DELIVER_SECTIONS) if (!sec[h]) problems.push(`deliver.md: no ${h} section`);

  if (sec.Branch) {
    parsed.branch = sec.Branch.map((l) => l.trim()).join("\n");
    if (parsed.branch !== `groundwork/${change}`) problems.push(`deliver.md: branch must be groundwork/${change}`);
  }
  if (sec["Commit message"]) {
    const [first, ...rest] = sec["Commit message"];
    parsed.subject = first.trim();
    while (rest.length && !rest[0].trim()) rest.shift();
    parsed.body = rest.map((l) => l.replace(/\s+$/, "")).join("\n");
    if ([...parsed.subject].length > 72) problems.push("deliver.md: commit subject is longer than 72 characters");
  }
  if (sec["Pull request title"]) {
    const t = sec["Pull request title"].map((l) => l.trim()).filter(Boolean);
    parsed.title = t.join(" ");
    if (t.length > 1) problems.push("deliver.md: pull request title must be one line");
  }
  // Task 4 passes the subject and title to git and the code host: no control, format or line-separator character, and no
  // leading "-" that could read as an option (ruling R4). Tabs stay allowed in the body.
  const unsafe = (s) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s) || /^-/.test(s);
  if (parsed.subject !== null && unsafe(parsed.subject)) problems.push("deliver.md: commit subject has a control character or starts with -");
  if (parsed.title !== null && unsafe(parsed.title)) problems.push("deliver.md: pull request title has a control character or starts with -");
  // A skeleton placeholder line the agent did not replace (ruling R4; final review D1): only gw-deliver's own placeholder texts,
  // at the start of a line or of its bullet, and never inside a code fence, so HTML, comments and autolinks pass.
  const prose = outsideFences(lines);
  for (const [i, l] of lines.entries()) {
    if (!prose[i]) continue;
    const t = l.trim().replace(/^[-*]\s+(OpenSpec change:\s*)?/, "");
    if (DELIVER_PLACEHOLDERS.some((p) => t.startsWith(p))) problems.push(`deliver.md: placeholder left: ${l.trim()}`);
  }
  const descLines = sec["Pull request description"];
  if (descLines) parsed.description = descLines.map((l) => l.replace(/\s+$/, "")).join("\n");
  if (sec.Changelog) parsed.changelog = sec.Changelog.map((l) => l.replace(/\s+$/, "")).join("\n");

  // Tracker link forms (spec 8.6), from trackerLink; none without a ticket.
  const link = trackerLink(parseRun(change), loadConfig());
  if (link.title) {
    if (parsed.subject !== null && !hasForm(parsed.subject, link.title)) problems.push(`deliver.md: commit subject must contain ${link.title}`);
    if (parsed.title !== null && !hasForm(parsed.title, link.title)) problems.push(`deliver.md: pull request title must contain ${link.title}`);
  }
  if (link.description && parsed.description !== null && !hasForm(parsed.description, link.description)) {
    problems.push(`deliver.md: pull request description must contain ${link.description}`);
  }

  if (descLines) {
    const headings = markdownHeadings(descLines);
    for (const h of DESCRIPTION_HEADINGS) if (!headings.has(h)) problems.push(`deliver.md: description has no ${h} section`);
    // Every AC of the approving review (format 2) is listed in the description's Acceptance criteria section, or anywhere in the
    // description when that section is missing. Format 1 records no AC table, so nothing is checked (ruling R1(b)).
    const input = read(path.join(dir, "inputs", "deliver.md"));
    if (input === null) problems.push("deliver.md: inputs/deliver.md is missing (run deliver-input)");
    else {
      let scope = parsed.description;
      if (headings.has("Acceptance criteria")) {
        const s = headings.get("Acceptance criteria");
        const next = [...headings.values()].filter((i) => i > s).sort((a, b) => a - b)[0] ?? descLines.length;
        scope = descLines.slice(s + 1, next).join("\n");
      }
      for (const ac of deliverInputAcs(input)) if (!hasForm(scope, ac)) problems.push(`deliver.md: description does not list ${ac}`);
      // Full path (final review D7): the description's OpenSpec change line names exactly the folder of the input's OpenSpec:
      // header (live or archived). Backticks around the path and a trailing slash do not matter.
      const osHeader = headerValue(input, "OpenSpec");
      if (osHeader && osHeader !== "none") {
        const norm = (p) => p.replace(/^`(.*)`$/, "$1").trim().replace(/\/+$/, "");
        const prose = outsideFences(descLines);
        const found = descLines.map((l, i) => prose[i] && /^\s*[-*]\s+OpenSpec change:\s*(.*?)\s*$/.exec(l)).filter(Boolean).map((m) => m[1]);
        if (!found.length || found.some((p) => norm(p) !== norm(osHeader))) problems.push(`deliver.md: OpenSpec change line must be ${osHeader}`);
      }
    }
  }
  return { problems, parsed };
}

function cmdCheckDeliver() {
  const usage = "Usage: check-deliver <change> [--json]";
  const change = changeArg(usage);
  if (!change) return;
  const { problems, parsed } = deliverProblems(change);
  print({ ok: problems.length === 0, problems, parsed }, problems.length ? problems.join("\n") : `deliver.md for ${change}: ok.`);
  if (problems.length) process.exitCode = 1;
}

// ---------- deliver ----------

// gh or az, or their GW_FAKE_HOST stand-in (decision 1): <dir>/<tool>.json maps the call key (the leading subcommand words) to
// { code, stdout, stderr }, and each call is appended to <dir>/calls.jsonl. files names the text the call reads from temporary
// files, by flag; the fake host records it with the args so tests see the exact title and description sent.
function hostRun(tool, args, files = {}, timeoutMs = 5 * 60 * 1000) {
  const fake = process.env.GW_FAKE_HOST;
  if (fake) {
    const words = [];
    for (const a of args) { if (!/^[a-z][a-z0-9-]*$/.test(a)) break; words.push(a); }
    const key = words.join(" ");
    const callKey = (a) => { const w = []; for (const x of a) { if (!/^[a-z][a-z0-9-]*$/.test(x)) break; w.push(x); } return w.join(" "); };
    const log = path.join(fake, "calls.jsonl");
    // A key may map to a list of responses, used in call order; the last one repeats.
    let earlier = 0;
    try {
      for (const l of fs.readFileSync(log, "utf8").split("\n")) {
        if (!l) continue;
        const c = JSON.parse(l);
        if (c.tool === tool && callKey(c.args || []) === key) earlier++;
      }
    } catch { /* first call */ }
    fs.appendFileSync(log, JSON.stringify({ tool, args, files }) + "\n");
    let map = null;
    try { map = JSON.parse(fs.readFileSync(path.join(fake, `${tool}.json`), "utf8")); } catch { /* no fixture: every call fails */ }
    let entry = isPlainObject(map) ? map[key] : null;
    if (Array.isArray(entry)) entry = entry.length ? entry[Math.min(earlier, entry.length - 1)] : null;
    const r = isPlainObject(entry) ? entry : null;
    if (!r) return { code: 1, stdout: "", stderr: `fake host: no response for ${key}` };
    return { code: Number(r.code) || 0, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
  }
  const opts = { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs };
  let r;
  // az is a .cmd script on Windows and needs cmd.exe; deliver passes it only fixed words, branch names and @file references, so
  // no title or description text is ever on that command line. gh is an executable and runs without a shell everywhere.
  if (process.platform === "win32" && tool === "az") {
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    r = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${[tool, ...args].map(q).join(" ")}"`], { ...opts, windowsVerbatimArguments: true });
  } else r = spawnSync(tool, args, opts);
  if (r.error) return { code: 1, stdout: "", stderr: r.error.code === "ENOENT" ? `${tool} is not installed or not on PATH` : r.error.message };
  return { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// Paths of a change's folder that are generated or local state and never committed (decision 6, ruling R1(a)).
const DELIVER_SKIP = [/^inputs\//, /^tests\/[^/]*\.log$/, /^plan-summary\.html$/, /^delivery-summary\.html$/, /^snapshots\//];

// The paths deliver stages: everything that differs from HEAD outside .groundwork/ (the approved code and openspec/ files,
// deletions and untracked files included), plus the change's own .groundwork/changes/<c>/ files, minus DELIVER_SKIP. On the base
// branch HEAD is the diff base, so this is changedFiles() plus the change's files; on a re-run it is what is not yet committed.
function deliverPaths(change) {
  const head = gitAt(ROOT, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const own = `.groundwork/changes/${change}/`;
  return changedFiles({ includeGroundwork: true, base: head.ok && head.out.trim() ? head.out.trim() : null }).files.map((f) => f.path).filter((p) => {
    if (p.startsWith(own)) return !DELIVER_SKIP.some((re) => re.test(p.slice(own.length)));
    return !(p === ".groundwork" || p.startsWith(".groundwork/"));
  });
}

// Decision 2, extended to the push by ruling R7: the commit and the push run with the user's own git configuration, so their
// hooks (pre-commit, commit-msg, and pre-push, where Git LFS uploads its objects) and commit signing apply. The user approved
// this exact content at gate 2 and expects their hooks; the hardened empty hooksPath of every other git call is not used here.
// core.fsmonitor stays off. timeoutMs bounds a slow or interactive hook.
function userGit(args, { env = {}, timeoutMs } = {}) {
  const r = spawnSync("git", ["-c", "core.fsmonitor=false", ...args],
    { cwd: ROOT, env: gitEnv(env), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...(timeoutMs ? { timeout: timeoutMs } : {}) });
  const timedOut = !!r.error && r.error.code === "ETIMEDOUT";
  return { ok: !r.error && r.status === 0, timedOut, err: r.error && !timedOut ? r.error.message : `${r.stderr || ""}\n${r.stdout || ""}` };
}

// The line of git's output that says why it failed: a rejected ref, then error:, fatal:, remote: lines, else the first line.
function gitReason(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const re of [/^! \[/, /^error:/, /^fatal:/, /^remote:/]) {
    const l = lines.find((x) => re.test(x));
    if (l) return l;
  }
  return lines[0] || "no output";
}

// The only place Groundwork commits, pushes and opens or updates a pull request. Steps stop at the first failure; nothing in git
// changes before the approval and branch checks pass, and a refused staging leaves the index as it was. A failure after the
// commit keeps the commit and branch, and a re-run skips the commit and repeats push (a no-op when done) and the PR step (list
// first, so it edits instead of creating twice). Every failure prints { ok: false, step, error }.
function cmdDeliver() {
  const change = changeArg("Usage: deliver <change> [--json]");
  if (!change) return;
  const { out, fail } = deliveryOutput();
  let step = "config";
  let tmp = null;
  try {
    tmp = fs.mkdtempSync(path.join(tmpdir(), "gw-deliver-"));
    deliverSteps(change, fail, out, tmp, (s) => { step = s; });
  } catch (e) {
    fail(step, `deliver: ${e.message}`);
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const splitNul = (s) => s.split("\0").filter(Boolean);

// A deliver-style command's output: every result carries the warning that the fake host is on (decision 1), so it can never pass
// unnoticed on a real push, and every failure is { ok: false, step, error }.
function deliveryOutput() {
  const warning = process.env.GW_FAKE_HOST ? `GW_FAKE_HOST is set; gh and az calls are faked from ${process.env.GW_FAKE_HOST}` : null;
  const out = (obj, text) => print(warning ? { ...obj, warning } : obj, warning ? `warning: ${warning}\n${text}` : text);
  const fail = (step, error) => { out({ ok: false, step, error }, error); process.exitCode = 1; };
  return { out, fail };
}

// Branch rule (decision 3): from the base branch (the branch is created later) or from the branch itself (an update). Returns the
// current branch, or null after a failure.
function deliveryBranch(who, base, branch, fail) {
  const cur = gitAt(ROOT, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const current = cur.ok ? cur.out.trim() : null;
  if (current !== base && current !== branch) { fail("branch", `${who}: switch to ${base} or ${branch} first`); return null; }
  if (!gitAt(ROOT, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).ok) { fail("branch", `${who}: the repository has no commit yet`); return null; }
  if (current === base && gitAt(ROOT, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) {
    fail("branch", `${who}: branch ${branch} already exists; switch to it first`);
    return null;
  }
  return current;
}

// Refuses (true after fail) when one of paths is marked assume-unchanged or skip-worktree: git add and git diff skip such a file,
// so the commit would not hold what was approved. ls-files -v tags it with a lowercase letter or S.
function hiddenByIndexFlag(who, paths, next, fail) {
  const want = new Set(paths);
  const flagged = splitNul(gitAtMust(ROOT, ["ls-files", "-v", "-z"]).out)
    .filter((e) => e[0] === "S" || e[0] !== e[0].toUpperCase()).map((e) => e.slice(2)).filter((p) => want.has(p)).sort();
  if (!flagged.length) return false;
  fail("stage", `${who}: ${capList(flagged)} is marked assume-unchanged or skip-worktree; run git update-index --no-assume-unchanged --no-skip-worktree -- ${flagged.map(shellArg).join(" ")} first. Next: ${next}`);
  return true;
}

// Stages exactly paths, as literal pathspecs read from a file (no length limit, no glob or magic). foreignError(list) words the
// refusal of anything staged that is not in paths, which comes before the index is touched. Returns null after a failure.
function stageExactly(who, paths, tmp, foreignError, next, fail) {
  const literal = { GIT_LITERAL_PATHSPECS: "1" };
  let n = 0;
  const pathspecs = (list) => { const f = path.join(tmp, `pathspecs-${n++}`); fs.writeFileSync(f, list.join("\0")); return [`--pathspec-from-file=${f}`, "--pathspec-file-nul"]; };
  // The index file as it was, so undoing the staging restores it exactly: a version the user staged, index flags and stat data.
  const indexFile = path.resolve(ROOT, gitAtMust(ROOT, ["rev-parse", "--git-path", "index"]).out.trim());
  const saved = path.join(tmp, "index-before");
  let haveSaved = false;
  try { fs.copyFileSync(indexFile, saved); haveSaved = true; } catch { /* no index yet: undo by reset */ }
  // reset unstages list back to HEAD, a version the user staged included; unstage undoes this run's staging.
  const reset = (list) => { if (list.length) gitAtMust(ROOT, ["reset", "-q", ...pathspecs(list)], { env: literal }); };
  // The copy-back can fail (on Windows a scanner holding the index gives EPERM): then reset to HEAD, which keeps every other entry
  // but not a version of list the user staged, and the refusal stays the error reported.
  const unstage = (list) => {
    if (haveSaved) {
      const restore = `${indexFile}.gw-restore`;
      try { fs.copyFileSync(saved, restore); fs.renameSync(restore, indexFile); return; } catch {
        try { fs.rmSync(restore, { force: true }); } catch { /* not ours to remove (a directory), or already gone */ }
      }
    }
    reset(list);
  };
  const stagedNow = () => splitNul(gitAtMust(ROOT, ["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD"]).out);
  const want = new Set(paths);
  const foreign = stagedNow().filter((p) => !want.has(p));
  if (foreign.length) { fail("stage", foreignError(foreign)); return null; }
  if (hiddenByIndexFlag(who, paths, next, fail)) return null;
  // Only paths whose working file differs from the index, or that are untracked, are added: a deletion an earlier run already
  // staged has no file and no index entry, and git add would refuse its pathspec.
  const dirty = new Set([...splitNul(gitAtMust(ROOT, ["diff", "--name-only", "-z", "--no-renames"]).out),
    ...splitNul(gitAtMust(ROOT, ["ls-files", "--others", "--exclude-standard", "-z"]).out)]);
  const toAdd = paths.filter((p) => dirty.has(p));
  if (toAdd.length) {
    const add = gitAt(ROOT, ["add", "-A", ...pathspecs(toAdd)], { env: literal });
    if (!add.ok) {
      try { unstage(toAdd); } catch { /* the working tree is never touched; the add error is the one to report */ }
      fail("stage", `${who}: git add failed: ${firstOutputLine(add.err)}`);
      return null;
    }
  }
  const staged = stagedNow();
  const have = new Set(staged);
  const differ = [...new Set([...paths.filter((p) => !have.has(p)), ...staged.filter((p) => !want.has(p))])].sort();
  if (differ.length) {
    unstage(toAdd);
    fail("stage", `${who}: staged files differ from the approved set: ${differ.join(", ")}`);
    return null;
  }
  // The index must hold what is in the working tree.
  const unsynced = splitNul(gitAtMust(ROOT, ["diff", "--name-only", "-z", "--no-renames"]).out).filter((p) => have.has(p));
  if (unsynced.length) {
    unstage(toAdd);
    fail("stage", `${who}: files changed while they were staged: ${unsynced.join(", ")}; run ${who} again`);
    return null;
  }
  return { staged, have, toAdd, unstage, reset };
}

// Commits the index with the message exactly (--cleanup=verbatim keeps it as shown at the gate), with the user's hooks. A hook that
// rewrote and re-staged files changed what was approved: stop before anything leaves the machine. Returns false after a failure.
function commitExactly(who, message, tmp, branch, fail) {
  const msgFile = path.join(tmp, "message");
  fs.writeFileSync(msgFile, `${message}\n`);
  const tree = gitAtMust(ROOT, ["write-tree"]).out.trim();
  const c = userGit(["commit", "-q", "--cleanup=verbatim", "-F", msgFile]);
  if (!c.ok) { fail("commit", `${who}: commit failed: ${firstOutputLine(c.err)}; you are on ${branch}; fix the hook and run ${who} again`); return false; }
  if (gitAtMust(ROOT, ["rev-parse", "HEAD^{tree}"]).out.trim() !== tree) { fail("commit", `${who}: a commit hook changed the committed files; review and run ${who} again`); return false; }
  return true;
}

// The commits of the local base branch that origin's base does not have: the branch carries them along when it is pushed. null when
// the remote base is unknown (never fetched) or there is no merge base. Reported, not refused.
function unpushedBaseCommits(base) {
  const { base: mb, fallback } = diffBase();
  if (fallback || !mb) return null;
  const n = gitAt(ROOT, ["rev-list", "--count", `refs/remotes/origin/${base}..${mb}`]);
  return n.ok ? Number(n.out.trim()) : null;
}
const unpushedNote = (n, base) => (n ? `\nNote: ${n} commit(s) on local ${base} are not on origin; they are part of this branch` : "");

// Pushes with the user's hooks (see userGit), no credential prompt, at most five minutes; then opens or updates the pull request,
// listing first so a re-run edits instead of creating twice. Title and description go through files or argv-safe flags, never a
// command line a shell reads. Returns { pr, created }, or null after a failure.
function publishBranch(who, { codeHost, base, branch, title, description }, tmp, fail, setStep) {
  setStep("push");
  const unpushedBase = unpushedBaseCommits(base);
  const push = userGit(["push", "-u", "origin", branch], { env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 5 * 60 * 1000 });
  if (push.timedOut) { fail("push", `${who}: push failed: no answer within 5 minutes`); return null; }
  if (!push.ok) { fail("push", `${who}: push failed: ${gitReason(push.err)}`); return null; }

  setStep("pr");
  const stop = (error) => { fail("pr", error); return null; };
  const descFile = path.join(tmp, "description.md");
  fs.writeFileSync(descFile, description);
  const tool = codeHost === "github" ? "gh" : "az";
  const hostFail = (r) => stop(`${who}: ${tool} failed: ${firstOutputLine(r.stderr, r.stdout)}`);
  const listOf = (r) => { try { const v = JSON.parse(r.stdout); return Array.isArray(v) ? v : null; } catch { return null; } };
  if (tool === "gh") {
    const list = hostRun("gh", ["pr", "list", "--head", branch, "--json", "url,number", "--state", "open"]);
    if (list.code !== 0) return hostFail(list);
    const prs = listOf(list);
    if (!prs) return stop(`${who}: gh failed: pr list did not return a JSON list`);
    const body = { "--body-file": description };
    if (!prs.length) {
      const c = hostRun("gh", ["pr", "create", "--base", base, "--head", branch, `--title=${title}`, "--body-file", descFile], body);
      if (c.code !== 0) return hostFail(c);
      const pr = c.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^https?:\/\/\S+$/.test(l)).pop();
      if (!pr) return stop(`${who}: gh failed: pr create printed no URL`);
      return { pr, created: true, unpushedBase };
    }
    const p = prs[0];
    if (!isPlainObject(p) || !Number.isInteger(p.number) || typeof p.url !== "string") return stop(`${who}: gh failed: pr list returned no number and url`);
    const e = hostRun("gh", ["pr", "edit", String(p.number), `--title=${title}`, "--body-file", descFile], body);
    if (e.code !== 0) return hostFail(e);
    return { pr: p.url, created: false, unpushedBase };
  }
  // az reads "--x=@file" as the file's content, so title and description never appear on the command line (and a title
  // that itself starts with @ cannot make az read some other file).
  const titleFile = path.join(tmp, "title.txt");
  fs.writeFileSync(titleFile, title);
  const text = [`--title=@${titleFile}`, `--description=@${descFile}`];
  const texts = { "--title": title, "--description": description };
  const webUrl = (p) => (isPlainObject(p) && Number.isInteger(p.pullRequestId) && isPlainObject(p.repository) && typeof p.repository.webUrl === "string"
    ? `${p.repository.webUrl.replace(/\/+$/, "")}/pullrequest/${p.pullRequestId}` : isPlainObject(p) && typeof p.url === "string" ? p.url : null);
  const one = (r) => { try { const v = JSON.parse(r.stdout); return isPlainObject(v) ? v : null; } catch { return null; } };
  const list = hostRun("az", ["repos", "pr", "list", "--source-branch", branch, "--status", "active", "--output", "json"]);
  if (list.code !== 0) return hostFail(list);
  const prs = listOf(list);
  if (!prs) return stop(`${who}: az failed: repos pr list did not return a JSON list`);
  let pr, created;
  if (!prs.length) {
    const c = hostRun("az", ["repos", "pr", "create", "--source-branch", branch, "--target-branch", base, ...text, "--output", "json"], texts);
    if (c.code !== 0) return hostFail(c);
    pr = webUrl(one(c));
    created = true;
  } else {
    if (!isPlainObject(prs[0]) || !Number.isInteger(prs[0].pullRequestId)) return stop(`${who}: az failed: repos pr list returned no pullRequestId`);
    const u = hostRun("az", ["repos", "pr", "update", `--id=${prs[0].pullRequestId}`, ...text, "--output", "json"], texts);
    if (u.code !== 0) return hostFail(u);
    pr = webUrl(one(u)) || webUrl(prs[0]);
    created = false;
  }
  if (!pr) return stop(`${who}: az failed: no pull request URL in the output`);
  return { pr, created, unpushedBase };
}

function deliverSteps(change, fail, out, tmp, setStep) {
  const run = parseRun(change);
  const cfg = loadConfig();
  if (cfg._error) return fail("config", `deliver: ${cfg._error}`);
  const d = cfg.deliver || {};
  const base = d.baseBranch;
  const branch = `groundwork/${change}`;
  const own = `.groundwork/changes/${change}/`;
  if (typeof base !== "string" || !/^[A-Za-z0-9._/-]+$/.test(base) || base.startsWith("-")) return fail("config", "deliver: deliver.baseBranch is not a valid branch name");
  if (d.codeHost !== "github" && d.codeHost !== "azure-repos") return fail("config", `deliver: deliver.codeHost must be github or azure-repos, not "${d.codeHost}"`);

  // 1. No feedback round waits for its fix (it would ship without the fix), and deliver.md passes check-deliver.
  setStep("check");
  const { pending } = roundState(change);
  if (pending) return fail("check", `deliver: feedback round ${pending} waits for its fix; run /groundwork resume ${change}`);
  const { problems, parsed } = deliverProblems(change);
  if (problems.length) return fail("check", `deliver: check-deliver found problems: ${problems.join("; ")}`);

  // 2. Gate 2: the tree and deliver.md are what was approved.
  setStep("approval");
  const differsMsg = `deliver: the change differs from what was approved at gate 2; run /groundwork resume ${change}`;
  let approved = null;
  if (d.requireApproval !== false) {
    const row = run.approvals.filter((a) => a.gate === "deliver" && a.decision === "approved").pop();
    let fp;
    try { fp = deliverFingerprint(change); } catch (e) { return fail("approval", `deliver: cannot compute the delivery fingerprint: ${e.message}`); }
    if (!row || !row.fingerprint || row.fingerprint !== fp) return fail("approval", differsMsg);
    approved = row.fingerprint;
  }

  // 3. Branch rule (decision 3): from the base branch (groundwork/<c> is created below) or from groundwork/<c> (an update).
  setStep("branch");
  const current = deliveryBranch("deliver", base, branch, fail);
  if (current === null) return;

  // 4. Stage exactly deliverPaths. Anything the user staged that is not part of the delivery is refused.
  setStep("stage");
  const stage = stageExactly("deliver", deliverPaths(change), tmp, (foreign) => `deliver: files are staged that are not part of the delivery: ${foreign.join(", ")}; unstage them and run deliver again`, `\`/groundwork approve ${change}\``, fail);
  if (!stage) return;
  const { staged, have, toAdd, unstage, reset } = stage;
  // What the index holds must still be what gate 2 approved (nothing changed between the fingerprint check and git add).
  if (approved !== null && deliverFingerprint(change) !== approved) {
    unstage(toAdd);
    return fail("approval", differsMsg);
  }

  // 5. Commit deliver.md's message exactly: subject, blank line, body (subject alone when the body is empty).
  setStep("commit");
  const message = parsed.body ? `${parsed.subject}\n\n${parsed.body}` : parsed.subject;
  const mb = diffBase().base;
  const ahead = mb ? Number(gitAt(ROOT, ["rev-list", "--count", `${mb}..HEAD`]).out.trim()) || 0 : 0;
  let commit = staged.length > 0;
  if (current === branch && ahead > 0 && staged.every((p) => p.startsWith(own))) {
    // A re-run after a failure past the commit, decided by content (hooks may rewrite the message): HEAD holds this deliver.md
    // exactly as the working file (so it is not staged) and the base did not. Only the change's own bookkeeping files (the
    // orchestrator logs the failure in run.md) differ; they make no second commit, and are unstaged to HEAD (a version the user
    // staged included), not restored to the saved index.
    const dm = `${own}deliver.md`;
    const inHead = gitAt(ROOT, ["rev-parse", "--verify", "--quiet", `HEAD:${dm}`]);
    const atBase = gitAt(ROOT, ["rev-parse", "--verify", "--quiet", `${mb}:${dm}`]);
    if (!have.has(dm) && inHead.ok && (!atBase.ok || atBase.out.trim() !== inHead.out.trim())) { reset(staged); commit = false; }
  }
  if (!commit && (current === base || ahead === 0)) { unstage(toAdd); return fail("commit", "deliver: nothing to commit"); }
  if (current === base) {
    const sw = gitAt(ROOT, ["switch", "-q", "-c", branch]);
    if (!sw.ok) { unstage(toAdd); return fail("branch", `deliver: cannot create ${branch}: ${firstOutputLine(sw.err)}`); }
  }
  if (commit && !commitExactly("deliver", message, tmp, branch, fail)) return;

  // 6. No pull request: print the commands and stop. The description goes to inputs/ (ignored, never committed).
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  if (d.openPullRequest !== true) {
    const descRel = `${own}inputs/pr-description.md`;
    fs.mkdirSync(path.join(ROOT, own, "inputs"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, descRel), `${parsed.description}\n`);
    // A re-delivery: the branch is on origin already, so the push alone updates its pull request, if one was opened.
    const onOrigin = gitAt(ROOT, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).ok;
    const commands = onOrigin ? [`git push origin ${branch}`] : [`git push -u origin ${branch}`, d.codeHost === "github"
      ? `gh pr create --base ${base} --head ${branch} --title ${q(parsed.title)} --body-file ${q(descRel)}`
      : `az repos pr create --source-branch ${branch} --target-branch ${base} --title ${q(parsed.title)} --description ${q(`@${descRel}`)}`];
    const note = onOrigin ? `${branch} is on origin already; the push updates its pull request if one is open.` : "Quoted for POSIX shells and PowerShell; in PowerShell write a ' inside the title as ''.";
    out({ ok: true, pushed: false, committed: commit, branch, commands, descriptionFile: descRel, note },
      [`${commit ? "Committed" : "Already committed"} on ${branch}. openPullRequest is false; to publish:`, ...commands.map((c) => `  ${c}`), note].join("\n"));
    return;
  }

  // 7, 8. Push, then open or update the pull request. Title and description are exactly deliver.md's.
  const published = publishBranch("deliver", { codeHost: d.codeHost, base, branch, title: parsed.title, description: parsed.description }, tmp, fail, setStep);
  if (!published) return;
  const { pr, created, unpushedBase } = published;

  // 9. The orchestrator records the URL in run.md.
  out({ ok: true, pushed: true, pr, created, committed: commit, branch, unpushedBase }, `${created ? "Opened" : "Updated"} ${pr} from ${branch}.${unpushedNote(unpushedBase, base)}`);
}

// ---------- pr-status, feedback, cleanup ----------

const firstOutputLine = (...texts) => texts.flatMap((t) => String(t || "").split(/\r?\n/)).map((l) => l.trim()).find(Boolean) || "no output";
// GitHub check run conclusions that fail a check; a status context fails with FAILURE or ERROR.
const GH_FAILED_CONCLUSIONS = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];
// GitHub authors whose comments count (ruling R9(d)); bots count too.
const GH_TRUSTED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];
// Line comments are read 100 per page, at most this many pages (ruling R9 minor 8).
const GH_LINE_COMMENT_PAGES = 10;
// Azure Repos thread statuses that mean the thread is settled.
const AZ_SETTLED_THREADS = ["fixed", "wontfix", "closed", "bydesign"];

// Organization URL of an Azure DevOps API or web URL (https://dev.azure.com/<org> or https://<org>.visualstudio.com), or null.
function azureOrg(u) {
  try {
    const x = new URL(String(u));
    if (x.protocol !== "https:") return null;
    if (x.hostname.toLowerCase() === "dev.azure.com") {
      const seg = x.pathname.split("/").filter(Boolean)[0];
      return seg && /^[A-Za-z0-9._-]+$/.test(seg) ? `https://dev.azure.com/${seg}` : null;
    }
    if (/^[A-Za-z0-9-]+\.visualstudio\.com$/i.test(x.hostname)) return `https://${x.hostname.toLowerCase()}`;
  } catch { /* not a URL */ }
  return null;
}

// The code host's view of groundwork/<change>'s pull request. State comes from the host only (Review Focus 4), so a squash merge,
// whose commit never reaches the branch's history, counts as merged. With stateOnly, only the state and URL are read.
// For an open PR, comments and failed checks are read too:
// - comments: top-level comments, COMMENTED and CHANGES_REQUESTED review bodies (never APPROVED or DISMISSED ones) and line
//   comments, minus exactly those an earlier feedback round recorded in its feedback-<k>.json (ruling R11: each comment's key is
//   its host id plus its update time, so an edited comment counts again; no clock is compared). On GitHub only OWNER, MEMBER
//   and COLLABORATOR authors and bots count, and never a minimized comment (ruling R9(d)); the others are counted in a warning.
//   On Azure Repos every organisation member does. A GitHub maintainer whose latest review requests changes without a word gets
//   one entry (keyed by that review), so the request is not lost.
// - failed checks: every failed check run, status or build policy, never skipped.
// Returns { ok: true, state: "open"|"merged"|"closed"|"none", url, changesRequested, comments: [{ author, path, line, body, key }],
// failedChecks: [{ name, url }], warnings } or { ok: false, error }. Bodies and author names are untrusted text: callers keep
// them data, and pr-status prints bodies only with --bodies (ruling R9(e)).
function prStatus(change, { stateOnly = false } = {}) {
  const cfg = loadConfig();
  if (cfg._error) return { ok: false, error: `pr-status: ${cfg._error}` };
  const codeHost = (cfg.deliver || {}).codeHost;
  if (codeHost !== "github" && codeHost !== "azure-repos") return { ok: false, error: `pr-status: deliver.codeHost must be github or azure-repos, not "${codeHost}"` };
  const branch = `groundwork/${change}`;
  const tool = codeHost === "github" ? "gh" : "az";
  const hostError = (r) => ({ ok: false, error: `pr-status: ${tool} failed: ${firstOutputLine(r.stderr, r.stdout)}` });
  const bad = (what) => ({ ok: false, error: `pr-status: ${tool} failed: ${what}` });
  const parse = (r) => { try { return JSON.parse(r.stdout); } catch { return undefined; } };
  const arr = (v) => (Array.isArray(v) ? v.filter(isPlainObject) : []);
  const str = (v) => (typeof v === "string" && v !== "" ? v : null);
  const none = { ok: true, state: "none", url: null, changesRequested: false, comments: [], failedChecks: [], warnings: [] };
  const comments = [];
  const failedChecks = [];
  const warnings = [];
  const recorded = recordedComments(change);
  // A comment's identity: kind, host id, update time and the first 16 hex characters of the body's sha256 (final review D2: gh
  // gives top-level comments and review bodies no update time, so an edit changes only the body). Without a host id it has no
  // key and is never skipped.
  const keyOf = (kind, id, updated, body) => (id === undefined || id === null || id === "" ? null
    : `${kind}:${String(id).slice(0, 200)}@${String(updated ?? "").slice(0, 64)}#${createHash("sha256").update(typeof body === "string" ? body : "").digest("hex").slice(0, 16)}`);
  const add = (author, filePath, line, body, key) => {
    if (typeof body !== "string" || !body.trim() || (key && recorded.has(key))) return;
    comments.push({ author: str(author) || "unknown", path: str(filePath), line: Number.isInteger(line) && line > 0 ? line : null, body, key });
  };

  if (tool === "gh") {
    const v = hostRun("gh", ["pr", "view", branch, "--json", "state,url,reviewDecision,reviews,comments,statusCheckRollup"]);
    if (v.code !== 0) return /no (open )?pull requests? found/i.test(v.stderr) ? none : hostError(v);
    const pr = parse(v);
    if (!isPlainObject(pr)) return bad("pr view did not return a JSON object");
    const state = { OPEN: "open", MERGED: "merged", CLOSED: "closed" }[pr.state];
    if (!state) return bad(`pr view returned an unknown state ${JSON.stringify(pr.state)}`);
    const url = str(pr.url);
    if (state === "open" && !stateOnly) {
      const login = (a) => (isPlainObject(a) ? str(a.login) : null);
      const isBot = (a) => isPlainObject(a) && (a.is_bot === true || a.type === "Bot" || /\[bot\]$/i.test(a.login || "") || /^app\//i.test(a.login || ""));
      const trusted = (assoc, a) => GH_TRUSTED_ASSOCIATIONS.includes(String(assoc || "").toUpperCase()) || isBot(a);
      let untrusted = 0;
      const said = (body) => typeof body === "string" && body.trim() !== "";
      for (const c of arr(pr.statusCheckRollup)) {
        if (c.__typename === "StatusContext" || (typeof c.context === "string" && c.conclusion === undefined)) {
          if (["FAILURE", "ERROR"].includes(c.state)) failedChecks.push({ name: str(c.context) || "status", url: str(c.targetUrl) });
        } else if (GH_FAILED_CONCLUSIONS.includes(c.conclusion)) failedChecks.push({ name: str(c.name) || "check", url: str(c.detailsUrl) });
      }
      for (const c of arr(pr.comments)) {
        if (c.isMinimized === true) continue;
        if (!trusted(c.authorAssociation, c.author)) { if (said(c.body)) untrusted++; continue; }
        add(login(c.author), null, null, c.body, keyOf("gh-comment", c.id || c.url, c.updatedAt || c.lastEditedAt || c.createdAt, c.body));
      }
      const reviews = arr(pr.reviews);
      for (const r of reviews) {
        if (!["COMMENTED", "CHANGES_REQUESTED"].includes(r.state)) continue;
        if (!trusted(r.authorAssociation, r.author)) { if (said(r.body)) untrusted++; continue; }
        add(login(r.author), null, null, r.body, keyOf("gh-review", r.id, r.updatedAt || r.submittedAt, r.body));
      }
      const number = (/\/pull\/(\d+)(?:[/?#]|$)/.exec(url || "") || [])[1];
      if (!number) return bad("pr view returned no pull request URL");
      // Line comments, page by page; {owner}/{repo} is filled in by gh from the current repository.
      for (let page = 1; page <= GH_LINE_COMMENT_PAGES; page++) {
        const a = hostRun("gh", ["api", `repos/{owner}/{repo}/pulls/${number}/comments?per_page=100&page=${page}`]);
        if (a.code !== 0) return hostError(a);
        const list = parse(a);
        if (!Array.isArray(list)) return bad("api did not return a JSON list of review comments");
        for (const c of arr(list)) {
          if (!trusted(c.author_association, c.user)) { if (said(c.body)) untrusted++; continue; }
          add(login(c.user), c.path, Number.isInteger(c.line) ? c.line : c.original_line, c.body, keyOf("gh-line", c.id, c.updated_at || c.created_at, c.body));
        }
        if (list.length < 100) break;
        if (page === GH_LINE_COMMENT_PAGES) warnings.push(`line comments: only the first ${GH_LINE_COMMENT_PAGES * 100} were read`);
      }
      const latest = new Map();
      for (const r of reviews) {
        const who = login(r.author);
        if (who && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) latest.set(who, r);
      }
      for (const [who, r] of latest) {
        if (r.state !== "CHANGES_REQUESTED" || !trusted(r.authorAssociation, r.author)) continue;
        const key = keyOf("gh-review", r.id, r.updatedAt || r.submittedAt, r.body);
        if (!comments.some((c) => c.author === who) && !(key && recorded.has(key))) comments.push({ author: who, path: null, line: null, body: "Requested changes without a comment.", key });
      }
      if (untrusted) warnings.push(`${untrusted} comments from authors without write access were ignored`);
    }
    return { ok: true, state, url, changesRequested: state === "open" && pr.reviewDecision === "CHANGES_REQUESTED", comments, failedChecks, warnings };
  }

  // Azure Repos: the newest active PR of the branch, else the newest one; az finds the organization and project from the remote
  // or its defaults, as in deliver.
  const l = hostRun("az", ["repos", "pr", "list", "--source-branch", branch, "--status", "all", "--output", "json"]);
  if (l.code !== 0) return hostError(l);
  const list = parse(l);
  if (!Array.isArray(list)) return bad("repos pr list did not return a JSON list");
  const prs = arr(list).filter((p) => Number.isInteger(p.pullRequestId));
  if (!prs.length) return none;
  const newest = (xs) => xs.reduce((a, b) => (b.pullRequestId > a.pullRequestId ? b : a));
  const active = prs.filter((p) => String(p.status).toLowerCase() === "active");
  const id = newest(active.length ? active : prs).pullRequestId;
  const s = hostRun("az", ["repos", "pr", "show", `--id=${id}`, "--output", "json"]);
  if (s.code !== 0) return hostError(s);
  const pr = parse(s);
  if (!isPlainObject(pr)) return bad("repos pr show did not return a JSON object");
  const state = { active: "open", completed: "merged", abandoned: "closed" }[String(pr.status).toLowerCase()];
  if (!state) return bad(`repos pr show returned an unknown status ${JSON.stringify(pr.status)}`);
  const repo = isPlainObject(pr.repository) ? pr.repository : {};
  const url = typeof repo.webUrl === "string" ? `${repo.webUrl.replace(/\/+$/, "")}/pullrequest/${id}` : str(pr.url);
  const reviewers = arr(pr.reviewers);
  if (state === "open" && !stateOnly) {
    const org = azureOrg(repo.url || pr.url || repo.webUrl);
    const project = isPlainObject(repo.project) && typeof repo.project.id === "string" && /^[A-Za-z0-9-]+$/.test(repo.project.id) ? repo.project.id : null;
    const repoId = typeof repo.id === "string" && /^[A-Za-z0-9-]+$/.test(repo.id) ? repo.id : null;
    if (!project || !repoId) return bad("repos pr show returned no repository and project id");
    const invoke = (resource, params) => hostRun("az", ["devops", "invoke", "--area", "git", "--resource", resource, "--route-parameters", `project=${project}`,
      `repositoryId=${repoId}`, ...params, ...(org ? ["--org", org] : []), "--api-version", "7.0", "--output", "json"]);
    const t = invoke("pullRequestThreads", [`pullRequestId=${id}`]);
    if (t.code !== 0) return hostError(t);
    const threads = parse(t);
    if (!isPlainObject(threads) || !Array.isArray(threads.value)) return bad("devops invoke did not return the pull request threads");
    for (const th of arr(threads.value)) {
      if (th.isDeleted === true || AZ_SETTLED_THREADS.includes(String(th.status || "").toLowerCase())) continue;
      const ctx = isPlainObject(th.threadContext) ? th.threadContext : {};
      const filePath = typeof ctx.filePath === "string" ? ctx.filePath.replace(/^\/+/, "") : null;
      const at = [ctx.rightFileStart, ctx.leftFileStart].find((x) => isPlainObject(x) && Number.isInteger(x.line));
      for (const c of arr(th.comments)) {
        if (c.isDeleted === true || String(c.commentType || "").toLowerCase() === "system") continue;
        const who = isPlainObject(c.author) ? str(c.author.displayName) || str(c.author.uniqueName) : null;
        add(who, filePath, at ? at.line : null, c.content, th.id !== undefined && c.id !== undefined ? keyOf("az", `${th.id}/${c.id}`, c.lastUpdatedDate || c.publishedDate, c.content) : null);
      }
    }
    const p = hostRun("az", ["repos", "pr", "policy", "list", `--id=${id}`, "--output", "json"]);
    if (p.code !== 0) return hostError(p);
    const policies = parse(p);
    if (!Array.isArray(policies)) return bad("repos pr policy list did not return a JSON list");
    // Checks are build and status policies; reviewer, comment and work item policies are covered by the votes and threads.
    for (const pol of arr(policies)) {
      if (!["rejected", "broken"].includes(String(pol.status || "").toLowerCase())) continue;
      const conf = isPlainObject(pol.configuration) ? pol.configuration : {};
      const type = isPlainObject(conf.type) ? str(conf.type.displayName) : null;
      const buildId = isPlainObject(pol.context) && Number.isInteger(pol.context.buildId) ? pol.context.buildId : null;
      if (buildId === null && !["build", "status"].includes(String(type || "").toLowerCase())) continue;
      const name = (isPlainObject(conf.settings) && (str(conf.settings.displayName) || str(conf.settings.statusName))) || type || "policy";
      failedChecks.push({ name, url: buildId !== null && org ? `${org}/${project}/_build/results?buildId=${buildId}` : null });
    }
  }
  return { ok: true, state, url, changesRequested: state === "open" && reviewers.some((r) => Number(r.vote) <= -5), comments, failedChecks, warnings };
}

function cmdPrStatus() {
  const change = changeArg("Usage: pr-status <change> [--bodies] [--json]");
  if (!change) return;
  const s = prStatus(change);
  if (!s.ok) { print({ ok: false, error: s.error }, s.error); process.exitCode = 1; return; }
  const out = { ...s, comments: flags.has("--bodies") ? s.comments : s.comments.map(({ body, ...c }) => c) };
  const parts = [s.changesRequested ? "changes requested" : null, `${s.comments.length} comment(s)`, `${s.failedChecks.length} failed check(s)`].filter(Boolean);
  print(out, [s.state === "none" ? `No pull request for groundwork/${change}.` : `${s.url || "Pull request"}: ${s.state}${s.state === "open" ? ` (${parts.join(", ")})` : ""}`,
    ...s.warnings.map((w) => `warning: ${w}`)].join("\n"));
}

// Finding cell text for untrusted feedback (decision 5, ruling R9 minor 13): control, line and paragraph separators become spaces,
// format characters (bidi controls, zero-width spaces) are removed except the zero width joiner that emoji need, whitespace
// collapses, at most `max` characters ("..." when cut), then | is escaped, so the text stays inside one table cell.
function feedbackCell(text, max = 300) {
  let t = String(text).replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/(?!‍)\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
  const cps = Array.from(t);
  if (cps.length > max) t = `${cps.slice(0, max - 3).join("").trimEnd()}...`;
  return cell(t);
}

// Writes PR or user feedback as a new review round (decision 5, rulings R8(a) and R9): round n = max(reviewRound(), 1 + the
// highest review-<k>.md), so an approved round is never overwritten; review-<n>.md says Mode: feedback and Status: Changes
// requested and has one blocking finding per comment (correctness) or failed check (tests), with R ids above every earlier one.
// feedback-<n>.json (committed with the change, ruling R10) records the file's sha256, which makes it a feedback round, and the
// keys of the PR comments it used, which later rounds skip (ruling R11). It follows an approved normal round only. Refused while a feedback round waits for
// its fix. Nothing is written when there is nothing to record. User text is capped at 2000 characters, PR text at 300.
function cmdFeedback() {
  const usage = "Usage: feedback <change> --source pr|user [--text <t> | --text-file <path>] [--json]";
  const has = (name) => rest.includes(`--${name}`) || rest.some((a) => a.startsWith(`--${name}=`));
  const source = opt("source");
  const hasText = has("text"), hasFile = has("text-file");
  if (!["pr", "user"].includes(source) || (source === "pr" && (hasText || hasFile)) || (source === "user" && hasText === hasFile)
    || (hasFile && !opt("text-file"))) { console.error(usage); process.exitCode = 2; return; }
  const change = changeArg(usage);
  if (!change) return;
  const fail = (error) => { print({ ok: false, error }, error); process.exitCode = 1; };
  const dir = path.join(CHANGES_DIR, change);
  const { names, pending } = roundState(change);
  if (pending) return fail(`feedback: round ${pending} waits for its fix`);
  // Feedback follows an approved normal round only (ruling R11 minor 2).
  const highestReview = names.map((f) => /^review-(\d+)\.md$/.exec(f)).filter(Boolean).reduce((a, m) => Math.max(a, Number(m[1])), 0);
  if (!highestReview || isFeedbackRound(change, highestReview) || !reviewProblems(change, highestReview).approved) return fail("feedback: the latest review round is not approved");
  const keys = [];
  const items = [];
  if (source === "user") {
    let text = opt("text") || "";
    if (hasFile) {
      const file = path.resolve(opt("text-file"));
      try { text = fs.readFileSync(file, "utf8"); } catch (e) { return fail(`feedback: cannot read ${file}: ${e.code || e.message}`); }
    }
    if (!text.trim()) return fail("feedback: nothing to record: the feedback text is empty");
    items.push({ area: "correctness", where: "-", finding: `User feedback: ${text}`, max: 2000, fix: "Address the feedback" });
  } else {
    const s = prStatus(change);
    if (!s.ok) return fail(s.error.replace(/^pr-status:/, "feedback:"));
    if (s.state !== "open") return fail(`feedback: nothing to record: ${s.state === "none" ? "no pull request is open" : `the pull request is ${s.state}`}`);
    for (const c of s.comments) {
      if (c.key) keys.push(c.key);
      items.push({ area: "correctness", where: c.path ? `${c.path}${c.line ? `:${c.line}` : ""}` : "-", finding: `PR comment by ${c.author}: ${c.body}`, max: 300, fix: "Address the comment" });
    }
    for (const k of s.failedChecks) items.push({ area: "tests", where: "-", finding: `Check ${k.name} failed: ${k.url || "no link"}`, max: 300, fix: "Make the check pass" });
    if (!items.length) return fail("feedback: nothing to record: the pull request has no new comments and no failed checks");
  }
  const n = Math.max(reviewRound(change), highestReview + 1);
  let highest = 0;
  for (let k = 1; k < n; k++) {
    for (const f of roundFindings(read(path.join(dir, `review-${k}.md`)) || "") || []) if (REVIEW_ID.test(f.id)) highest = Math.max(highest, Number(f.id.slice(1)));
  }
  const rows = items.map((it, i) => `| R${highest + 1 + i} | blocking | ${it.area} | ${feedbackCell(it.where, 200)} | ${feedbackCell(it.finding, it.max)} | ${it.fix} |`);
  const text = [`# Review round ${n}`, "", `Change: ${change}`, "Stage: review", `Round: ${n}`, "Mode: feedback", "Status: Changes requested",
    `Source: ${source === "pr" ? "pull request" : "user"}`, "", "## Findings", "", FINDINGS_HEADER, "|----|----------|------|-----------|---------|---------------|", ...rows, ""].join("\n");
  const bytes = Buffer.from(text, "utf8");
  const file = path.join(dir, `review-${n}.md`);
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(path.join(dir, feedbackRecord(n)), JSON.stringify({ sha256: sha256(normalizeBytes(bytes)), comments: keys }) + "\n");
  print({ ok: true, round: n, file: rel(file), findings: rows.length }, `Wrote ${rel(file)}: feedback round ${n} with ${rows.length} blocking finding(s).`);
}

// After a merge (ruling R8(e)): refuses unless pr-status says merged (--force skips that) or while tracked files outside the
// change's own folder (any change's run.md aside) have uncommitted changes. Removes the change's worktrees. On groundwork/<change>: restores the change's
// folder to HEAD (the delivered commit; what it drops is listed) and switches to deliver.baseBranch. On the base branch (then or
// already): `git pull --ff-only` with the user's git, no prompt, at most five minutes; a failed pull is reported and cleanup goes
// on. Deletes the local groundwork/<change> branch.
function cmdCleanup() {
  const change = changeArg("Usage: cleanup <change> [--force] [--json]");
  if (!change) return;
  const fail = (error, extra = {}) => { print({ ok: false, error, ...extra }, error); process.exitCode = 1; };
  const cfg = loadConfig();
  if (cfg._error) return fail(`cleanup: ${cfg._error}`);
  const base = (cfg.deliver || {}).baseBranch;
  if (typeof base !== "string" || !/^[A-Za-z0-9._/-]+$/.test(base) || base.startsWith("-")) return fail("cleanup: deliver.baseBranch is not a valid branch name");
  if (!flags.has("--force")) {
    const s = prStatus(change, { stateOnly: true });
    if (!s.ok) return fail(`${s.error.replace(/^pr-status:/, "cleanup:")}; run cleanup --force to clean up without the check`);
    if (s.state !== "merged") return fail(`cleanup: the pull request is ${s.state === "none" ? "not opened" : s.state}, not merged; run cleanup --force to clean up anyway`);
  }
  const branch = `groundwork/${change}`;
  const own = `.groundwork/changes/${change}/`;
  const literal = { GIT_LITERAL_PATHSPECS: "1" };
  const split = (out) => out.split("\0").filter(Boolean);
  const cur = gitAt(ROOT, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const current = cur.ok ? cur.out.trim() : null;
  // Only where cleanup switches or pulls (ruling R11 minor 3); on any other branch the user's work is left alone. The run.md of
  // any change is never in the way (final review I2): an earlier merged change's run.md says Current: done only locally.
  const anyRun = /^\.groundwork\/changes\/[^/]+\/run\.md$/;
  const dirty = current === branch || current === base
    ? split(gitAtMust(ROOT, ["status", "--porcelain=v1", "-z", "--untracked-files=no", "--no-renames"]).out).map((e) => e.slice(3)).filter((p) => !p.startsWith(own) && !anyRun.test(p)) : [];
  if (dirty.length) return fail(`cleanup: uncommitted changes: ${dirty.join(", ")}; commit or stash them, then run cleanup again`);
  const { removed, left } = pruneChangeWorktrees(change);
  if (left.length) return fail(`cleanup: could not remove worktrees: ${left.map(rel).join(", ")}`);
  let dropped = [], switchedTo = null, pull = null;
  if (current === branch) {
    dropped = split(gitAtMust(ROOT, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", own], { env: literal }).out).map((e) => e.slice(3)).sort();
    if (gitAtMust(ROOT, ["ls-files", "-z", "--", own], { env: literal }).out) gitAtMust(ROOT, ["reset", "-q", "--", own], { env: literal });
    if (gitAtMust(ROOT, ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", own], { env: literal }).out) gitAtMust(ROOT, ["checkout", "-q", "HEAD", "--", own], { env: literal });
    for (const p of split(gitAtMust(ROOT, ["ls-files", "--others", "--exclude-standard", "-z", "--", own], { env: literal }).out)) fs.rmSync(path.join(ROOT, p), { force: true });
    const sw = gitAt(ROOT, ["switch", "-q", base]);
    if (!sw.ok) return fail(`cleanup: cannot switch to ${base}: ${firstOutputLine(sw.err)}`, { worktrees: removed.map(rel), dropped });
    switchedTo = base;
  }
  if (current === branch || current === base) {
    const p = userGit(["pull", "--ff-only"], { env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 5 * 60 * 1000 });
    pull = p.ok ? { ok: true } : { ok: false, error: `git pull --ff-only failed: ${p.timedOut ? "no answer within 5 minutes" : gitReason(p.err)}` };
  }
  let branchDeleted = false;
  if (gitAt(ROOT, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) {
    const d = gitAt(ROOT, ["branch", "-D", branch]);
    if (!d.ok) return fail(`cleanup: cannot delete ${branch}: ${firstOutputLine(d.err)}`, { worktrees: removed.map(rel), dropped, switchedTo, pull });
    branchDeleted = true;
  }
  const worktrees = removed.map(rel);
  print({ ok: true, worktrees, dropped, switchedTo, pull, branchDeleted }, [
    `Cleaned up ${change}: ${worktrees.length} worktree(s) removed${switchedTo ? `, switched to ${switchedTo}` : ""}${branchDeleted ? `, deleted ${branch}` : `, no local ${branch}`}.`,
    ...(dropped.length ? [`Dropped local changes in the change folder: ${dropped.join(", ")}`] : []),
    ...(pull ? [pull.ok ? `Pulled ${current === branch ? base : current}.` : `warning: ${pull.error}`] : []),
  ].join("\n"));
}

// ---------- check-tune ----------

const TUNE_ACTIONS = ["create", "edit", "delete", "move"];
const TUNE_BLOCK_PLACEHOLDER = "<exact diff, or full new content for a new file>";

// One path component the way a file system may read it: ignorable characters (HFS+), trailing dots and spaces (Windows), case.
const foldSegment = (seg) => seg.replace(/\p{Cf}/gu, "").replace(/[. ]+$/, "").toLowerCase();
// ".git", also by its 8.3 short name.
const isGitSegment = (seg) => { const n = foldSegment(seg); return n === ".git" || /^git~\d+$/.test(n); };

// The real location of a path that may not exist yet: its deepest existing folder, resolved, plus the rest. null for a dangling link.
function realLocation(abs) {
  const tail = [];
  let cur = abs;
  for (;;) {
    let found = false;
    try { fs.lstatSync(cur); found = true; } catch { /* look at the parent */ }
    if (found) { try { return path.join(fs.realpathSync.native(cur), ...tail); } catch { return null; } }
    const up = path.dirname(cur);
    if (up === cur) return null;
    tail.unshift(path.basename(cur));
    cur = up;
  }
}

const isInside = (abs, dir) => {
  const r = path.relative(dir, abs);
  return r === "" || (r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r));
};

// The Groundwork plugin folder, or null when this script is not running from a plugin (the vendored .groundwork/bin/ copy).
function pluginFolder() {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return exists(path.join(dir, ".claude-plugin", "plugin.json")) ? realLocation(dir) : null;
}

// A proposal path's components, relative to the repository root, or null when it is not such a path: absolute, home, variable or
// URL forms, a climb above the root, any colon or control character, or a name made only of dots and spaces. A leading $ is a
// variable only as $(, ${ or $NAME/; $types.ts is a file name.
function tuneSegments(raw) {
  const p = raw.split("\\").join("/");
  if (/^[/~%]/.test(p) || /^\$(?:[({]|[A-Za-z_][A-Za-z0-9_]*\/)/.test(p) || /[:\p{Cc}]/u.test(p)) return null;
  const segs = [];
  for (const s of p.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") { if (!segs.length) return null; segs.pop(); continue; }
    if (/^[. ]+$/.test(s)) return null;
    segs.push(s);
  }
  return segs;
}

// The normalised form two proposal paths are compared by; a path that is not relative stays as written.
const tunePathKey = (raw) => { const s = tuneSegments(raw); return s ? s.join("/") : raw.split("\\").join("/"); };

// "outside" (outside the repository or inside .git/), "owned" (Groundwork's own files), "plugin", or null for a path a proposal may
// touch. The real location decides as well as the name, so a link cannot reach any of them. Model routing in .groundwork/config.json
// is the one exception, and it must be named exactly.
function tunePathRisk(raw) {
  const segs = tuneSegments(raw);
  if (!segs || !segs.length || segs.some(isGitSegment)) return "outside";
  const root = realLocation(ROOT);
  const real = realLocation(path.join(ROOT, ...segs));
  if (!root || !real || !isInside(real, root)) return "outside";
  const realSegs = path.relative(root, real).split(path.sep);
  if (realSegs.some(isGitSegment)) return "outside";
  if (foldSegment(segs[0]) === ".groundwork" || foldSegment(realSegs[0]) === ".groundwork") {
    const allowed = ".groundwork/config.json";
    return segs.join("/") === allowed && realSegs.join("/") === allowed ? null : "owned";
  }
  const plugin = pluginFolder();
  return plugin && isInside(real, plugin) ? "plugin" : null;
}

// Whether a path component is a reserved Windows device name, with or without an extension. Refused on every platform: the repository
// may be checked out on Windows.
const isDeviceName = (raw) => (tuneSegments(raw) || []).some((s) => /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(s.split(".")[0].trim()));

// Paths in the repository that git runs or reads as configuration, case-folded: .husky/, and the core.hooksPath folder and
// include.path / includeIf.*.path files that the repository's own .git/config names. Read once per run.
let TUNE_GIT_FILES = null;
function tuneGitFiles() {
  if (TUNE_GIT_FILES) return TUNE_GIT_FILES;
  TUNE_GIT_FILES = [".husky"];
  let cfgFile;
  try { cfgFile = path.join(gitCommonDir(), "config"); } catch { return TUNE_GIT_FILES; }
  const r = gitAt(ROOT, ["config", "--file", cfgFile, "--no-includes", "-z", "--get-regexp", "^(core\\.hookspath|include(if\\..*)?\\.path)$"]);
  for (const rec of r.ok ? splitNul(r.out) : []) {
    const nl = rec.indexOf("\n");
    const key = rec.slice(0, nl < 0 ? rec.length : nl).toLowerCase();
    const v = nl < 0 ? "" : rec.slice(nl + 1).trim();
    if (!v || /^~[\\/]/.test(v)) continue; // a home path is outside the repository
    const abs = path.resolve(key === "core.hookspath" ? ROOT : path.dirname(cfgFile), v);
    const rel = path.relative(ROOT, abs);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) TUNE_GIT_FILES.push(rel.split(path.sep).join("/"));
  }
  TUNE_GIT_FILES = TUNE_GIT_FILES.map((p) => p.toLowerCase());
  return TUNE_GIT_FILES;
}
const isTuneGitFile = (raw) => { const k = tunePathKey(raw).toLowerCase(); return tuneGitFiles().some((p) => k === p || k.startsWith(`${p}/`)); };

// Whether a proposal path names a folder that exists.
function isDirectoryPath(raw) {
  try { return fs.statSync(path.join(ROOT, ...(tuneSegments(raw) || []))).isDirectory(); } catch { return false; }
}

// git's C-style path quoting: "a/.g\151t/x" names a/.git/x.
function cUnquote(s) {
  const m = /^"(.*)"$/.exec(s);
  if (!m) return s;
  const named = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  const bytes = [];
  const body = m[1];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") { const cp = String.fromCodePoint(body.codePointAt(i)); bytes.push(...Buffer.from(cp, "utf8")); i += cp.length - 1; continue; }
    const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1));
    if (oct) { bytes.push(parseInt(oct[0], 8) & 255); i += oct[0].length; continue; }
    const c = body[++i];
    bytes.push(...Buffer.from(c === undefined ? "" : named[c] !== undefined ? String.fromCharCode(named[c]) : c, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

// The two names of a "diff --git" line, or null when it does not read as a/<x> b/<y>. An unquoted name may hold spaces: the split that
// gives two equal names wins, then a single possible split.
function diffGitNames(rest) {
  let a = null, b = null;
  const q = /^("(?:[^"\\]|\\.)*"|[^"\s]\S*)\s+("(?:[^"\\]|\\.)*"|[^"\s]\S*)$/.exec(rest);
  if (q) { a = cUnquote(q[1]); b = cUnquote(q[2]); }
  else {
    const splits = [];
    for (let i = rest.indexOf(" b/"); i >= 0; i = rest.indexOf(" b/", i + 1)) splits.push([rest.slice(0, i), rest.slice(i + 1)]);
    const same = splits.find(([x, y]) => x.slice(2) === y.slice(2));
    const pick = same || (splits.length === 1 ? splits[0] : null);
    if (pick) [a, b] = pick;
  }
  if (!a || !b || !a.startsWith("a/") || !b.startsWith("b/")) return null;
  return [a.slice(2), b.slice(2)];
}

// Reads a unified diff: { names, unparsable, modes, truncated }. Hunks are consumed by the counts on their @@ line, so headers are read
// only between hunks and a removed line that looks like a header stays a removed line. A hunk that does not match its counts, a bad
// @@ line, a stray hunk line after a hunk, or a ---/+++ pair with no hunk is a truncated diff. hunks holds what tune-apply applies;
// other holds every line that is neither a known header nor in a hunk, so a block that shows more than its hunks is never applied.
function parseDiff(block) {
  const out = { names: [], unparsable: [], modes: [], truncated: false, hunks: [], other: [], modeChange: false, devNull: false };
  let oldMode = null;
  const name = (s) => cUnquote(s.split("\t")[0].trim());
  const side = (s) => name(s).replace(/^[ab]\//, "");
  let hunks = 0, awaitingHunk = false;
  for (let i = 0; i < block.length;) {
    const l = block[i];
    let m;
    if (l.startsWith("@@")) {
      m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(l);
      i++;
      if (!m) { out.truncated = true; continue; }
      let before = m[2] === undefined ? 1 : Number(m[2]);
      let after = m[3] === undefined ? 1 : Number(m[3]);
      const lines = [];
      const noEol = () => { if (lines.length) lines[lines.length - 1].noEol = true; };
      while ((before > 0 || after > 0) && i < block.length) {
        const c = block[i][0];
        if (c === undefined || c === " ") { before--; after--; }
        else if (c === "-") before--;
        else if (c === "+") after--;
        else if (c !== "\\") break;
        if (c === "\\") noEol(); else lines.push({ op: c === undefined ? " " : c, text: block[i].slice(1), noEol: false });
        i++;
      }
      if (before !== 0 || after !== 0) out.truncated = true;
      while (i < block.length && block[i].startsWith("\\")) { noEol(); i++; }
      out.hunks.push({ oldStart: Number(m[1]), lines });
      hunks++;
      awaitingHunk = false;
      continue;
    }
    if ((m = /^diff --git (.*)$/.exec(l))) {
      if (awaitingHunk) out.truncated = true;
      awaitingHunk = false;
      const pair = diffGitNames(m[1]);
      if (pair) out.names.push(...pair); else out.unparsable.push(m[1]);
    } else if ((m = /^(?:rename|copy) (?:from|to) (.+)$/.exec(l))) out.names.push(name(m[1]));
    else if ((m = /^(old mode|new mode|new file mode|deleted file mode) (\d+)\s*$/.exec(l))) {
      out.modes.push(m[2]);
      if (m[1] === "old mode") oldMode = m[2];
      else if (m[1] === "new mode" && m[2] !== oldMode) out.modeChange = true;
    }
    else if ((m = /^index \S+ (\d+)\s*$/.exec(l))) out.modes.push(m[1]);
    else if (l.startsWith("--- ") && (block[i + 1] || "").startsWith("+++ ")) {
      if (awaitingHunk) out.truncated = true;
      out.names.push(side(l.slice(4)), side(block[i + 1].slice(4)));
      if (side(l.slice(4)) === "/dev/null" || side(block[i + 1].slice(4)) === "/dev/null") out.devNull = true;
      awaitingHunk = true;
      i += 2;
      continue;
    } else if (hunks > 0 && /^[ +-]/.test(l)) out.truncated = true;
    else if (l.trim() && !/^(?:index |similarity index |dissimilarity index )/.test(l)) out.other.push(l);
    i++;
  }
  if (awaitingHunk) out.truncated = true;
  out.names = out.names.filter((p) => p !== "/dev/null");
  return out;
}

// Checks .groundwork/tune/proposal.md, written by gw-auditor, the guard before files are edited. Everything inside a fenced block is
// data: only the proposal's own lines are read. Every "###" heading is either a change or a problem, so none can hide by its form.
// A move's File line is "<from> -> <to>": file is <from>, and the entry gains to. Paths in changes are normalised. plans holds each
// change again with its parsed content for tune-apply and tune-deliver. status says which Status passes: "awaiting", "applied" (the
// one approve tune sets) or "either" (tune-apply after an approval that died before it wrote state.md).
function tuneProblems({ status = "awaiting" } = {}) {
  const text = read(path.join(GW_DIR, "tune", "proposal.md"));
  if (text === null) return { problems: ["proposal.md is missing"], changes: [], plans: [], summary: "", date: null };
  const items = [];
  const statuses = [];
  const dates = [];
  const summary = [];
  const problems = [];
  let fence = null, inChanges = false, inSummary = false, header = true, cur = null;
  for (const [index, line] of text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/).entries()) {
    if (fence) {
      const c = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (c && c[1][0] === fence.mark[0] && c[1].length >= fence.mark.length) {
        if (cur) cur.blocks.push(fence.body);
        fence = null;
      } else fence.body.push(line);
      continue;
    }
    const o = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (o && !(o[1][0] === "`" && o[2].includes("`"))) { fence = { mark: o[1], body: [], line: index + 1 }; continue; } // a backtick in the info string makes it inline code
    const h = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))??(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (h) {
      header = false;
      const title = (h[2] || "").trim();
      if (h[1].length <= 2) { inChanges = h[1].length === 2 && title === "Changes"; inSummary = h[1].length === 2 && title === "Summary"; cur = null; }
      else if (h[1].length === 3) {
        if (!inChanges) problems.push(`proposal.md: heading ${title} is outside Changes`);
        else {
          const impl = /\(implements\s+(R\d+(?:\s*,\s*R\d+)*)\s*\)/.exec(title);
          cur = { id: (/^[^\s:(]+/.exec(title) || ["?"])[0], title, implements: impl ? impl[1] : null, files: [], actions: [], blocks: [], effects: [] };
          items.push(cur);
        }
      }
      continue;
    }
    if (header && /^status[ \t]*:/i.test(line)) statuses.push(line.trimEnd());
    if (header && /^date[ \t]*:/i.test(line)) dates.push(line.trimEnd());
    if (inSummary) summary.push(line);
    if (!cur) continue;
    let m;
    if ((m = /^- File:[ \t]*(.*?)[ \t]*$/.exec(line))) cur.files.push(m[1]);
    else if ((m = /^- Action:[ \t]*(.*?)[ \t]*$/.exec(line))) cur.actions.push(m[1]);
    else if ((m = /^- Expected effect:[ \t]*(.*?)[ \t]*$/.exec(line))) cur.effects.push(m[1]);
  }
  if (fence) problems.push(`proposal.md: unclosed code block at line ${fence.line}`);
  const isAwaiting = statuses.length === 1 && statuses[0] === "Status: Awaiting approval";
  const isApplied = statuses.length === 1 && /^Status: Applied \d{4}-\d{2}-\d{2} by \S/.test(statuses[0]);
  if (status === "applied" ? !isApplied : status === "either" ? !isAwaiting && !isApplied : !isAwaiting) {
    problems.unshift(status === "applied" ? "proposal.md: Status must be Applied <YYYY-MM-DD> by <approver>" : "proposal.md: Status must be Awaiting approval");
  }
  const date = dates.length === 1 ? dates[0].replace(/^date[ \t]*:[ \t]*/i, "") : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) problems.push("proposal.md: Date must be YYYY-MM-DD");
  if (!items.length) problems.push("proposal.md: no changes");
  const unquote = (s) => s.replace(/^`(.*)`$/, "$1").trim();
  const seen = new Set();
  const owners = []; // [key, id] of every change's File paths, for the nesting check
  const plans = [];
  const changes = items.map((c) => {
    const say = (s) => problems.push(`proposal.md: change ${c.id} ${s}`);
    const action = c.actions[0] ?? null;
    const entry = { id: c.id, implements: c.implements, file: null, action };
    if (seen.has(c.id)) problems.push(`proposal.md: change id ${c.id} is used twice`);
    seen.add(c.id);
    if (!/^C\d+$/.test(c.id)) say("id must be C<n>");
    if (!c.implements) say("does not name the R<m> it implements");

    const filePaths = [];
    for (const raw of c.files) {
      const mv = action === "move" ? /^(.+?)\s+->\s+(.+)$/.exec(raw) : null;
      const these = (mv ? [mv[1], mv[2]] : action === "move" ? [] : [raw]).map(unquote).filter(Boolean);
      if (these.length && entry.file === null) { entry.file = tunePathKey(these[0]); if (mv) entry.to = tunePathKey(these[1]); }
      filePaths.push(...these);
    }
    if (!filePaths.length) say("has no File line");
    if (c.files.length > 1) say("has more than one File line");
    if (!c.actions.length) say("has action none");
    if (c.actions.length > 1) say("has more than one Action line");
    for (const a of c.actions) if (!TUNE_ACTIONS.includes(a)) say(`has action ${a}`);

    const fileKeys = new Set(filePaths.map(tunePathKey));
    const filled = c.blocks.filter((b) => b.join("\n").trim() !== TUNE_BLOCK_PLACEHOLDER);
    const blocks = filled.filter((b) => b.some((l) => l.trim()));
    const hasBlock = action === "create" ? filled.length > 0 : blocks.length > 0; // an empty block creates an empty file
    if (c.blocks.length > 1) say("has more than one block");
    // New file content is not a diff, unless it reads as one.
    const diffs = blocks.filter((b) => action !== "create" || /^(diff --git |--- )/.test(b.find((l) => l.trim()) || "")).map(parseDiff);
    const named = diffs.flatMap((d) => d.names);
    const namedKeys = new Set(named.map(tunePathKey));
    const strays = [...new Set(named)].filter((p) => !fileKeys.has(tunePathKey(p)));
    const unparsable = diffs.flatMap((d) => d.unparsable);
    const unnamed = action !== "create" && fileKeys.size > 0 && ![...fileKeys].every((k) => namedKeys.has(k));
    if (!hasBlock || (unnamed && !strays.length && !unparsable.length)) say("has no diff or content block");
    if (diffs.some((d) => d.truncated)) say("has a truncated diff");
    // Link and submodule entries, by the type bits of the octal mode, so 0120000 and 120777 count too.
    for (const mode of new Set(diffs.flatMap((d) => d.modes))) if ([0o120000, 0o160000].includes(parseInt(mode, 8) & 0o170000)) say(`has mode ${mode}`);
    for (const u of unparsable) say(`diff names ${u}, not its File line`);
    if (fileKeys.size) for (const p of strays) say(`diff names ${p}, not its File line`);

    const reported = new Set();
    for (const p of [...filePaths, ...named]) {
      const key = tunePathKey(p);
      if (reported.has(key)) continue;
      reported.add(key);
      const risk = tunePathRisk(p);
      if (risk === "outside") say(`touches ${p}, which is outside the repository or inside .git/`);
      else if (risk === "owned") say(`touches ${p}, which Groundwork owns`);
      else if (risk === "plugin") say(`edits the plugin (${p})`);
      else if (filePaths.includes(p) && (/["<>|*?]/.test(p) || /[/\\]$/.test(p) || isDirectoryPath(p) || isDeviceName(p))) say(`has File ${p}, which is not a file path`);
      else if (filePaths.includes(p) && isTuneGitFile(p)) problems.push(`proposal.md: ${c.id} File ${p} is a git hook or git config file`);
    }

    // One change may create a link or a file the next would write through.
    for (const key of fileKeys) {
      const fold = key.toLowerCase();
      for (const [other, id] of owners) {
        if (id === c.id) continue;
        if (fold.startsWith(`${other.toLowerCase()}/`)) say(`touches ${key}, which is under ${other} of change ${id}`);
        else if (other.toLowerCase().startsWith(`${fold}/`)) problems.push(`proposal.md: change ${id} touches ${other}, which is under ${key} of change ${c.id}`);
      }
    }
    for (const key of fileKeys) owners.push([key, c.id]);
    plans.push({ ...entry, title: c.title, effect: c.effects[0] ?? "", block: filled[0] ?? [], diff: diffs[0] ?? null });
    return entry;
  });
  return { problems, changes, plans, summary: summary.join("\n").trim(), date };
}

function cmdCheckTune() {
  if (positional.length) { console.error("Usage: check-tune [--json]"); process.exitCode = 2; return; }
  const { problems, changes } = tuneProblems();
  const visible = (s) => s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
  print({ ok: problems.length === 0, problems, changes }, problems.length ? problems.map(visible).join("\n") : `proposal.md: ok, ${changes.length} change(s).`);
  if (problems.length) process.exitCode = 1;
}

// ---------- tune-apply, tune-deliver ----------

const TUNE_APPROVE = "`/groundwork approve tune`";
const TUNE_CHANGED = "The proposal changed after it was shown. Next: `/groundwork tune`";
const TUNE_PROPOSAL = ".groundwork/tune/proposal.md";
const TUNE_STATE = ".groundwork/tune/state.md";
// The audit report tune works from. Claude Code refuses a subagent's Write of a .md file whose name starts with report, summary,
// findings or analysis, so the auditor writes audit-result.md; a report.md from before 0.2.3 is used while no audit-result.md exists.
function tuneReport() {
  return !exists(path.join(ROOT, ...AUDIT_RESULT.split("/"))) && exists(path.join(ROOT, ...AUDIT_REPORT_V022.split("/"))) ? AUDIT_REPORT_V022 : AUDIT_RESULT;
}
const TUNE_MARKER = ".groundwork/tune/apply.json";
const TUNE_BRANCH = /^groundwork\/tune-\d{4}-\d{2}-\d{2}(?:-[1-9]\d*)?$/;
// Changed files tune-deliver neither stages nor refuses: audit snapshots, archive copies, tune-apply's marker, and the state of other
// changes (R4).
const TUNE_LEFT_UNSTAGED = [/^\.groundwork\/tune\/apply\.json$/, /^\.groundwork\/audit\/snapshots\//, /^\.groundwork\/audit\/(?:report|audit-result)-[^/]*\.md$/, /^\.groundwork\/tune\/proposal-[^/]*\.md$/,
  /^\.groundwork\/changes\//, /^\.groundwork\/refinements\//, /^\.groundwork\/worktrees\//];

// A path as one shell argument the user can paste: as it is when plain, otherwise in single quotes, which POSIX shells and
// PowerShell both read literally ($ and backticks included), as in deliver's printed commands. A ' is closed and escaped the POSIX
// way, so stashAdvice then adds deliver's PowerShell note.
const shellArg = (p) => (/^[A-Za-z0-9._/@+=:,-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`);
// A refusal names at most LIST_CAP paths; with more, the stash command would be as unreadable, so git status lists them.
const LIST_CAP = 20;
const capList = (list) => (list.length > LIST_CAP ? `${list.slice(0, LIST_CAP).join(", ")} … and ${list.length - LIST_CAP} more` : list.join(", "));
const stashAdvice = (list) => (list.length > LIST_CAP ? "commit them or stash them (git status --short lists them all)"
  : `commit them or stash them with git stash push -u -- ${list.map(shellArg).join(" ")}${list.some((p) => p.includes("'")) ? " (quoted for POSIX shells and PowerShell; in PowerShell write a ' inside a path as '')" : ""}`);

// Changed, staged and untracked paths that are none of want, the three tune files or the files tune-deliver leaves unstaged: work
// that is not the proposal's, and would block or ride along with its delivery. Sorted.
function tuneStrays(want) {
  const names = (args) => splitNul(gitAtMust(ROOT, args).out);
  const all = new Set([...names(["diff", "--name-only", "-z", "--no-renames", "HEAD"]), ...names(["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD"]),
    ...names(["ls-files", "--others", "--exclude-standard", "-z"])]);
  const own = new Set([TUNE_PROPOSAL, TUNE_STATE, AUDIT_RESULT, AUDIT_REPORT_V022]);
  // A path that a proposal path runs through (a directory turned into a link shows up this way
  // on POSIX) is the proposal's own concern: the apply skips or refuses linked paths itself.
  const underIt = (p) => { for (const w of want) if (w.startsWith(p + "/")) return true; return false; };
  return [...all].filter((p) => !want.has(p) && !own.has(p) && !underIt(p) && !TUNE_LEFT_UNSTAGED.some((re) => re.test(p))).sort();
}

// The proposal's fingerprint: CRLF and a bare CR as LF, as the check reads them. Approving sets the header's Status line, and only
// that line stays out of the hash, so an applied proposal keeps the fingerprint that was shown. null when there is no proposal.
function tuneFingerprint() {
  let buf;
  try { buf = fs.readFileSync(path.join(GW_DIR, "tune", "proposal.md")); } catch { return null; }
  const lines = buf.toString("latin1").replace(/^\xEF\xBB\xBF/, "").split(/\r\n|\n|\r/);
  let end = lines.findIndex((l) => /^ {0,3}(?:#{1,6}(?:[ \t]|$)|`{3,}|~{3,})/.test(l));
  if (end < 0) end = lines.length;
  const kept = lines.filter((l, i) => i >= end || !/^status[ \t]*:/i.test(l));
  return fingerprintOf([{ name: "proposal.md", content: Buffer.from(kept.join("\n"), "latin1") }]);
}

// The hash state.md records for the audit report the proposal was shown with; "none" when there is no report.
function tuneReportHash() {
  let buf;
  try { buf = fs.readFileSync(path.join(ROOT, ...tuneReport().split("/"))); } catch { return "none"; }
  return fingerprintOf([{ name: "report.md", content: buf }]);
}

// The hunks applied to a file's bytes, at exactly their own lines and with exact context: { data } or { reason }. Each kept line keeps
// its own line ending, and an added line takes the ending of the lines around it.
function applyHunks(buf, hunks) {
  const decoded = buf.toString("utf8");
  if (buf.includes(0) || !Buffer.from(decoded, "utf8").equals(buf)) return { reason: "it is not a text file" };
  const bom = decoded.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = decoded.slice(bom.length);
  const lines = [];
  for (let i = 0; i < body.length;) {
    const n = body.indexOf("\n", i);
    if (n < 0) { lines.push({ text: body.slice(i), eol: "" }); break; }
    const end = n > i && body[n - 1] === "\r" ? n - 1 : n;
    lines.push({ text: body.slice(i, end), eol: body.slice(end, n + 1) });
    i = n + 1;
  }
  const mismatch = { reason: "a hunk does not match the file" };
  const out = [];
  let pos = 0;
  for (const h of hunks) {
    // "@@ -n,0" inserts after line n; any other hunk starts on line n.
    const start = h.lines.some((l) => l.op !== "+") ? h.oldStart - 1 : h.oldStart;
    if (start < pos || start > lines.length) return mismatch;
    out.push(...lines.slice(pos, start));
    pos = start;
    for (const l of h.lines) {
      if (l.op === "+") {
        out.push({ text: l.text, eol: l.noEol ? "" : (lines[pos - 1]?.eol || lines[pos]?.eol || lines[0]?.eol || "\n") });
        continue;
      }
      const o = lines[pos];
      if (!o || o.text !== l.text || (o.eol === "") !== l.noEol) return mismatch;
      pos++;
      if (l.op === " ") out.push(o);
    }
  }
  out.push(...lines.slice(pos));
  if (out.slice(0, -1).some((l) => l.eol === "")) return mismatch; // a last line with no newline cannot stay in the middle
  return { data: Buffer.from(bom + out.map((l) => l.text + l.eol).join(""), "utf8") };
}

// What one change does, given readFile(path) -> Buffer or null: { ops } or { reason }. It decides without touching anything, so the
// same logic applies a change to the working tree and, in tune-deliver, proves what the applied files must hold.
function tuneOps(c, readFile) {
  const cur = readFile(c.file);
  if (c.action === "create") {
    if (c.diff) return { reason: "its block is a diff, not the content of the new file" };
    if (cur !== null) return { reason: `${c.file} already exists` };
    return { ops: [{ write: c.file, data: Buffer.from(c.block.length ? `${c.block.join("\n")}\n` : "", "utf8"), fresh: true }] };
  }
  if (cur === null) return { reason: `${c.file} does not exist` };
  if (c.diff?.other.length) return { reason: "its diff has lines outside its hunks" };
  if (c.diff?.modeChange) return { reason: "its diff changes the file mode" };
  if (c.diff?.devNull && c.action !== "delete") return { reason: `its ${c.action} diff has a /dev/null header` };
  const hunks = c.diff?.hunks || [];
  if (c.action === "edit" && !hunks.length) return { reason: "its diff has no hunks" };
  let data = cur;
  if (hunks.length) {
    const r = applyHunks(cur, hunks);
    if (r.reason) return r;
    data = r.data;
  }
  if (c.action === "edit") return { ops: [{ write: c.file, data }] };
  if (c.action === "delete") return data.length ? { reason: "its diff does not remove the whole file" } : { ops: [{ remove: c.file }] };
  if (readFile(c.to) !== null) return { reason: `${c.to} already exists` };
  return { ops: [{ move: c.file, to: c.to, data: hunks.length ? data : null, same: data }] };
}

// Why a proposal path cannot be touched now, or null: a link on the way to it (check-tune already refused one that leaves the
// repository), or something that is not a regular file.
function tunePathBlocked(rel) {
  let cur = ROOT;
  const segs = rel.split("/");
  for (const [i, seg] of segs.entries()) {
    cur = path.join(cur, seg);
    let st;
    try { st = fs.lstatSync(cur); } catch { return null; }
    if (st.isSymbolicLink()) return `${rel} goes through a link`;
    if (i === segs.length - 1 && !st.isFile()) return `${rel} is not a regular file`;
  }
  return null;
}

function readWorkingFile(rel) {
  try { return fs.readFileSync(path.join(ROOT, ...rel.split("/"))); } catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return null; throw e; }
}

// Writes through a temporary file beside the target and a rename, so a crash leaves the old file or the new one, and a link that
// appeared at the target is replaced, not followed. The mode of the file it replaces stays.
function writeFileWhole(abs, data, { fresh = false } = {}) {
  let mode;
  try {
    const st = fs.lstatSync(abs);
    if (fresh) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    mode = st.mode & 0o777;
  } catch (e) { if (e.code !== "ENOENT") throw e; }
  const temp = `${abs}.gw-tune-${process.pid}`;
  try {
    fs.writeFileSync(temp, data, { flag: "wx" });
    if (mode !== undefined) fs.chmodSync(temp, mode);
    fs.renameSync(temp, abs);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    throw e;
  }
}

function writeTuneOps(ops) {
  const abs = (rel) => path.join(ROOT, ...rel.split("/"));
  const parent = (rel) => fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  for (const op of ops) {
    if (op.remove) fs.unlinkSync(abs(op.remove));
    else if (op.move) {
      parent(op.to);
      fs.renameSync(abs(op.move), abs(op.to));
      if (op.data) writeFileWhole(abs(op.to), op.data);
    } else {
      parent(op.write);
      writeFileWhole(abs(op.write), op.data, { fresh: !!op.fresh });
    }
  }
}

// The paths of the changes that hold uncommitted work: they differ from HEAD, or exist and HEAD does not have them, ignored or not. A
// tune applies only onto clean files, so its replay from HEAD is valid on a re-run. A path through a link is not listed: it is never
// written, and that change is skipped with its own reason.
function tuneUncommitted(plans) {
  const diff = gitAt(ROOT, ["diff", "--name-only", "-z", "--no-renames", "HEAD"]);
  const changed = new Set(diff.ok ? splitNul(diff.out) : []);
  const paths = [...new Set(plans.flatMap((c) => (c.to ? [c.file, c.to] : [c.file])))];
  return paths.filter((p) => !tunePathBlocked(p) && (changed.has(p) || (gitBlob(`HEAD:${p}`) === null && readWorkingFile(p) !== null)));
}

// Each tune gets its own branch: the first free name of groundwork/tune-<date>, groundwork/tune-<date>-2, ... A name left on origin is
// taken too, because pushing to it would update the old pull request.
function freeTuneBranch(date) {
  const taken = (b) => [`refs/heads/${b}`, `refs/remotes/origin/${b}`].some((r) => gitAt(ROOT, ["rev-parse", "--verify", "--quiet", r]).ok);
  for (let n = 1; ; n++) {
    const name = `groundwork/tune-${date}${n > 1 ? `-${n}` : ""}`;
    if (!taken(name)) return name;
  }
}

function cmdTuneApply() {
  if (positional.length) { console.error("Usage: tune-apply [--json]"); process.exitCode = 2; return; }
  const refuse = (error, extra = {}) => { print({ ok: false, error, ...extra }, error); process.exitCode = 1; };
  const state = read(path.join(ROOT, ...TUNE_STATE.split("/")));
  if (state === null) return refuse("tune-apply: no proposal was shown. Next: `/groundwork tune`");
  if (headerValue(state, "Status") !== "awaiting approval") return refuse("tune-apply: state.md does not say awaiting approval. Next: `/groundwork tune`");
  const fp = tuneFingerprint();
  if (!fp) return refuse("tune-apply: proposal.md is missing. Next: `/groundwork tune`");
  if (fp !== headerValue(state, "Shown")) return refuse(TUNE_CHANGED);
  const shownReport = headerValue(state, "Report");
  if (shownReport === null) return refuse("tune-apply: state.md has no Report line. Next: `/groundwork tune`");
  if (shownReport !== tuneReportHash()) return refuse(`tune-apply: ${tuneReport()} changed after the proposal was shown. Next: \`/groundwork tune\``);
  const { problems, plans, date } = tuneProblems({ status: "either" });
  if (problems.length) return refuse(`tune-apply: check-tune found problems: ${problems.join("; ")}. Next: \`/groundwork tune\``, { problems });
  // The marker says an earlier run of this proposal may have written files, so uncommitted changes there can be its own, and it
  // holds the branch that run chose.
  const markerPath = path.join(ROOT, ...TUNE_MARKER.split("/"));
  let marker = null;
  try { const m = JSON.parse(read(markerPath)); if (m?.fingerprint === fp) marker = m; } catch { /* no marker, or a broken one */ }
  let marked = marker !== null;
  if (!marked) {
    // Shipping goes through a pull request from the base branch, so a tune that starts anywhere else could never ship.
    const cfg = loadConfig();
    if (cfg._error) return refuse(`tune-apply: ${cfg._error}`);
    if (cfg.deliver?.openPullRequest === true) {
      const base = cfg.deliver.baseBranch;
      const cur = gitAt(ROOT, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      if (!cur.ok || cur.out.trim() !== base) {
        const tracked = gitAt(ROOT, ["diff", "--name-only", "-z", "--no-renames", "HEAD", "--", ".groundwork/tune", tuneReport()]);
        const dirty = tracked.ok ? splitNul(tracked.out) : [];
        // A changed report blocks the switch only when the base branch holds another version of it.
        const reportBlocks = dirty.includes(tuneReport()) && !gitAt(ROOT, ["diff", "--quiet", "HEAD", `refs/heads/${base}`, "--", tuneReport()]).ok;
        const restore = [...(dirty.some((p) => p.startsWith(".groundwork/tune/")) ? [".groundwork/tune"] : []), ...(reportBlocks ? [tuneReport()] : [])];
        return refuse(`tune-apply: switch to ${base} first; a tune starts from the base branch${restore.length ? `; run git restore ${restore.join(" ")} before the switch. Next: \`/groundwork tune\`` : ""}`);
      }
      // tune-deliver refuses anything outside the proposal, so it is refused here, before a file changes.
      const strays = tuneStrays(new Set(plans.flatMap((c) => (c.to ? [c.file, c.to] : [c.file]))));
      if (strays.length) return refuse(`tune-apply: ${capList(strays)} has changes outside the proposal; ${stashAdvice(strays)} first. Next: \`/groundwork approve tune\``);
    }
    const dirty = tuneUncommitted(plans);
    if (dirty.length) return refuse(`tune-apply: ${capList(dirty)} has uncommitted changes; ${stashAdvice(dirty)} first. Next: \`/groundwork approve tune\``);
  }
  const branch = marker && TUNE_BRANCH.test(String(marker.branch)) ? marker.branch : freeTuneBranch(date);
  // An approval that died before it wrote state.md: a change is already applied when its paths hold the state after it, or after a
  // later change to that path. This is decided before any write, because a hunk that only inserts or deletes lines can match again.
  const { failed, after } = tuneReplay(plans, "HEAD");
  const holds = (p, i) => {
    try { return !tunePathBlocked(p) && (after.get(p) || []).some((s) => s.index >= i && sameContent(s.data, readWorkingFile(p))); } catch { return false; }
  };
  const appliedIds = new Set(plans.filter((c, i) => !failed.has(c.id) && (c.to ? [c.file, c.to] : [c.file]).every((p) => holds(p, i))).map((c) => c.id));
  const skipped = [];
  for (const c of plans) {
    if (appliedIds.has(c.id)) continue;
    const reason = () => {
      for (const p of c.to ? [c.file, c.to] : [c.file]) {
        const blocked = tunePathBlocked(p);
        if (blocked) return blocked;
      }
      const r = tuneOps(c, readWorkingFile);
      if (r.reason) return r.reason;
      if (!marked) { fs.writeFileSync(markerPath, `${JSON.stringify({ fingerprint: fp, branch })}\n`); marked = true; }
      writeTuneOps(r.ops);
      return null;
    };
    let why;
    try { why = reason(); } catch (e) { why = `cannot change the file: ${e.code || e.message}`; }
    if (why) skipped.push({ id: c.id, reason: why }); else appliedIds.add(c.id);
  }
  const applied = plans.filter((c) => appliedIds.has(c.id)).map((c) => c.id);
  const visible = (s) => s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
  print({ ok: true, applied, skipped, branch }, [`Applied: ${applied.join(" ") || "none"}`, `Branch: ${branch}`, ...skipped.map((s) => visible(`Skipped ${s.id}: ${s.reason}`))].join("\n"));
}

const gitBlob = (spec) => { const r = gitAt(ROOT, ["cat-file", "blob", spec], { raw: true }); return r.ok ? r.out : null; };
const sameContent = (a, b) => (a === null || b === null ? a === b : normalizeBytes(a).equals(normalizeBytes(b)));

// What the changes make of the files at ref, in order, touching nothing: { overlay: path -> Buffer or null, failed: ids that do not
// apply, after: path -> [{ index of the change in plans, data after it }] }.
function tuneReplay(plans, ref) {
  const overlay = new Map();
  const failed = new Set();
  const after = new Map();
  const readFile = (p) => (overlay.has(p) ? overlay.get(p) : gitBlob(`${ref}:${p}`));
  for (const [index, c] of plans.entries()) {
    const r = tuneOps(c, readFile);
    if (r.reason) { failed.add(c.id); continue; }
    const set = (p, data) => { overlay.set(p, data); if (!after.has(p)) after.set(p, []); after.get(p).push({ index, data }); };
    for (const op of r.ops) {
      if (op.remove) set(op.remove, null);
      else if (op.move) { set(op.move, null); set(op.to, op.same); }
      else set(op.write, op.data);
    }
  }
  return { overlay, failed, after };
}

// The paths that do not hold what the applied changes make of the files at ref: the check of decision 1 that the shipped content is
// the approved content, so an edit made before or after approval cannot ride along. It reads the working files, or with index what
// was staged (a clean filter can make the two differ).
function tuneDrift(applied, ref, { index = false } = {}) {
  const { overlay, failed } = tuneReplay(applied, ref);
  const drift = new Set(applied.filter((c) => failed.has(c.id)).map((c) => c.file));
  for (const [p, want] of overlay) {
    if (!index && tunePathBlocked(p)) { drift.add(p); continue; }
    if (!sameContent(want, index ? gitBlob(`:${p}`) : readWorkingFile(p))) drift.add(p);
  }
  return [...drift].sort();
}

function cmdTuneDeliver() {
  if (positional.length) { console.error("Usage: tune-deliver [--json]"); process.exitCode = 2; return; }
  const { out, fail } = deliveryOutput();
  let step = "config";
  let tmp = null;
  try {
    tmp = fs.mkdtempSync(path.join(tmpdir(), "gw-tune-deliver-"));
    tuneDeliverSteps(fail, out, tmp, (s) => { step = s; });
  } catch (e) {
    fail(step, `tune-deliver: ${e.message}`);
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function tuneDeliverSteps(fail, out, tmp, setStep) {
  const cfg = loadConfig();
  if (cfg._error) return fail("config", `tune-deliver: ${cfg._error}`);
  const d = cfg.deliver || {};
  const base = d.baseBranch;
  if (typeof base !== "string" || !/^[A-Za-z0-9._/-]+$/.test(base) || base.startsWith("-")) return fail("config", "tune-deliver: deliver.baseBranch is not a valid branch name");
  if (d.codeHost !== "github" && d.codeHost !== "azure-repos") return fail("config", `tune-deliver: deliver.codeHost must be github or azure-repos, not "${d.codeHost}"`);
  if (d.openPullRequest !== true) return fail("config", "tune-deliver: deliver.openPullRequest is false; review and commit the applied files yourself");

  // 1. The proposal was applied, and it is still the one the user approved.
  setStep("check");
  const state = read(path.join(ROOT, ...TUNE_STATE.split("/")));
  if (state === null || headerValue(state, "Status") !== "applied") return fail("check", "tune-deliver: the proposal is not applied. Next: `/groundwork approve tune`");
  setStep("approval");
  const shownFingerprint = headerValue(state, "Shown");
  const shownReport = headerValue(state, "Report");
  const lockProblem = () => {
    if (tuneFingerprint() !== shownFingerprint) return `tune-deliver: ${TUNE_CHANGED}`;
    if (tuneReportHash() !== shownReport) return `tune-deliver: ${tuneReport()} changed after the proposal was shown. Next: \`/groundwork tune\``;
    return null;
  };
  const locked = lockProblem();
  if (locked) return fail("approval", locked);
  setStep("check");
  const { problems, plans, summary, date } = tuneProblems({ status: "applied" });
  if (problems.length) return fail("check", `tune-deliver: check-tune found problems: ${problems.join("; ")}. Next: \`/groundwork tune\``);
  const idsOf = (key) => (headerValue(state, key) || "").split(/\s+/).filter(Boolean);
  const appliedIds = idsOf("Applied"), skippedIds = idsOf("Skipped");
  const known = new Set(plans.map((c) => c.id));
  const listed = new Set([...appliedIds, ...skippedIds]);
  const unknown = [...listed].filter((id) => !known.has(id));
  if (unknown.length) return fail("check", `tune-deliver: state.md names ${unknown.join(", ")}, not in the proposal. Next: \`/groundwork tune\``);
  const unlisted = [...known].filter((id) => !listed.has(id));
  if (unlisted.length) return fail("check", `tune-deliver: state.md does not list ${unlisted.join(", ")}. Next: \`/groundwork tune\``);
  const applied = plans.filter((c) => appliedIds.includes(c.id));
  if (!applied.length) return fail("check", "tune-deliver: no change was applied, so there is nothing to deliver. Next: `/groundwork tune`");

  const branch = headerValue(state, "Branch");
  if (!TUNE_BRANCH.test(branch || "") || !`${branch}-`.startsWith(`groundwork/tune-${date}-`)) return fail("check", "tune-deliver: state.md has no valid Branch line. Next: `/groundwork tune`");
  // The tune's name in its commit and pull request: the date, with the branch's suffix for a later tune that day.
  const tuneName = branch.slice("groundwork/tune-".length);

  // 2. Branch rule, as for deliver.
  setStep("branch");
  const current = deliveryBranch("tune-deliver", base, branch, fail);
  if (current === null) return;

  // 3. Nothing outside the applied proposal goes along, or waits in the way.
  setStep("stage");
  const appliedPaths = applied.flatMap((c) => (c.to ? [c.file, c.to] : [c.file]));
  const want = new Set([TUNE_PROPOSAL, TUNE_STATE, AUDIT_RESULT, AUDIT_REPORT_V022, ...appliedPaths]);
  const outside = (list) => `tune-deliver: ${capList(list)} is not part of the applied proposal`;
  const notPart = (list) => `${outside(list)}. Next: ${stashAdvice(list)}, then \`/groundwork approve tune\``;
  const preStaged = splitNul(gitAtMust(ROOT, ["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD"]).out).filter((p) => !want.has(p));
  if (preStaged.length) return fail("stage", notPart(preStaged));
  const changed = [...new Set([...splitNul(gitAtMust(ROOT, ["diff", "--name-only", "-z", "--no-renames", "HEAD"]).out),
    ...splitNul(gitAtMust(ROOT, ["ls-files", "--others", "--exclude-standard", "-z"]).out)])];
  const strays = tuneStrays(want);
  if (strays.length) return fail("stage", notPart(strays));
  // git add would leave an ignored file out, and the commit would not hold what was approved.
  const ignored = appliedPaths.filter((p) => gitAt(ROOT, ["check-ignore", "-q", "--", p]).status === 0);
  if (ignored.length) return fail("stage", `tune-deliver: ${ignored.join(", ")} is ignored by git, so it cannot ship. Next: remove it from .gitignore and commit that .gitignore change first, then \`/groundwork approve tune\``);
  // A flagged applied file is missing from the changed list, so stageExactly would never see it.
  if (hiddenByIndexFlag("tune-deliver", [...want], TUNE_APPROVE, fail)) return;

  // Everything the branch holds beyond the base must be in the proposal too: a commit made before this one, a hook's git add, an amend.
  const compared = diffBase();
  if (compared.fallback) return fail("stage", `tune-deliver: cannot compare the branch with ${base}. Next: create a local ${base} that shares history with this branch, then \`/groundwork approve tune\``);
  const mb = compared.base;
  const committedOutside = () => splitNul(gitAtMust(ROOT, ["diff", "--name-only", "-z", "--no-renames", mb, "HEAD"]).out).filter((p) => !want.has(p));
  const onBranch = (list) => `${outside(list)}; these come from commits already on ${branch}. Next: remove them from that branch or rename it, switch to ${base}, then \`/groundwork approve tune\``;
  const foreignCommitted = committedOutside();
  if (foreignCommitted.length) return fail("stage", onBranch(foreignCommitted));

  // A re-run after a failure past the commit, decided by content (hooks may rewrite the message): HEAD holds this proposal exactly as
  // the working file, and the base did not. Only state.md, the orchestrator's own file, may differ; it makes no second commit.
  const ahead = Number(gitAt(ROOT, ["rev-list", "--count", `${mb}..HEAD`]).out.trim()) || 0;
  const blobOf = (ref) => { const r = gitAt(ROOT, ["rev-parse", "--verify", "--quiet", `${ref}:${TUNE_PROPOSAL}`]); return r.ok ? r.out.trim() : null; };
  const inHead = blobOf("HEAD");
  const committed = current === branch && ahead > 0 && !changed.includes(TUNE_PROPOSAL) && inHead !== null && blobOf(mb) !== inHead;
  if (committed) {
    const later = changed.filter((p) => want.has(p) && p !== TUNE_STATE);
    if (later.length) return fail("stage", `tune-deliver: ${later.join(", ")} changed after the proposal was committed. Next: amend or commit that restore on the branch, then \`/groundwork approve tune\``);
  }
  const drift = tuneDrift(applied, mb);
  if (drift.length) return fail("stage", `tune-deliver: ${drift.join(", ")} differs from the applied proposal. Next: restore ${drift.join(", ")} to the proposal's result, or \`/groundwork tune\` for a new proposal`);

  if (!committed) {
    const stage = stageExactly("tune-deliver", [...want].filter((p) => changed.includes(p)), tmp, notPart, TUNE_APPROVE, fail);
    if (!stage) return;
    // What the index holds must be what was approved: nothing changed since the checks above, and no clean filter rewrote it.
    const stagedDrift = tuneDrift(applied, mb, { index: true });
    const stillLocked = lockProblem();
    if (stagedDrift.length || stillLocked) {
      stage.unstage(stage.toAdd);
      if (stillLocked) return fail("approval", stillLocked);
      return fail("stage", `tune-deliver: ${stagedDrift.join(", ")} differs from the applied proposal once staged; a clean filter on that file may be the cause, and tune-deliver cannot ship a filtered file. Next: commit the whole tune by hand`);
    }
    if (current === base) {
      const sw = gitAt(ROOT, ["switch", "-q", "-c", branch]);
      if (!sw.ok) { stage.unstage(stage.toAdd); return fail("branch", `tune-deliver: cannot create ${branch}: ${firstOutputLine(sw.err)}`); }
    }
    // 4. Commit.
    setStep("commit");
    const subject = `chore: groundwork tune ${tuneName}`;
    if (!commitExactly("tune-deliver", summary ? `${subject}\n\n${summary}` : subject, tmp, branch, fail)) return;
    const afterCommit = committedOutside();
    if (afterCommit.length) return fail("stage", onBranch(afterCommit));
  }

  // 5. Push, then open or update the pull request. The description is the proposal's Summary and its applied changes.
  const title = `Groundwork tune ${tuneName}`;
  const description = [...(summary ? ["## Summary", summary, ""] : []), "## Changes", "", ...applied.flatMap((c) => [`### ${c.title}`, c.effect, ""]),
    ...(skippedIds.length ? [`Skipped: ${skippedIds.join(" ")}`, ""] : [])].join("\n");
  const published = publishBranch("tune-deliver", { codeHost: d.codeHost, base, branch, title, description }, tmp, fail, setStep);
  if (!published) return;
  const { pr, created, unpushedBase } = published;
  // 6. Back to the base branch, where the next tune starts. The branch is shipped, so a failure here fails nothing.
  const back = gitAt(ROOT, ["switch", "-q", base]);
  const note = back.ok ? null : `Still on ${branch}: ${firstOutputLine(back.err)}. Next: git restore .groundwork/tune, then git switch ${base}`;
  out({ ok: true, pushed: true, pr, created, committed: !committed, branch, unpushedBase, onBase: back.ok, ...(note ? { note } : {}) },
    `${created ? "Opened" : "Updated"} ${pr} from ${branch}.${unpushedNote(unpushedBase, base)}${note ? `\n${note}` : `\nBack on ${base}.`}`);
}

// ---------- dispatch ----------

const commands = { help: cmdHelp, version: cmdVersion, doctor: cmdDoctor, status: cmdStatus, list: cmdList, refinement: cmdRefinement, ready: cmdReady, answers: cmdAnswers, "refine-comment": cmdRefineComment, "new-questions": cmdNewQuestions, cost: cmdCost, stats: cmdStats, verify: cmdVerify, context: cmdContext, config: cmdConfig, classify: cmdClassify, diff: cmdDiff, fingerprint: cmdFingerprint, snapshot: cmdSnapshot, "check-scope": cmdCheckScope, summary: cmdSummary, "check-refined": cmdCheckRefined, "check-context": cmdCheckContext, "check-plan": cmdCheckPlan, "check-explore": cmdCheckExplore, "check-gate": cmdCheckGate, "check-build": cmdCheckBuild, groups: cmdGroups, "run-tests": cmdRunTests, "review-input": cmdReviewInput, "check-review": cmdCheckReview, "deliver-input": cmdDeliverInput, "check-deliver": cmdCheckDeliver, deliver: cmdDeliver, "check-tune": cmdCheckTune, "tune-apply": cmdTuneApply, "tune-deliver": cmdTuneDeliver, "pr-status": cmdPrStatus, feedback: cmdFeedback, cleanup: cmdCleanup, worktree: cmdWorktree, task: cmdTask, history: cmdHistory, refs: cmdRefs };
if (commands[command]) {
  try { await commands[command](); } catch (e) { print({ error: e.message }, e.message); process.exitCode = 1; }
} else {
  console.log(`Unknown command "${command}".\n`);
  cmdHelp();
  process.exitCode = 2;
}
