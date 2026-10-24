// Preloaded (NODE_OPTIONS --import) into every process a test spawns, via
// _dev-base.mjs. A hook under test may only talk to a loopback stub: any other
// host fails like a network error. Without this, a spawn that forgot the
// dev-base override fell back to the production gateway, and CI sent
// gsk_test_* calls to govern.agenticcontrolplane.com (2026-10-24).
const LOOPBACK = new Set(["localhost", ["127", "0", "0", "1"].join("."), "[::1]", "::1"]);
const realFetch = globalThis.fetch;
if (typeof realFetch === "function" && !globalThis.__acpNoProdFetch) {
  globalThis.__acpNoProdFetch = true;
  globalThis.fetch = (input, init) => {
    let host = "";
    try { host = new URL(typeof input === "string" || input instanceof URL ? input : input.url).hostname; } catch { /* let fetch reject it */ }
    if (host && !LOOPBACK.has(host)) {
      return Promise.reject(new TypeError(`fetch blocked in tests: ${host} is not loopback`));
    }
    return realFetch(input, init);
  };
}
