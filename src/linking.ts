import { Component } from "./types";
import { componentIdentifier } from "./util";

// Stage 3 linking: resolve each mcp_config Component's raw hostApp string
// against the deduped app_bundle Components by name/path match. On a match, set
// the server's hostApp to the resolved host identifier and append the server's
// identifier to the host's relatedComponents. No match -> leave hostApp as the
// raw config string; the server still stands as its own Component.
export function linkHostApps(components: Component[]): void {
  const apps = components.filter((c) => c.installMethod === "app_bundle");

  for (const server of components) {
    if (server.installMethod !== "mcp_config" || !server.hostApp) continue;

    const host = findHost(server.hostApp, apps);
    if (!host) continue; // leave raw hostApp string in place

    const serverId = componentIdentifier(server);
    const hostId = componentIdentifier(host);

    server.hostApp = hostId;
    host.relatedComponents = addUnique(host.relatedComponents, serverId);
  }
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

function addUnique(arr: string[] | undefined, value: string): string[] {
  const next = arr ? [...arr] : [];
  if (!next.includes(value)) next.push(value);
  return next;
}
