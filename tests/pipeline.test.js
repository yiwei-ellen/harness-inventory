"use strict";
// Tests exercise the pure pipeline stages against synthetic records, so they
// run anywhere (the macOS collectors are covered separately by manual runs on a
// Mac). Run with: npm run build && node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");

const { dedupe } = require("../dist/dedup");
const { linkHostApps } = require("../dist/linking");
const {
  loadCatalog,
  defaultCatalogPath,
  isInScope,
  matchAgent,
  applyAgentIdentity,
} = require("../dist/catalog");
const { buildPayload, buildUrl } = require("../dist/shadowReport");
const { renderJson, renderTable } = require("../dist/report");

const CATALOG = loadCatalog(defaultCatalogPath());

function comp(over) {
  return Object.assign(
    {
      name: "x",
      installMethod: "app_bundle",
      path: "/x",
      platform: "macos",
      signingStatus: "unknown",
      firstSeen: "2026-01-01T00:00:00.000Z",
      sourceRefs: [],
      identified: false,
    },
    over
  );
}

test("dedup merges a component found via multiple sources into one row", () => {
  const a = comp({
    name: "goose",
    installMethod: "brew",
    path: "/opt/homebrew/opt/goose",
    sourceRefs: ["brew:formula:goose"],
    identified: true,
  });
  const b = comp({
    name: "goose",
    installMethod: "launch_item",
    path: "/opt/homebrew/opt/goose",
    sourceRefs: ["launch_item:/Library/LaunchAgents/goose.plist"],
  });
  const out = dedupe([a, b]);
  assert.equal(out.length, 1, "same path dedups to one");
  assert.deepEqual(
    out[0].sourceRefs.sort(),
    ["brew:formula:goose", "launch_item:/Library/LaunchAgents/goose.plist"].sort(),
    "provenance from both sources preserved"
  );
});

test("host app with two MCP servers produces three linked components", () => {
  const app = comp({
    name: "Cursor",
    installMethod: "app_bundle",
    path: "/Applications/Cursor.app",
    bundleId: "com.todesktop.230313mzl4w4u92",
    identified: true,
  });
  const s1 = comp({
    name: "github",
    installMethod: "mcp_config",
    path: "/Users/nobody/.cursor/mcp.json",
    sourceRefs: ["mcp_config:1"],
    hostApp: "Cursor (~/.cursor/mcp.json)",
    identified: true,
  });
  const s2 = comp({
    name: "filesystem",
    installMethod: "mcp_config",
    path: "/Users/nobody/.cursor/mcp.json",
    sourceRefs: ["mcp_config:2"],
    hostApp: "Cursor (~/.cursor/mcp.json)",
    identified: true,
  });
  const all = [app, s1, s2];
  linkHostApps(all);

  assert.equal(all.length, 3, "app + two servers = three components");
  assert.equal(s1.hostApp, "com.todesktop.230313mzl4w4u92");
  assert.equal(s2.hostApp, "com.todesktop.230313mzl4w4u92");
  assert.equal((app.relatedComponents || []).length, 2, "host lists both servers");
});

test("agent allowlist matches known agents and rejects ordinary apps", () => {
  assert.ok(matchAgent(comp({ name: "Claude" }), CATALOG), "Claude matches");
  assert.ok(matchAgent(comp({ name: "Ollama" }), CATALOG), "Ollama matches");
  assert.equal(matchAgent(comp({ name: "Google Chrome" }), CATALOG), undefined);
  assert.equal(matchAgent(comp({ name: "Safari" }), CATALOG), undefined);
  // The generic "agent" allowlist name must match only an exact name, never a
  // reverse-DNS label like Google's keystone.agent.
  assert.equal(
    matchAgent(comp({ name: "com.google.keystone.agent" }), CATALOG),
    undefined,
    "keystone.agent is not swept in by the generic 'agent' entry"
  );
});

test("scope filter keeps only agents + MCP servers (real-machine sample)", () => {
  // Mirrors the components a real scan produced; only Claude is an agent.
  const sample = [
    comp({ name: "ClashX" }),
    comp({ name: "Claude" }),
    comp({ name: "Google Chrome" }),
    comp({ name: "Granola" }),
    comp({ name: "Microsoft Edge" }),
    comp({ name: "Notion" }),
    comp({ name: "Safari" }),
    comp({ name: "Steam" }),
    comp({ name: "Code" }),
    comp({ name: "WeChat" }),
    comp({ name: "Wispr Flow" }),
    comp({ name: "WorkBuddy AI" }),
    comp({ name: "zoom.us" }),
    comp({ name: "Slay the Spire 2" }),
    comp({ name: "com.google.GoogleUpdater.wake", installMethod: "launch_item" }),
    comp({ name: "com.google.keystone.agent", installMethod: "launch_item" }),
    comp({ name: "com.microsoft.EdgeUpdater.wake", installMethod: "launch_item" }),
    comp({ name: "com.valvesoftware.steamclean", installMethod: "launch_item" }),
    comp({ name: "com.west2online.ClashX.ProxyConfigHelper", installMethod: "launch_item" }),
    comp({ name: "corepack", installMethod: "npm" }),
    comp({ name: "npm", installMethod: "npm" }),
    comp({ name: "us.zoom.ZoomDaemon", installMethod: "launch_item" }),
    comp({ name: "Wispr Flow", installMethod: "launch_item" }),
  ];
  const kept = sample.filter((c) => isInScope(c, CATALOG)).map((c) => c.name);
  assert.deepEqual(kept, ["Claude"], "only the AI agent survives the filter");
});

test("MCP servers stay in scope; unknown ones are unidentified, known ones identified", () => {
  const unknown = comp({
    name: "some-random-mcp",
    installMethod: "mcp_config",
    path: "/Users/nobody/.cursor/mcp.json",
  });
  const known = comp({
    name: "ollama",
    installMethod: "mcp_config",
    path: "/Users/nobody/.cursor/mcp.json",
  });
  assert.ok(isInScope(unknown, CATALOG), "any MCP server is in scope");
  assert.ok(isInScope(known, CATALOG));
  assert.equal(matchAgent(unknown, CATALOG), undefined, "unknown MCP has no catalog identity");
  const entry = matchAgent(known, CATALOG);
  assert.ok(entry, "known MCP matches the catalog");
  applyAgentIdentity(known, entry);
  assert.equal(known.identified, true);
  assert.equal(known.name, "Ollama");
});

test("table shows a BINARY column and strips control chars from names", () => {
  const c = comp({
    name: "evil[31m\nFAKE",
    binaryName: "claude",
    installMethod: "app_bundle",
    identified: true,
  });
  const table = renderTable([c]);
  assert.ok(table.includes("BINARY"), "BINARY column header present");
  assert.ok(table.includes("claude"), "binary name rendered");
  assert.ok(!table.includes(""), "no ESC character reaches the terminal");
  const bodyLines = table.split("\n").filter((l) => /evil|FAKE/.test(l));
  assert.equal(bodyLines.length, 1, "crafted name stays on one row");
});

test("shadow payload never contains $HOME or the username; one hash per title", () => {
  const home = os.homedir();
  const c = comp({
    name: "mystery",
    installMethod: "mcp_config",
    path: path.join(home, "Library/Weird/mystery-bin"),
    identified: false,
  });
  const payload = buildPayload(c);
  const url = buildUrl(payload);

  assert.ok(payload.fingerprint_hash.length === 64, "sha-256 hex hash present");
  assert.ok(payload.match_path.startsWith("~"), "home replaced with ~");
  assert.ok(!JSON.stringify(payload).includes(home), "payload has no literal $HOME");

  const title = new URL(url).searchParams.get("title");
  assert.ok(title.startsWith(`[shadow-agent] ${payload.fingerprint_hash}`));
  const hashOccurrences = title.split(payload.fingerprint_hash).length - 1;
  assert.equal(hashOccurrences, 1, "exactly one hash in the title");
});

test("renderJson generalizes paths so no username leaks to JSON output", () => {
  const home = os.homedir();
  const c = comp({
    name: "z",
    path: path.join(home, "Applications/Z.app"),
    identified: true,
  });
  const json = renderJson([c]);
  assert.ok(!json.includes(home), "no literal home path in JSON output");
  assert.ok(json.includes("~/Applications/Z.app"));
});
