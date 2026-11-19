# Groundwork by Stackrift

Groundwork is a spec-driven agentic workflow for software teams. One entry point,
`/groundwork`, takes a ticket or a prompt through refinement, explore, plan (OpenSpec),
build, review and delivery, with a human approval at the plan and before any git write,
and a pull request feedback loop after it. Audit, tune and verify keep the setup healthy.

Every stage runs as a scoped agent that writes only its own handoff file; a
deterministic script (`gw.mjs`, no dependencies) checks each stage, does every git and
pull request operation, and runs the same checks in CI.

Groundwork runs in Claude Code and OpenCode. GitHub Copilot CLI and Codex are planned.

## Install (Claude Code)

```
/plugin marketplace add stackrift-io/groundwork
/plugin install stackrift-groundwork@stackrift
```

Update later with `/plugin marketplace update stackrift`.

Requirements: Node.js 20.19 or later, Git, and the OpenSpec CLI
(`npm install -g @fission-ai/openspec@1.16.0`; `/groundwork init` offers to install it).
For pull requests, `gh` (GitHub) or `az` (Azure Repos), signed in.

## Install (OpenCode)

```
git clone https://github.com/stackrift-io/groundwork
sh groundwork/plugins/opencode/install.sh          # macOS / Linux
powershell -File groundwork\plugins\opencode\install.ps1   # Windows
```

The installer copies the folder to `~/.config/opencode/groundwork/` and writes only the
command and one agent into OpenCode's folders. Re-run it to update. `/groundwork init`
then generates the stage agents in the repository's `.opencode/agents/`. See
[plugins/opencode/README.md](plugins/opencode/README.md).

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
plugins/opencode/   the OpenCode install folder (clone, then run its installer)
```

## License

Apache License 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE). The Groundwork by
Stackrift name is not licensed under it.

Built and maintained by [Stackrift](https://stackrift.io).
