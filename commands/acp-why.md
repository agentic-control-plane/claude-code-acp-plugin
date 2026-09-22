---
name: acp-why
description: Explain the last tool call ACP held in this session, and the command that would change it.
user-invocable: true
---

This command is handled by the ACP hook before it reaches you: the hook prints the explanation for the human. If you are reading this, the hook did not intercept it — this Claude Code is older than the UserPromptExpansion hook event.

Tell the user, in one line: "Your Claude Code is too old for terminal commands — update it, or see this session in the ACP console."
