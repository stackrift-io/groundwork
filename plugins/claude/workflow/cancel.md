# /groundwork cancel <change>

Stop a change cleanly. This never deletes code or reverts commits.

1. Read `.groundwork/changes/<change>/run.md`. If it does not exist, say so and stop. If `Current` is `done` or `cancelled`, say so and stop.
2. Ask the user to confirm, and ask for a one-line reason (optional).
3. Set `Current: cancelled` and add a log line with the reason.
4. Tell the user what is left in place and how to remove it if they want:
   - Uncommitted code changes, if `git status` shows any: `git restore` / `git stash` are theirs to run.
   - The OpenSpec change folder `openspec/changes/<change>/` (full path only): delete it to drop the proposal, or keep it for reference.
   - `.groundwork/changes/<change>/` stays as the record of the cancelled change.
