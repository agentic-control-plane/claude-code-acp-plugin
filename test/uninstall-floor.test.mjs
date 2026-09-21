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
import { uninstallFloor, decide, classifyTool } from "../bin/decide.mjs";

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

test("#1277 HIGH-1: the semicolon-joined variable spellings fire (`.acp;` is the dir)", () => {
  for (const cmd of [
    'd=~/.acp; rm -rf "$d"',
    "d=$HOME/.acp; rm -rf $d",
    "export ACP=~/.acp; rm -rf $ACP",
    "sh -c 'd=~/.acp; rm -rf $d'",
    "d=~/.acp\nrm -rf \"$d\"",
    "d=~/.acp && rm -rf \"$d\"",
    "(d=~/.acp; rm -rf \"$d\")",
    "d=$(echo ~/.acp); rm -rf $d",
  ]) assert.equal(u(cmd), "removes the ACP directory (shell)", cmd);
  assert.equal(
    u("$acp = Join-Path $env:USERPROFILE '.acp'\nif (Test-Path $acp) {\n  Remove-Item -Recurse -Force $acp\n}"),
    "removes the ACP directory (PowerShell)",
  );
});

test("#1277 MED-3: the variable rule is per statement — `.acp` elsewhere in the payload is not an operand", () => {
  for (const cmd of [
    "rm -rf $TMP && cat ~/.acp/lapse.log",
    'for d in $(ls); do rm -rf "$d"; done; cat .acp/config',
    "rm -r $BUILD_DIR   # keep .acp",
    'DIR=dist; rm -rf "$DIR"; echo \'see .acp/lapse.log\'',
    'rm -rf "$OUT"; ls .acp',
    "rm -rf $DIR\nls ~/.acp",
    "Remove-Item -Recurse -Force $build; Write-Host \"acp: see .acp/lapse.log\"",
    "rmdir /s /q build && dir .acp",
  ]) assert.equal(u(cmd), null, cmd);
});

test("#1277 MED-4: wrappers, quoted paths, launchers, find, inline scripts, pipelines, cmd.exe, plugin disable", () => {
  for (const cmd of [
    "command acp-uninstall",
    '"$HOME/.acp/bin/acp-uninstall"',
    "npx acp-uninstall",
    "source ~/.acp/uninstall.sh",
    ". ~/.acp/uninstall.sh",
    "bash < ~/.acp/uninstall.sh",
    "~/.acp/uninstall.sh",
    "sudo bash ~/.acp/uninstall.sh",
    '& "$env:USERPROFILE\\.acp\\uninstall.ps1"',
  ]) assert.equal(u(cmd), "runs the ACP uninstaller", cmd);
  for (const cmd of [
    "find ~/.acp -delete",
    "find ~ -maxdepth 1 -name .acp -exec rm -rf {} +",
    "Get-ChildItem $env:USERPROFILE\\.acp -Recurse | Remove-Item -Force -Recurse",
    "ls -d ~/.acp | xargs rm -rf",
    "set d=%USERPROFILE%\\.acp & rd /s /q %d%",
  ]) assert.match(u(cmd), /^removes the ACP directory/, cmd);
  for (const cmd of [
    "python3 -c \"import shutil,os; shutil.rmtree(os.path.expanduser('~/.acp'))\"",
    "node -e \"require('fs').rmSync(require('os').homedir()+'/.acp',{recursive:true})\"",
  ]) assert.equal(u(cmd), "removes the ACP directory (script)", cmd);
  for (const cmd of [
    "claude plugin disable agentic-control-plane",
    "claude plugin uninstall acp",
    "claude plugin remove agentic-control-plane@acp-marketplace",
  ]) assert.equal(u(cmd), "disables the ACP plugin", cmd);
});

test("#1277 adversarial: the review's refuted false positives stay null; comments/heredocs don't flip the label", () => {
  for (const cmd of [
    "rm -rf node_modules/.acp-cache",
    "rm -rf .acpx",
    "rm -rf ~/.acp-backup",
    "npm uninstall acp-client",
    "git checkout -- .acp",
    "docker rm -f acp-uninstall",
    "cat docs/acp-uninstall.md",
    "Remove-Item -Recurse .\\build",
    "claude plugin disable acp-foo",
    "find . -name '*.pyc' -delete",
  ]) assert.equal(u(cmd), null, cmd);
  assert.equal(u("d=~/.acp; rm -rf $d # Remove-Item"), "removes the ACP directory (shell)");
  assert.equal(classifyTool("Bash", { command: "rm -rf ~/work/scratch # Remove-Item" }), "Bash.rm");
  assert.equal(classifyTool("Bash", { command: "cat > deploy.ps1 <<'EOF'\nRemove-Item -Recurse dist\nEOF" }), "Bash.cat");
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
