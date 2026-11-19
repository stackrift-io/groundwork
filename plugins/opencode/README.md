# Groundwork by Stackrift for OpenCode

Groundwork is a spec-driven agentic workflow for software teams. One command,
`/groundwork`, takes a ticket or a prompt through refinement, explore, plan (with
OpenSpec), build, review and delivery. You approve the plan before any code changes, and
you approve the delivery before anything is committed or pushed. After the pull request
opens, its comments and failed checks come back as review rounds. Audit, tune and verify
keep the repository's agent setup healthy.

## Install

```
git clone https://github.com/stackrift-io/groundwork
sh groundwork/plugins/opencode/install.sh          # macOS / Linux
powershell -File groundwork\plugins\opencode\install.ps1   # Windows
```

The installer copies this folder to `~/.config/opencode/groundwork/` and writes only the
`/groundwork` command and the `gw-orchestrator` agent into OpenCode's own folders. To
update, pull the repository and re-run the installer. It moves the old copy, and the command
and agent it overwrites, to `~/.config/opencode/groundwork-backups/`.

Requirements: Node.js 20.19 or later, Git, and the OpenSpec CLI. For pull requests, the
GitHub CLI (`gh`) or the Azure CLI (`az`), signed in.

## Use it

In a Git repository, run `/groundwork init` once. It generates the stage agents as
`.opencode/agents/gw-*.md` and runs doctor to check the setup. Then start a change with
`/groundwork start "PROJ-123"` (a Jira key, a GitHub issue or a plain description),
review the plan, and type `/groundwork approve <change>`. `/groundwork help` lists every
command.

## Models

`.groundwork/config.json` sets a model for each stage under `models.opencode`. Where a
stage has no entry, it uses `opencode/claude-<tier>-5-5`, with the tier taken from
`models.<stage>` (`haiku`, `sonnet` or `opus`). Any `provider/model` that OpenCode can
reach works. After a change, regenerate the agents:

```
node ~/.config/opencode/groundwork/scripts/gw.mjs opencode-agents --write
```

On Windows the folder is `%USERPROFILE%\.config\opencode\groundwork`.

## What it runs

- `scripts/gw.mjs`, a Node.js script with no dependencies, which ships in this folder. It
  checks each stage, renders the approval pages and runs every Git and pull request
  operation. `/groundwork init` copies it into your repository as `.groundwork/bin/gw.mjs`
  so your CI can run the same checks.
- Git, on your repository: status, diff and log at every stage; branch, commit and
  push only after you approve the delivery; worktrees when you turn on parallel builds.
- The OpenSpec CLI, to create, validate and archive change specs.
- The test commands you set in `.groundwork/config.json`, and Docker when those
  tests need it.
- `gh` or `az`, with your own sign-in, to open, update and read your pull requests.
- The system's file opener (`explorer.exe`, `open` or `xdg-open`) to show the local
  approval pages it writes under `.groundwork/`.

Each agent writes only its own handoff files. OpenCode's own permission rules, set in the
generated agent files, enforce that: an agent has no more tools than its stage needs.

## What it sends and fetches

Groundwork has no server and collects nothing. Data leaves your machine only
through tools you configure and sign in to yourself:

- Your model provider, through OpenCode, which receives the prompts and files the agents
  read. Choose it under Models above.
- Your issue tracker (Jira, GitHub Issues or Azure DevOps), through the tracker MCP
  server you name in the config, to read tickets and, only after you approve the exact
  text, to post a comment.
- Your code host, through `gh` or `az`, to push branches and manage pull requests.
- Reference pages you pass with `--ref <url>`, fetched only from the domains you list
  in `context.trustedDomains` (empty by default).

Everything it writes stays in your repository, under `.groundwork/` and `openspec/`. A
change's record (the saved ticket, history and review rounds) is committed with the
change when you approve the delivery, so it reaches your code host with the pull request.

## Privacy

See [Privacy](PRIVACY.md): what Groundwork stores, where data goes, and that Stackrift
receives nothing.

## License

Apache License 2.0. See LICENSE and NOTICE. Built by [Stackrift](https://stackrift.io).
