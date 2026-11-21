---
name: web
description: Share this Claude Code session in the pi-websession web UI, or change how it's shared. Only run when the user types /web.
disable-model-invocation: true
argument-hint: "[on|off|control|nocontrol|url|status|rotate]"
---

The pi-websession plugin's UserPromptSubmit hook already carried out this `/web` command and showed the user the result. Reply with one short line, like "Done.", and don't run any tools.

If there's no hook context about it above, the plugin's hooks aren't loaded. Say so in one line and suggest restarting Claude Code.
