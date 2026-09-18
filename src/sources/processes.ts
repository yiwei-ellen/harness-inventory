import { safeExec } from "../util";

// Running-process snapshot, used ONLY to cross-reference paths already found by
// other sources (to confirm running state and enable signing checks). This tool
// does NOT enumerate processes as components: a process matching no known
// install source is never reported, because without heuristic name matching or
// network inspection (both explicit non-goals) there is no principled way to
// confirm it is agent-related rather than arbitrary software.
export interface RunningProcesses {
  // Absolute executable paths observed running (best-effort, from argv[0]).
  paths: Set<string>;
}

export function collectRunningProcesses(): RunningProcesses {
  const paths = new Set<string>();
  const res = safeExec("ps", ["-axo", "pid,comm,args"]);
  if (!res.ok && !res.stdout.trim()) {
    return { paths };
  }

  const lines = res.stdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i === 0) continue; // header
    const line = lines[i].trim();
    if (!line) continue;
    // Columns: pid, comm, args. `comm` (full command path) is the reliable
    // executable path; capture it when it is absolute.
    const m = line.match(/^\s*\d+\s+(\S+)\s+/);
    if (m && m[1].startsWith("/")) {
      paths.add(m[1]);
    }
  }
  return { paths };
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
