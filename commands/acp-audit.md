---
name: acp-audit
description: Put this workspace back in audit mode — everything recorded, nothing held. You confirm with one tap.
user-invocable: true
---

This command is handled by the ACP hook before it reaches you: the hook files the request and prints a confirm link for the human. If you are reading this, the hook did not intercept it — this Claude Code is older than the UserPromptExpansion hook event.

Tell the user, in one line: "Your Claude Code is too old for terminal commands — update it, or change the mode at https://cloud.agenticcontrolplane.com/policies." Do not attempt to change the workspace yourself.
