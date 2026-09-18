import * as path from "path";
import { Component, SourceResult } from "../types";
import {
  homeDir,
  readJsonFile,
  pathExists,
  fileFirstSeen,
  generalizePath,
} from "../util";
import { makeComponent } from "./base";

// Known MCP client config locations on macOS. `serverKeys` lists the JSON keys
// under which a client stores its server map (clients disagree on the name).
//
// Paths marked (confirmed) are the documented locations; (inferred) are our
// best current guess and are called out so a reviewer can correct them without
// reading code.
interface ClientConfig {
  appName: string; // display name of the client app, matched in Stage 3
  relPath: string; // path relative to home
  serverKeys: string[];
  confidence: "confirmed" | "inferred";
}

function clientConfigs(): ClientConfig[] {
  return [
    {
      appName: "Claude",
      // ~/Library/Application Support/Claude/claude_desktop_config.json (confirmed)
      relPath: "Library/Application Support/Claude/claude_desktop_config.json",
      serverKeys: ["mcpServers"],
      confidence: "confirmed",
    },
    {
      appName: "Cursor",
      // Cursor reads a global MCP config from ~/.cursor/mcp.json (confirmed).
      // Project-scoped .cursor/mcp.json files also exist but are per-repo and
      // out of scope for a machine inventory.
      relPath: ".cursor/mcp.json",
      serverKeys: ["mcpServers"],
      confidence: "confirmed",
    },
    {
      appName: "Windsurf",
      // ~/.codeium/windsurf/mcp_config.json (confirmed).
      relPath: ".codeium/windsurf/mcp_config.json",
      serverKeys: ["mcpServers"],
      confidence: "confirmed",
    },
    {
      appName: "Zed",
      // Zed stores MCP servers as "context_servers" inside its settings.json
      // (~/.config/zed/settings.json). Key name confirmed; treated as inferred
      // because Zed's schema shifts between releases.
      relPath: ".config/zed/settings.json",
      serverKeys: ["context_servers", "mcpServers"],
      confidence: "inferred",
    },
  ];
}

// Parse one client's config into zero or more mcp_config Components. Transcribes
// declared data only; no inference about what a server "is". Absent or malformed
// config -> empty list, silently.
function parseClient(cfg: ClientConfig): Component[] {
  const abs = path.join(homeDir(), cfg.relPath);
  const json = readJsonFile<Record<string, any>>(abs);
  if (!json) return [];

  let serverMap: Record<string, any> | undefined;
  for (const key of cfg.serverKeys) {
    if (json[key] && typeof json[key] === "object") {
      serverMap = json[key];
      break;
    }
  }
  if (!serverMap) return [];

  const firstSeen = fileFirstSeen(abs);
  // hostApp carries the client app's name and (generalized) config location, so
  // Stage 3 can resolve it against the app_bundle Components.
  const hostAppRaw = `${cfg.appName} (${generalizePath(abs)})`;

  const out: Component[] = [];
  for (const [serverName, def] of Object.entries(serverMap)) {
    const command: string | undefined =
      def && typeof def === "object" ? def.command : undefined;
    // path: prefer the server's command when it is an absolute path (so signing
    // can run against a real binary); otherwise fall back to the config file so
    // provenance is never empty. Commands like "npx"/"node" are not absolute and
    // intentionally leave path pointing at the config.
    const resolvedPath =
      command && path.isAbsolute(command) ? command : abs;

    out.push(
      makeComponent({
        name: serverName,
        installMethod: "mcp_config",
        path: resolvedPath,
        // The command the server launches under (e.g. "npx", "node", or an
        // absolute binary's name).
        binaryName: command ? path.basename(command) : undefined,
        firstSeen,
        sourceRefs: [`mcp_config:${abs}`],
        // A server the client explicitly declares by name is identified: the
        // config author named it. Catalog lookup is skipped for these.
        identified: true,
        hostApp: hostAppRaw,
      })
    );
  }
  return out;
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
  return { source: "mcp_config", found: anyFound, components };
}
