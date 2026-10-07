// Regression corpus for the wrapper/compound command-laundering class (#19 /
// acp-install#18, gateway's gsc#516/gsc#750): the safety floor and local
// policy must hold against ordinary command shapes — wrapper operands
// (sudo -u USER, timeout DURATION, nice -n N), option-arguments before a
// subcommand (git -C DIR push), grouping (subshells, braces, $( )), and
// compound commands, which classify by their most-privileged segment and are
// policy-checked segment-by-segment (strictest verdict wins).
//
// bin/decide.mjs is a verbatim copy of acp-install's decide.mjs; this file is
// the plugin-side guard the mirror never had.

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyTool, hardlineFloor, decide } from "../bin/decide.mjs";

const bash = (command) => ["Bash", { command }];
// Assembled so this file never contains a literal runnable catastrophe.
const RM = "r" + "m";

const FLOOR_DENY = [
  ["sudo", "-u", "root", RM, "-rf", "/"].join(" "),    // sudo's -u USER operand
  ["timeout", "5", RM, "-rf", "~"].join(" "),          // timeout's DURATION operand
  ["nice", "-n", "10", RM, "-rf", "/"].join(" "),      // nice's -n N operand
  ["nohup", "timeout", "2", RM, "-rf", "/"].join(" "), // stacked wrappers
  ["(", RM, "-rf", "/", ")"].join(" "),                // subshell
  ["{", RM, "-rf", "/;", "}"].join(" "),               // brace group
  ["fish -c '", RM, "-rf /'"].join(" "),               // fish is a SHELL_BIN
  ["echo ok $(", RM, "-rf ~ )"].join(" "),             // command substitution
  ["echo hi &&", RM, "-rf", "~"].join(" "),            // compound
  [RM, "-rf", "/."].join(" "),                         // /. spelling of root
];

for (const cmd of FLOOR_DENY) {
  test(`floor denies: ${cmd}`, () => {
    assert.notEqual(hardlineFloor(...bash(cmd)), null, `expected floor to deny: ${cmd}`);
    assert.equal(decide(...bash(cmd), { default: "allow", rules: {} }).decision, "deny");
  });
}

const FLOOR_ALLOW = [
  "timeout 30 npm test",
  "sudo -u postgres psql -c 'select 1'",
  "nice -n 10 make build",
  "git -C /repo status",
  "npm run lint && npm test",
  [RM, "-rf", "node_modules"].join(" "),
];

for (const cmd of FLOOR_ALLOW) {
  test(`floor allows: ${cmd}`, () => {
    assert.equal(hardlineFloor(...bash(cmd)), null, `floor should NOT fire on: ${cmd}`);
  });
}

test("classifyTool unwraps wrapper operands and option-arguments (#19)", () => {
  assert.equal(classifyTool(...bash("sudo -u root chmod 777 f")), "Bash.chmod");
  assert.equal(classifyTool(...bash("timeout 5 npm test")), "Bash.npm.test");
  assert.equal(classifyTool(...bash("nice -n 10 git push origin dev")), "Bash.git.push");
  assert.equal(classifyTool(...bash("git -C /repo push origin dev")), "Bash.git.push"); // was the malformed "Bash.git.."
});

test("compound commands are policy-checked per segment; strictest verdict wins (#18)", () => {
  const policy = { default: "allow", rules: { "Bash.gcloud": "deny", ["Bash." + RM]: "deny", "Bash.curl": "ask" } };
  assert.equal(decide(...bash("which gcloud && gcloud sql instances delete x --quiet"), policy).decision, "deny");
  assert.equal(decide(...bash(["true &&", RM, "-rf", "/tmp/demo"].join(" ")), policy).decision, "deny");
  assert.equal(decide(...bash("echo hi && curl https://x.com"), policy).decision, "ask");
  assert.equal(decide(...bash("npm run lint && npm test"), policy).decision, "allow");
});

test("unparseable non-empty commands are Bash.unknown, never a wrong-segment key", () => {
  assert.equal(classifyTool(...bash(") ) )")), "Bash.unknown");
  assert.equal(classifyTool(...bash("")), "Bash");
});
