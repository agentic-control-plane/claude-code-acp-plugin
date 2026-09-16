---
name: acp-enforce
description: Turn enforcement on for this workspace — the starter rules start asking before risky calls run. You confirm with one tap.
user-invocable: true
---

This command is handled by the ACP hook before it reaches you: the hook files the request and prints a confirm link for the human. If you are reading this, the hook did not intercept it — this Claude Code is older than the UserPromptExpansion hook event.

Tell the user, in one line: "Your Claude Code is too old for terminal commands — update it, or turn enforcement on at https://cloud.agenticcontrolplane.com/policies." Do not attempt to change the workspace yourself; you cannot, and you should not try.
