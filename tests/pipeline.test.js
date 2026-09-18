"use strict";
// Tests exercise the pure pipeline stages against synthetic records, so they
// run anywhere (the macOS collectors are covered separately by manual runs on a
// Mac). Run with: npm run build && node --test tests/
const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");

const { dedupe } = require("../dist/dedup");
const { linkHostApps } = require("../dist/linking");
const { applyCatalog } = require("../dist/catalog");
const { buildPayload, buildUrl } = require("../dist/shadowReport");
const { renderJson } = require("../dist/report");

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
    bundleId: "com.todesktop.cursor",
    identified: true,
  });
  const s1 = comp({
    name: "github",
    installMethod: "mcp_config",
    path: "/Users/nobody/.cursor/mcp.json",
    hostApp: "Cursor (~/.cursor/mcp.json)",
    identified: true,
  });
  const s2 = comp({
    name: "filesystem",
    installMethod: "mcp_config",
    path: "/Users/nobody/.cursor/mcp.json",
    // distinct path key so dedup keeps them separate
    sourceRefs: ["mcp_config:2"],
    hostApp: "Cursor (~/.cursor/mcp.json)",
    identified: true,
  });
  // Give the two servers distinct dedup keys (name+method differ by name).
  const all = [app, s1, s2];
  linkHostApps(all);

  assert.equal(all.length, 3, "app + two servers = three components");
  assert.equal(s1.hostApp, "com.todesktop.cursor", "server resolves to host id");
  assert.equal(s2.hostApp, "com.todesktop.cursor", "server resolves to host id");
  assert.ok(
    (app.relatedComponents || []).length === 2,
    "host lists both servers"
  );
});

test("catalog labels an unidentified component and skips identified ones", () => {
  const stranger = comp({
    name: "weird-daemon",
    installMethod: "launch_item",
    path: "/usr/local/bin/openclaw-runner",
    identified: false,
  });
  const known = comp({
    name: "already",
    installMethod: "brew",
    path: "/opt/homebrew/opt/openclaw-lib", // also contains "openclaw"
    publisher: "homebrew tap x/y",
    identified: true,
  });
  const entries = [
    {
      match: { bundleId: null, pathContains: "openclaw", nameExact: null },
      identity: { displayName: "OpenClaw", publisher: "example" },
      declaredCapabilities: [],
    },
  ];
  applyCatalog([stranger, known], entries);
  assert.equal(stranger.identified, true, "stranger identified via catalog");
  assert.equal(stranger.name, "OpenClaw");
  assert.equal(
    known.name,
    "already",
    "already-identified component untouched by catalog"
  );
});

test("catalog with an all-null match block matches nothing", () => {
  const c = comp({ name: "anything", path: "/tmp/anything", identified: false });
  applyCatalog(
    [c],
    [{ match: { bundleId: null, pathContains: null, nameExact: null }, identity: { displayName: "Nope" } }]
  );
  assert.equal(c.identified, false);
  assert.equal(c.name, "anything");
});

test("shadow payload never contains $HOME or the username; one hash per title", () => {
  const home = os.homedir();
  const username = path.basename(home);
  const c = comp({
    name: "mystery",
    installMethod: "launch_item",
    path: path.join(home, "Library/Weird/mystery-bin"),
    identified: false,
  });
  const payload = buildPayload(c);
  const url = buildUrl(payload);

  assert.ok(payload.fingerprint_hash.length === 64, "sha-256 hex hash present");
  assert.ok(payload.match_path.startsWith("~"), "home replaced with ~");
  assert.ok(!payload.match_path.includes(home), "no literal home path");
  if (username && username !== "~") {
    // The generalized path must not leak the username component of $HOME.
    assert.ok(
      !JSON.stringify(payload).includes(home),
      "payload has no literal $HOME anywhere"
    );
  }

  // Title carries exactly one fingerprint hash. Parse via URL so the query
  // encoding (including "+" for space) is decoded the way GitHub decodes it.
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
