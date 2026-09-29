import {
  Component,
  DataFootprint,
  McpServerDetails,
  PublisherCheck,
  SigningStatus,
} from "./types";
import { generalizePath, componentIdentifier, sanitizeForTerminal, homeDir } from "./util";
import { CatalogEntry, entryId } from "./catalog";
import { Leftover } from "./footprint";

// Human-readable signing string. Reported as plain fact — no color coding, no
// ranking. "—" means signing does not apply / is not determinable.
function signingLabel(s: SigningStatus): string {
  switch (s) {
    case "signed_notarized":
      return "notarized";
    case "signed_unnotarized":
      return "signed";
    case "unsigned":
      return "unsigned";
    case "unknown":
    default:
      return "—";
  }
}

function methodLabel(m: string): string {
  switch (m) {
    case "mcp_config":
      return "mcp config";
    case "app_bundle":
      return "app bundle";
    case "launch_item":
      return "launch item";
    case "cli_on_path":
      return "on PATH";
    case "native_messaging_host":
      return "browser bridge";
    case "browser_extension":
      return "browser ext";
    default:
      return m;
  }
}

function idLabel(c: Component): string {
  return c.identified ? "identified" : "unidentified";
}

function firstSeenLabel(iso: string): string {
  if (!iso) return "—";
  return iso.slice(0, 10); // YYYY-MM-DD
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

// Components that belong in the default, agent-focused view:
//   - anything the catalog recognizes as an agent
//   - every MCP server
//   - anything unidentified (the strangers are the point)
//   - plus whatever is linked to those (an app's MCP servers and browser
//     bridges, a bridge's extensions) so the family tree stays whole.
// Everything else (ordinary apps, packages, launch items with a known
// publisher) is only listed with --all.
export function agentRelated(components: Component[]): Set<Component> {
  const byId = new Map<string, Component>();
  for (const c of components) byId.set(componentIdentifier(c), c);

  const shown = new Set<Component>();
  for (const c of components) {
    if (c.agent || c.installMethod === "mcp_config" || !c.identified) shown.add(c);
  }

  // Parents of shown components (one level): keeps e.g. an app whose bridge is
  // a known agent visible above it.
  for (const c of components) {
    for (const rel of c.relatedComponents || []) {
      const child = byId.get(rel);
      if (child && shown.has(child) && child.agent) shown.add(c);
    }
  }

  // Descendants of shown components, transitively.
  const queue = Array.from(shown);
  while (queue.length > 0) {
    const c = queue.shift()!;
    for (const rel of c.relatedComponents || []) {
      const child = byId.get(rel);
      if (child && !shown.has(child)) {
        shown.add(child);
        queue.push(child);
      }
    }
  }
  return shown;
}

export interface TableOptions {
  // Only list agent-related components (see agentRelated). Default false, so
  // renderTable(components) lists everything as it always has.
  agentsOnly?: boolean;
}

// Render the table. Linked components print indented beneath what they belong
// to (MCP servers under their client, a browser bridge under its app, an
// extension under its bridge) so the "family tree" reads clearly; everything
// else prints flat. External-derived names are shown verbatim (data, not
// markup).
export function renderTable(components: Component[], opts: TableOptions = {}): string {
  const visible = opts.agentsOnly
    ? agentRelated(components)
    : new Set<Component>(components);
  const list = components.filter((c) => visible.has(c));
  const rows = treeRows(list);

  const nameCells = rows.map(
    (r) => treePrefix(r.depth) + sanitizeForTerminal(r.c.name)
  );
  const nameWidth = Math.max(4, ...nameCells.map((s) => s.length)) + 2;
  const methodWidth = 16;
  const signWidth = 12;
  const statusWidth = 14;

  const header =
    pad("NAME", nameWidth) +
    pad("INSTALLED VIA", methodWidth) +
    pad("SIGNED", signWidth) +
    pad("STATUS", statusWidth) +
    "FIRST SEEN";

  const lines: string[] = [header];
  rows.forEach((r, i) => {
    lines.push(
      pad(nameCells[i], nameWidth) +
        pad(methodLabel(r.c.installMethod), methodWidth) +
        pad(signingLabel(r.c.signingStatus), signWidth) +
        pad(idLabel(r.c), statusWidth) +
        firstSeenLabel(r.c.firstSeen)
    );
  });

  const total = list.length;
  const identified = list.filter((c) => c.identified).length;
  const unidentified = total - identified;
  lines.push("");
  if (opts.agentsOnly) {
    const hidden = components.length - total;
    lines.push(
      `${total} agent-related component${total === 1 ? "" : "s"} · ${identified} identified · ${unidentified} unidentified` +
        (hidden > 0
          ? ` · ${hidden} other app${hidden === 1 ? "" : "s"} or package${hidden === 1 ? "" : "s"} not shown (--all lists everything)`
          : "")
    );
  } else {
    lines.push(
      `${total} component${total === 1 ? "" : "s"} found · ${identified} identified · ${unidentified} unidentified`
    );
  }

  return lines.join("\n");
}

function treePrefix(depth: number): string {
  if (depth === 0) return "";
  return "  ".repeat(depth - 1) + "  └ ";
}

// Order rows: roots (app bundles first, then by name), each followed by its
// linked components depth-first. Cycles and repeats are guarded.
function treeRows(list: Component[]): { depth: number; c: Component }[] {
  const byId = new Map<string, Component>();
  for (const c of list) byId.set(componentIdentifier(c), c);

  const isChild = new Set<Component>();
  for (const c of list) {
    for (const rel of c.relatedComponents || []) {
      const child = byId.get(rel);
      if (child && child !== c) isChild.add(child);
    }
  }

  const roots = list
    .filter((c) => !isChild.has(c))
    .sort((a, b) => {
      const aa = a.installMethod === "app_bundle" ? 0 : 1;
      const bb = b.installMethod === "app_bundle" ? 0 : 1;
      if (aa !== bb) return aa - bb;
      return aa === 0 ? 0 : a.name.localeCompare(b.name); // apps keep scan order
    });

  const rows: { depth: number; c: Component }[] = [];
  const printed = new Set<Component>();
  const visit = (c: Component, depth: number) => {
    if (printed.has(c)) return;
    printed.add(c);
    rows.push({ depth, c });
    for (const rel of c.relatedComponents || []) {
      const child = byId.get(rel);
      if (child) visit(child, depth + 1);
    }
  };
  for (const r of roots) visit(r, 0);
  // Anything only reachable through a cycle.
  for (const c of list) visit(c, 0);
  return rows;
}

// ---------------------------------------------------------------------------
// Details: one block per known agent (and per MCP server with no linked
// client), with only the lines that have something to say.
// ---------------------------------------------------------------------------
export interface DetailOptions {
  // Known agents not installed here whose data is still on disk.
  leftovers?: Leftover[];
  // Used to name clients by their catalog display name.
  catalog?: CatalogEntry[];
}

export function renderDetails(components: Component[], opts: DetailOptions = {}): string {
  const byId = new Map<string, Component>();
  for (const c of components) byId.set(componentIdentifier(c), c);
  const catalogNames = new Map<string, string>();
  for (const e of opts.catalog ?? []) catalogNames.set(entryId(e), e.identity.displayName);

  const visible = agentRelated(components);
  const blocks: string[] = [];

  const agents = components
    .filter((c) => visible.has(c) && c.agent && c.installMethod !== "mcp_config")
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const c of agents) blocks.push(agentBlock(c, byId));

  // Agents that aren't installed but left config and data behind: MCP servers
  // whose client wasn't found, and catalog data locations that still exist.
  // Grouped by client (catalog id when known, else the config's client name).
  interface Absent {
    title: string;
    servers: Component[];
    footprint: DataFootprint[];
  }
  const absent = new Map<string, Absent>();
  const slot = (key: string, title: string): Absent => {
    let a = absent.get(key);
    if (!a) {
      a = { title, servers: [], footprint: [] };
      absent.set(key, a);
    }
    return a;
  };

  for (const s of components) {
    if (s.installMethod !== "mcp_config") continue;
    if (s.hostApp && byId.has(s.hostApp)) continue; // linked to an installed client
    const clientId = s.mcp?.clientId;
    const rawName = (s.hostApp || "unknown client").replace(/\s*\(.*\)\s*$/, "");
    const key = clientId ? `id:${clientId}` : `raw:${rawName}`;
    const title = clientId ? catalogNames.get(clientId) || rawName : rawName;
    slot(key, title).servers.push(s);
  }
  for (const l of opts.leftovers ?? []) {
    slot(`id:${l.catalogId}`, l.displayName).footprint.push(...l.footprint);
  }

  for (const a of absent.values()) {
    const lines = [`${sanitizeForTerminal(a.title)}  ·  not found installed on this Mac  ·  its config and data remain`];
    lines.push(...labeled("MCP servers", a.servers.map(mcpLine)));
    lines.push(...labeled("Keeps on disk", footprintLines(a.footprint)));
    blocks.push(lines.join("\n"));
  }

  if (blocks.length === 0) return "";
  return ["DETAILS", "", blocks.join("\n\n")].join("\n");
}

const LABEL_WIDTH = 14;

function labeled(label: string, values: string[]): string[] {
  if (values.length === 0) return [];
  return values.map(
    (v, i) => "  " + pad(i === 0 ? label : "", LABEL_WIDTH) + v
  );
}

function agentBlock(c: Component, byId: Map<string, Component>): string {
  const title = `${sanitizeForTerminal(c.name)}  ·  ${methodLabel(c.installMethod)}  ·  ${sanitizeForTerminal(
    generalizePath(c.executablePath || c.path)
  )}`;
  const lines: string[] = [title];

  lines.push(...labeled("Publisher", [publisherLine(c)]));

  if (c.permissions && c.permissions.length > 0) {
    lines.push(...labeled("Permissions", [c.permissions.join(", ")]));
  }
  if (c.inheritedPermissions && c.inheritedPermissions.length > 0) {
    lines.push(
      ...labeled(
        "Inherits",
        c.inheritedPermissions.map(
          (ip) => `when run in ${ip.from}: ${ip.permissions.join(", ")}`
        )
      )
    );
  }

  const servers = (c.relatedComponents || [])
    .map((id) => byId.get(id))
    .filter((s): s is Component => !!s && s.installMethod === "mcp_config");
  lines.push(...labeled("MCP servers", servers.map(mcpLine)));

  const bridges = (c.relatedComponents || [])
    .map((id) => byId.get(id))
    .filter((s): s is Component => !!s && s.installMethod === "native_messaging_host");
  lines.push(...labeled("Browser", bridges.map((b) => bridgeLine(b, byId))));

  if (c.installMethod === "native_messaging_host") {
    lines.push(...labeled("Bridges to", [bridgeLine(c, byId)]));
  }
  if (c.installMethod === "browser_extension" && c.browser) {
    lines.push(...labeled("In browsers", [c.browser.browsers.join(", ")]));
    if (c.browser.permissions && c.browser.permissions.length > 0) {
      lines.push(...labeled("Declares", [c.browser.permissions.map(sanitizeForTerminal).join(", ")]));
    }
  }

  lines.push(...labeled("Keeps on disk", footprintLines(c.footprint || [])));

  if (c.running) {
    const kids = (c.runningChildren || []).map((k) => sanitizeForTerminal(k.label));
    lines.push(
      ...labeled("Running now", [
        kids.length > 0 ? `yes · underneath it: ${kids.join(", ")}` : "yes",
      ])
    );
  }
  return lines.join("\n");
}

function checkLabel(pc: PublisherCheck | undefined): string {
  switch (pc) {
    case "matches_catalog":
      return "signing team matches the catalog";
    case "differs_from_catalog":
      return "signing team differs from the catalog's record";
    case "no_catalog_record":
      return "catalog has no signing team on file yet";
    default:
      return "";
  }
}

function publisherLine(c: Component): string {
  const check = checkLabel(c.publisherCheck);
  if (c.teamId || (c.publisher && c.signingStatus !== "unknown")) {
    const who = sanitizeForTerminal(c.publisher || `TeamID ${c.teamId}`);
    return check ? `${who} · ${check}` : who;
  }
  if (c.signingStatus === "unsigned") return "not code-signed";
  return "no code signature to check (script, package, or config)";
}

export function mcpLine(s: Component): string {
  const d: McpServerDetails | undefined = s.mcp;
  const parts: string[] = [];
  if (d) {
    if (d.transport !== "unknown") parts.push(d.transport);
    if (d.urlHost) parts.push(d.urlHost);
    else if (d.launches) parts.push(`${d.command ?? ""} ${d.launches}`.trim());
    else if (d.command) parts.push(d.command);
    if (d.envKeys && d.envKeys.length > 0) parts.push(`passes ${d.envKeys.join(", ")}`);
    if (d.tools && d.tools.length > 0) parts.push(`${d.tools.length} declared tools`);
    if (d.scope && d.scope !== "user") parts.push(d.scope);
    if (d.enabled === false) parts.push("disabled");
  }
  const detail = parts.length > 0 ? ` (${parts.map(sanitizeForTerminal).join(" · ")})` : "";
  return `${sanitizeForTerminal(s.name)}${detail}`;
}

function bridgeLine(host: Component, byId: Map<string, Component>): string {
  const exts = (host.relatedComponents || [])
    .map((id) => byId.get(id))
    .filter((e): e is Component => !!e && e.installMethod === "browser_extension")
    .map((e) => sanitizeForTerminal(e.name));
  const browsers = host.browser?.browsers.join(", ") || "browser";
  const allowed = host.browser?.extensionIds?.length ?? 0;
  const extText =
    exts.length > 0
      ? `extension ${exts.join(", ")}`
      : `${allowed} allowed extension ID${allowed === 1 ? "" : "s"}, none installed`;
  return `${sanitizeForTerminal(host.name)} → ${browsers} (${extText})`;
}

function footprintLines(fp: DataFootprint[]): string[] {
  if (fp.length === 0) return [];
  const pathWidth = Math.min(48, Math.max(...fp.map((f) => f.path.length)) + 2);
  return fp.map((f) => {
    const size = `${formatBytes(f.bytes)}${f.truncated ? "+" : ""}`;
    const files = f.files === 1 ? "" : ` · ${f.files.toLocaleString("en-US")}${f.truncated ? "+" : ""} files`;
    const changed = f.lastModified ? ` · changed ${f.lastModified.slice(0, 10)}` : "";
    const shownPath = sanitizeForTerminal(f.path);
    const pathCell = shownPath.length >= pathWidth ? `${shownPath}  ` : pad(shownPath, pathWidth);
    return `${pathCell}${pad(f.kind, 14)}${size}${files}${changed}`;
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// Full JSON output: the Component[] array, paths generalized so no username
// leaks into machine-readable output either. Every component is included;
// `agentRelated` marks the ones the default table shows.
export function renderJson(components: Component[]): string {
  const shown = agentRelated(components);
  const safe = components.map((c) => ({
    ...c,
    path: generalizePath(c.path),
    ...(c.executablePath ? { executablePath: generalizePath(c.executablePath) } : {}),
    agentRelated: shown.has(c),
  }));
  // Paths also ride inside sourceRefs and relatedComponents identifiers;
  // generalize every occurrence of the home directory, not just `path`.
  const text = JSON.stringify(safe, null, 2);
  const home = JSON.stringify(homeDir()).slice(1, -1);
  if (!home || home === "/") return text;
  return text.split(`${home}/`).join("~/").split(`"${home}"`).join('"~"');
}
