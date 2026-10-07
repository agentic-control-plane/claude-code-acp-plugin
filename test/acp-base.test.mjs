// claude-code-acp-plugin#26 — gateway / console base-URL allowlist.
//
// Env overrides (ACP_API_BASE, ACP_GOVERN_BASE, ACP_CONSOLE_BASE) may only
// select among the enumerated ACP hosts. The only way to reach anything else
// is the dev/test override FILE ~/.acp/dev_base_override. There is no
// self-host escape hatch: ACP_SELF_HOST in the environment is just noise.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as lib from "../lib/acp-base.mjs";

const GOVERN = fileURLToPath(new URL("../bin/govern.mjs", import.meta.url));
const LIB = fileURLToPath(new URL("../lib/acp-base.mjs", import.meta.url));
const block = (src) => src.slice(src.indexOf("// acp-base:begin"), src.indexOf("// acp-base:end"));
const inlinedSrc = block(readFileSync(GOVERN, "utf8"));
const libSrc = block(readFileSync(LIB, "utf8"));
const inlined = new Function("readFileSync", `${inlinedSrc}\nreturn { resolveAcpBase, readDevBaseOverride, ACP_HOSTS };`)(readFileSync);

const LOOPBACK = [127, 0, 0, 1].join(".");
const DEF = "https://api.agenticcontrolplane.com";

test("the copy inlined in govern.mjs is the lib block with `export ` removed", () => {
  assert.ok(inlinedSrc.length > 500, "markers found in govern.mjs");
  assert.equal(inlinedSrc, libSrc.replaceAll("export ", ""));
});

// A4: enumerated hosts, not a wildcard.
const accept = {
  "https://api.agenticcontrolplane.com": "https://api.agenticcontrolplane.com",
  "https://govern.agenticcontrolplane.com/": "https://govern.agenticcontrolplane.com",
  "https://cloud.agenticcontrolplane.com": "https://cloud.agenticcontrolplane.com",
  "HTTPS://API.AgenticControlPlane.com": "https://api.agenticcontrolplane.com",
  "  https://api.agenticcontrolplane.com  ": "https://api.agenticcontrolplane.com",
  "https://api.agenticcontrolplane.com:443": "https://api.agenticcontrolplane.com",
  // A3: origin only — path, query, fragment and parser quirks are dropped.
  "https://api.agenticcontrolplane.com/x?token=1#f": "https://api.agenticcontrolplane.com",
  "https://api.agenticcontrolplane.com/v1/": "https://api.agenticcontrolplane.com",
  "https://api.agenticcontrolplane.com\\@evil.com": "https://api.agenticcontrolplane.com",
};
const reject = [
  "http://api.agenticcontrolplane.com",
  "https://api.agenticcontrolplane.com:8443",
  "https://agenticcontrolplane.com",             // apex is the website, not a service
  "https://staging.agenticcontrolplane.com",     // not enumerated
  "https://a.b.agenticcontrolplane.com",
  "https://www.agenticcontrolplane.com",
  "https://evil.com",
  "https://agenticcontrolplane.com.evil.com",
  "https://evilagenticcontrolplane.com",
  "https://api.agenticcontrolplane.com@evil.com",
  "https://evil.com@api.agenticcontrolplane.com",
  "https://user:pw@api.agenticcontrolplane.com",
  "https://evil.com/.agenticcontrolplane.com",
  "https://evil.com?x=.agenticcontrolplane.com",
  "https://evil.com#.agenticcontrolplane.com",
  "https://api.agenticcontrolplane.com.",
  "https://ａgenticcontrolplane.com.evil.com",
  "https://xn--agenticcontrolplane-9ib.com",
  "ftp://api.agenticcontrolplane.com",
  "javascript:alert(1)",
  "not a url",
  "//api.agenticcontrolplane.com",
  "https://",
  "http://localhost:8080",
  `http://${LOOPBACK}:1`,
  "http://[::1]:1",
];

for (const [name, mod] of [["lib", lib], ["inlined in govern.mjs", inlined]]) {
  const fn = mod.resolveAcpBase;
  test(`${name}: ACP_HOSTS is exactly api, govern and cloud`, () => {
    assert.deepEqual(mod.ACP_HOSTS, ["api.agenticcontrolplane.com", "govern.agenticcontrolplane.com", "cloud.agenticcontrolplane.com"]);
  });
  test(`${name}: allowlisted hosts accepted, origin only`, () => {
    for (const [u, want] of Object.entries(accept)) {
      const warns = [];
      assert.equal(fn(u, DEF, (...a) => warns.push(a)), want, u);
      assert.equal(warns.length, 0, `${u} should not warn`);
    }
  });
  test(`${name}: everything else falls back to the default and warns once`, () => {
    for (const u of reject) {
      const warns = [];
      assert.equal(fn(u, DEF, (...a) => warns.push(a)), DEF, u);
      assert.equal(warns.length, 1, `${u} should warn`);
    }
  });
  test(`${name}: unset or blank returns the default silently`, () => {
    for (const u of [undefined, null, 42, "", "   "]) {
      const warns = [];
      assert.equal(fn(u, DEF, (...a) => warns.push(a)), DEF);
      assert.equal(warns.length, 0);
    }
  });
  test(`${name}: the dev override file allows https anywhere and http on loopback only`, () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-dev-base-"));
    const file = join(dir, "dev_base_override");
    const read = (text) => { const w = []; writeFileSync(file, text); return [mod.readDevBaseOverride(file, (...a) => w.push(a)), w]; };
    try {
      assert.equal(mod.readDevBaseOverride(join(dir, "missing")), undefined);
      assert.deepEqual(read(""), [undefined, []]);
      assert.deepEqual(read("# only a comment\n\n"), [undefined, []]);
      assert.deepEqual(read(`http://${LOOPBACK}:8787\n`), [`http://${LOOPBACK}:8787`, []]);
      assert.deepEqual(read("# stub\n\n  http://localhost:8787/some/path?x=1 \n"), ["http://localhost:8787", []]);
      assert.deepEqual(read("http://[::1]:8787"), ["http://[::1]:8787", []]);
      assert.deepEqual(read("https://gw.corp.example/base/"), ["https://gw.corp.example", []]);
      for (const bad of ["http://gw.corp.example", "http://localhost.evil.com", "http://user:pw@localhost:1", "ftp://localhost", "not a url", "1"]) {
        const [got, w] = read(bad);
        assert.equal(got, undefined, bad);
        assert.equal(w.length, 1, `${bad} should warn`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

// End to end: the hook never sends the bearer to a poisoned base, ACP_SELF_HOST
// in the env changes nothing, and the dev override file is what reaches a stub.
test("govern.mjs: poisoned env bases get zero requests even with ACP_SELF_HOST=1; the dev file is honoured", async () => {
  const hits = [];
  const stub = http.createServer((req, res) => { hits.push(req.url); res.end("{}"); });
  await new Promise((r) => stub.listen(0, LOOPBACK, r));
  const base = `http://${LOOPBACK}:${stub.address().port}`;
  const run = (home, env) => new Promise((resolve) => {
    const c = spawn(process.execPath, [GOVERN], { env: { PATH: process.env.PATH, HOME: home, ACP_BEARER_TOKEN: "gsk_test_x", ACP_FIRST_ATTEMPT_MS: "300", ACP_RETRY_ATTEMPT_MS: "300", ...env } });
    let err = "";
    c.stderr.on("data", (d) => { err += d; });
    c.on("close", (code) => resolve({ code, err }));
    c.stdin.end(JSON.stringify({ session_id: "t", cwd: "/tmp", hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/tmp/x" } }));
  });
  const home = mkdtempSync(join(tmpdir(), "acp-base-e2e-"));
  try {
    for (const env of [
      { ACP_GOVERN_BASE: base },
      { ACP_API_BASE: base },
      { ACP_SELF_HOST: "1", ACP_GOVERN_BASE: base },
      { ACP_SELF_HOST: "1", ACP_API_BASE: base, ACP_GOVERN_BASE: base },
      { ACP_GOVERN_BASE: `https://${LOOPBACK}:${stub.address().port}` },
    ]) {
      const r = await run(home, env);
      assert.equal(hits.length, 0, `${JSON.stringify(env)}: poisoned host must receive nothing`);
      assert.equal((r.err.match(/ignoring ACP_API_BASE\/ACP_GOVERN_BASE\/ACP_CONSOLE_BASE override/g) || []).length, 1, `exactly one warning: ${r.err}`);
      assert.doesNotMatch(r.err, /dev override active/);
      assert.equal(typeof r.code, "number", "hook exited on its own");
    }
    // The dev override file (under HOME) is the only way to a loopback stub.
    mkdirSync(join(home, ".acp"), { recursive: true });
    writeFileSync(join(home, ".acp", "dev_base_override"), `# test stub\n${base}\n`);
    const r = await run(home, {});
    assert.ok(hits.length > 0, "the dev override must reach the loopback stub");
    assert.match(r.err, /\[ACP\] dev override active: gateway base is http:\/\/127\.0\.0\.1:\d+/);
    assert.doesNotMatch(r.err, /ignoring ACP_API_BASE/);
    // With the file present the gateway env vars are not consulted at all.
    hits.length = 0;
    const r2 = await run(home, { ACP_GOVERN_BASE: "https://evil.com", ACP_API_BASE: "https://evil.com" });
    assert.ok(hits.length > 0, "the dev override still wins");
    assert.doesNotMatch(r2.err, /ignoring ACP_API_BASE/);
    assert.match(r2.err, /dev override active/);
  } finally { stub.close(); rmSync(home, { recursive: true, force: true }); }
});

// A2: the console base is printed in the enrolment hint ("open <console>/plugin/authorize,
// then paste your API key"), so a poisoned ACP_CONSOLE_BASE is a phishing link.
test("govern.mjs: a poisoned ACP_CONSOLE_BASE never reaches the enrolment hint", () => {
  const home = mkdtempSync(join(tmpdir(), "acp-console-e2e-"));
  try {
    const run = (env) => spawnSync(process.execPath, [GOVERN], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" }, hook_event_name: "PreToolUse", session_id: "s1" }),
      encoding: "utf8", timeout: 15000,
      env: { HOME: home, PATH: process.env.PATH, ACP_REQUIRE_ENROLLMENT: "1", ...env },
    });
    for (const bad of ["https://evil.com", "https://cloud.agenticcontrolplane.com.evil.com", "http://cloud.agenticcontrolplane.com", "https://cloud.agenticcontrolplane.com@evil.com"]) {
      const r = run({ ACP_CONSOLE_BASE: bad });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /open https:\/\/cloud\.agenticcontrolplane\.com\/plugin\/authorize/, bad);
      assert.doesNotMatch(r.stdout, /evil\.com|http:\/\/cloud/);
      assert.match(r.stderr, /ignoring ACP_API_BASE\/ACP_GOVERN_BASE\/ACP_CONSOLE_BASE override/);
    }
    // A path on an allowlisted console host is dropped too (A3).
    const ok = run({ ACP_CONSOLE_BASE: "https://cloud.agenticcontrolplane.com/evil/" });
    assert.match(ok.stdout, /open https:\/\/cloud\.agenticcontrolplane\.com\/plugin\/authorize/);
    assert.doesNotMatch(ok.stderr, /ignoring/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("govern.mjs reads ACP_CONSOLE_BASE only through resolveAcpBase", () => {
  const src = readFileSync(GOVERN, "utf8");
  const uses = src.match(/process\.env\.ACP_CONSOLE_BASE/g) || [];
  assert.equal(uses.length, 1);
  assert.match(src, /const ACP_CONSOLE = resolveAcpBase\(\s*process\.env\.ACP_CONSOLE_BASE, "https:\/\/cloud\.agenticcontrolplane\.com"/);
  assert.doesNotMatch(src, /ACP_SELF_HOST/);
});
