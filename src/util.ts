import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// Run an external command without ever throwing. A missing binary, non-zero
// exit, or timeout all resolve to { ok:false }. Callers treat a failed exec as
// "source absent" and return an empty list — no source is allowed to halt the
// scan.
export function safeExec(
  cmd: string,
  args: string[],
  timeoutMs = 20000
): ExecResult {
  try {
    const stdout = execFileSync(cmd, args, {
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout ?? "", stderr: "" };
  } catch (err: any) {
    // execFileSync throws on non-zero exit but still exposes captured output.
    return {
      ok: false,
      stdout: err?.stdout ? String(err.stdout) : "",
      stderr: err?.stderr ? String(err.stderr) : String(err?.message ?? ""),
    };
  }
}

export function homeDir(): string {
  return os.homedir();
}

// Strip control characters (C0/C1, including ESC) from a string before printing
// it to the terminal. Names and paths come from untrusted sources — config
// files, plist labels, process args, the fetched catalog — and a crafted value
// with ANSI escapes could otherwise spoof or corrupt the report. JSON output is
// unaffected (JSON.stringify already escapes these); this is display-only.
export function sanitizeForTerminal(s: string): string {
  // Remove C0 (0x00-0x1F) and C1/DEL (0x7F-0x9F) control characters. Written
  // with numeric comparisons so the source itself holds no control bytes.
  let out = "";
  for (const ch of s || "") {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

// Replace the current user's home directory prefix with "~". Never emits the
// literal username. Used for both display and shadow-report payloads.
export function generalizePath(p: string): string {
  const home = homeDir();
  if (!p) return p;
  if (p === home) return "~";
  if (p.startsWith(home + path.sep)) {
    return "~" + p.slice(home.length);
  }
  return p;
}

export function readTextFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

export function readJsonFile<T = any>(p: string): T | null {
  const text = readTextFile(p);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // Malformed config: transcribe nothing rather than throw.
    return null;
  }
}

export function pathExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Best-effort first-seen: file change time (ctime) as ISO. Empty string if the
// path can't be stat'd.
export function fileFirstSeen(p: string): string {
  try {
    return fs.statSync(p).ctime.toISOString();
  } catch {
    return "";
  }
}

export function fileSize(p: string): number | null {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

// SHA-256 of a file's bytes, hex. null if the path is not a readable file.
export function sha256File(p: string): string | null {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    const buf = fs.readFileSync(p);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

// Parse an Apple property list (binary or XML) to a JS value via `plutil`.
// Returns null off-macOS or on any failure.
export function readPlist<T = any>(p: string): T | null {
  const res = safeExec("plutil", ["-convert", "json", "-o", "-", p]);
  if (!res.ok || !res.stdout.trim()) return null;
  try {
    return JSON.parse(res.stdout) as T;
  } catch {
    return null;
  }
}

export function listDir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

// A stable identity string for linking/dedup display: bundleId if known, else
// the resolved path, else name+method.
//
// mcp_config is special-cased: sibling servers declared in one client config
// share that config's path, so identity must incorporate the server name to
// keep them distinct (two servers in one config are two components, not one).
export function componentIdentifier(c: {
  bundleId?: string;
  path: string;
  name: string;
  installMethod: string;
}): string {
  if (c.bundleId) return c.bundleId;
  if (c.installMethod === "mcp_config") {
    return `mcp_config:${c.name}:${c.path}`;
  }
  if (c.path) return c.path;
  return `${c.name}:${c.installMethod}`;
}

// macOS product version (e.g. "14.5"), or "" off-macOS. No build number, no
// machine identifiers.
export function macosVersion(): string {
  const res = safeExec("sw_vers", ["-productVersion"]);
  return res.ok ? res.stdout.trim() : "";
}
