import * as fs from "fs";
import { Component } from "./types";
import { componentIdentifier } from "./util";

// Stage 3 linking: resolve each mcp_config Component's raw hostApp string
// to the component that configured it. On a match, set the server's hostApp to
// the resolved host identifier and append the server's identifier to the host's
// relatedComponents. No match -> leave hostApp as the raw config string; the
// server still stands as its own Component.
//
// Servers from a client the catalog knows (mcp.clientId) link to the component
// the catalog tagged with that id: that is how a server in ~/.claude.json
// lands under Claude Code rather than under the "Claude" desktop app whose
// name happens to be a substring. Servers without a clientId fall back to the
// original name match against app bundles.
export function linkHostApps(components: Component[]): void {
  const apps = components.filter((c) => c.installMethod === "app_bundle");

  for (const server of components) {
    if (server.installMethod !== "mcp_config" || !server.hostApp) continue;

    const host = server.mcp?.clientId
      ? findByCatalogId(server.mcp.clientId, components)
      : findHost(server.hostApp, apps);
    if (!host) continue; // leave raw hostApp string in place

    const serverId = componentIdentifier(server);
    const hostId = componentIdentifier(host);

    server.hostApp = hostId;
    host.relatedComponents = addUnique(host.relatedComponents, serverId);
  }
}

// Prefer the app bundle, then a CLI, then a package record for the same agent.
const HOST_PREFERENCE = ["app_bundle", "cli_on_path", "npm", "brew", "pip"];

function findByCatalogId(id: string, components: Component[]): Component | undefined {
  const candidates = components.filter(
    (c) => c.agent?.catalogId === id && c.installMethod !== "mcp_config"
  );
  candidates.sort(
    (a, b) => rank(a.installMethod) - rank(b.installMethod)
  );
  return candidates[0];
}

function rank(m: string): number {
  const i = HOST_PREFERENCE.indexOf(m);
  return i < 0 ? HOST_PREFERENCE.length : i;
}

// The raw hostApp string looks like "Claude (~/Library/.../config.json)".
// Match against an app bundle whose display name (or path basename) appears in
// that string, case-insensitively.
function findHost(hostAppRaw: string, apps: Component[]): Component | undefined {
  const hay = hostAppRaw.toLowerCase();
  // Prefer the longest matching app name to avoid a short name matching inside
  // an unrelated string.
  let best: Component | undefined;
  let bestLen = 0;
  for (const app of apps) {
    const appName = app.name.toLowerCase();
    if (appName && hay.includes(appName) && appName.length > bestLen) {
      best = app;
      bestLen = appName.length;
    }
  }
  return best;
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function inside(child: string, parent: string): boolean {
  return !!parent && child.startsWith(parent.endsWith("/") ? parent : parent + "/");
}

// A CLI found on PATH that resolves into a package or app the inventory
// already has is the same software, not a second component: fold it in.
// ~/.npm-global/bin/claude -> .../node_modules/@anthropic-ai/claude-code/cli.js
// /opt/homebrew/bin/ollama -> /opt/homebrew/Cellar/ollama/<v>/bin/ollama
// /usr/local/bin/ollama    -> /Applications/Ollama.app/Contents/Resources/ollama
//
// For a package the CLI binary becomes its executablePath, so signing and
// running checks look at the real executable. An app keeps its own path.
export function absorbClis(components: Component[]): Component[] {
  const containers = components
    .filter((c) => ["npm", "brew", "pip", "app_bundle"].includes(c.installMethod))
    .filter((c) => c.path && c.path.startsWith("/"))
    .map((c) => ({ c, real: realpathOr(c.path) }));

  const absorbed = new Set<Component>();
  for (const cli of components) {
    if (cli.installMethod !== "cli_on_path") continue;
    const home = containers.find(
      ({ c, real }) => inside(cli.path, real) || inside(cli.path, c.path)
    );
    if (!home) continue;
    const target = home.c;
    target.sourceRefs = Array.from(new Set([...target.sourceRefs, ...cli.sourceRefs]));
    if (target.installMethod !== "app_bundle" && !target.executablePath) {
      target.executablePath = cli.path;
    }
    absorbed.add(cli);
  }
  return components.filter((c) => !absorbed.has(c));
}

// Browser bridge links, structural only:
//   app bundle  -> native messaging host whose program lives inside the app
//   native host -> extensions whose IDs the host manifest allows
export function linkBrowserBridges(components: Component[]): void {
  const apps = components.filter((c) => c.installMethod === "app_bundle");
  const hosts = components.filter((c) => c.installMethod === "native_messaging_host");
  const exts = components.filter((c) => c.installMethod === "browser_extension");

  for (const host of hosts) {
    const hostId = componentIdentifier(host);
    const app = apps.find((a) => inside(host.path, a.path));
    if (app) app.relatedComponents = addUnique(app.relatedComponents, hostId);

    const allowed = new Set((host.browser?.extensionIds ?? []).map((x) => x.toLowerCase()));
    if (allowed.size === 0) continue;
    for (const ext of exts) {
      const ids = (ext.browser?.extensionIds ?? []).map((x) => x.toLowerCase());
      if (ids.some((id) => allowed.has(id))) {
        host.relatedComponents = addUnique(host.relatedComponents, componentIdentifier(ext));
      }
    }
  }
}

function addUnique(arr: string[] | undefined, value: string): string[] {
  const next = arr ? [...arr] : [];
  if (!next.includes(value)) next.push(value);
  return next;
}
