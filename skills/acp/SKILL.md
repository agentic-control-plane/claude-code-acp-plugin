---
name: acp
description: Identity, governance, and audit for all Claude Code tool calls via the Agentic Control Plane
user-invocable: true
---

# Agentic Control Plane (ACP)

ACP is the identity and governance layer for Claude Code. When active, **every tool call** (Bash, Read, Write, Edit, Grep, WebFetch, and all MCP tools) is logged and governed through the user's ACP workspace. The user does not need to change how they work — ACP runs transparently via a PreToolUse hook.

## What ACP does

- **Audit logging** — every tool call is recorded with identity, tool name, arguments, timestamp, and decision
- **Policy enforcement** — workspace admins can allow/deny tool calls by pattern, scope, or ABAC rules
- **Rate limiting & budgets** — cap tool calls per minute, per month, or by cost
- **Content scanning** — detect and optionally redact PII in tool inputs
- **Team governance** — multiple members per workspace, role-based access

ACP does NOT proxy or replace the user's tools. Their MCP servers, Bash commands, and file operations work exactly as before. ACP observes and governs the orchestration layer.

## Setup flow — help users connect

When a user asks to set up ACP, connect to ACP, or enable governance, follow these steps:

### Step 1: Check if already configured

```bash
cat ~/.acp/credentials 2>/dev/null && echo "ACP credentials found" || echo "No ACP credentials"
```

If credentials exist, skip to Step 4 (verify).

### Step 2: Create account or log in

Open the browser to the ACP authorization page:

```bash
open "https://cloud.agenticcontrolplane.com/plugin/authorize"
```

Tell the user:
> I've opened your browser to log in to ACP. If you don't have an account, you can sign up there with Google or email. After logging in, you'll see a token — please paste it here.

### Step 3: Store credentials

Once the user provides the token, store it:

```bash
mkdir -p ~/.acp && echo "THE_TOKEN" > ~/.acp/credentials && chmod 600 ~/.acp/credentials
```

Confirm:
> Your ACP credentials are stored securely. The governance hook is now active — every tool call in this session and future sessions will be logged to your ACP workspace.

### Step 4: Verify connection

Test the governance endpoint:

```bash
curl -sf -X GET "https://api.agenticcontrolplane.com/govern/health" && echo " — ACP reachable"
```

### Step 5: Direct to the console

Tell the user:
> Your dashboard is ready. Open it to see your audit logs:
>
> https://cloud.agenticcontrolplane.com/logs
>
> Every tool call Claude makes — Bash commands, file edits, web fetches, MCP tools — shows up there in real-time. You can set policies, rate limits, and content scanning from the dashboard.

## Console pages (for directing users)

| What they want | URL |
|---|---|
| Audit logs (start here) | `https://cloud.agenticcontrolplane.com/logs` |
| Policy rules (allow/deny tools) | `https://cloud.agenticcontrolplane.com/policies` |
| Rate limits & budgets | `https://cloud.agenticcontrolplane.com/limits` |
| Content/PII policy | `https://cloud.agenticcontrolplane.com/content` |
| API keys | `https://cloud.agenticcontrolplane.com/api-keys` |
| Team members | `https://cloud.agenticcontrolplane.com/users` |
| Billing & usage | `https://cloud.agenticcontrolplane.com/billing` |

For a mode or rule change, don't only point at the console — the user can type `/acp-status`, `/acp-enforce`, `/acp-audit`, `/acp-allow <tool>`, `/acp-ask <tool>`, `/acp-deny <tool>`, or `/acp-apply <proposal>` right in the terminal; the hook files it and hands back a link they confirm themselves, no context switch required.

## Managing ACP from within Claude

Users can ask Claude to help with ACP management. You can assist with:

### Check status
```bash
TOKEN=$(cat ~/.acp/credentials 2>/dev/null)
curl -sf -H "Authorization: Bearer $TOKEN" "https://api.agenticcontrolplane.com/govern/health"
```

### View recent tool calls
Direct the user to `https://cloud.agenticcontrolplane.com/logs` — the dashboard shows all tool calls with filtering by tool name, identity, time range, and decision.

### Disconnect / pause governance
To temporarily disable ACP governance without uninstalling:
```bash
mv ~/.acp/credentials ~/.acp/credentials.paused
```
To re-enable:
```bash
mv ~/.acp/credentials.paused ~/.acp/credentials
```

### Uninstall
```bash
rm -rf ~/.acp
```
Then disable the plugin: `claude plugin disable agentic-control-plane`

## How the hook works (for user questions)

The plugin registers a PreToolUse hook that fires before every tool call:

1. Hook reads `~/.acp/credentials` for the API key
2. Sends tool name + input to `POST /govern/tool-use`
3. ACP runs a 6-layer governance pipeline (immutable rules, scope enforcement, ABAC policies, rate limits, content scanning)
4. Returns `allow` or `deny` with a reason
5. If denied, Claude sees the reason and can adapt
6. If the API is unreachable, the hook **fails open** — Claude is never blocked by ACP outages

## Important notes

- The hook adds ~50-200ms latency per tool call (negligible for most workflows)
- No tool inputs are stored permanently unless the workspace has logging enabled
- ACP never modifies tool inputs or outputs — it only observes and allows/denies
- The governance hook does NOT expose any new tools to Claude — it only monitors existing ones
