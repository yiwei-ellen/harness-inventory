"use strict";
// Tests for catalog v2, the new sources, and the new report sections. Pure
// functions are tested directly; the end-to-end test runs the built CLI
// against a simulated Mac home directory (tests/fixtures/fakeHome.js), so the
// whole suite runs anywhere. Run with: npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { stripJsonc, parseJsonc, parseCodexMcpServers, describeServer, launchedPackage } = require("../dist/mcpParse");
const { parseTeamId } = require("../dist/signing");
const { applyCatalog, checkPublishers, publisherCheckFor, detectMatches, catalogCliNames, loadCatalog, suggestTeamIds } = require("../dist/catalog");
const { absorbClis, linkHostApps, linkBrowserBridges } = require("../dist/linking");
const { parsePs, childrenOf, processLabel, ownPids } = require("../dist/sources/processes");
const { parseTccRows, applyPermissions } = require("../dist/permissions");
const { agentRelated, renderTable, mcpLine, formatBytes } = require("../dist/report");
const { measure } = require("../dist/footprint");
const { dedupe } = require("../dist/dedup");
const { makeFakeHome } = require("./fixtures/fakeHome");

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

// --- MCP config parsing ------------------------------------------------------

test("JSONC: comments and trailing commas removed, // inside strings kept", () => {
  const text = '{\n // c\n "a": "https://x.example//p", /* b */ "b": [1,2,],\n}';
  const parsed = parseJsonc(text);
  assert.deepEqual(parsed, { a: "https://x.example//p", b: [1, 2] });
  assert.ok(stripJsonc('"/* not a comment */"').includes("/* not a comment */"));
  assert.equal(parseJsonc("{not json"), null);
});

test("Codex TOML: server tables, env sub-table + inline env keys, multi-line args", () => {
  const toml = [
    'model = "gpt-5" # comment',
    "[mcp_servers.a]",
    'command = "npx"',
    'args = [',
    '  "-y", # flag',
    '  "pkg@1",',
    "]",
    "[mcp_servers.a.env]",
    'TOKEN = "secret"',
    '[mcp_servers."b.c"]',
    'url = "https://h.example/mcp"',
    "enabled = false",
    "[mcp_servers.d]",
    'command = "/bin/d"',
    'env = { K1 = "v, with comma", "K2" = "v" }',
    "[profiles.x]",
    'command = "ignored"',
  ].join("\n");
  const s = parseCodexMcpServers(toml);
  assert.deepEqual(Object.keys(s).sort(), ["a", "b.c", "d"]);
  assert.deepEqual(s.a.args, ["-y", "pkg@1"]);
  assert.deepEqual(Object.keys(s.a.env), ["TOKEN"]);
  assert.equal(s.a.env.TOKEN, "", "env values are never kept");
  assert.equal(s["b.c"].enabled, false);
  assert.deepEqual(Object.keys(s.d.env).sort(), ["K1", "K2"]);
});

test("describeServer keeps names, drops values, full URLs and args", () => {
  const d = describeServer({
    command: "npx",
    args: ["-y", "@scope/server@2.0.0", "--token", "SECRET-arg"],
    env: { B_KEY: "SECRET-1", A_KEY: "SECRET-2" },
  });
  assert.equal(d.transport, "stdio");
  assert.equal(d.launches, "@scope/server");
  assert.deepEqual(d.envKeys, ["A_KEY", "B_KEY"]);
  assert.ok(!JSON.stringify(d).includes("SECRET"));

  const h = describeServer({ url: "https://mcp.example.com:8443/sse?token=SECRET", headers: { Authorization: "SECRET" } });
  assert.equal(h.transport, "http");
  assert.equal(h.urlHost, "mcp.example.com:8443");
  assert.deepEqual(h.envKeys, ["header:Authorization"]);
  assert.ok(!JSON.stringify(h).includes("SECRET"));

  assert.equal(describeServer({ command: "x", disabled: true }).enabled, false);
});

test("launchedPackage: npx, uvx, pnpm dlx, docker run with value flags", () => {
  assert.equal(launchedPackage("npx", ["-y", "pkg@latest"]), "pkg");
  assert.equal(launchedPackage("uvx", ["mcp-server-git==1.0"]), "mcp-server-git");
  assert.equal(launchedPackage("pnpm", ["dlx", "@a/b@1"]), "@a/b");
  assert.equal(launchedPackage("docker", ["run", "-i", "--rm", "-e", "PGPASSWORD", "-v", "/x:/y", "mcp/pg:latest", "arg"]), "mcp/pg:latest");
  assert.equal(launchedPackage("node", ["server.js"]), undefined);
});

// --- Signing + catalog -------------------------------------------------------

test("parseTeamId accepts 10-char team IDs and ignores 'not set'", () => {
  assert.equal(parseTeamId("Identifier=x\nTeamIdentifier=Q6L2SF6YDW\n"), "Q6L2SF6YDW");
  assert.equal(parseTeamId("TeamIdentifier=not set"), undefined);
  assert.equal(parseTeamId("nothing"), undefined);
});

test("publisher check: matches, differs, no record, not applicable", () => {
  assert.equal(publisherCheckFor("Q6L2SF6YDW", ["Q6L2SF6YDW"]), "matches_catalog");
  assert.equal(publisherCheckFor("q6l2sf6ydw", ["Q6L2SF6YDW"]), "matches_catalog");
  assert.equal(publisherCheckFor("AAAAAAAAAA", ["Q6L2SF6YDW"]), "differs_from_catalog");
  assert.equal(publisherCheckFor("AAAAAAAAAA", []), "no_catalog_record");
  assert.equal(publisherCheckFor(undefined, ["Q6L2SF6YDW"]), "not_applicable");
});

test("detect identifiers are scoped to their install method", () => {
  const d = { cliNames: ["claude"], npmPackages: ["@modelcontextprotocol/server-*"], brewNames: ["opencode"], pipPackages: ["Open_Interpreter"] };
  // An npm package that happens to be named "claude" is not the CLI.
  assert.equal(detectMatches(comp({ name: "claude", installMethod: "npm" }), d), false);
  assert.equal(detectMatches(comp({ name: "claude", installMethod: "cli_on_path" }), d), true);
  assert.equal(detectMatches(comp({ name: "@modelcontextprotocol/server-github", installMethod: "npm" }), d), true);
  assert.equal(detectMatches(comp({ name: "@modelcontextprotocol/sdk", installMethod: "npm" }), d), false);
  assert.equal(detectMatches(comp({ name: "OpenCode", installMethod: "brew", sourceRefs: ["brew:formula:sst/tap/opencode"] }), d), true);
  assert.equal(detectMatches(comp({ name: "open-interpreter", installMethod: "pip" }), d), true);
  // An app named "claude" doesn't match cliNames.
  assert.equal(detectMatches(comp({ name: "claude", installMethod: "app_bundle" }), d), false);
});

test("catalog tags identified apps without renaming; always names PATH CLIs", () => {
  const entries = [
    { id: "a.app", kind: "desktop-app", identity: { displayName: "Claude", publisher: "Anthropic" }, detect: { bundleIds: ["com.anthropic.claudefordesktop"] }, signing: { teamIds: ["Q6L2SF6YDW"] } },
    { id: "a.cli", kind: "cli", identity: { displayName: "Claude Code", publisher: "Anthropic" }, detect: { cliNames: ["claude"] }, signing: { teamIds: ["Q6L2SF6YDW"] } },
  ];
  const app = comp({ name: "Claude (Beta)", bundleId: "com.anthropic.claudefordesktop", identified: true, teamId: "Q6L2SF6YDW" });
  const cli = comp({ name: "claude", installMethod: "cli_on_path", path: "/u/.local/share/claude/versions/2", publisher: "Developer ID Application: Someone Else (ZZZZZZZZZZ)", teamId: "ZZZZZZZZZZ", identified: true });
  applyCatalog([app, cli], entries);
  checkPublishers([app, cli], entries);

  assert.equal(app.name, "Claude (Beta)", "identified app keeps its own name");
  assert.equal(app.agent.catalogId, "a.app");
  assert.equal(app.publisherCheck, "matches_catalog");
  assert.equal(cli.name, "Claude Code", "PATH CLI takes the catalog name");
  assert.equal(cli.publisher, "Developer ID Application: Someone Else (ZZZZZZZZZZ)", "catalog never overwrites a signing publisher");
  assert.equal(cli.publisherCheck, "differs_from_catalog");

  const sugg = suggestTeamIds([app, cli], entries);
  assert.equal(sugg.length, 1);
  assert.equal(sugg[0].observedTeamId, "ZZZZZZZZZZ");
});

test("shipped catalog loads, ids are unique, CLI names are plain file names", () => {
  const entries = loadCatalog(path.join(__dirname, "..", "catalog", "known-agents.json"));
  assert.ok(entries.length >= 30);
  const ids = entries.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "catalog ids are unique");
  for (const n of catalogCliNames(entries)) assert.ok(!n.includes("/"));
  for (const e of entries) {
    for (const t of (e.signing && e.signing.teamIds) || []) {
      assert.match(t, /^[A-Z0-9]{10}$/, `${e.id} team id format`);
    }
    for (const dp of e.dataPaths || []) {
      assert.ok(dp.path.startsWith("~/") || dp.path.startsWith("/"), `${e.id} data path is absolute or ~`);
    }
  }
});

// --- Linking -------------------------------------------------------------------

test("a CLI resolving into a package folds into it; into an app keeps the app path", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-absorb-"));
  const pkg = path.join(tmp, "lib/node_modules/@openai/codex");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  const script = path.join(pkg, "bin/codex.js");
  fs.writeFileSync(script, "");
  const npm = comp({ name: "@openai/codex", installMethod: "npm", path: pkg, identified: true, sourceRefs: ["npm:@openai/codex"] });
  const cli = comp({ name: "codex", installMethod: "cli_on_path", path: script, sourceRefs: ["cli:codex"] });
  const app = comp({ name: "Ollama", installMethod: "app_bundle", path: "/Applications/Ollama.app", bundleId: "com.electron.ollama" });
  const cli2 = comp({ name: "ollama", installMethod: "cli_on_path", path: "/Applications/Ollama.app/Contents/Resources/ollama", sourceRefs: ["cli:ollama"] });

  const out = absorbClis([npm, cli, app, cli2]);
  assert.equal(out.length, 2);
  assert.equal(npm.executablePath, script);
  assert.ok(npm.sourceRefs.includes("cli:codex"));
  assert.equal(app.executablePath, undefined, "an app keeps its own path for signing");
  assert.ok(app.sourceRefs.includes("cli:ollama"));
});

test("MCP servers link to their client by catalog id, not by name substring", () => {
  const desktop = comp({ name: "Claude", installMethod: "app_bundle", path: "/Applications/Claude.app", bundleId: "com.anthropic.claudefordesktop", identified: true, agent: { catalogId: "anthropic.claude-desktop", kind: "desktop-app", displayName: "Claude" } });
  const code = comp({ name: "Claude Code", installMethod: "cli_on_path", path: "/u/.local/share/claude/versions/2", identified: true, agent: { catalogId: "anthropic.claude-code", kind: "cli", displayName: "Claude Code" } });
  const server = comp({ name: "sentry", installMethod: "mcp_config", path: "/u/.claude.json", hostApp: "Claude Code (~/.claude.json)", identified: true, sourceRefs: ["mcp_config:/u/.claude.json"], mcp: { transport: "http", clientId: "anthropic.claude-code" } });
  const orphan = comp({ name: "x", installMethod: "mcp_config", path: "/u/.codex/config.toml", hostApp: "Codex (~/.codex/config.toml)", identified: true, sourceRefs: ["mcp_config:/u/.codex/config.toml"], mcp: { transport: "stdio", clientId: "openai.codex-cli" } });
  linkHostApps([desktop, code, server, orphan]);
  assert.ok((code.relatedComponents || []).length === 1, "linked under Claude Code");
  assert.equal(desktop.relatedComponents, undefined, "not under the Claude app");
  assert.equal(orphan.hostApp, "Codex (~/.codex/config.toml)", "client not installed: raw string stays");
});

test("browser bridge: app -> native host -> allowed extension", () => {
  const app = comp({ name: "Claude", installMethod: "app_bundle", path: "/Applications/Claude.app", bundleId: "com.anthropic.claudefordesktop", identified: true });
  const host = comp({ name: "com.anthropic.claude_browser_extension", installMethod: "native_messaging_host", path: "/Applications/Claude.app/Contents/Helpers/chrome-native-host", browser: { browsers: ["Chrome"], extensionIds: ["abcdefghijklmnopabcdefghijklmnop"] } });
  const ext = comp({ name: "Claude", installMethod: "browser_extension", path: "/p/ext", bundleId: "chrome-extension:abcdefghijklmnopabcdefghijklmnop", identified: true, browser: { browsers: ["Chrome"], extensionIds: ["abcdefghijklmnopabcdefghijklmnop"] } });
  const other = comp({ name: "Dark Reader", installMethod: "browser_extension", path: "/p/ext2", bundleId: "chrome-extension:ponmlkjihgfedcbaponmlkjihgfedcba", identified: true, browser: { browsers: ["Chrome"], extensionIds: ["ponmlkjihgfedcbaponmlkjihgfedcba"] } });
  linkBrowserBridges([app, host, ext, other]);
  assert.equal(app.relatedComponents.length, 1);
  assert.equal(host.relatedComponents.length, 1);
  assert.equal(host.relatedComponents[0], "chrome-extension:abcdefghijklmnopabcdefghijklmnop");
});

test("dedup merges one native host seen by two browsers, keeping both", () => {
  const a = comp({ name: "h", installMethod: "native_messaging_host", path: "/bin/h", sourceRefs: ["native_messaging_host:chrome"], browser: { browsers: ["Chrome"], extensionIds: ["a"] } });
  const b = comp({ name: "h", installMethod: "native_messaging_host", path: "/bin/h", sourceRefs: ["native_messaging_host:brave"], browser: { browsers: ["Brave"], extensionIds: ["a"] } });
  const out = dedupe([a, b]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].browser.browsers.sort(), ["Brave", "Chrome"]);
});

// --- Processes -------------------------------------------------------------------

test("running children: descendants that aren't the agent itself, labels drop trailing args", () => {
  const comm = [
    "  1     0 /sbin/launchd",
    "100     1 /Users/u/.local/share/claude/versions/2.0.0",
    "101   100 /bin/zsh",
    "102   101 /usr/bin/git",
    "103   100 /opt/homebrew/bin/node",
    "200     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].join("\n");
  const args = [
    "  1 /sbin/launchd",
    "100 claude --resume",
    "101 /bin/zsh -c git push origin main",
    "102 git push origin main --token SECRET",
    "103 node /Users/u/.npm/_npx/x/node_modules/@modelcontextprotocol/server-github/dist/index.js",
    "200 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --flag",
  ].join("\n");
  const running = parsePs(comm, args);
  assert.ok(running.paths.has("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), "comm with spaces parsed");

  const agent = comp({ name: "Claude Code", installMethod: "cli_on_path", path: "/Users/u/.local/share/claude/versions/2.0.0", agent: { catalogId: "x", kind: "cli", displayName: "Claude Code" } });
  assert.deepEqual(Array.from(ownPids(agent, running)), [100]);
  const { children, total } = childrenOf(agent, running);
  assert.equal(total, 3);
  const labels = children.map((c) => c.label);
  assert.ok(labels.includes("git push"), labels.join("|"));
  assert.ok(labels.includes("node @modelcontextprotocol/server-github"), labels.join("|"));
  assert.ok(!labels.join(" ").includes("SECRET"));
  assert.ok(!labels.join(" ").includes("origin"), "only the first positional argument is shown");
});

test("an npm CLI run by node is found through its package path in the args", () => {
  const running = parsePs(
    "10 1 /opt/homebrew/bin/node",
    "10 node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js exec"
  );
  const pkg = comp({ name: "@openai/codex", installMethod: "npm", path: "/opt/homebrew/lib/node_modules/@openai/codex" });
  const lookalike = comp({ name: "@openai/codex-x", installMethod: "npm", path: "/opt/homebrew/lib/node_modules/@openai/cod" });
  assert.equal(ownPids(pkg, running).size, 1);
  assert.equal(ownPids(lookalike, running).size, 0, "path prefix must end at a separator");
});

test("processLabel drops KEY=value first arguments", () => {
  assert.equal(processLabel({ pid: 1, ppid: 0, comm: "/usr/bin/env", args: "env TOKEN=SECRET cmd" }), "env");
});

// --- Permissions ---------------------------------------------------------------

test("TCC grants attach by bundle ID and path; CLI agents inherit terminal grants", () => {
  const rows = [
    "kTCCServiceAccessibility|com.openai.chat|0|2",
    "kTCCServiceScreenCapture|com.openai.chat|0|0", // denied
    "kTCCServiceSystemPolicyAllFiles|com.googlecode.iterm2|0|2",
    "kTCCServiceAccessibility|/Users/u/.local/share/claude/versions/2.0.0|1|2",
    "kTCCServiceUbiquity|com.openai.chat|0|2", // not reported
    "garbage line",
  ].join("\n");
  const grants = parseTccRows(rows);
  assert.equal(grants.length, 5);

  const chat = comp({ name: "ChatGPT", bundleId: "com.openai.chat", identified: true, agent: { catalogId: "openai.chatgpt", kind: "desktop-app", displayName: "ChatGPT" } });
  const cli = comp({ name: "Claude Code", installMethod: "cli_on_path", path: "/Users/u/.local/share/claude/versions/2.0.0", agent: { catalogId: "c", kind: "cli", displayName: "Claude Code" } });
  applyPermissions([chat, cli], grants);
  assert.deepEqual(chat.permissions, ["Accessibility (can control the computer)"]);
  assert.equal(chat.inheritedPermissions, undefined, "apps don't inherit terminal grants");
  assert.deepEqual(cli.permissions, ["Accessibility (can control the computer)"]);
  assert.deepEqual(cli.inheritedPermissions, [{ from: "iTerm2", permissions: ["Full Disk Access"] }]);
});

// --- Report ----------------------------------------------------------------------

test("default view: agents, MCP servers, strangers and their links; not every app", () => {
  const agent = comp({ name: "Claude", bundleId: "com.anthropic.claudefordesktop", identified: true, agent: { catalogId: "a", kind: "desktop-app", displayName: "Claude" }, relatedComponents: ["h"] });
  const host = comp({ name: "h", installMethod: "native_messaging_host", path: "h", identified: true });
  const safari = comp({ name: "Calculator", bundleId: "com.apple.calculator", identified: true });
  const stranger = comp({ name: "mystery", installMethod: "launch_item", path: "/opt/mystery" });
  const shown = agentRelated([agent, host, safari, stranger]);
  assert.ok(shown.has(agent) && shown.has(host) && shown.has(stranger));
  assert.ok(!shown.has(safari));

  const table = renderTable([agent, host, safari, stranger], { agentsOnly: true });
  assert.ok(!table.includes("Calculator"));
  assert.ok(table.includes("1 other app or package not shown"));
  assert.ok(renderTable([agent, host, safari, stranger]).includes("Calculator"), "renderTable(components) still lists everything");
});

test("mcpLine and formatBytes read plainly", () => {
  const s = comp({ name: "gh", installMethod: "mcp_config", mcp: { transport: "stdio", command: "npx", launches: "@x/gh", envKeys: ["GITHUB_TOKEN"], scope: "project ~/code/a", enabled: false } });
  assert.equal(mcpLine(s), "gh (stdio · npx @x/gh · passes GITHUB_TOKEN · project ~/code/a · disabled)");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(50 * 1024 * 1024), "50 MB");
});

test("footprint measurement never follows symlinks", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-fp-"));
  fs.mkdirSync(path.join(tmp, "d"));
  fs.writeFileSync(path.join(tmp, "d", "a"), "12345");
  const big = path.join(tmp, "big");
  fs.writeFileSync(big, "x".repeat(10000));
  fs.symlinkSync(big, path.join(tmp, "d", "link"));
  const m = measure(path.join(tmp, "d"));
  assert.equal(m.files, 1);
  assert.equal(m.bytes, 5);
  assert.equal(measure(path.join(tmp, "d", "link")), null);
});

// --- End to end ----------------------------------------------------------------

test("end to end against a simulated Mac home", () => {
  const { home } = makeFakeHome();
  const env = { HOME: home, PATH: "/usr/bin:/bin" };
  const cli = path.join(__dirname, "..", "dist", "index.js");
  const run = (args) =>
    execFileSync(process.execPath, [cli, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  const json = run(["scan", "--json"]);
  assert.ok(!json.includes("SECRET"), "no secret value from any config reaches JSON output");
  assert.ok(!json.includes(home), "no literal home path in JSON output");
  const comps = JSON.parse(json);
  const byName = (n) => comps.find((c) => c.name === n);

  const code = byName("Claude Code");
  assert.ok(code, "native Claude Code found on PATH");
  assert.equal(code.installMethod, "cli_on_path");
  assert.equal(code.agent.catalogId, "anthropic.claude-code");
  assert.equal(code.relatedComponents.length, 2, "user + project servers from ~/.claude.json");
  assert.ok(code.footprint.some((f) => f.kind === "transcripts" && f.files === 2));

  assert.equal(byName("postgres").mcp.launches, "mcp/postgres:latest");
  assert.equal(byName("postgres").mcp.scope, "project ~/code/app");
  assert.equal(byName("linear").mcp.urlHost, "mcp.linear.app");
  assert.equal(byName("Apple Notes").mcp.enabled, false);
  assert.deepEqual(byName("Apple Notes").mcp.tools, ["list_notes", "read_note", "create_note"]);
  assert.deepEqual(byName("fs").mcp.envKeys, ["API_KEY", "ROOT"]);
  assert.equal(byName("docs.remote").mcp.enabled, false);
  assert.equal(byName("playwright").mcp.launches, "@playwright/mcp");
  assert.equal(byName("fetch").mcp.urlHost, "fetch.example.com");

  const bridge = comps.find((c) => c.installMethod === "native_messaging_host");
  assert.equal(bridge.agent.catalogId, "anthropic.claude-browser-bridge");
  assert.deepEqual(bridge.browser.browsers.sort(), ["Brave", "Chrome"]);
  const ext = comps.find((c) => c.installMethod === "browser_extension" && c.agentRelated);
  assert.equal(ext.name, "Claude", "localized name from the newest version folder");
  assert.equal(ext.version, "1.0.10");
  assert.ok(ext.browser.permissions.includes("nativeMessaging"));
  assert.equal(comps.find((c) => c.name === "Dark Reader"), undefined, "ordinary extension left out of the scan");
  const all = JSON.parse(run(["scan", "--all", "--json"]));
  assert.equal(all.find((c) => c.name === "Dark Reader").agentRelated, false, "--all keeps it, flagged");

  const text = run(["scan"]);
  assert.ok(!text.includes("SECRET"));
  assert.ok(!text.includes("Dark Reader"), "unrelated extension hidden by default");
  assert.ok(/Codex CLI\s+·\s+not found installed/.test(text), "uninstalled agent's leftovers reported");
  assert.ok(/~\/\.codex\/auth\.json\s+credentials/.test(text));
  assert.ok(run(["scan", "--all"]).includes("Dark Reader"));
});
