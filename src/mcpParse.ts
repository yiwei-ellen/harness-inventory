import * as path from "path";
import { McpServerDetails } from "./types";
import { generalizePath } from "./util";

// Pure parsing helpers for MCP client configs. No filesystem access here, so
// every function is unit-testable off-macOS.

// ---------------------------------------------------------------------------
// JSONC (VS Code, Zed): strip // and /* */ comments and trailing commas, while
// leaving string contents (URLs with "//", globs with "/*") untouched.
// ---------------------------------------------------------------------------
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      // Copy a string literal verbatim, honoring escapes.
      let j = i + 1;
      while (j < n && text[j] !== '"') {
        if (text[j] === "\\") j++;
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  // Trailing commas: a comma followed only by whitespace before } or ].
  // Safe after comment removal because strings were copied verbatim above and
  // this pattern cannot occur inside a valid JSON string without a quote.
  return removeTrailingCommas(out);
}

function removeTrailingCommas(s: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += s[i + 1] ?? "";
        i++;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === "}" || s[j] === "]") continue; // drop it
    }
    out += ch;
  }
  return out;
}

export function parseJsonc<T = any>(text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    try {
      return JSON.parse(stripJsonc(text)) as T;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal TOML reader for Codex's ~/.codex/config.toml. It understands exactly
// what an MCP server table needs:
//
//   [mcp_servers.name]            (bare or "quoted" name)
//   command = "npx"
//   args = ["-y", "pkg"]          (single- or multi-line arrays of strings)
//   url = "https://..."
//   enabled = false
//   env = { KEY = "v" }           (inline table: keys only are kept)
//   [mcp_servers.name.env]        (sub-table: keys only are kept)
//
// Anything else is skipped. Returns a server map shaped like the JSON clients'
// ({ name: { command, args, url, env: {KEY: ""}, enabled } }).
// ---------------------------------------------------------------------------
export function parseCodexMcpServers(text: string): Record<string, any> {
  const servers: Record<string, any> = {};
  let current: { name: string; sub: string | null } | null = null;
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    let line = stripTomlComment(lines[i]).trim();
    if (!line) continue;

    const header = line.match(/^\[\s*([^\[\]]+?)\s*\]$/);
    if (header) {
      const keys = splitTomlKey(header[1]);
      if (keys[0] === "mcp_servers" && keys.length >= 2) {
        const name = keys[1];
        servers[name] = servers[name] || {};
        current = { name, sub: keys.length >= 3 ? keys[2] : null };
      } else {
        current = null;
      }
      continue;
    }
    if (line.startsWith("[[")) {
      current = null;
      continue;
    }
    if (!current) continue;

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = unquote(line.slice(0, eq).trim());
    let value = line.slice(eq + 1).trim();

    // Multi-line arrays: keep reading until brackets balance.
    if (value.startsWith("[")) {
      while (bracketDepth(value) > 0 && i + 1 < lines.length) {
        i++;
        value += " " + stripTomlComment(lines[i]).trim();
      }
    }

    const target = servers[current.name];
    if (current.sub === "env") {
      target.env = target.env || {};
      target.env[key] = "";
      continue;
    }
    if (current.sub) continue; // other sub-tables are ignored

    if (key === "env" && value.startsWith("{")) {
      target.env = target.env || {};
      for (const k of inlineTableKeys(value)) target.env[k] = "";
    } else if (key === "args") {
      target.args = parseStringArray(value);
    } else if (key === "command" || key === "url") {
      target[key] = unquote(value);
    } else if (key === "enabled") {
      target.enabled = value === "true";
    }
  }
  return servers;
}

function stripTomlComment(line: string): string {
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === "\\" && inStr === '"') i++;
      else if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") {
      inStr = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function splitTomlKey(s: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inStr: string | null = null;
  for (const ch of s) {
    if (inStr) {
      if (ch === inStr) inStr = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      inStr = ch;
    } else if (ch === ".") {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur.trim());
  return parts;
}

function unquote(s: string): string {
  const t = s.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return t;
}

function bracketDepth(s: string): number {
  let d = 0;
  let inStr: string | null = null;
  for (const ch of s) {
    if (inStr) {
      if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === "[") d++;
    else if (ch === "]") d--;
  }
  return d;
}

function parseStringArray(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

function inlineTableKeys(s: string): string[] {
  const inner = s.replace(/^\{/, "").replace(/\}\s*$/, "");
  const keys: string[] = [];
  // Split on commas outside strings.
  let cur = "";
  let inStr: string | null = null;
  for (const ch of inner) {
    if (inStr) {
      if (ch === inStr) inStr = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      inStr = ch;
      cur += ch;
    } else if (ch === ",") {
      keys.push(cur);
      cur = "";
    } else cur += ch;
  }
  keys.push(cur);
  return keys
    .map((kv) => kv.split("=")[0])
    .map((k) => unquote(k.trim()))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Describe one declared server. Transcribes, never interprets: what command,
// what package a launcher runs, which host a remote URL points at, and which
// env var NAMES are passed. Values, full URLs and full args are dropped.
// ---------------------------------------------------------------------------
const LAUNCHERS = new Set(["npx", "bunx", "uvx", "pipx", "pnpx", "dlx"]);

// docker/podman `run` flags that consume the next argument.
const DOCKER_VALUE_FLAGS = new Set([
  "-e", "--env", "-v", "--volume", "--name", "-p", "--publish", "--network",
  "--mount", "-w", "--workdir", "-u", "--user", "--env-file", "--entrypoint",
  "--platform", "-l", "--label", "--add-host", "--cap-add", "--cap-drop",
]);

export function describeServer(def: any): McpServerDetails {
  const d: McpServerDetails = { transport: "unknown" };
  if (!def || typeof def !== "object") return d;

  const url: unknown = def.url ?? def.serverUrl ?? def.httpUrl;
  const command: unknown = def.command;
  const args: string[] = Array.isArray(def.args)
    ? def.args.filter((a: unknown) => typeof a === "string")
    : [];

  if (typeof url === "string" && url) {
    d.transport = "http";
    d.urlHost = urlHost(url);
  } else if (typeof command === "string" && command) {
    d.transport = "stdio";
  }

  if (typeof command === "string" && command) {
    d.command = path.isAbsolute(command) ? generalizePath(command) : command;
    const launches = launchedPackage(path.basename(command), args);
    if (launches) d.launches = launches;
  }

  const env = def.env;
  if (env && typeof env === "object" && !Array.isArray(env)) {
    const keys = Object.keys(env).filter(Boolean).sort();
    if (keys.length > 0) d.envKeys = keys;
  }
  // HTTP servers commonly pass credentials as headers: record header NAMES.
  const headers = def.headers;
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    const keys = Object.keys(headers).filter(Boolean).sort();
    if (keys.length > 0) d.envKeys = [...(d.envKeys ?? []), ...keys.map((k) => `header:${k}`)];
  }

  if (def.disabled === true || def.enabled === false) d.enabled = false;
  return d;
}

function urlHost(u: string): string | undefined {
  try {
    const parsed = new URL(u);
    return parsed.host || undefined;
  } catch {
    return undefined;
  }
}

// The package a launcher runs: first non-flag argument after the launcher
// (npx -y @scope/pkg ...), or the image of a docker/podman run.
export function launchedPackage(cmd: string, args: string[]): string | undefined {
  const base = cmd.toLowerCase();
  if (LAUNCHERS.has(base)) {
    for (const a of args) {
      if (a.startsWith("-")) continue;
      return stripVersion(a);
    }
    return undefined;
  }
  if (base === "pnpm" || base === "yarn" || base === "npm") {
    // pnpm dlx pkg / yarn dlx pkg / npm exec pkg
    const i = args.findIndex((a) => a === "dlx" || a === "exec");
    if (i >= 0) {
      for (const a of args.slice(i + 1)) {
        if (a === "--" || a.startsWith("-")) continue;
        return stripVersion(a);
      }
    }
    return undefined;
  }
  if (base === "docker" || base === "podman") {
    const i = args.indexOf("run");
    if (i < 0) return undefined;
    for (let j = i + 1; j < args.length; j++) {
      const a = args[j];
      if (DOCKER_VALUE_FLAGS.has(a)) {
        j++; // skip its value
        continue;
      }
      if (a.startsWith("-")) continue;
      return a;
    }
  }
  return undefined;
}

// "@scope/pkg@1.2.3" -> "@scope/pkg"; "pkg@latest" -> "pkg". Leaves a
// leading scope "@" alone. Python specs ("pkg==1.0") are trimmed too.
function stripVersion(spec: string): string {
  const py = spec.split(/[=<>~!]=|[<>]/)[0];
  if (py !== spec) return py;
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}
