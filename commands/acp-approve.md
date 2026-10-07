---
name: acp-approve
description: List this session's held calls waiting for approval (optionally one code), each with its console link.
user-invocable: true
---

This command is handled by the ACP hook before it reaches you: the hook prints, for the human, what is waiting for approval in this session — not the model. If you are reading this, the hook did not intercept it — this Claude Code is older than the UserPromptExpansion hook event.

Tell the user, in one line: "Your Claude Code is too old for terminal commands — update it, or see the workspace at https://cloud.agenticcontrolplane.com/policies."
