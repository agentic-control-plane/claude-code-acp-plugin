# Agentic Control Plane — Claude Code Plugin

Identity, governance, and audit for every Claude Code tool call.

When active, **every tool call** Claude makes — `Bash`, `Read`, `Write`, `Edit`, `WebFetch`, and all MCP tools — is checked against your policy and logged: on your machine by default, or to a shared ACP workspace once you connect a team. Set policies to control what's allowed; get full audit visibility.

ACP doesn't replace your tools or change how you use Claude. It's the governance layer that sits transparently in front of everything.

Docs: [install guide + troubleshooting](https://agenticcontrolplane.com/integrations/claude-code) · [which Claude Code tools to deny out of the box](https://agenticcontrolplane.com/blog/which-claude-code-tools-to-deny-out-of-the-box) · [the Tool Surface Index](https://agenticcontrolplane.com/tool-surfaces) — every tool one Claude Code session declares, grouped by blast radius

## One-command install

```bash
# Free, on-device, no account — governs Claude Code locally:
curl -sf https://agenticcontrolplane.com/install.sh | bash -s -- --local
```

This installs the plugin plus the on-device engine and activates the governance hook. Every Claude Code tool call is checked against `~/.acp/policy.json` and logged to `~/.acp/audit.jsonl` — no account, nothing leaves your machine. Restart Claude Code and you're governed.

Want team policy across everyone's agents, verified identity, and the cost X-ray? Run it **without** `--local` and the installer opens your browser to provision a shared workspace instead:

```bash
curl -sf https://agenticcontrolplane.com/install.sh | bash
```

Already have the plugin? Run `/acp-connect` inside Claude Code to connect.

## How it works

The plugin registers a **PreToolUse hook** that fires before every tool call:

1. Hook sends tool name + input to the decision engine — on-device (`~/.acp/decide.mjs`) in `--local` mode, or ACP's governance API when connected to a workspace
2. The engine evaluates your policy: immutable safety floor, scope enforcement, ABAC policies, rate limits, budget caps, content scanning (the full 6-layer pipeline in cloud mode; the safety floor + your `policy.json` on-device)
3. Returns `allow` or `deny`
4. All calls are logged — to `~/.acp/audit.jsonl` on-device, or your workspace's audit trail when connected

The hook **fails open** on network errors in an interactive session — ACP outages never block Claude Code — but never silently, and never below the floors (see next section).

### Offline floor and local ledger (v0.16.0+)

Whenever the gateway cannot see a call — no key on this machine yet, key present but the gateway unreachable, or `--local` mode — the hook still does two things:

1. **Applies the two floors.** The hardline floor denies catastrophic commands (wiping root or home, formatting disks, fork bombs). The destructive floor asks a human before a force push, destructive SQL handed to a database client, a remote download piped into a shell, or a recursive delete outside the working directory. Everything else proceeds with a loud warning. The floors read what will *execute*, not what appears: a heredoc written to a file or a quoted string never trips them.
2. **Records the call** to `~/.acp/ledger.jsonl` — tool, classification, decision, reason, timestamp, session. Bounded at 5 MB; nothing leaves the machine without a key.

When a key is connected (or the gateway comes back), the ledger uploads **once**, in the background, and the calls appear in your workspace audit with their original timestamps. Connect after two weeks of local use and the console shows two weeks of history, not an empty page. Buffered rows are a record, not a decision: they are never re-evaluated against workspace policy, and they never count as new agents on your plan.

### Deny messages — three categories

When ACP denies a call, the plugin tells you why with a distinct prefix so you can tell network problems apart from real policy denials at a glance:

- `[ACP] Denied by policy: <reason>` — a workspace policy intentionally blocked the call
- `[ACP] Gateway error — tool blocked for safety (HTTP X)` — ACP responded with an error (e.g. auth, server crash)
- `[ACP] Gateway unreachable — tool blocked for safety` — ACP didn't respond at all (timeout, network)

### Context guard (v0.15.0+, off by default)

Whole-file reads are the cheapest thing an agent does and the most expensive thing it puts into a frontier model's context. The hook sizes a read **before** it happens — `Read` (offset/limit-aware) and `cat` / `head` / `tail` / `less` / `more` / `bat` — and sends the line and byte count to the gateway (or the local engine) as `tool_context`. Targeted reads always pass: offset/limit, `head -n 20`, pipes (`cat f | grep x`), redirects, byte ranges, `tail -f`.

The policy block lives on the governance doc (console → Policies → Context guard) or in `~/.acp/policy.json` for local mode:

```json
"contextGuard": { "maxLines": 350, "mode": "shadow", "action": "deny" }
```

- `shadow` — allow, but every audit row for a read over the ceiling carries `contextGuard.estTokens`: what it would have put into context. Watch this ledger first.
- `enforce` — deny (or `ask`) with a reason that always names the sanctioned path: read the section you need, grep for the symbol, or hand the read to a subagent so it stays out of this context. Codex gets `sed -n 'START,ENDp'` instead of offset/limit.
- No `tool_context` (older hook, unreadable file) — not guarded, never a lapse. The tool surfaces its own error for a missing file.

The ledger counts tokens the frontier model never saw. It does not count what the agent did instead, so read it next to run cost before enforcing.

### Cross-architecture credential brokering (v0.5.0+, opt-in)

When your workspace has **scoped tokens** enabled (`policies.scopedTokensEnabled: true` in your tenant config), the plugin recognizes calls to known vendors — currently `gh`, `curl api.github.com`, and `git push https://github.com/…` — and:

1. Requests a short-lived ACP-issued scoped token bound to your stored OAuth credential for that vendor
2. Injects the token into the call as `GH_TOKEN=…` so the existing CLI keeps working with no setup change
3. **Your local PAT is never read or used by the agent** — ACP brokers the credential and audits every issuance + use

If you haven't connected the vendor yet, the plugin emits a deny with a clickable connect URL inline in the IDE so you can complete OAuth in your browser without leaving Claude Code.

If your workspace doesn't have scoped tokens enabled, the plugin behaves exactly as v0.4.0 did — your existing local credentials continue to work unchanged.

Other vendors (Slack, Salesforce, Notion, etc.) ship in subsequent releases. Track progress at [gatewaystack-connect#114](https://github.com/davidcrowe/gatewaystack-connect/issues/114).

## What you get

- **Audit logs** — every tool call with identity, arguments, timestamps, decisions
- **Policy enforcement** — allow/deny by tool name, argument patterns, ABAC rules
- **Rate limits & budgets** — cap tool calls per minute, per month, or by cost
- **Content scanning** — detect PII in tool inputs, optionally block or redact
- **Team management** — multiple members, roles, workspace-level controls

## Console

After setup, your dashboard is at:

- **Logs**: `https://cloud.agenticcontrolplane.com/logs`
- **Policies**: `https://cloud.agenticcontrolplane.com/policies`
- **Limits**: `https://cloud.agenticcontrolplane.com/limits`

## Managed rollouts (enterprise)

Pushing this hook to every seat from an admin console or MDM? The hook config
carries no secret: each person enrolls once (their own key lands in
`~/.acp/credentials`), so every call is attributed to a person. Set
`ACP_REQUIRE_ENROLLMENT=1` in the managed hook command or managed `env` and an
unenrolled machine **blocks** each call with the enrollment step instead of
running it ungoverned with a warning. That is the only thing the flag changes.
Per-harness recipes: https://agenticcontrolplane.com/docs/enterprise

## Pause / disable

```bash
# Pause governance (keep credentials)
mv ~/.acp/credentials ~/.acp/credentials.paused

# Resume
mv ~/.acp/credentials.paused ~/.acp/credentials

# Fully remove
rm -rf ~/.acp
claude plugin disable agentic-control-plane
```

## Support

- Site: https://agenticcontrolplane.com
- Issues: https://github.com/davidcrowe/claude-code-acp-plugin/issues
