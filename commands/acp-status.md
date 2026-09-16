---
name: acp-status
description: Show this workspace's mode, its interactive rules, and any proposals or approvals waiting for you.
user-invocable: true
---

This command is handled by the ACP hook before it reaches you: the hook prints the workspace status for the human. If you are reading this, the hook did not intercept it — this Claude Code is older than the UserPromptExpansion hook event.

Tell the user, in one line: "Your Claude Code is too old for terminal commands — update it, or see the workspace at https://cloud.agenticcontrolplane.com/policies."
