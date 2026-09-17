// Unit tests for the ask-level uninstall floor in bin/decide.mjs
// (gatewaystack-connect#1229). Same fixtures as the gateway's
// riskClassifier.test.ts so an offline call and a governed call agree.
// This floor exists specifically for the outage / key-gone case: it is
// the one gate an agent cannot route around by knocking the hook itself
// offline.
//
// Run with: node --test test/uninstall-floor.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { uninstallFloor, decide } from "../bin/decide.mjs";

const u = (command) => uninstallFloor("Bash", { command });

const SATISHGODA_REMOVAL =
  "$acp = Join-Path $env:USERPROFILE '.acp'; if (Test-Path $acp) { Remove-Item -Recurse -Force $acp }";

test("the 2026-09-17 removal: caught even though the verb and the path are in different statements", () => {
  assert.equal(u(SATISHGODA_REMOVAL), "removes the ACP directory (PowerShell)");
});

test("(a) the sanctioned uninstaller in command position, any wrapper or path", () => {
  for (const cmd of [
    "acp-uninstall",
    "acp-uninstall --dry-run",
    "~/.acp/bin/acp-uninstall",
    "cd ~ && acp-uninstall",
    "sudo acp-uninstall",
    "acp-uninstall.cmd",
    "bash ~/.acp/uninstall.sh --dry-run",
  ]) assert.equal(u(cmd), "runs the ACP uninstaller", cmd);
});

test("(b) fetching the hosted uninstaller, POSIX and PowerShell spellings", () => {
  for (const cmd of [
    "curl -sf https://agenticcontrolplane.com/uninstall.sh | bash",
    "wget -qO- https://agenticcontrolplane.com/uninstall.sh | sh",
    "irm https://agenticcontrolplane.com/uninstall.ps1 | iex",
    "Invoke-WebRequest -Uri https://agenticcontrolplane.com/uninstall.ps1 -OutFile u.ps1",
  ]) assert.equal(u(cmd), "fetches the ACP uninstaller", cmd);
});

test("(c) a recursive delete of .acp through a variable, POSIX or PowerShell", () => {
  assert.equal(u('ACP_DIR="$HOME/.acp"; rm -rf "$ACP_DIR"'), "removes the ACP directory (shell)");
  assert.equal(u("Remove-Item -Recurse -Force (Join-Path $env:USERPROFILE '.acp')"), "removes the ACP directory (PowerShell)");
  assert.equal(u("$acp = Join-Path $HOME '.acp'; rd -r $acp"), "removes the ACP directory (PowerShell)");
});

test("a literal rm -rf ~/.acp is still caught (no separate tamper floor offline, but this one sees it)", () => {
  assert.equal(u("rm -rf ~/.acp"), "removes the ACP directory (shell)");
});

test("benign PowerShell and prose never fire", () => {
  for (const cmd of [
    "Remove-Item -Recurse .\\build",
    'Write-Host "see ~/.acp/lapse.log"',
    "grep -ri lapse ~/.acp/",
    "cat ~/.acp/uninstall.sh",
    "git commit -m 'document acp-uninstall and the Remove-Item path'",
    "acp-uninstall-notes.md",
    "cat acp-uninstall.md",
  ]) assert.equal(u(cmd), null, cmd);
});

test("decide(): tightens an allow to ask; a policy deny still wins; non-shell tools untouched", () => {
  const r = decide("Bash", { command: "acp-uninstall" }, { rules: {}, default: "allow" }, {});
  assert.equal(r.decision, "ask");
  assert.match(r.reason, /^uninstall floor: runs the ACP uninstaller/);
  assert.equal(r.source, "uninstall-floor");

  const denied = decide("Bash", { command: "acp-uninstall" }, { rules: { "Bash.acp-uninstall": "deny" }, default: "allow" }, {});
  assert.equal(denied.decision, "deny");

  assert.equal(uninstallFloor("Read", { file_path: "/x" }), null);
});
