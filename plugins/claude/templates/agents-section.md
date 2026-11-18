<!-- groundwork:start -->
## Groundwork workflow

This repository uses Groundwork for agent-driven changes. Start every change with
`/groundwork start "<task or Jira key>"`. Do not run the stages any other way.

- Stages: Refine (optional) -> Explore -> Plan (OpenSpec change) -> human approval -> Build -> Review -> human approval -> Deliver (specs archived into the same PR) -> merge -> cleanup.
- Specs live in `openspec/specs/`; in-flight changes in `openspec/changes/<change>/`.
- Run state and handoffs live in `.groundwork/changes/<change>/`. Only the orchestrator writes `run.md`.
- No code changes before `/groundwork approve <change>`.
- `/groundwork help` lists every command.
<!-- groundwork:end -->
