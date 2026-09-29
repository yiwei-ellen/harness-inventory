"use strict";
// Builds a simulated macOS home directory for end-to-end tests. Everything the
// scanner reads from $HOME is here; nothing outside the returned directory is
// touched. Values that must never appear in output are marked SECRET-*.
const fs = require("fs");
const os = require("os");
const path = require("path");

function write(p, content, mode) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  if (mode) fs.chmodSync(p, mode);
}

const EXT_ID = "abcdefghijklmnopabcdefghijklmnop"; // 32 chars, a-p
const OTHER_EXT_ID = "ponmlkjihgfedcbaponmlkjihgfedcba";

function makeFakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-inventory-home-"));
  const support = path.join(home, "Library/Application Support");

  // Claude Desktop: a stdio server with secret env, and a remote server whose
  // URL carries a token in its query string.
  write(
    path.join(support, "Claude/claude_desktop_config.json"),
    JSON.stringify({
      mcpServers: {
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github@1.2.3"],
          env: { GITHUB_TOKEN: "SECRET-gh-token" },
        },
        linear: { url: "https://mcp.linear.app/sse?token=SECRET-query-token" },
      },
    })
  );

  // Claude Desktop extension with declared tools, disabled in settings.
  write(
    path.join(support, "Claude/Claude Extensions/ant.dir.notes/manifest.json"),
    JSON.stringify({
      name: "notes",
      display_name: "Apple Notes",
      version: "0.4.0",
      server: {
        type: "node",
        mcp_config: { command: "node", args: ["${__dirname}/server/index.js"], env: {} },
      },
      tools: [{ name: "list_notes" }, { name: "read_note" }, { name: "create_note" }],
    })
  );
  write(
    path.join(support, "Claude/Claude Extensions Settings/ant.dir.notes.json"),
    JSON.stringify({ isEnabled: false })
  );

  // Claude Code: user-scope and project-scope servers in ~/.claude.json.
  write(
    path.join(home, ".claude.json"),
    JSON.stringify({
      numStartups: 12,
      mcpServers: {
        sentry: { type: "http", url: "https://mcp.sentry.dev/mcp", headers: { Authorization: "Bearer SECRET-hdr" } },
      },
      projects: {
        [path.join(home, "code/app")]: {
          mcpServers: { postgres: { command: "docker", args: ["run", "-i", "--rm", "-e", "PGPASSWORD", "mcp/postgres:latest"], env: { PGPASSWORD: "SECRET-pg" } } },
        },
        [path.join(home, "code/empty")]: { mcpServers: {} },
      },
    })
  );
  write(path.join(home, ".claude/CLAUDE.md"), "# my instructions\n");
  write(path.join(home, ".claude/projects/-code-app/session1.jsonl"), "x".repeat(2048));
  write(path.join(home, ".claude/projects/-code-app/session2.jsonl"), "y".repeat(1024));

  // Native Claude Code install: ~/.local/bin/claude -> versions/<v>.
  const claudeBin = path.join(home, ".local/share/claude/versions/2.0.0");
  write(claudeBin, "#!/bin/sh\necho claude\n", 0o755);
  fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
  fs.symlinkSync(claudeBin, path.join(home, ".local/bin/claude"));

  // Codex: TOML with sub-table env, inline env, multi-line args, comments.
  write(
    path.join(home, ".codex/config.toml"),
    [
      'model = "gpt-5"  # a comment',
      "",
      "[mcp_servers.context7]",
      'command = "npx"',
      "args = [",
      '  "-y",',
      '  "@upstash/context7-mcp@latest",',
      "]",
      "",
      "[mcp_servers.context7.env]",
      'CONTEXT7_KEY = "SECRET-c7"',
      "",
      '[mcp_servers."docs.remote"]',
      'url = "https://docs.example.com/mcp?key=SECRET-url"',
      "enabled = false",
      "",
      "[mcp_servers.fs]",
      'command = "/opt/tools/mcp-fs"',
      'env = { ROOT = "/Users/nobody", API_KEY = "SECRET-inline" }',
      "",
      "[profiles.fast]",
      'model = "o4-mini"',
    ].join("\n")
  );
  write(path.join(home, ".codex/auth.json"), '{"token":"SECRET-auth"}');
  write(path.join(home, ".codex/sessions/2026/09/29/rollout.jsonl"), "z".repeat(4096));

  // VS Code mcp.json in JSONC: comments, trailing commas, "//" inside a string.
  write(
    path.join(support, "Code/User/mcp.json"),
    [
      "{",
      "  // servers for agent mode",
      '  "servers": {',
      '    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest",], },',
      '    /* remote */ "fetch": { "type": "http", "url": "https://fetch.example.com//mcp" },',
      "  },",
      "}",
    ].join("\n")
  );

  // Browser bridge: native host manifest for Chrome and Brave (same program),
  // plus the extension it allows, with a localized name.
  const hostManifest = JSON.stringify({
    name: "com.anthropic.claude_browser_extension",
    description: "Claude browser extension native host",
    path: "/Applications/Claude.app/Contents/Helpers/chrome-native-host",
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXT_ID}/`],
  });
  write(path.join(support, "Google/Chrome/NativeMessagingHosts/com.anthropic.claude_browser_extension.json"), hostManifest);
  write(path.join(support, "BraveSoftware/Brave-Browser/NativeMessagingHosts/com.anthropic.claude_browser_extension.json"), hostManifest);

  const extDir = path.join(support, `Google/Chrome/Default/Extensions/${EXT_ID}`);
  write(
    path.join(extDir, "1.0.10_0/manifest.json"),
    JSON.stringify({
      name: "__MSG_appName__",
      default_locale: "en",
      version: "1.0.10",
      permissions: ["nativeMessaging", "tabs", "debugger"],
      host_permissions: ["<all_urls>"],
    })
  );
  write(path.join(extDir, "1.0.10_0/_locales/en/messages.json"), JSON.stringify({ appName: { message: "Claude" } }));
  // An older version folder that must not win (it sorts later as a string).
  write(path.join(extDir, "1.0.9_0/manifest.json"), JSON.stringify({ name: "Claude (old)", version: "1.0.9" }));

  // An unrelated extension: listed only with --all.
  write(
    path.join(support, `Google/Chrome/Profile 1/Extensions/${OTHER_EXT_ID}/2.0_0/manifest.json`),
    JSON.stringify({ name: "Dark Reader", version: "2.0", permissions: ["storage"] })
  );

  return { home, EXT_ID, OTHER_EXT_ID };
}

module.exports = { makeFakeHome };
