import * as fs from "fs";
import * as path from "path";
import { Component, SourceResult } from "../types";
import { homeDir, listDir, fileFirstSeen } from "../util";
import { makeComponent } from "./base";

// Agent CLIs on PATH.
//
// Package-manager sources miss CLIs installed by their own installer (e.g.
// Claude Code's native build in ~/.local/bin). This source looks up ONLY the
// executable names the catalog lists — an exact file-name lookup, never a
// heuristic — in PATH plus the bin dirs installers commonly use (a scan run
// from a GUI launcher or cron gets a minimal PATH).
//
// Each hit is recorded at its resolved (symlink-followed) path so dedup and
// signing see the real binary. The first hit per name wins, like a shell.

function candidateDirs(): string[] {
  const home = homeDir();
  const fromPath = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extras = [
    path.join(home, ".local/bin"),
    path.join(home, "bin"),
    path.join(home, ".npm-global/bin"),
    path.join(home, ".bun/bin"),
    path.join(home, ".cargo/bin"),
    path.join(home, ".volta/bin"),
    path.join(home, ".deno/bin"),
    path.join(home, ".claude/local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  // nvm keeps one bin dir per installed Node version.
  const nvmRoot = path.join(home, ".nvm/versions/node");
  for (const v of listDir(nvmRoot).sort().reverse()) {
    extras.push(path.join(nvmRoot, v, "bin"));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of [...fromPath, ...extras]) {
    const key = path.resolve(d);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p); // follows symlinks
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

export function collectCliOnPath(cliNames: string[]): SourceResult {
  const dirs = candidateDirs();
  const components: Component[] = [];

  for (const name of cliNames) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (!isExecutableFile(candidate)) continue;
      const resolved = realpathOr(candidate);
      components.push(
        makeComponent({
          name,
          installMethod: "cli_on_path",
          path: resolved,
          firstSeen: fileFirstSeen(resolved),
          sourceRefs: [`cli:${name}`, `cli_on_path:${candidate}`],
          // Identity comes from the catalog (it listed this exact name) or a
          // code-signing publisher, never from the file name alone.
          identified: false,
        })
      );
      break; // first hit on the search path wins
    }
  }

  return { source: "cli_on_path", found: components.length > 0, components };
}
