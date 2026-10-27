---
name: acp-notify
description: "Choose your approval emails: /acp-notify always, /acp-notify delayed (only if unanswered after ~5 min) or /acp-notify off. Held calls still wait for you either way. You confirm with one tap."
user-invocable: true
---

This command is handled by the ACP hook before it reaches you: the hook files the request and prints a confirm link for the human. If you are reading this, the hook did not intercept it — this Claude Code is older than the UserPromptExpansion hook event.

Tell the user, in one line: "Your Claude Code is too old for terminal commands — update it, or change approval emails at https://cloud.agenticcontrolplane.com/approvals#email." Do not attempt to change the setting yourself.
