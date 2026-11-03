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

1. If ACP runs as the Claude Code **plugin** (the normal case — `claude
   plugin list` shows `agentic-control-plane@acp`), the only command that
   switches the active version is:

   ```bash
   claude plugin update agentic-control-plane@acp
   ```

   Re-running the installer does NOT upgrade an installed plugin
   (`claude plugin install` is a no-op on one that is already installed —
   acp-install#64), so do not send the user back to the installer for this.

   If ACP runs as a **standalone hook** (`~/.acp/govern.mjs` wired directly
   in `~/.claude/settings.json`, no plugin listed), run the canonical
   installer, exactly:

   ```bash
   curl -sf https://agenticcontrolplane.com/install.sh | bash
   ```

   Expect an approval requirement: refreshing the governance hook is
   step_up-gated at unattended tiers, and the deny reason carries the
   approval link. Ask your human to approve it in the ACP console, then
   run the SAME command again — the consumed approval lets it through.
   Do not modify the command, add flags, or chain other commands onto it:
   only the exact canonical form is recognized.

2. Either way, tell the user to **restart Claude Code** (the running
   session keeps the old hook in memory).

3. On the next session start the hook re-attests: the console session view
   shows the new version and hash. If the badge still shows the old
   version, the update did not take — `claude plugin list` should show the
   version in `~/.claude/plugins/marketplaces/acp/.claude-plugin/marketplace.json`
   (plugin), or `~/.acp/govern.mjs` should have been rewritten (standalone).

## Never

- Never edit `~/.acp/govern.mjs`, `~/.claude/settings.json` hooks, or the
  plugin files directly — governance machinery is human-only; the
  canonical installer behind a human approval is the ONE sanctioned path.
- Never work around a denied installer run — the approval link in the
  deny reason is the path forward.
