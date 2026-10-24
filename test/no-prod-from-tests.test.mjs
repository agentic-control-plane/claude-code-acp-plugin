// Tests must never reach a real ACP gateway. On 2026-10-24 CI sent gsk_test_*
// calls to govern.agenticcontrolplane.com: specs that spawned the hook without
// the dev-base override fell back to production. _dev-base.mjs now preloads
// _no-prod-fetch.mjs into every spawned process; these tests keep it that way.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import "./_dev-base.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOVERN = join(HERE, "..", "bin", "govern.mjs");

test("every test that spawns a process imports ./_dev-base.mjs", () => {
  const missing = readdirSync(HERE)
    .filter((f) => f.endsWith(".test.mjs"))
    .filter((f) => {
      const src = readFileSync(join(HERE, f), "utf8");
      return /\b(spawn|spawnSync)\s*\(/.test(src) && !src.includes("./_dev-base.mjs");
    });
  assert.deepEqual(missing, [], `these spawn without the no-prod shim: ${missing.join(", ")}`);
});

test("a spawned hook with NO dev-base override cannot reach the production gateway", () => {
  const home = mkdtempSync(join(tmpdir(), "acp-noprod-"));
  const r = spawnSync(process.execPath, [GOVERN], {
    env: { PATH: process.env.PATH, HOME: home, ACP_BEARER_TOKEN: "gsk_test_noprod", CLAUDE_CODE_ENTRYPOINT: "sdk-cli", ACP_FIRST_ATTEMPT_MS: "300", ACP_RETRY_ATTEMPT_MS: "300" },
    input: JSON.stringify({ session_id: "np", cwd: "/tmp", hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t", tool_input: { command: "echo hi" }, permission_mode: "default" }),
    encoding: "utf8", timeout: 20000,
  });
  const out = JSON.parse(r.stdout);
  // Unattended + blocked network = the outage posture, never a 401 from prod.
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.systemMessage, /unreachable/i);
  assert.doesNotMatch(out.systemMessage, /KEY REJECTED|Key rejected/);
});
