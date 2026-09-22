---
name: acp-upgrade
description: Upgrade the ACP governance plugin and hook to the latest version via the canonical installer (human-approved)
user-invocable: true
---

# ACP upgrade

Use this when ACP reports that a newer plugin version is available (an
`[ACP]` upgrade notice at session start), or when the user asks to upgrade
ACP.

## Why upgrades matter

The govern hook is the enforcement point on this machine. Old versions can
carry enforcement gaps — for example, pre-0.11.0 hooks could time out under
gateway latency, and a timed-out PreToolUse hook is non-blocking: the call
runs even though the server issued a deny. Upgrading closes gaps that are
already fixed upstream.

## How to upgrade

1. Run the canonical installer, exactly:

   ```bash
   curl -sf https://agenticcontrolplane.com/install.sh | bash
   ```

   Expect an approval requirement: refreshing the governance hook is
   step_up-gated at unattended tiers, and the deny reason carries the
   approval link. Ask your human to approve it in the ACP console, then
   run the SAME command again — the consumed approval lets it through.
   Do not modify the command, add flags, or chain other commands onto it:
   only the exact canonical form is recognized.

2. After the installer finishes, tell the user to **restart their session**
   (the running session keeps the old hook in memory).

3. On the next session start the hook re-attests: the console session view
   shows the new version and hash. If the badge still shows the old
   version, the installer did not take — check `~/.acp/govern.mjs` was
   rewritten and `claude plugin list` shows the current plugin version.

## Never

- Never edit `~/.acp/govern.mjs`, `~/.claude/settings.json` hooks, or the
  plugin files directly — governance machinery is human-only; the
  canonical installer behind a human approval is the ONE sanctioned path.
- Never work around a denied installer run — the approval link in the
  deny reason is the path forward.
