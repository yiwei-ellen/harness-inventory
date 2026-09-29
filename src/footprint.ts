import * as fs from "fs";
import * as path from "path";
import { Component, DataFootprint } from "./types";
import { CatalogEntry, entriesById } from "./catalog";
import { homeDir, generalizePath } from "./util";

// What each agent leaves on disk: transcripts, instruction files, stored
// logins, downloaded models. Locations come from the catalog; this module only
// measures them (size, file count, last change). It never opens a file, never
// follows symlinks, and caps each walk so a huge model folder can't stall the
// scan.

const MAX_FILES = 50000;
const MAX_DEPTH = 16;

export function expandHome(p: string): string {
  if (p === "~") return homeDir();
  if (p.startsWith("~/")) return path.join(homeDir(), p.slice(2));
  return p;
}

export function measure(absPath: string): Omit<DataFootprint, "path" | "kind"> | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(absPath);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return null;
  if (st.isFile()) {
    return { bytes: st.size, files: 1, truncated: false, lastModified: st.mtime.toISOString() };
  }
  if (!st.isDirectory()) return null;

  let bytes = 0;
  let files = 0;
  let latest = st.mtimeMs;
  let truncated = false;
  const stack: { dir: string; depth: number }[] = [{ dir: absPath, depth: 0 }];

  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (depth + 1 <= MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
        else truncated = true;
        continue;
      }
      if (!e.isFile()) continue;
      if (files >= MAX_FILES) {
        truncated = true;
        stack.length = 0;
        break;
      }
      try {
        const fst = fs.lstatSync(full);
        bytes += fst.size;
        files += 1;
        if (fst.mtimeMs > latest) latest = fst.mtimeMs;
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  return { bytes, files, truncated, lastModified: new Date(latest).toISOString() };
}

// Attach footprints to one component per catalog agent (the first found, in
// component order), so an agent seen via two install sources isn't counted
// twice.
export function applyFootprints(components: Component[], entries: CatalogEntry[]): void {
  const byId = entriesById(entries);
  const done = new Set<string>();
  for (const c of components) {
    if (!c.agent || done.has(c.agent.catalogId)) continue;
    const entry = byId.get(c.agent.catalogId);
    const dataPaths = entry?.dataPaths ?? [];
    if (dataPaths.length === 0) continue;
    done.add(c.agent.catalogId);
    const fp = measureAll(dataPaths);
    if (fp.length > 0) c.footprint = fp;
  }
}

// Catalog agents that are NOT installed (no component tagged with their id)
// but whose data is still on disk: transcripts and logins outlive uninstalls.
export interface Leftover {
  catalogId: string;
  displayName: string;
  footprint: DataFootprint[];
}

export function findLeftovers(components: Component[], entries: CatalogEntry[]): Leftover[] {
  const installed = new Set(
    components.map((c) => c.agent?.catalogId).filter((x): x is string => !!x)
  );
  const out: Leftover[] = [];
  for (const [id, entry] of entriesById(entries)) {
    if (installed.has(id)) continue;
    const fp = measureAll(entry.dataPaths ?? []);
    if (fp.length > 0) {
      out.push({ catalogId: id, displayName: entry.identity.displayName, footprint: fp });
    }
  }
  return out;
}

function measureAll(dataPaths: CatalogEntry["dataPaths"]): DataFootprint[] {
  const fp: DataFootprint[] = [];
  for (const dp of dataPaths ?? []) {
    if (!dp || typeof dp.path !== "string") continue;
    const abs = expandHome(dp.path);
    if (!path.isAbsolute(abs)) continue;
    const m = measure(abs);
    if (!m) continue;
    fp.push({ path: generalizePath(abs), kind: dp.kind || "data", ...m });
  }
  return fp;
}
