#!/usr/bin/env sh
# Install Groundwork for OpenCode (macOS / Linux). Run it from this folder: sh install.sh
# Copies this folder to ~/.config/opencode/groundwork/, then writes the /groundwork command and the gw-orchestrator agent
# into ~/.config/opencode/commands/ and ~/.config/opencode/agents/. The stage agents are not installed globally:
# /groundwork init generates them per repository in .opencode/agents/.
set -eu

SRC="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${HOME}/.config/opencode"
DEST="${CONFIG}/groundwork"

if [ ! -f "$SRC/commands/groundwork.md" ] || [ ! -f "$SRC/agents/gw-orchestrator.md" ] || [ ! -f "$SRC/scripts/gw.mjs" ]; then
  echo "Run this script from the Groundwork OpenCode folder (commands/, agents/ and scripts/ must sit next to it)." >&2
  exit 1
fi
if [ -d "$DEST" ] && [ "$SRC" = "$(cd "$DEST" && pwd)" ]; then
  echo "This is the installed copy; run the installer from the downloaded folder instead." >&2
  exit 1
fi

mkdir -p "$CONFIG"
# One backup folder for everything this install replaces: the old install folder, and the command and the orchestrator agent
# it overwrites (under previous-config/), whoever wrote them.
CMD_FILE="${CONFIG}/commands/groundwork.md"
AGENT_FILE="${CONFIG}/agents/gw-orchestrator.md"
if [ -e "$DEST" ] || [ -e "$CMD_FILE" ] || [ -e "$AGENT_FILE" ]; then
  mkdir -p "${CONFIG}/groundwork-backups"
  BACKUP="${CONFIG}/groundwork-backups/groundwork-$(date +%Y%m%d-%H%M%S)"
  n=1
  while [ -e "$BACKUP" ]; do BACKUP="${CONFIG}/groundwork-backups/groundwork-$(date +%Y%m%d-%H%M%S)-$n"; n=$((n + 1)); done
  if [ -e "$DEST" ]; then mv "$DEST" "$BACKUP"; else mkdir -p "$BACKUP"; fi
  if [ -e "$CMD_FILE" ]; then mkdir -p "$BACKUP/previous-config/commands"; cp "$CMD_FILE" "$BACKUP/previous-config/commands/groundwork.md"; fi
  if [ -e "$AGENT_FILE" ]; then mkdir -p "$BACKUP/previous-config/agents"; cp "$AGENT_FILE" "$BACKUP/previous-config/agents/gw-orchestrator.md"; fi
  echo "Existing install backed up to $BACKUP"
fi
cp -R "$SRC" "$DEST"

# The command names the absolute Groundwork home: OpenCode has no plugin-root variable.
mkdir -p "${CONFIG}/commands" "${CONFIG}/agents"
ESCAPED="$(printf '%s' "$DEST" | sed -e 's/[\\&|]/\\&/g')"
sed "s|@@GW_HOME@@|${ESCAPED}|g" "$SRC/commands/groundwork.md" > "${CONFIG}/commands/groundwork.md"
cp "$SRC/agents/gw-orchestrator.md" "${CONFIG}/agents/gw-orchestrator.md"

echo "Groundwork installed at $DEST"
echo "Start OpenCode in a repository and type: /groundwork init"
