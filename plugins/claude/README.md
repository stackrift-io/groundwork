# Groundwork by Stackrift

Groundwork is a spec-driven agentic workflow for software teams in Claude Code. One
command, `/groundwork`, takes a ticket or a prompt through refinement, explore, plan
(with OpenSpec), build, review and delivery. You approve the plan before any code
changes, and you approve the delivery before anything is committed or pushed. After
the pull request opens, its comments and failed checks come back as review rounds.
Audit, tune and verify keep the repository's agent setup healthy.

## Use it

In a Git repository, run `/groundwork init` once. Then start a change with
`/groundwork start "PROJ-123"` (a Jira key, a GitHub issue or a plain description),
review the plan, and type `/groundwork approve <change>`. `/groundwork help` lists
every command.

Requirements: Node.js 20.19 or later, Git, and the OpenSpec CLI. For pull requests,
the GitHub CLI (`gh`) or the Azure CLI (`az`), signed in.

## What it runs

- `scripts/gw.mjs`, a Node.js script with no dependencies, which ships in this
  plugin. It checks each stage, renders the approval pages and runs every Git and
  pull request operation. `/groundwork init` copies it into your repository as
  `.groundwork/bin/gw.mjs` so your CI can run the same checks.
- Git, on your repository: status, diff and log at every stage; branch, commit and
  push only after you approve the delivery; worktrees when you turn on parallel builds.
- The OpenSpec CLI, to create, validate and archive change specs.
- The test commands you set in `.groundwork/config.json`, and Docker when those
  tests need it.
- `gh` or `az`, with your own sign-in, to open, update and read your pull requests.
- The system's file opener (`explorer.exe`, `open` or `xdg-open`) to show the local
  approval pages it writes under `.groundwork/`.

## What it sends and fetches

Groundwork has no server and collects nothing. Data leaves your machine only
through tools you configure and sign in to yourself:

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
