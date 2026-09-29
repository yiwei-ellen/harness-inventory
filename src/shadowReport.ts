import * as readline from "readline";
import * as crypto from "crypto";
import { Component } from "./types";
import {
  generalizePath,
  sha256File,
  fileSize,
  macosVersion,
  sanitizeForTerminal,
} from "./util";

// Pinned project repository for shadow-agent issue drafts. Issues open in the
// user's browser prefilled; the user submits — nothing is posted programmatically.
export const REPO_SLUG = "yiwei-ellen/harness-inventory";
const ISSUE_NEW_URL = `https://github.com/${REPO_SLUG}/issues/new`;

export interface ShadowPayload {
  fingerprint_hash: string;
  match_path: string; // generalized (~), never a username
  match_bundle_id: string;
  install_method: string;
  signing_status: string; // status + publisher
  file_size: string;
  first_seen: string;
  macos_version: string;
}

export interface ShadowDraft {
  component: Component;
  payload: ShadowPayload;
  url: string;
}

// Build the per-component payload. Path is generalized so no $HOME or username
// appears. The fingerprint is the SHA-256 of the binary when the path is a file;
// when it is not a single file (e.g. an app bundle directory), we fingerprint
// the generalized identity string instead, which keeps the hash-in-title
// search/dedup property (same component on many machines -> same hash).
export function buildPayload(c: Component): ShadowPayload {
  const genPath = generalizePath(c.path);
  let hash = sha256File(c.path);
  if (!hash) {
    hash = crypto
      .createHash("sha256")
      .update(`${c.installMethod}|${genPath}|${c.name}`)
      .digest("hex");
  }
  const size = fileSize(c.path);
  const signing = c.publisher
    ? `${c.signingStatus}; ${c.publisher}`
    : c.signingStatus;

  return {
    fingerprint_hash: hash,
    match_path: genPath,
    match_bundle_id: c.bundleId || "",
    install_method: c.installMethod,
    signing_status: signing,
    file_size: size != null ? `${size} bytes` : "unknown",
    first_seen: c.firstSeen || "unknown",
    macos_version: macosVersion() || "unknown",
  };
}

// One prefilled issue URL per component. The SHA-256 hash leads the title as
// `[shadow-agent] <hash>` so maintainers can search a hash and count how many
// machines reported the same fingerprint. Extra context (file size, macOS
// version) rides in the optional notes field, clearly labeled as auto-collected.
export function buildUrl(p: ShadowPayload): string {
  const params = new URLSearchParams();
  params.set("template", "shadow-agent.yml");
  params.set("title", `[shadow-agent] ${p.fingerprint_hash}`);
  params.set("fingerprint_hash", p.fingerprint_hash);
  params.set("match_path", p.match_path);
  params.set("match_bundle_id", p.match_bundle_id);
  params.set("install_method", p.install_method);
  params.set("signing_status", p.signing_status);
  params.set("first_seen", p.first_seen);
  params.set(
    "anything_known",
    `(auto-collected, edit freely) file size: ${p.file_size}; macOS: ${p.macos_version}`
  );
  return `${ISSUE_NEW_URL}?${params.toString()}`;
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a)));
}

// Stage 6 entry point. Prompts once; on "yes" prints every payload, takes ONE
// confirmation covering all, then opens each draft in sequence (or prints all
// URLs with noBrowser). Never submits.
export async function runShadowReport(
  components: Component[],
  opts: { noBrowser: boolean; openFn: (url: string) => void }
): Promise<void> {
  // Shadow reporting covers MCP servers only: an MCP server you configured is an
  // agent by definition, so one the catalog doesn't recognize is a genuine
  // "shadow agent" worth reporting. Non-MCP components are shown only when they
  // match the allowlist, so they are never unidentified and never reported.
  const unidentified = components.filter(
    (c) => !c.identified && c.installMethod === "mcp_config"
  );
  if (unidentified.length === 0) return; // nothing to report -> no prompt at all

  // Non-interactive stdin (piped/CI): default to No, take no network action.
  if (!process.stdin.isTTY) {
    console.log(
      `\n${unidentified.length} MCP server${
        unidentified.length === 1 ? "" : "s"
      } could not be identified. Re-run in an interactive terminal to report ${
        unidentified.length === 1 ? "it" : "them"
      }.`
    );
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const ans = (
      await ask(
        rl,
        `\n${unidentified.length} MCP server${
          unidentified.length === 1 ? "" : "s"
        } could not be identified. Report ${
          unidentified.length === 1 ? "it" : "them"
        } to help the community catalog? [y/N] `
      )
    )
      .trim()
      .toLowerCase();

    if (ans !== "y" && ans !== "yes") {
      // "no" or Enter -> no network action.
      return;
    }

    // v1 selection: all unidentified components are selected. (A per-component
    // picker is a reasonable future addition; selecting all keeps v1 simple and
    // still produces one issue per component.)
    const drafts: ShadowDraft[] = unidentified.map((c) => {
      const payload = buildPayload(c);
      return { component: c, payload, url: buildUrl(payload) };
    });

    // Print the exact payload for every component before submission.
    console.log(
      `\nThe following ${drafts.length} report${
        drafts.length === 1 ? "" : "s"
      } will be prepared as GitHub issue drafts (one per component).`
    );
    console.log("Nothing is submitted — each opens prefilled for you to review and submit.\n");
    drafts.forEach((d, i) => {
      console.log(
        `--- Report ${i + 1} of ${drafts.length}: ${sanitizeForTerminal(d.component.name)} ---`
      );
      console.log(JSON.stringify(d.payload, null, 2));
      console.log("");
    });

    // One explicit confirmation covering all of them.
    const confirm = (
      await ask(
        rl,
        `Prepare ${drafts.length} issue draft${
          drafts.length === 1 ? "" : "s"
        } with exactly the payload${drafts.length === 1 ? "" : "s"} above? [y/N] `
      )
    )
      .trim()
      .toLowerCase();

    if (confirm !== "y" && confirm !== "yes") {
      console.log("Cancelled. Nothing was opened or sent.");
      return;
    }

    if (opts.noBrowser) {
      console.log("\nOpen each URL yourself, at your own pace:\n");
      drafts.forEach((d, i) => {
        console.log(`[${i + 1}] ${sanitizeForTerminal(d.component.name)}`);
        console.log(d.url);
        console.log("");
      });
      return;
    }

    // Open each draft one at a time, pausing so browsers aren't all launched at
    // once.
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i];
      console.log(
        `\nOpening report ${i + 1} of ${drafts.length}: ${sanitizeForTerminal(d.component.name)}`
      );
      opts.openFn(d.url);
      if (i < drafts.length - 1) {
        await ask(rl, "Press Enter to open the next draft… ");
      }
    }
    console.log("\nAll drafts opened. Review and submit each on GitHub yourself.");
  } finally {
    rl.close();
  }
}
