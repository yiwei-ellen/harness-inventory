#!/usr/bin/env node
import { execFile } from "child_process";
import { runScan } from "./scan";
import { renderTable, renderJson } from "./report";
import { runShadowReport } from "./shadowReport";
import { defaultCatalogPath } from "./catalog";
import { updateCatalog } from "./network";
import { SourceResult } from "./types";

interface Options {
  json: boolean;
  noBrowser: boolean;
  updateCatalog: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): { command: string; opts: Options } {
  const opts: Options = {
    json: false,
    noBrowser: false,
    updateCatalog: false,
    help: false,
  };
  let command = "scan";
  for (const arg of argv) {
    switch (arg) {
      case "scan":
        command = "scan";
        break;
      case "--json":
        opts.json = true;
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
  return { command, opts };
}

function printHelp(): void {
  console.log(
    [
      "agent-inventory — read-only inventory of AI agents, MCP servers, and harnesses on macOS",
      "",
      "Usage:",
      "  npx agent-inventory scan [options]",
      "",
      "Options:",
      "  --json             Print the full Component[] array as JSON",
      "  --no-browser       In the report flow, print issue-draft URLs instead of opening a browser",
      "  --update-catalog   Fetch the latest known-agents.json from the project repo before scanning",
      "                     (the only network call; off by default, logged before it runs)",
      "  -h, --help         Show this help",
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
  return parts.join("\n");
}

function openInBrowser(url: string): void {
  // macOS `open`. Best-effort; failure is non-fatal (URL was already printed).
  execFile("open", [url], () => {
    /* ignore errors */
  });
}

async function main(): Promise<void> {
  const { opts } = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    return;
  }

  const catalogPath = defaultCatalogPath();

  // The single permitted background network call, opt-in and announced.
  if (opts.updateCatalog) {
    await updateCatalog(catalogPath);
  }

  const { components, sources } = runScan(catalogPath);

  if (opts.json) {
    console.log(renderJson(components));
  } else {
    console.log(renderTable(components));
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
