import { Component, DataFootprint, McpServerDetails, PublisherCheck } from "./types";
import { componentIdentifier, generalizePath, homeDir, macosVersion } from "./util";
import { agentRelated } from "./report";
import { Leftover } from "./footprint";
import { CatalogEntry, entryId } from "./catalog";
import { SourceResult } from "./types";

// ---------------------------------------------------------------------------
// HTML report: one self-contained file the scan writes locally and opens in
// the browser. No fonts, scripts or images are fetched from anywhere — the
// same no-network promise as the CLI. Scan data is embedded as JSON and every
// name is rendered with textContent, never as markup, because names come from
// untrusted config files and plists.
// ---------------------------------------------------------------------------

export interface McpRow {
  name: string;
  transport: string;
  target: string; // host, launched package, or command
  keys: string[];
  tools: number;
  scope: string;
  enabled: boolean;
}

export interface FootprintRow {
  path: string;
  kind: string;
  bytes: number;
  files: number;
  truncated: boolean;
  lastModified: string;
}

export interface AgentCard {
  id: string;
  name: string;
  kind: string;
  via: string;
  binary: string;
  path: string;
  signing: string;
  publisher: string;
  check: PublisherCheck | "none";
  permissions: string[];
  inherits: { from: string; permissions: string[] }[];
  running: boolean;
  children: string[];
  mcp: McpRow[];
  bridges: { name: string; browsers: string[]; extensions: string[] }[];
  extension: { browsers: string[]; permissions: string[] } | null;
  footprint: FootprintRow[];
}

export interface AbsentCard {
  name: string;
  mcp: McpRow[];
  footprint: FootprintRow[];
}

export interface Attention {
  kind: "keys" | "team" | "inherit" | "screen" | "credentials" | "unidentified";
  title: string;
  detail: string;
}

export interface ReportModel {
  generatedAt: string;
  macos: string;
  summary: {
    agents: number;
    mcpServers: number;
    serversWithKeys: number;
    running: number;
    leftBehind: number;
    notShown: number;
  };
  attention: Attention[];
  agents: AgentCard[];
  absent: AbsentCard[];
  unidentified: { name: string; via: string; path: string }[];
  sources: { scanned: string[]; missing: string[]; notes: string[] };
  sample: boolean;
}

const VIA: Record<string, string> = {
  mcp_config: "MCP config",
  app_bundle: "App",
  launch_item: "Launch item",
  cli_on_path: "Command line",
  native_messaging_host: "Browser bridge",
  browser_extension: "Browser extension",
  brew: "Homebrew",
  npm: "npm",
  pip: "pip",
};

const KIND: Record<string, string> = {
  cli: "Command-line agent",
  "desktop-app": "Desktop app",
  ide: "Code editor",
  "browser-bridge": "Browser bridge",
  "agentic-browser": "Agentic browser",
  "local-model-server": "Local models",
  "agent-framework": "Agent framework",
  "agent-sandbox": "Agent sandbox",
  "terminal-agent": "Terminal",
  "mcp-server": "MCP server",
  agent: "Agent",
};

const SIGNING: Record<string, string> = {
  signed_notarized: "Notarized",
  signed_unnotarized: "Signed",
  unsigned: "Unsigned",
  unknown: "No signature",
};

function mcpRow(s: Component): McpRow {
  const d: McpServerDetails | undefined = s.mcp;
  const target = d?.urlHost || (d?.launches ? `${d.command ?? ""} ${d.launches}`.trim() : d?.command || "");
  return {
    name: s.name,
    transport: d?.transport ?? "unknown",
    target,
    keys: d?.envKeys ?? [],
    tools: d?.tools?.length ?? 0,
    scope: d?.scope && d.scope !== "user" ? d.scope : "",
    enabled: d?.enabled !== false,
  };
}

function fpRows(fp: DataFootprint[] | undefined): FootprintRow[] {
  return (fp ?? []).map((f) => ({ ...f }));
}

export interface ReportInput {
  components: Component[];
  sources: SourceResult[];
  leftovers: Leftover[];
  catalog: CatalogEntry[];
  outOfScope: number;
  sample?: boolean;
}

export function buildReportModel(input: ReportInput): ReportModel {
  const { components } = input;
  const byId = new Map<string, Component>();
  for (const c of components) byId.set(componentIdentifier(c), c);
  const catalogNames = new Map<string, string>();
  for (const e of input.catalog) catalogNames.set(entryId(e), e.identity.displayName);
  const visible = agentRelated(components);

  const related = (c: Component, method: string) =>
    (c.relatedComponents || [])
      .map((id) => byId.get(id))
      .filter((x): x is Component => !!x && x.installMethod === method);

  // A known agent that is linked under another one (a browser bridge inside
  // Claude.app) is shown inside that card, not as a card of its own.
  const cardCandidates = components.filter(
    (c) => visible.has(c) && c.agent && c.installMethod !== "mcp_config"
  );
  const nested = new Set<string>();
  for (const c of cardCandidates) for (const id of c.relatedComponents || []) nested.add(id);

  const agents: AgentCard[] = cardCandidates
    .filter((c) => !nested.has(componentIdentifier(c)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({
      id: componentIdentifier(c),
      name: c.name,
      kind: KIND[c.agent!.kind] || "Agent",
      via: VIA[c.installMethod] || c.installMethod,
      binary: c.binaryName || (c.executablePath || c.path).split("/").pop() || "",
      path: generalizePath(c.executablePath || c.path),
      signing: SIGNING[c.signingStatus] || "No signature",
      publisher: c.teamId || (c.publisher && c.signingStatus !== "unknown") ? c.publisher || `TeamID ${c.teamId}` : "",
      check: c.publisherCheck || "none",
      permissions: c.permissions ?? [],
      inherits: c.inheritedPermissions ?? [],
      running: !!c.running,
      children: (c.runningChildren ?? []).map((k) => k.label),
      mcp: related(c, "mcp_config").map(mcpRow),
      bridges: related(c, "native_messaging_host")
        .concat(c.installMethod === "native_messaging_host" ? [c] : [])
        .map((h) => ({
          name: h.name,
          browsers: h.browser?.browsers ?? [],
          extensions: related(h, "browser_extension").map((e) => e.name),
        })),
      extension:
        c.installMethod === "browser_extension" && c.browser
          ? { browsers: c.browser.browsers, permissions: c.browser.permissions ?? [] }
          : null,
      footprint: fpRows(c.footprint),
    }));

  // Agents not installed whose config or data remains, grouped by client.
  const absentMap = new Map<string, AbsentCard>();
  const slot = (key: string, name: string) => {
    let a = absentMap.get(key);
    if (!a) {
      a = { name, mcp: [], footprint: [] };
      absentMap.set(key, a);
    }
    return a;
  };
  for (const s of components) {
    if (s.installMethod !== "mcp_config") continue;
    if (s.hostApp && byId.has(s.hostApp)) continue;
    const raw = (s.hostApp || "Unknown client").replace(/\s*\(.*\)\s*$/, "");
    const id = s.mcp?.clientId;
    slot(id ? `id:${id}` : `raw:${raw}`, id ? catalogNames.get(id) || raw : raw).mcp.push(mcpRow(s));
  }
  for (const l of input.leftovers) slot(`id:${l.catalogId}`, l.displayName).footprint.push(...fpRows(l.footprint));
  const absent = Array.from(absentMap.values()).sort((a, b) => a.name.localeCompare(b.name));

  const unidentified = components
    .filter((c) => !c.identified)
    .map((c) => ({ name: c.name, via: VIA[c.installMethod] || c.installMethod, path: generalizePath(c.path) }));

  // What deserves a second look, stated as facts.
  const attention: Attention[] = [];
  for (const a of agents) {
    const keyed = a.mcp.filter((m) => m.keys.length > 0);
    if (keyed.length > 0) {
      attention.push({
        kind: "keys",
        title: `${a.name} hands keys to ${keyed.length} MCP server${keyed.length === 1 ? "" : "s"}`,
        detail: keyed.map((m) => `${m.name}: ${m.keys.join(", ")}`).join(" · "),
      });
    }
    if (a.check === "differs_from_catalog") {
      attention.push({
        kind: "team",
        title: `${a.name} is signed by a different team than the catalog records`,
        detail: a.publisher,
      });
    }
    const screen = a.permissions.filter((p) => /Accessibility|Screen Recording|Full Disk/.test(p));
    if (screen.length > 0) {
      attention.push({ kind: "screen", title: `${a.name} can ${describeReach(screen)}`, detail: screen.join(", ") });
    }
  }
  const inheritSeen = new Set<string>();
  for (const a of agents) {
    for (const ip of a.inherits) {
      const strong = ip.permissions.filter((p) => /Full Disk|Accessibility|Screen Recording/.test(p));
      if (strong.length === 0 || inheritSeen.has(ip.from)) continue;
      inheritSeen.add(ip.from);
      attention.push({
        kind: "inherit",
        title: `Command-line agents started in ${ip.from} get ${strong.join(" and ")}`,
        detail: "They run with the terminal's macOS permissions.",
      });
    }
  }
  for (const b of absent) {
    const creds = b.footprint.filter((f) => f.kind === "credentials");
    if (creds.length > 0) {
      attention.push({
        kind: "credentials",
        title: `${b.name} isn't installed but left a login behind`,
        detail: creds.map((f) => f.path).join(", "),
      });
    }
    const keyed = b.mcp.filter((m) => m.keys.length > 0);
    if (keyed.length > 0) {
      attention.push({
        kind: "keys",
        title: `${b.name}'s leftover config still hands keys to ${keyed.length} MCP server${keyed.length === 1 ? "" : "s"}`,
        detail: keyed.map((m) => `${m.name}: ${m.keys.join(", ")}`).join(" · "),
      });
    }
  }
  if (unidentified.length > 0) {
    attention.push({
      kind: "unidentified",
      title: `${unidentified.length} component${unidentified.length === 1 ? "" : "s"} nobody can vouch for`,
      detail: unidentified.map((u) => u.name).join(", "),
    });
  }

  // Most consequential first: identity problems, then credentials, then reach.
  const order: Attention["kind"][] = ["team", "credentials", "unidentified", "keys", "screen", "inherit"];
  attention.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));

  const allMcp = components.filter((c) => c.installMethod === "mcp_config");
  return {
    generatedAt: new Date().toISOString(),
    macos: macosVersion(),
    summary: {
      agents: agents.length,
      mcpServers: allMcp.length,
      serversWithKeys: allMcp.filter((c) => (c.mcp?.envKeys?.length ?? 0) > 0).length,
      running: agents.filter((a) => a.running).length,
      leftBehind: absent.length,
      notShown: input.outOfScope + (components.length - visible.size),
    },
    attention,
    agents,
    absent,
    unidentified,
    sources: {
      scanned: input.sources.filter((s) => s.found).map((s) => s.source),
      missing: input.sources.filter((s) => !s.found).map((s) => s.source),
      notes: input.sources.map((s) => s.note).filter((n): n is string => !!n),
    },
    sample: !!input.sample,
  };
}

function describeReach(perms: string[]): string {
  const parts: string[] = [];
  if (perms.some((p) => p.startsWith("Accessibility"))) parts.push("control your computer");
  if (perms.includes("Screen Recording")) parts.push("see your screen");
  if (perms.includes("Full Disk Access")) parts.push("read your whole disk");
  return parts.join(", ").replace(/, ([^,]*)$/, " and $1");
}

// Serialize for a <script type="application/json"> block. Escaping "<" keeps
// a crafted name like "</script>" from closing the tag.
export function embedJson(model: ReportModel): string {
  const text = JSON.stringify(model)
    .replace(/</g, "\\u003c")
    .split(String.fromCharCode(0x2028)).join("\\u2028")
    .split(String.fromCharCode(0x2029)).join("\\u2029");
  // Last line of defense: paths in the model are generalized already; make
  // sure no literal home directory slipped through anywhere else.
  const home = JSON.stringify(homeDir()).slice(1, -1);
  if (!home || home === "/") return text;
  return text.split(`${home}/`).join("~/");
}

// `fragment` omits <!doctype>/<html>/<head>/<body> for hosts that supply them.
export function renderHtmlReport(model: ReportModel, opts: { fragment?: boolean } = {}): string {
  const body = `<title>Agent Inventory</title>
<style>${CSS}</style>
<div id="app" class="wrap" aria-live="polite"></div>
<noscript><p class="wrap">This report needs JavaScript to display the scan results.</p></noscript>
<script type="application/json" id="scan-data">${embedJson(model)}</script>
<script>${JS}</script>`;
  if (opts.fragment) return body;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
</head>
<body>
${body}
</body>
</html>
`;
}

// Layout: a visitor log. Summary line, "worth a look" list, then one card per
// guest with its paperwork (signature), what it was handed (MCP servers, keys,
// permissions) and what it keeps in the room (files on disk).
const CSS = `
:root {
  --bg: #f3f5f8; --surface: #ffffff; --sunk: #eef1f5; --fg: #17202e; --muted: #5b6678;
  --line: #d9dfe8; --accent: #2f55d4; --accent-soft: #e6ecfd;
  --ok: #217a52; --ok-soft: #e3f3ea; --warn: #9a6200; --warn-soft: #fbefd9; --alert: #b23a3a; --alert-soft: #fbe6e6;
  --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif;
  --display: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0f131a; --surface: #171c25; --sunk: #1d2330; --fg: #e5e9f0; --muted: #98a3b6;
  --line: #2a3242; --accent: #8ea6ff; --accent-soft: #1f2a4a;
  --ok: #6fcf9f; --ok-soft: #173326; --warn: #e3b25a; --warn-soft: #3a2c12; --alert: #f08c8c; --alert-soft: #3d1c1f;
  color-scheme: dark;
} }
:root[data-theme="dark"] {
  --bg: #0f131a; --surface: #171c25; --sunk: #1d2330; --fg: #e5e9f0; --muted: #98a3b6;
  --line: #2a3242; --accent: #8ea6ff; --accent-soft: #1f2a4a;
  --ok: #6fcf9f; --ok-soft: #173326; --warn: #e3b25a; --warn-soft: #3a2c12; --alert: #f08c8c; --alert-soft: #3d1c1f;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--bg); color: var(--fg); font: 15px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
.wrap { max-width: 1040px; margin: 0 auto; padding: 32px 20px 64px; display: grid; gap: 28px; }
h1, h2, h3 { font-family: var(--display); margin: 0; text-wrap: balance; }
h1 { font-size: 28px; font-weight: 700; letter-spacing: -0.01em; }
h2 { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
h3 { font-size: 18px; font-weight: 650; }
p { margin: 0; }
code, .mono { font-family: var(--mono); font-size: 12.5px; }
.muted { color: var(--muted); }
.sample { background: var(--warn-soft); color: var(--warn); border-radius: 8px; padding: 10px 14px; font-size: 14px; }

header.top { display: grid; gap: 10px; }
.meta { color: var(--muted); font-size: 13px; }
.tally { display: flex; flex-wrap: wrap; gap: 8px 22px; margin-top: 6px; font-variant-numeric: tabular-nums; }
.tally div { display: flex; align-items: baseline; gap: 6px; }
.tally b { font-family: var(--display); font-size: 22px; font-weight: 700; }
.tally span { color: var(--muted); font-size: 13px; }

section { display: grid; gap: 12px; }
.attn { display: grid; gap: 8px; }
.attn-item { display: grid; grid-template-columns: 6px 1fr; gap: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px 12px 12px; }
.attn-item .stripe { border-radius: 3px; background: var(--warn); }
.attn-item[data-kind="team"] .stripe, .attn-item[data-kind="credentials"] .stripe, .attn-item[data-kind="unidentified"] .stripe { background: var(--alert); }
.attn-item[data-kind="inherit"] .stripe, .attn-item[data-kind="screen"] .stripe { background: var(--accent); }
.attn-item p.t { font-weight: 600; }
.attn-item p.d { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.calm { color: var(--ok); background: var(--ok-soft); border-radius: 10px; padding: 12px 14px; }

.controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.controls input { flex: 1 1 220px; min-width: 0; font: inherit; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); color: var(--fg); }
.chip-btn { font: inherit; font-size: 13px; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); color: var(--fg); cursor: pointer; }
.chip-btn[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.cards { display: grid; gap: 12px; }
details.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; }
details.card > summary { list-style: none; cursor: pointer; padding: 14px 16px; display: grid; gap: 8px; }
details.card > summary::-webkit-details-marker { display: none; }
.card-head { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; justify-content: space-between; }
.card-head .who { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; min-width: 0; }
.card-head .kind { color: var(--muted); font-size: 13px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--sunk); color: var(--muted); white-space: nowrap; }
.chip.ok { background: var(--ok-soft); color: var(--ok); }
.chip.warn { background: var(--warn-soft); color: var(--warn); }
.chip.alert { background: var(--alert-soft); color: var(--alert); }
.chip.live { background: var(--accent-soft); color: var(--accent); }
.chip.live::before { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: currentColor; margin-right: 5px; vertical-align: 1px; }
.card-body { border-top: 1px solid var(--line); padding: 14px 16px 16px; display: grid; gap: 14px; }
.row { display: grid; grid-template-columns: 130px 1fr; gap: 4px 16px; }
.row > .k { color: var(--muted); font-size: 13px; padding-top: 1px; }
.row > .v { min-width: 0; overflow-wrap: anywhere; }
.tbl-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; font-variant-numeric: tabular-nums; }
th { text-align: left; font-weight: 600; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; padding: 6px 10px 6px 0; border-bottom: 1px solid var(--line); }
td { padding: 7px 10px 7px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
td.num { text-align: right; white-space: nowrap; }
.key { font-family: var(--mono); font-size: 12px; background: var(--warn-soft); color: var(--warn); border-radius: 4px; padding: 1px 5px; margin: 0 4px 2px 0; display: inline-block; }
.off { color: var(--muted); text-decoration: line-through; }
.empty { color: var(--muted); padding: 8px 0; }
footer { color: var(--muted); font-size: 13px; display: grid; gap: 6px; border-top: 1px solid var(--line); padding-top: 16px; }

@media (max-width: 640px) {
  .wrap { padding: 20px 16px 48px; }
  .row { grid-template-columns: 1fr; }
  h1 { font-size: 24px; }
}
@media (prefers-reduced-motion: no-preference) {
  details.card[open] > .card-body { animation: reveal .18s ease-out; }
  @keyframes reveal { from { opacity: .4; transform: translateY(-2px); } to { opacity: 1; transform: none; } }
}
`;

// Plain ES5-ish, no template literals: this string is embedded in a TS
// template literal. All untrusted text goes through textContent.
const JS = `
(function () {
  var data = JSON.parse(document.getElementById("scan-data").textContent);
  var app = document.getElementById("app");
  var state = { q: "", filter: "all" };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]); return parent; }
  function bytes(n) {
    if (n < 1024) return n + " B";
    var u = ["KB", "MB", "GB", "TB"], v = n / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 10 ? Math.round(v) : v.toFixed(1)) + " " + u[i];
  }
  function day(iso) { return iso ? iso.slice(0, 10) : ""; }
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }

  var CHECK = {
    matches_catalog: ["Signing team matches the catalog", "ok"],
    differs_from_catalog: ["Signing team differs from the catalog", "alert"],
    no_catalog_record: ["Catalog has no signing team on file", ""],
    not_applicable: ["", ""], none: ["", ""]
  };

  function header() {
    var h = el("header", "top");
    add(h, el("h1", null, "Agents on this Mac"));
    var when = new Date(data.generatedAt);
    add(h, el("p", "meta", "Scanned " + when.toLocaleString() + (data.macos ? " · macOS " + data.macos : "") + " · read-only, nothing left this machine"));
    var s = data.summary, t = el("div", "tally");
    [[s.agents, "agents"], [s.mcpServers, "MCP servers"], [s.serversWithKeys, "handed keys"], [s.running, "running now"], [s.leftBehind, "left behind"]].forEach(function (p) {
      var d = el("div"); add(d, el("b", null, p[0]), el("span", null, p[1])); t.appendChild(d);
    });
    add(h, t);
    if (data.sample) add(h, el("p", "sample", "Sample data from a simulated Mac. Run the scan yourself to see your own agents."));
    return h;
  }

  function attention() {
    var s = el("section");
    add(s, el("h2", null, "Worth a look"));
    if (!data.attention.length) { add(s, el("p", "calm", "Nothing stands out. No keys handed out, no signature mismatches, no logins left behind.")); return s; }
    var list = el("div", "attn");
    data.attention.forEach(function (a) {
      var item = el("div", "attn-item"); item.setAttribute("data-kind", a.kind);
      var txt = el("div"); add(txt, el("p", "t", a.title), el("p", "d", a.detail));
      add(item, el("div", "stripe"), txt); list.appendChild(item);
    });
    add(s, list);
    return s;
  }

  function row(k, v) {
    if (!v) return null;
    var r = el("div", "row"); add(r, el("div", "k", k));
    var val = typeof v === "string" ? el("div", "v", v) : v;
    if (val.className.indexOf("v") < 0) val.className += " v";
    add(r, val); return r;
  }

  function mcpTable(rows) {
    if (!rows.length) return null;
    var wrap = el("div", "tbl-wrap"), t = el("table"), head = el("tr");
    ["Server", "Reaches", "Keys it receives"].forEach(function (h) { head.appendChild(el("th", null, h)); });
    t.appendChild(head);
    rows.forEach(function (m) {
      var tr = el("tr");
      var n = el("td", m.enabled ? null : "off", m.name);
      var reach = el("td"); add(reach, el("span", "mono", m.target || "—"));
      var bits = [m.transport === "http" ? "remote" : m.transport === "stdio" ? "runs locally" : ""];
      if (m.tools) bits.push(plural(m.tools, "declared tool"));
      if (m.scope) bits.push(m.scope);
      if (!m.enabled) bits.push("disabled");
      bits = bits.filter(Boolean);
      if (bits.length) add(reach, el("div", "muted", bits.join(" · ")));
      var keys = el("td");
      if (m.keys.length) m.keys.forEach(function (k) { keys.appendChild(el("span", "key", k)); });
      else keys.appendChild(el("span", "muted", "none"));
      add(tr, n, reach, keys); t.appendChild(tr);
    });
    return add(wrap, t);
  }

  function diskTable(rows) {
    if (!rows.length) return null;
    var wrap = el("div", "tbl-wrap"), t = el("table"), head = el("tr");
    ["Location", "What", "Size", "Changed"].forEach(function (h, i) { var th = el("th", null, h); if (i === 2) th.style.textAlign = "right"; head.appendChild(th); });
    t.appendChild(head);
    rows.forEach(function (f) {
      var tr = el("tr");
      var what = el("td"); add(what, el("span", "chip" + (f.kind === "credentials" ? " alert" : f.kind === "transcripts" ? " warn" : ""), f.kind));
      var size = bytes(f.bytes) + (f.truncated ? "+" : "") + (f.files > 1 ? " · " + f.files.toLocaleString() + (f.truncated ? "+" : "") + " files" : "");
      add(tr, add(el("td"), el("span", "mono", f.path)), what, el("td", "num", size), el("td", "num", day(f.lastModified)));
      t.appendChild(tr);
    });
    return add(wrap, t);
  }

  function totalBytes(fp) { return fp.reduce(function (a, f) { return a + f.bytes; }, 0); }

  function card(a, open) {
    var d = el("details", "card"); if (open) d.open = true;
    var sum = el("summary"), head = el("div", "card-head"), who = el("div", "who");
    add(who, el("h3", null, a.name), el("span", "kind", a.kind + " · " + a.via));
    add(head, who, el("code", "muted", a.binary));
    var chips = el("div", "chips");
    var c = CHECK[a.check] || ["", ""];
    if (c[0]) chips.appendChild(el("span", "chip " + c[1], c[1] === "ok" ? "Verified publisher" : c[1] === "alert" ? "Publisher mismatch" : "Publisher not on file"));
    else chips.appendChild(el("span", "chip", a.signing));
    if (a.running) chips.appendChild(el("span", "chip live", "Running"));
    if (a.mcp.length) chips.appendChild(el("span", "chip", plural(a.mcp.length, "MCP server")));
    var keyed = a.mcp.filter(function (m) { return m.keys.length; }).length;
    if (keyed) chips.appendChild(el("span", "chip warn", "Hands out keys"));
    if (a.permissions.length) chips.appendChild(el("span", "chip warn", plural(a.permissions.length, "permission")));
    if (a.footprint.length) chips.appendChild(el("span", "chip", bytes(totalBytes(a.footprint)) + " on disk"));
    add(sum, head, chips); d.appendChild(sum);

    var body = el("div", "card-body");
    var pub = a.publisher ? a.publisher + (c[0] ? " · " + c[0] : "") : a.signing === "Unsigned" ? "Not code-signed" : "No code signature to check (script, package or config)";
    add(body, row("Publisher", pub), row("Location", add(el("div"), el("span", "mono", a.path))));
    if (a.permissions.length) add(body, row("Permissions", a.permissions.join(", ")));
    if (a.inherits.length) add(body, row("Inherits", a.inherits.map(function (i) { return "In " + i.from + ": " + i.permissions.join(", "); }).join(" · ")));
    if (a.bridges.length) add(body, row("Browser", a.bridges.map(function (b) { return b.name + " → " + (b.browsers.join(", ") || "browser") + (b.extensions.length ? " (" + b.extensions.join(", ") + ")" : ""); }).join(" · ")));
    if (a.extension) {
      add(body, row("In browsers", a.extension.browsers.join(", ")));
      if (a.extension.permissions.length) add(body, row("Declares", a.extension.permissions.join(", ")));
    }
    if (a.mcp.length) add(body, row("MCP servers", mcpTable(a.mcp)));
    if (a.footprint.length) add(body, row("Keeps on disk", diskTable(a.footprint)));
    if (a.running) add(body, row("Running now", a.children.length ? "Underneath it: " + a.children.join(", ") : "Yes"));
    d.appendChild(body);
    return d;
  }

  function absentCard(b) {
    var d = el("details", "card"); d.open = true;
    var sum = el("summary"), head = el("div", "card-head"), who = el("div", "who");
    add(who, el("h3", null, b.name), el("span", "kind", "Not found installed · its config and data remain"));
    add(head, who);
    var chips = el("div", "chips");
    if (b.mcp.length) chips.appendChild(el("span", "chip", plural(b.mcp.length, "MCP server")));
    if (b.footprint.some(function (f) { return f.kind === "credentials"; })) chips.appendChild(el("span", "chip alert", "Login left behind"));
    if (b.footprint.length) chips.appendChild(el("span", "chip", bytes(totalBytes(b.footprint)) + " on disk"));
    add(sum, head, chips); d.appendChild(sum);
    var body = el("div", "card-body");
    if (b.mcp.length) add(body, row("MCP servers", mcpTable(b.mcp)));
    if (b.footprint.length) add(body, row("Keeps on disk", diskTable(b.footprint)));
    d.appendChild(body);
    return d;
  }

  function matches(a) {
    var q = state.q.toLowerCase();
    if (q) {
      var hay = [a.name, a.kind, a.via, a.binary, a.path].concat(a.mcp.map(function (m) { return m.name + " " + m.target + " " + m.keys.join(" "); })).join(" ").toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    if (state.filter === "running") return !!a.running;
    if (state.filter === "keys") return a.mcp.some(function (m) { return m.keys.length; });
    if (state.filter === "perms") return a.permissions.length > 0 || a.inherits.length > 0;
    return true;
  }

  var cardsHost = el("div", "cards");
  function renderCards() {
    cardsHost.textContent = "";
    var shown = data.agents.filter(matches);
    if (!shown.length) { cardsHost.appendChild(el("p", "empty", data.agents.length ? "No agents match." : "No known agents found on this Mac.")); return; }
    shown.forEach(function (a) { cardsHost.appendChild(card(a, shown.length <= 4)); });
  }

  function agentsSection() {
    var s = el("section");
    add(s, el("h2", null, "Agents"));
    var controls = el("div", "controls");
    var search = el("input"); search.id = "search"; search.type = "search"; search.placeholder = "Search agents, servers, keys"; search.setAttribute("aria-label", "Search agents");
    search.addEventListener("input", function () { state.q = search.value; renderCards(); });
    controls.appendChild(search);
    [["all", "All"], ["running", "Running"], ["keys", "Hands out keys"], ["perms", "Has permissions"]].forEach(function (f) {
      var b = el("button", "chip-btn", f[1]); b.type = "button"; b.setAttribute("aria-pressed", String(state.filter === f[0]));
      b.addEventListener("click", function () {
        state.filter = f[0];
        Array.prototype.forEach.call(controls.querySelectorAll(".chip-btn"), function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        renderCards();
      });
      controls.appendChild(b);
    });
    add(s, controls, cardsHost);
    renderCards();
    return s;
  }

  function absentSection() {
    if (!data.absent.length) return null;
    var s = el("section");
    add(s, el("h2", null, "Left behind"));
    add(s, el("p", "muted", "Agents that aren't installed here, but whose settings, transcripts or logins are still on disk."));
    var host = el("div", "cards");
    data.absent.forEach(function (b) { host.appendChild(absentCard(b)); });
    return add(s, host);
  }

  function unidentifiedSection() {
    if (!data.unidentified.length) return null;
    var s = el("section");
    add(s, el("h2", null, "Unidentified"));
    var wrap = el("div", "tbl-wrap"), t = el("table"), head = el("tr");
    ["Name", "Found via", "Location"].forEach(function (h) { head.appendChild(el("th", null, h)); });
    t.appendChild(head);
    data.unidentified.forEach(function (u) { var tr = el("tr"); add(tr, el("td", null, u.name), el("td", null, u.via), add(el("td"), el("span", "mono", u.path))); t.appendChild(tr); });
    return add(s, add(wrap, t));
  }

  function footer() {
    var f = el("footer");
    add(f, el("p", null, "Looked in: " + (data.sources.scanned.join(", ") || "nothing")));
    if (data.sources.missing.length) add(f, el("p", null, "Not on this Mac: " + data.sources.missing.join(", ")));
    data.sources.notes.forEach(function (n) { add(f, el("p", null, n)); });
    if (data.summary.notShown) add(f, el("p", null, plural(data.summary.notShown, "other app or package") + " not shown. Run the scan with --all to include them."));
    add(f, el("p", null, "Key names are shown; key values never are. File sizes are measured; contents are never opened."));
    return f;
  }

  add(app, header(), attention(), agentsSection(), absentSection(), unidentifiedSection(), footer());
})();
`;
