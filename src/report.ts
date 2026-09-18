import { Component, SigningStatus } from "./types";
import { generalizePath, componentIdentifier, sanitizeForTerminal } from "./util";

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

// Render the default table. MCP servers linked to a host app are printed
// indented beneath that host so the "family tree" reads clearly; everything
// else prints flat. External-derived names are shown verbatim (data, not
// markup).
export function renderTable(components: Component[]): string {
  const printed = new Set<Component>();
  const rows: { indent: boolean; c: Component }[] = [];

  const apps = components.filter((c) => c.installMethod === "app_bundle");
  const byId = new Map<string, Component>();
  for (const c of components) byId.set(componentIdentifier(c), c);

  // Host apps first, each followed by its linked mcp_config servers.
  for (const app of apps) {
    rows.push({ indent: false, c: app });
    printed.add(app);
    for (const relId of app.relatedComponents || []) {
      const server = byId.get(relId);
      if (server && !printed.has(server)) {
        rows.push({ indent: true, c: server });
        printed.add(server);
      }
    }
  }

  // Everything not already printed, in stable name order.
  const rest = components
    .filter((c) => !printed.has(c))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const c of rest) rows.push({ indent: false, c });

  const nameCells = rows.map(
    (r) => (r.indent ? "  └ " : "") + sanitizeForTerminal(r.c.name)
  );
  const nameWidth = Math.max(4, ...nameCells.map((s) => s.length)) + 2;
  const methodWidth = 14;
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

  const total = components.length;
  const identified = components.filter((c) => c.identified).length;
  const unidentified = total - identified;
  lines.push("");
  lines.push(
    `${total} component${total === 1 ? "" : "s"} found · ${identified} identified · ${unidentified} unidentified`
  );

  return lines.join("\n");
}

// Full JSON output: the Component[] array, paths generalized so no username
// leaks into machine-readable output either. Stable field order via the schema.
export function renderJson(components: Component[]): string {
  const safe = components.map((c) => ({
    ...c,
    path: generalizePath(c.path),
  }));
  return JSON.stringify(safe, null, 2);
}
