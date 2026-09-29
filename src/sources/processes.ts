import * as path from "path";
import { ChildProcess, Component } from "../types";
import { safeExec } from "../util";

// Running-process snapshot, used ONLY to cross-reference components already
// found by other sources: to confirm running state, and to show what is
// running *underneath* a running component. This tool does NOT enumerate
// processes as components: a process matching no known install source is never
// reported, because without heuristic name matching or network inspection
// (both explicit non-goals) there is no principled way to confirm it is
// agent-related rather than arbitrary software.

export interface Proc {
  pid: number;
  ppid: number;
  // Executable path as reported by `ps -o comm` (absolute on macOS).
  comm: string;
  args: string;
}

export interface RunningProcesses {
  // Absolute executable paths observed running (best-effort).
  paths: Set<string>;
  procs: Proc[];
}

// Two ps calls, joined by pid: `comm` may itself contain spaces
// ("/Applications/Google Chrome.app/..."), so it can't share a line with args.
export function collectRunningProcesses(): RunningProcesses {
  const comm = safeExec("ps", ["-axo", "pid=,ppid=,comm="]);
  const args = safeExec("ps", ["-axo", "pid=,args="]);
  return parsePs(comm.stdout, args.stdout);
}

export function parsePs(commOut: string, argsOut: string): RunningProcesses {
  const argsByPid = new Map<number, string>();
  for (const line of (argsOut || "").split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m) argsByPid.set(Number(m[1]), m[2]);
  }
  const procs: Proc[] = [];
  const paths = new Set<string>();
  for (const line of (commOut || "").split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const p: Proc = {
      pid,
      ppid: Number(m[2]),
      comm: m[3],
      args: argsByPid.get(pid) ?? m[3],
    };
    procs.push(p);
    if (p.comm.startsWith("/")) paths.add(p.comm);
  }
  return { paths, procs };
}

// Is a component's resolved path currently running? Matches when the process
// path equals, is a prefix of, or is contained by the component path (covers a
// launch item that points at a binary inside a .app bundle).
export function isRunning(
  componentPath: string,
  running: RunningProcesses
): boolean {
  if (!componentPath || !componentPath.startsWith("/")) return false;
  if (running.paths.has(componentPath)) return true;
  for (const p of running.paths) {
    if (p.startsWith(componentPath + "/")) return true; // binary inside a bundle dir
    if (componentPath.startsWith(p + "/")) return true;
  }
  return false;
}

// Processes that ARE this component: its executable (or anything inside its
// bundle/package directory), including interpreted CLIs whose script path
// appears in the arguments ("node /opt/homebrew/lib/node_modules/pkg/cli.js").
export function ownPids(c: Component, running: RunningProcesses): Set<number> {
  const roots = [c.executablePath, c.path].filter(
    (p): p is string => !!p && p.startsWith("/") && !p.endsWith(".json")
  );
  const pids = new Set<number>();
  if (roots.length === 0) return pids;
  for (const proc of running.procs) {
    for (const r of roots) {
      if (
        proc.comm === r ||
        proc.comm.startsWith(r + "/") ||
        argvHasPath(proc.args, r)
      ) {
        pids.add(proc.pid);
        break;
      }
    }
  }
  return pids;
}

function argvHasPath(args: string, root: string): boolean {
  // Word-boundary match on the path so "/x/pkg" doesn't match "/x/pkg-other".
  const idx = args.indexOf(root);
  if (idx < 0) return false;
  const before = idx === 0 ? " " : args[idx - 1];
  const after = args[idx + root.length] ?? " ";
  return /\s/.test(before) && (after === "/" || /\s/.test(after));
}

const MAX_CHILDREN = 12;

// Descendants of the component's own processes that are NOT part of it: the
// shells, tools and MCP servers it has spawned. Returns at most MAX_CHILDREN
// (plus the true total) so a busy agent can't flood the report.
export function childrenOf(
  c: Component,
  running: RunningProcesses
): { children: ChildProcess[]; total: number } {
  const own = ownPids(c, running);
  if (own.size === 0) return { children: [], total: 0 };

  const kids = new Map<number, Proc[]>();
  for (const p of running.procs) {
    const list = kids.get(p.ppid) ?? [];
    list.push(p);
    kids.set(p.ppid, list);
  }

  const out: Proc[] = [];
  const seen = new Set<number>(own);
  const queue = Array.from(own);
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of kids.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      if (!own.has(child.pid)) out.push(child);
      queue.push(child.pid);
    }
  }
  out.sort((a, b) => a.pid - b.pid);
  return {
    children: out.slice(0, MAX_CHILDREN).map((p) => ({ pid: p.pid, label: processLabel(p) })),
    total: out.length,
  };
}

const INTERPRETERS = new Set(["node", "bun", "deno", "python", "python3", "ruby", "uv", "uvx", "npx"]);

// "git push", "zsh", "node @modelcontextprotocol/server-filesystem". Only the
// executable name and ONE positional argument are shown; everything after it
// (where tokens and file paths tend to live) is dropped.
export function processLabel(p: Proc): string {
  const exe = path.basename(p.comm);
  const argv = p.args.split(/\s+/).filter(Boolean);
  const first = argv.slice(1).find((a) => !a.startsWith("-"));
  if (!first) return exe;

  let shown: string;
  const nm = first.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (nm) shown = nm[1];
  else if (first.includes("/")) shown = path.basename(first);
  else shown = first;

  // Interpreter running a script: the script/package is the interesting part.
  if (INTERPRETERS.has(exe.toLowerCase()) || !first.includes("=")) {
    return `${exe} ${shown}`.slice(0, 60);
  }
  return exe;
}
