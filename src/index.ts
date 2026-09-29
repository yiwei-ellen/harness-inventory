#!/usr/bin/env node
import { execFile } from "child_process";
import { runScan } from "./scan";
import { renderTable, renderJson, renderDetails } from "./report";
import { runShadowReport } from "./shadowReport";
import { defaultCatalogPath, suggestTeamIds } from "./catalog";
import { updateCatalog } from "./network";
import { SourceResult } from "./types";
import { sanitizeForTerminal } from "./util";

interface Options {
  json: boolean;
  noBrowser: boolean;
  updateCatalog: boolean;
  all: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): { command: string; sub: string; opts: Options } {
  const opts: Options = {
    json: false,
    noBrowser: false,
    updateCatalog: false,
    all: false,
    help: false,
  };
  let command = "scan";
  let sub = "";
  for (const arg of argv) {
    switch (arg) {
      case "scan":
        command = "scan";
        break;
      case "catalog":
        command = "catalog";
        break;
      case "suggest":
        if (command === "catalog") sub = "suggest";
        break;
      case "--json":
        opts.json = true;
        break;
      case "--all":
        opts.all = true;
        break;
      case "--no-browser":
        opts.noBrowser = true;
        break;
      case "--update-catalog":
        opts.updateCatalog = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        // Ignore unknown args rather than failing the scan.
        break;
    }
  }
  return { command, sub, opts };
}

function printHelp(): void {
  console.log(
    [
      "agent-inventory — read-only inventory of AI agents, MCP servers, and harnesses on macOS",
      "",
      "Usage:",
      "  npx agent-inventory scan [options]",
      "  npx agent-inventory catalog suggest [--json]",
      "",
      "Options:",
      "  --all              List every app and package found, not just agent-related ones",
      "  --json             Print the full Component[] array as JSON",
      "  --no-browser       In the report flow, print issue-draft URLs instead of opening a browser",
      "  --update-catalog   Fetch the latest known-agents.json from the project repo before scanning",
      "                     (the only network call; off by default, logged before it runs)",
      "  -h, --help         Show this help",
      "",
      "catalog suggest     List signing team IDs seen on this Mac for known agents that the",
      "                     catalog has no team on file for (or a different one) — a starting",
      "                     point for a catalog pull request. Nothing is sent or written.",
      "",
      "Runs on invocation, prints a report, and exits. No daemon, no telemetry.",
    ].join("\n")
  );
}

function summarizeSources(sources: SourceResult[]): string {
  const found = sources.filter((s) => s.found).map((s) => s.source);
  const absent = sources.filter((s) => !s.found).map((s) => s.source);
  const parts: string[] = [];
  parts.push(
    `Sources scanned: ${found.length > 0 ? found.join(", ") : "(none present)"}`
  );
  if (absent.length > 0) {
    parts.push(`Not present on this machine: ${absent.join(", ")}`);
  }
  for (const s of sources) {
    if (s.note) parts.push(s.note);
  }
  return parts.join("\n");
}

function openInBrowser(url: string): void {
  // macOS `open`. Best-effort; failure is non-fatal (URL was already printed).
  execFile("open", [url], () => {
    /* ignore errors */
  });
}

function runCatalogSuggest(json: boolean): void {
  const { components, catalog } = runScan(defaultCatalogPath());
  const suggestions = suggestTeamIds(components, catalog);
  if (json) {
    console.log(JSON.stringify(suggestions, null, 2));
    return;
  }
  if (suggestions.length === 0) {
    console.log(
      "Nothing to suggest: no signed catalog agent on this Mac has a team the catalog is missing."
    );
    return;
  }
  console.log("Signing teams seen on this Mac that the catalog doesn't record yet.");
  console.log("Check each one before adding it to catalog/known-agents.json (signing.teamIds).\n");
  for (const s of suggestions) {
    const status =
      s.status === "differs_from_catalog"
        ? `catalog lists ${s.catalogTeamIds.join(", ")}`
        : "catalog has none on file";
    console.log(
      `${sanitizeForTerminal(s.catalogId)}  ${s.observedTeamId}  ${sanitizeForTerminal(
        s.observedPublisher
      )}  (${status})`
    );
  }
}

async function main(): Promise<void> {
  const { command, sub, opts } = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    return;
  }

  const catalogPath = defaultCatalogPath();

  // The single permitted background network call, opt-in and announced.
  if (opts.updateCatalog) {
    await updateCatalog(catalogPath);
  }

  if (command === "catalog") {
    if (sub === "suggest") {
      runCatalogSuggest(opts.json);
    } else {
      printHelp();
    }
    return;
  }

  const { components, sources, leftovers, catalog, outOfScope } = runScan(catalogPath, {
    all: opts.all,
  });

  if (opts.json) {
    console.log(renderJson(components));
  } else {
    console.log(renderTable(components, { agentsOnly: !opts.all, hiddenElsewhere: outOfScope }));
    const details = renderDetails(components, { leftovers, catalog });
    if (details) {
      console.log("");
      console.log(details);
    }
    console.log("");
    console.log(summarizeSources(sources));
  }

  // Stage 6: shadow-agent reporting (interactive, opt-in, never auto-submits).
  // Skipped entirely in JSON mode to keep that output machine-clean.
  if (!opts.json) {
    await runShadowReport(components, {
      noBrowser: opts.noBrowser,
      openFn: openInBrowser,
    });
  }
}

main().catch((err) => {
  // Last-resort guard: never crash with a stack trace at the user.
  console.error(`agent-inventory: unexpected error: ${err?.message ?? err}`);
  process.exitCode = 1;
});
