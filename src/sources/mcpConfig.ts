import * as path from "path";
import { Component, SourceResult } from "../types";
import {
  homeDir,
  readTextFile,
  readJsonFile,
  pathExists,
  fileFirstSeen,
  generalizePath,
  listDir,
  isDirectory,
} from "../util";
import { parseJsonc, parseCodexMcpServers, describeServer } from "../mcpParse";
import { makeComponent } from "./base";

// Known MCP client config locations on macOS. `serverKeys` lists the keys
// under which a client stores its server map (clients disagree on the name; a
// dotted key like "mcp.servers" walks nested objects).
//
// Paths marked (confirmed) are the documented locations; (inferred) are our
// best current guess and are called out so a reviewer can correct them without
// reading code. Project-scoped config files that live inside repos
// (.mcp.json, .cursor/mcp.json, .vscode/mcp.json) are per-repo and out of scope
// for a machine inventory.
interface ClientConfig {
  appName: string; // display name of the client, matched in Stage 3
  // Catalog id of the client, so linking can attach servers to the right
  // component even when the client is a CLI rather than an .app.
  clientId?: string;
  relPath: string; // path relative to home
  format: "json" | "jsonc" | "codex-toml";
  serverKeys: string[];
  // ~/.claude.json keeps per-project servers under projects[<dir>].mcpServers.
  projectsKey?: string;
  confidence: "confirmed" | "inferred";
}

function clientConfigs(): ClientConfig[] {
  return [
    {
      appName: "Claude",
      clientId: "anthropic.claude-desktop",
      relPath: "Library/Application Support/Claude/claude_desktop_config.json",
      format: "json",
      serverKeys: ["mcpServers"],
      confidence: "confirmed",
    },
    {
      appName: "Claude Code",
      clientId: "anthropic.claude-code",
      // User-scope servers at top level; local-scope servers per project.
      relPath: ".claude.json",
      format: "json",
      serverKeys: ["mcpServers"],
      projectsKey: "projects",
      confidence: "confirmed",
    },
    {
      appName: "Cursor",
      clientId: "anysphere.cursor",
      relPath: ".cursor/mcp.json",
      format: "json",
      serverKeys: ["mcpServers"],
      confidence: "confirmed",
    },
    {
      appName: "Windsurf",
      clientId: "codeium.windsurf",
      relPath: ".codeium/windsurf/mcp_config.json",
      format: "json",
      serverKeys: ["mcpServers"],
      confidence: "confirmed",
    },
    {
      appName: "Zed",
      clientId: "zed.zed",
      // Zed keeps MCP servers as "context_servers" in its JSONC settings.
      // Inferred because Zed's schema shifts between releases.
      relPath: ".config/zed/settings.json",
      format: "jsonc",
      serverKeys: ["context_servers", "mcpServers"],
      confidence: "inferred",
    },
    {
      appName: "Visual Studio Code",
      clientId: "microsoft.vscode",
      relPath: "Library/Application Support/Code/User/mcp.json",
      format: "jsonc",
      serverKeys: ["servers"],
      confidence: "confirmed",
    },
    {
      appName: "Visual Studio Code",
      clientId: "microsoft.vscode",
      // Older releases kept servers inside settings.json under "mcp.servers".
      relPath: "Library/Application Support/Code/User/settings.json",
      format: "jsonc",
      serverKeys: ["mcp.servers"],
      confidence: "inferred",
    },
    {
      appName: "Visual Studio Code - Insiders",
      clientId: "microsoft.vscode",
      relPath: "Library/Application Support/Code - Insiders/User/mcp.json",
      format: "jsonc",
      serverKeys: ["servers"],
      confidence: "inferred",
    },
    {
      appName: "Cline (VS Code extension)",
      relPath:
        "Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
      format: "json",
      serverKeys: ["mcpServers"],
      confidence: "inferred",
    },
    {
      appName: "Codex",
      clientId: "openai.codex-cli",
      relPath: ".codex/config.toml",
      format: "codex-toml",
      serverKeys: [],
      confidence: "confirmed",
    },
    {
      appName: "Gemini CLI",
      clientId: "google.gemini-cli",
      relPath: ".gemini/settings.json",
      format: "json",
      serverKeys: ["mcpServers"],
      confidence: "confirmed",
    },
    {
      appName: "Qwen Code",
      clientId: "qwen-code",
      // Qwen Code is a Gemini CLI fork and uses the same settings shape.
      relPath: ".qwen/settings.json",
      format: "json",
      serverKeys: ["mcpServers"],
      confidence: "inferred",
    },
    {
      appName: "GitHub Copilot CLI",
      clientId: "github.copilot-cli",
      relPath: ".copilot/mcp-config.json",
      format: "json",
      serverKeys: ["mcpServers"],
      confidence: "inferred",
    },
    {
      appName: "LM Studio",
      clientId: "lmstudio",
      relPath: ".lmstudio/mcp.json",
      format: "json",
      serverKeys: ["mcpServers"],
      confidence: "inferred",
    },
    {
      appName: "OpenCode",
      clientId: "opencode",
      // OpenCode declares servers under "mcp" with command as an array.
      relPath: ".config/opencode/opencode.json",
      format: "jsonc",
      serverKeys: ["mcp"],
      confidence: "inferred",
    },
  ];
}

// Walk a dotted key ("mcp.servers"). A literal key containing the dot wins.
function getKey(obj: any, key: string): any {
  if (!obj || typeof obj !== "object") return undefined;
  if (key in obj) return obj[key];
  let cur = obj;
  for (const part of key.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

// Normalize client-specific shapes to { command, args, url, env, ... }.
function normalizeDef(def: any): any {
  if (!def || typeof def !== "object") return def;
  const out = { ...def };
  // OpenCode: command: ["npx", "-y", "pkg"], environment: {...}
  if (Array.isArray(out.command)) {
    const [cmd, ...rest] = out.command;
    out.command = cmd;
    out.args = Array.isArray(out.args) ? [...rest, ...out.args] : rest;
  }
  if (!out.env && out.environment && typeof out.environment === "object") {
    out.env = out.environment;
  }
  // Zed wraps the command: { command: { path, args, env } } in some releases.
  if (out.command && typeof out.command === "object" && !Array.isArray(out.command)) {
    const c = out.command;
    out.command = c.path ?? c.command;
    out.args = out.args ?? c.args;
    out.env = out.env ?? c.env;
  }
  return out;
}

function readConfig(abs: string, format: ClientConfig["format"]): any {
  if (format === "codex-toml") {
    const text = readTextFile(abs);
    if (text === null) return null;
    return { __servers: parseCodexMcpServers(text) };
  }
  if (format === "jsonc") return parseJsonc(readTextFile(abs));
  return readJsonFile(abs);
}

function serverMapsOf(
  json: any,
  cfg: ClientConfig
): { scope: string; map: Record<string, any>; refSuffix: string }[] {
  const maps: { scope: string; map: Record<string, any>; refSuffix: string }[] = [];
  if (cfg.format === "codex-toml") {
    if (json.__servers && Object.keys(json.__servers).length > 0) {
      maps.push({ scope: "user", map: json.__servers, refSuffix: "" });
    }
    return maps;
  }
  for (const key of cfg.serverKeys) {
    const m = getKey(json, key);
    if (m && typeof m === "object" && !Array.isArray(m)) {
      maps.push({ scope: "user", map: m, refSuffix: "" });
      break;
    }
  }
  if (cfg.projectsKey) {
    const projects = json[cfg.projectsKey];
    if (projects && typeof projects === "object") {
      for (const [projDir, proj] of Object.entries<any>(projects)) {
        const m = proj && typeof proj === "object" ? proj.mcpServers : undefined;
        if (m && typeof m === "object" && Object.keys(m).length > 0) {
          const gen = generalizePath(projDir);
          maps.push({ scope: `project ${gen}`, map: m, refSuffix: `#project:${gen}` });
        }
      }
    }
  }
  return maps;
}

// Parse one client's config into zero or more mcp_config Components. Transcribes
// declared data only; no inference about what a server "is". Absent or malformed
// config -> empty list, silently.
function parseClient(cfg: ClientConfig): Component[] {
  const abs = path.join(homeDir(), cfg.relPath);
  const json = readConfig(abs, cfg.format);
  if (!json || typeof json !== "object") return [];

  const firstSeen = fileFirstSeen(abs);
  // hostApp carries the client app's name and (generalized) config location, so
  // Stage 3 can resolve it against the host Components.
  const hostAppRaw = `${cfg.appName} (${generalizePath(abs)})`;

  const out: Component[] = [];
  for (const { scope, map, refSuffix } of serverMapsOf(json, cfg)) {
    for (const [serverName, rawDef] of Object.entries(map)) {
      const def = normalizeDef(rawDef);
      const command: string | undefined =
        def && typeof def === "object" && typeof def.command === "string"
          ? def.command
          : undefined;
      // path: prefer the server's command when it is an absolute path (so signing
      // can run against a real binary); otherwise fall back to the config file so
      // provenance is never empty. Commands like "npx"/"node" are not absolute and
      // intentionally leave path pointing at the config.
      const resolvedPath = command && path.isAbsolute(command) ? command : abs;
      const details = describeServer(def);
      details.scope = scope;
      if (cfg.clientId) details.clientId = cfg.clientId;

      out.push(
        makeComponent({
          name: serverName,
          installMethod: "mcp_config",
          path: resolvedPath,
          firstSeen,
          sourceRefs: [`mcp_config:${abs}${refSuffix}`],
          // A server the client explicitly declares by name is identified: the
          // config author named it. Catalog lookup is skipped for these.
          identified: true,
          hostApp: hostAppRaw,
          mcp: details,
        })
      );
    }
  }
  return out;
}

// Claude Desktop extensions (.mcpb/.dxt) install MCP servers outside
// claude_desktop_config.json: each lives in its own folder with a manifest
// that declares the server command and the tools it offers. (inferred layout)
function collectClaudeExtensions(): { found: boolean; components: Component[] } {
  const base = path.join(homeDir(), "Library/Application Support/Claude");
  const extDir = path.join(base, "Claude Extensions");
  const settingsDir = path.join(base, "Claude Extensions Settings");
  if (!isDirectory(extDir)) return { found: false, components: [] };

  const components: Component[] = [];
  for (const entry of listDir(extDir)) {
    const dir = path.join(extDir, entry);
    if (!isDirectory(dir)) continue;
    const manifestPath = path.join(dir, "manifest.json");
    const manifest = readJsonFile<any>(manifestPath);
    if (!manifest || typeof manifest !== "object") continue;

    const name: string =
      (typeof manifest.display_name === "string" && manifest.display_name) ||
      (typeof manifest.name === "string" && manifest.name) ||
      entry;
    const mcpConfig = normalizeDef(manifest.server?.mcp_config ?? {});
    const details = describeServer(mcpConfig);
    details.scope = "user";
    details.clientId = "anthropic.claude-desktop";
    if (Array.isArray(manifest.tools)) {
      const tools = manifest.tools
        .map((t: any) => (t && typeof t.name === "string" ? t.name : null))
        .filter(Boolean);
      if (tools.length > 0) details.tools = tools;
    }
    const settings = readJsonFile<any>(path.join(settingsDir, `${entry}.json`));
    if (settings && settings.isEnabled === false) details.enabled = false;

    components.push(
      makeComponent({
        name,
        installMethod: "mcp_config",
        path: dir,
        version: typeof manifest.version === "string" ? manifest.version : undefined,
        firstSeen: fileFirstSeen(dir),
        sourceRefs: [`mcp_config:${manifestPath}`],
        identified: true,
        hostApp: `Claude (${generalizePath(extDir)})`,
        mcp: details,
      })
    );
  }
  return { found: true, components };
}

export function collectMcpConfig(): SourceResult {
  const configs = clientConfigs();
  let anyFound = false;
  const components: Component[] = [];
  for (const cfg of configs) {
    const abs = path.join(homeDir(), cfg.relPath);
    if (pathExists(abs)) anyFound = true;
    components.push(...parseClient(cfg));
  }
  const ext = collectClaudeExtensions();
  if (ext.found) anyFound = true;
  components.push(...ext.components);
  return { source: "mcp_config", found: anyFound, components };
}
