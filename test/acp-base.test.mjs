// claude-code-acp-plugin#26 — gateway base-URL allowlist.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { resolveAcpBase as libResolve } from "../lib/acp-base.mjs";

const GOVERN = fileURLToPath(new URL("../bin/govern.mjs", import.meta.url));
const src = readFileSync(GOVERN, "utf8");
const inlined = src.slice(src.indexOf("// acp-base:begin"), src.indexOf("// acp-base:end"));
const inlineResolve = new Function(`${inlined}\nreturn resolveAcpBase;`)();

const DEF = "https://api.agenticcontrolplane.com";
const accept = [
  "https://api.agenticcontrolplane.com",
  "https://govern.agenticcontrolplane.com/",
  "https://agenticcontrolplane.com",
  "HTTPS://API.AgenticControlPlane.com",
  "https://a.b.agenticcontrolplane.com:8443/x",
];
const reject = [
  "http://api.agenticcontrolplane.com",
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
  "https://agenticcontrolplane.com..",
  "https://ａgenticcontrolplane.com.evil.com",
  "https://xn--agenticcontrolplane-9ib.com",
  "ftp://api.agenticcontrolplane.com",
  "javascript:alert(1)",
  "not a url",
  "//evil.com",
  "https://",
  "http://localhost:8080",
  "http://127.0.0.1:1",
];

for (const [name, fn] of [["lib", libResolve], ["inlined in govern.mjs", inlineResolve]]) {
  test(`${name}: allowlisted hosts accepted`, () => {
    for (const u of accept) {
      const warns = [];
      const got = fn(u, DEF, {}, (...a) => warns.push(a));
      assert.equal(warns.length, 0, `${u} should not warn`);
      assert.ok(got.startsWith("https://") || got.startsWith("HTTPS://") || got === DEF, u);
    }
    assert.equal(fn("https://govern.agenticcontrolplane.com/", DEF, {}), "https://govern.agenticcontrolplane.com");
    // WHATWG parsing treats "\\" as "/": the host is still ours, and the returned
    // value is the normalized origin+path, never the raw string.
    assert.equal(fn("https://api.agenticcontrolplane.com\\@evil.com", DEF, {}), "https://api.agenticcontrolplane.com/@evil.com");
    assert.equal(fn("https://api.agenticcontrolplane.com/x?token=1#f", DEF, {}), "https://api.agenticcontrolplane.com/x");
  });
  test(`${name}: everything else falls back to the default and warns`, () => {
    for (const u of reject) {
      const warns = [];
      assert.equal(fn(u, DEF, {}, (...a) => warns.push(a)), DEF, u);
      assert.equal(warns.length, 1, `${u} should warn`);
    }
  });
  test(`${name}: unset or blank returns the default silently`, () => {
    for (const u of [undefined, "", "   "]) {
      const warns = [];
      assert.equal(fn(u, DEF, {}, (...a) => warns.push(a)), DEF);
      assert.equal(warns.length, 0);
    }
  });
  test(`${name}: ACP_SELF_HOST=1 allows any https host and http only on loopback`, () => {
    const env = { ACP_SELF_HOST: "1" };
    assert.equal(fn("https://gw.corp.example/", DEF, env), "https://gw.corp.example");
    assert.equal(fn("http://localhost:8787", DEF, env), "http://localhost:8787");
    assert.equal(fn("http://127.0.0.1:8787", DEF, env), "http://127.0.0.1:8787");
    assert.equal(fn("http://[::1]:8787", DEF, env), "http://[::1]:8787");
    for (const u of ["http://gw.corp.example", "http://localhost.evil.com", "http://localhost@evil.com", "http://user:pw@localhost"]) {
      assert.equal(fn(u, DEF, env, () => {}), DEF, u);
    }
    // only the literal "1" opts in
    assert.equal(fn("https://gw.corp.example", DEF, { ACP_SELF_HOST: "true" }, () => {}), DEF);
  });
}

test("govern.mjs never sends the bearer to a poisoned base, and still fails open", async () => {
  const hits = [];
  const evil = http.createServer((req, res) => { hits.push(req.url); res.end("{}"); });
  await new Promise((r) => evil.listen(0, "127.0.0.1", r));
  const port = evil.address().port;
  const run = (env) => new Promise((resolve) => {
    const c = spawn("node", [GOVERN], { env: { PATH: process.env.PATH, HOME: "/nonexistent-acp-home", ACP_BEARER_TOKEN: "gsk_test_x", ACP_FIRST_ATTEMPT_MS: "300", ACP_RETRY_ATTEMPT_MS: "300", ...env } });
    let err = "";
    c.stderr.on("data", (d) => { err += d; });
    c.on("close", (code) => resolve({ code, err }));
    c.stdin.end(JSON.stringify({ session_id: "t", cwd: "/tmp", hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/tmp/x" } }));
  });
  try {
    for (const key of ["ACP_GOVERN_BASE", "ACP_API_BASE"]) {
      const r = await run({ [key]: `http://127.0.0.1:${port}` });
      assert.equal(hits.length, 0, `${key}: poisoned host must receive nothing`);
      assert.match(r.err, /ignoring ACP_API_BASE\/ACP_GOVERN_BASE override/);
      assert.equal((r.err.match(/ignoring ACP_API_BASE/g) || []).length, 1, "exactly one warning");
      assert.ok(r.code === 0 || r.code === 2 || r.code === null || typeof r.code === "number");
    }
    // with the opt-in the stub IS reached (proves the test would catch a regression)
    await run({ ACP_SELF_HOST: "1", ACP_GOVERN_BASE: `http://127.0.0.1:${port}` });
    assert.ok(hits.length > 0, "ACP_SELF_HOST=1 must reach the loopback stub");
  } finally { evil.close(); }
});
