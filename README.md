# Groundwork by Stackrift

Groundwork is a spec-driven agentic workflow for software teams. One entry point,
`/groundwork`, takes a ticket or a prompt through refinement, explore, plan (OpenSpec),
build, review and delivery, with a human approval at the plan and before any git write,
and a pull request feedback loop after it. Audit, tune and verify keep the setup healthy.

Every stage runs as a scoped agent that writes only its own handoff file; a
deterministic script (`gw.mjs`, no dependencies) checks each stage, does every git and
pull request operation, and runs the same checks in CI.

Groundwork runs in Claude Code today. GitHub Copilot CLI, OpenCode and Codex are planned.

## Install (Claude Code)

```
/plugin marketplace add stackrift-io/groundwork
/plugin install groundwork@stackrift
```

Update later with `/plugin marketplace update stackrift`.

Requirements: Node.js 20.19 or later, Git, and the OpenSpec CLI
(`npm install -g @fission-ai/openspec@latest`; `/groundwork init` offers to install it).
For pull requests, `gh` (GitHub) or `az` (Azure Repos), signed in.

## Start

In a repository:

```
/groundwork init
/groundwork start "PROJ-123"        # a Jira key, a GitHub issue, or a plain prompt
/groundwork help                    # every command
```

`start` stops at the plan approval; `/groundwork approve <change>` builds, reviews and
shows the delivery for a second approval before anything is committed or pushed.

## Layout

```
plugins/claude/     the Claude Code plugin (this marketplace installs it)
```

## License

Apache License 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE). The Groundwork by
Stackrift name is not licensed under it.

Built and maintained by [Stackrift](https://stackrift.io).
