import * as path from "path";
import { Component, InheritedPermission, SourceResult } from "./types";
import { homeDir, pathExists, safeExec } from "./util";

// macOS privacy permissions (TCC).
//
// Read from the TCC databases with the system `sqlite3`, read-only. macOS
// protects these files: the scan can only read them when the terminal running
// it has Full Disk Access. This tool never asks for elevated privileges; if
// the databases aren't readable, the summary says so and nothing else changes.

export interface TccGrant {
  service: string;
  client: string;
  // 0 = bundle identifier, 1 = absolute path
  clientType: number;
  authValue: number;
}

// Services worth reporting, in plain words. Anything else is skipped.
const SERVICE_LABELS: Record<string, string> = {
  kTCCServiceAccessibility: "Accessibility (can control the computer)",
  kTCCServiceScreenCapture: "Screen Recording",
  kTCCServiceSystemPolicyAllFiles: "Full Disk Access",
  kTCCServiceListenEvent: "Input Monitoring",
  kTCCServicePostEvent: "Send input events",
  kTCCServiceAppleEvents: "Automation (controls other apps)",
  kTCCServiceDeveloperTool: "Developer Tools",
  kTCCServiceSystemPolicyDocumentsFolder: "Documents folder",
  kTCCServiceSystemPolicyDesktopFolder: "Desktop folder",
  kTCCServiceSystemPolicyDownloadsFolder: "Downloads folder",
  kTCCServiceMicrophone: "Microphone",
  kTCCServiceCamera: "Camera",
};

export function serviceLabel(service: string): string | undefined {
  return SERVICE_LABELS[service];
}

// auth_value: 0 denied, 1 unknown, 2 allowed, 3 limited.
function isGranted(v: number): boolean {
  return v === 2 || v === 3;
}

// Parse `sqlite3 -separator '|'` output of
//   SELECT service, client, client_type, auth_value FROM access
export function parseTccRows(text: string): TccGrant[] {
  const out: TccGrant[] = [];
  for (const line of (text || "").split("\n")) {
    const parts = line.trim().split("|");
    if (parts.length < 4) continue;
    const [service, client, clientType, authValue] = parts;
    const ct = Number(clientType);
    const av = Number(authValue);
    if (!service || !client || Number.isNaN(ct) || Number.isNaN(av)) continue;
    out.push({ service, client, clientType: ct, authValue: av });
  }
  return out;
}

function tccDatabases(): string[] {
  return [
    path.join(homeDir(), "Library/Application Support/com.apple.TCC/TCC.db"),
    "/Library/Application Support/com.apple.TCC/TCC.db",
  ];
}

export interface TccRead {
  grants: TccGrant[];
  readable: boolean;
}

export function readTcc(): TccRead {
  const grants: TccGrant[] = [];
  let readable = false;
  for (const db of tccDatabases()) {
    if (!pathExists(db)) continue;
    let res = safeExec("sqlite3", [
      "-readonly",
      "-separator",
      "|",
      db,
      "SELECT service, client, client_type, auth_value FROM access",
    ]);
    if (!res.ok) {
      // Pre-Big Sur schema used `allowed` (0/1) instead of auth_value.
      res = safeExec("sqlite3", [
        "-readonly",
        "-separator",
        "|",
        db,
        "SELECT service, client, client_type, allowed * 2 FROM access",
      ]);
    }
    if (!res.ok) continue;
    readable = true;
    grants.push(...parseTccRows(res.stdout));
  }
  return { grants, readable };
}

// Terminals and editors whose integrated terminals launch CLI agents. A CLI
// agent started inside one runs with that app's privacy permissions.
export const TERMINAL_HOSTS: Record<string, string> = {
  "com.apple.Terminal": "Terminal",
  "com.googlecode.iterm2": "iTerm2",
  "dev.warp.Warp-Stable": "Warp",
  "com.mitchellh.ghostty": "Ghostty",
  "net.kovidgoyal.kitty": "kitty",
  "org.alacritty": "Alacritty",
  "io.alacritty": "Alacritty",
  "com.github.wez.wezterm": "WezTerm",
  "com.microsoft.VSCode": "Visual Studio Code",
  "com.todesktop.230313mzl4w4u92": "Cursor",
  "com.exafunction.windsurf": "Windsurf",
  "dev.zed.Zed": "Zed",
};

// Attach grants to components (by bundle ID, or by path for path clients),
// and give every CLI agent the list of terminal permissions it would inherit.
export function applyPermissions(components: Component[], grants: TccGrant[]): void {
  const allowed = grants.filter((g) => isGranted(g.authValue) && serviceLabel(g.service));

  for (const c of components) {
    const labels = new Set<string>();
    for (const g of allowed) {
      if (grantApplies(g, c)) labels.add(serviceLabel(g.service)!);
    }
    if (labels.size > 0) c.permissions = Array.from(labels).sort();
  }

  const inherited = terminalGrants(allowed);
  if (inherited.length === 0) return;
  for (const c of components) {
    if (isCliAgent(c)) c.inheritedPermissions = inherited;
  }
}

function grantApplies(g: TccGrant, c: Component): boolean {
  if (g.clientType === 0) {
    return !!c.bundleId && c.bundleId.toLowerCase() === g.client.toLowerCase();
  }
  if (g.clientType === 1) {
    const targets = [c.executablePath, c.path].filter(
      (p): p is string => !!p && p.startsWith("/")
    );
    return targets.some((t) => g.client === t || g.client.startsWith(t + "/"));
  }
  return false;
}

export function terminalGrants(allowed: TccGrant[]): InheritedPermission[] {
  const byHost = new Map<string, Set<string>>();
  for (const g of allowed) {
    if (g.clientType !== 0) continue;
    const host = TERMINAL_HOSTS[g.client];
    if (!host) continue;
    const label = serviceLabel(g.service);
    if (!label) continue;
    const set = byHost.get(host) ?? new Set<string>();
    set.add(label);
    byHost.set(host, set);
  }
  return Array.from(byHost.entries())
    .map(([from, set]) => ({ from, permissions: Array.from(set).sort() }))
    .sort((a, b) => a.from.localeCompare(b.from));
}

// A command-line agent: catalog kind "cli", or found on PATH, or an agent
// installed from npm/pip/brew that the catalog marks as a CLI.
function isCliAgent(c: Component): boolean {
  if (!c.agent) return false;
  return c.agent.kind === "cli" || c.installMethod === "cli_on_path";
}

export function permissionsSource(read: TccRead): SourceResult {
  return {
    source: "permissions",
    found: read.readable,
    components: [],
    note: read.readable
      ? undefined
      : "Privacy permissions not readable. To include them, give the terminal you run this from Full Disk Access (System Settings › Privacy & Security).",
  };
}
