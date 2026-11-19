# /groundwork init

Set up the current repository for Groundwork. Plan first, then ask once, then apply.

## 1. Check

Run `node "GW_HOME/scripts/gw.mjs" doctor --json` and read the result. Note:
- whether this is a git repository (if not, stop: Groundwork needs git)
- whether Node.js is 20.19 or later (OpenSpec needs it)
- whether `openspec` is installed, and whether `openspec/` exists
- which of these exist: `.groundwork/config.json`, `AGENTS.md`, `CLAUDE.md`, `.github/workflows/groundwork-verify.yml`, `.groundwork/bin/gw.mjs`

## 2. Show the plan and ask once

List only the steps below that are still needed, then ask the user to confirm with one question. Also ask which harnesses OpenSpec should set up: OpenCode only (default), or OpenCode and GitHub Copilot.

1. **OpenSpec CLI**: if missing, install with `npm install -g @fission-ai/openspec@1.16.0`.
2. **OpenSpec in the repo**: if `openspec/` is missing, run `openspec init --tools opencode` (or `--tools opencode,github-copilot`).
3. **Groundwork config**: create `.groundwork/config.json` from `GW_HOME/templates/config.json`, and the folder `.groundwork/changes/`.
4. **Verify script for CI**: copy `GW_HOME/scripts/gw.mjs` to `.groundwork/bin/gw.mjs`.
5. **CI workflow**: create `.github/workflows/groundwork-verify.yml` from `GW_HOME/templates/groundwork-verify.yml`. Ask about this step separately if the repository does not use GitHub Actions.
6. **AGENTS.md**: add the block from `GW_HOME/templates/agents-section.md`. If a block between `<!-- groundwork:start -->` and `<!-- groundwork:end -->` already exists, replace only that block. Never change anything else in the file.
7. **.gitignore**: make sure it contains the lines `.groundwork/changes/*/tests/*.log` (test logs can contain secrets), `.groundwork/worktrees/`, `.groundwork/changes/*/inputs/` (generated agent inputs) and `.groundwork/tune/apply.json` (tune-apply's marker). Create the file if it does not exist. Add only the lines that are missing; never change any other line.
8. **OpenCode agents** (always needed: list and run this step on every init, even when every other step is done, since the models in the config may have changed): run `node "GW_HOME/scripts/gw.mjs" opencode-agents --write`. It rewrites only the nine stage agents `.opencode/agents/gw-*.md` and leaves every other file there alone, with their models from `.groundwork/config.json` and their permissions from the scope lists. They are meant to be committed. Run it again after every change to `models` in the config.

## 3. Apply

Apply the confirmed steps in order. If a step fails, stop and report which step and why; do not continue past it.

## 4. Finish

Run `node "GW_HOME/scripts/gw.mjs" doctor` and show its output. Then tell the user:
- `.groundwork/` is meant to be committed: it is the audit trail of every change.
- Next: `/groundwork audit` to assess the current agent setup, or `/groundwork start "<task or Jira key>"`.
