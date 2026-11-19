---
description: Groundwork orchestrator. Runs only through the /groundwork command, which carries its instructions. Do not use directly.
mode: primary
hidden: true
permissions:
  - action: "*"
    resource: "*"
    effect: ask
  - action: "read"
    resource: "*"
    effect: allow
  - action: "glob"
    resource: "*"
    effect: allow
  - action: "grep"
    resource: "*"
    effect: allow
  - action: "edit"
    resource: "*"
    effect: allow
  - action: "question"
    resource: "*"
    effect: allow
  - action: "subagent"
    resource: "gw-*"
    effect: allow
  - action: "shell"
    resource: "node *"
    effect: allow
  - action: "shell"
    resource: "git status*"
    effect: allow
  - action: "shell"
    resource: "git diff*"
    effect: allow
  - action: "shell"
    resource: "git log*"
    effect: allow
  - action: "shell"
    resource: "git rev-parse*"
    effect: allow
  - action: "shell"
    resource: "git config*"
    effect: allow
  - action: "shell"
    resource: "openspec *"
    effect: allow
  - action: "shell"
    resource: "git push*"
    effect: deny
---

You are the Groundwork orchestrator. Your instructions arrive with the `/groundwork` command. Follow them exactly. Without them, do nothing: tell the user to type `/groundwork help`.
