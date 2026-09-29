import * as path from "path";
import { Component, SourceResult } from "../types";
import {
  homeDir,
  listDir,
  isDirectory,
  readJsonFile,
  fileFirstSeen,
} from "../util";
import { makeComponent } from "./base";

// Browser-side agents.
//
// To the OS, an agent living in a browser is just the browser. Two declared
// artifacts make it visible anyway:
//
//   1. Native messaging host manifests: JSON files a program drops into a
//      browser's NativeMessagingHosts folder so an extension can launch it and
//      talk to it. They declare the program path and which extension IDs may
//      connect — the bridge between a browser agent and this Mac.
//   2. Extension manifests in each Chromium profile: declared name, ID and
//      permissions.
//
// Both are transcribed as declared. Which ones are agents is decided later by
// the catalog and by structural links (extension -> native host -> app), not
// by guessing from names.

interface BrowserRoot {
  browser: string;
  // Folder under ~/Library/Application Support holding profiles.
  profilesRel: string;
  // NativeMessagingHosts folder relative to ~/Library/Application Support.
  nativeHostsRel: string;
}

function chromiumBrowsers(): BrowserRoot[] {
  return [
    { browser: "Chrome", profilesRel: "Google/Chrome", nativeHostsRel: "Google/Chrome/NativeMessagingHosts" },
    { browser: "Chrome Beta", profilesRel: "Google/Chrome Beta", nativeHostsRel: "Google/Chrome Beta/NativeMessagingHosts" },
    { browser: "Chrome Canary", profilesRel: "Google/Chrome Canary", nativeHostsRel: "Google/Chrome Canary/NativeMessagingHosts" },
    { browser: "Chromium", profilesRel: "Chromium", nativeHostsRel: "Chromium/NativeMessagingHosts" },
    { browser: "Brave", profilesRel: "BraveSoftware/Brave-Browser", nativeHostsRel: "BraveSoftware/Brave-Browser/NativeMessagingHosts" },
    { browser: "Edge", profilesRel: "Microsoft Edge", nativeHostsRel: "Microsoft Edge/NativeMessagingHosts" },
    // (inferred) Arc keeps Chromium data under "User Data".
    { browser: "Arc", profilesRel: "Arc/User Data", nativeHostsRel: "Arc/User Data/NativeMessagingHosts" },
    { browser: "Vivaldi", profilesRel: "Vivaldi", nativeHostsRel: "Vivaldi/NativeMessagingHosts" },
  ];
}

function nativeHostDirs(): { browser: string; dir: string }[] {
  const support = path.join(homeDir(), "Library/Application Support");
  const dirs = chromiumBrowsers().map((b) => ({
    browser: b.browser,
    dir: path.join(support, b.nativeHostsRel),
  }));
  dirs.push({ browser: "Firefox", dir: path.join(support, "Mozilla/NativeMessagingHosts") });
  // System-wide locations (installed for every user).
  dirs.push({ browser: "Chrome", dir: "/Library/Google/Chrome/NativeMessagingHosts" });
  dirs.push({ browser: "Edge", dir: "/Library/Microsoft/Edge/NativeMessagingHosts" });
  dirs.push({ browser: "Firefox", dir: "/Library/Application Support/Mozilla/NativeMessagingHosts" });
  return dirs;
}

// "chrome-extension://abcdef.../" -> "abcdef..."
export function extensionIdFromOrigin(origin: string): string | null {
  const m = origin.match(/^chrome-extension:\/\/([a-p]{32})\/?$/i);
  return m ? m[1].toLowerCase() : null;
}

export function collectNativeHosts(): SourceResult {
  let anyFound = false;
  const components: Component[] = [];

  for (const { browser, dir } of nativeHostDirs()) {
    if (!isDirectory(dir)) continue;
    anyFound = true;
    for (const file of listDir(dir)) {
      if (!file.toLowerCase().endsWith(".json")) continue;
      const manifestPath = path.join(dir, file);
      const m = readJsonFile<any>(manifestPath);
      if (!m || typeof m !== "object") continue;

      const name: string =
        typeof m.name === "string" && m.name ? m.name : file.replace(/\.json$/i, "");
      const program: string = typeof m.path === "string" ? m.path : "";
      const ids: string[] = [];
      for (const o of Array.isArray(m.allowed_origins) ? m.allowed_origins : []) {
        const id = typeof o === "string" ? extensionIdFromOrigin(o) : null;
        if (id) ids.push(id);
      }
      // Firefox manifests list extension IDs directly.
      for (const x of Array.isArray(m.allowed_extensions) ? m.allowed_extensions : []) {
        if (typeof x === "string" && x) ids.push(x);
      }

      components.push(
        makeComponent({
          name,
          installMethod: "native_messaging_host",
          // The launched program when declared (so signing and dedup see the
          // real binary); otherwise the manifest itself for provenance.
          path: program && path.isAbsolute(program) ? program : manifestPath,
          firstSeen: fileFirstSeen(manifestPath),
          sourceRefs: [`native_messaging_host:${manifestPath}`],
          // A manifest names a program but proves nothing about who made it;
          // identity comes from signing, the catalog, or a linked app.
          identified: false,
          browser: { browsers: [browser], extensionIds: uniq(ids) },
        })
      );
    }
  }
  return { source: "native_messaging_host", found: anyFound, components };
}

// Chromium profile folders: "Default", "Profile 1", ... (not "System Profile"
// or "Guest Profile", which hold no user extensions).
function profileDirs(root: string): string[] {
  return listDir(root)
    .filter((d) => d === "Default" || /^Profile \d+$/.test(d))
    .map((d) => path.join(root, d));
}

// Resolve "__MSG_key__" names via the extension's _locales messages.
function localized(extVersionDir: string, value: string, defaultLocale?: string): string {
  const m = value.match(/^__MSG_(.+)__$/);
  if (!m) return value;
  const key = m[1].toLowerCase();
  const locales = [defaultLocale, "en", "en_US"].filter(Boolean) as string[];
  for (const loc of locales) {
    const msgs = readJsonFile<Record<string, any>>(
      path.join(extVersionDir, "_locales", loc, "messages.json")
    );
    if (!msgs) continue;
    for (const [k, v] of Object.entries(msgs)) {
      if (k.toLowerCase() === key && v && typeof v.message === "string") {
        return v.message;
      }
    }
  }
  return value;
}

// Latest version folder of an installed extension ("1.2.3_0").
function latestVersionDir(extIdDir: string): string | null {
  const versions = listDir(extIdDir).filter((v) => isDirectory(path.join(extIdDir, v)));
  if (versions.length === 0) return null;
  versions.sort((a, b) => compareVersions(b, a));
  return path.join(extIdDir, versions[0]);
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[._]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[._]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function collectBrowserExtensions(): SourceResult {
  const support = path.join(homeDir(), "Library/Application Support");
  let anyFound = false;
  const components: Component[] = [];

  for (const b of chromiumBrowsers()) {
    const root = path.join(support, b.profilesRel);
    if (!isDirectory(root)) continue;
    for (const profile of profileDirs(root)) {
      const extRoot = path.join(profile, "Extensions");
      if (!isDirectory(extRoot)) continue;
      anyFound = true;
      for (const id of listDir(extRoot)) {
        if (!/^[a-p]{32}$/.test(id)) continue; // Chromium IDs are 32 chars a-p
        const vdir = latestVersionDir(path.join(extRoot, id));
        if (!vdir) continue;
        const manifest = readJsonFile<any>(path.join(vdir, "manifest.json"));
        if (!manifest || typeof manifest !== "object") continue;

        const rawName = typeof manifest.name === "string" ? manifest.name : id;
        const name = localized(vdir, rawName, manifest.default_locale);
        const perms = [
          ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
          ...(Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []),
        ].filter((p: unknown) => typeof p === "string") as string[];

        components.push(
          makeComponent({
            name,
            installMethod: "browser_extension",
            path: path.join(extRoot, id),
            // Namespaced so an extension ID can never collide with an app's
            // bundle ID; the same extension in several browsers/profiles
            // dedups to one record with every source kept.
            bundleId: `chrome-extension:${id}`,
            version: typeof manifest.version === "string" ? manifest.version : undefined,
            firstSeen: fileFirstSeen(path.join(extRoot, id)),
            sourceRefs: [`browser_extension:${b.browser}:${path.basename(profile)}:${id}`],
            // The browser's extension store named it: identified, like a
            // package from a registry.
            identified: true,
            browser: { browsers: [b.browser], extensionIds: [id], permissions: uniq(perms) },
          })
        );
      }
    }
  }
  return { source: "browser_extension", found: anyFound, components };
}

function uniq(a: string[]): string[] {
  return Array.from(new Set(a));
}
