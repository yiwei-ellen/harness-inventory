# agent-inventory

**Your Mac has guests. This tells you who they are, how they got in, and whether anyone can vouch for them.**

AI agents move in quietly — an `npm install` here, an MCP config there — and before long you've got a houseful of software with access to your files, and nobody's checked a single ID. `agent-inventory` is a free, open-source CLI that walks the halls of your Mac, takes attendance, and gives it to you straight: who's here, what they can prove about themselves, and who's the stranger in the corner nobody recognizes.

## Why this exists

No agent vendor is ever going to hand you a guest list that includes their competitors — they have no reason to. `agent-inventory` doesn't care who made what. It just checks IDs at *your* door, not theirs.

## 🔍 What it does

- **Takes attendance** — MCP servers, agent CLIs, and agent-adjacent apps, wherever they're hiding: Homebrew, npm, pip, `.app` bundles, launch agents, MCP client configs, CLIs sitting on your `PATH`, and the browser — extensions and the "native messaging" bridges they use to reach programs on your Mac.
- **Keeps the family tree straight** — an MCP server shows up linked to the app or CLI that configured it, and a browser extension shows up under the bridge (and the app) it talks to — not swallowed inside them.
- **Checks whatever ID is actually available** — see [Trust, explained honestly](#-trust-explained-honestly) below; not everything carries the same kind of paperwork. For known agents it also checks that the signature on disk comes from the team the catalog says ships it — an app *called* "Claude" and an app *signed by Anthropic* aren't the same claim.
- **Notes what each guest was handed** — which MCP servers an agent can call (and the names of the keys it passes them — never the values), and which macOS privacy permissions it holds, including the ones a command-line agent quietly inherits from your terminal.
- **Notices what they leave in the room** — transcripts, instruction files, saved logins, downloaded models: where they are, how big, when they last changed. It measures; it never opens them. Agents you've uninstalled still show up here if their files didn't leave with them.
- **Sees who's busy right now** — for agents that are running, the processes running underneath them (`git push`, a shell, an MCP server).
- **Doesn't bluff** — an unidentified component stays labeled unidentified. No guessing, no made-up names.
- **Shows up, does the walkthrough, leaves** — no background process, no scheduled visits, no telemetry. Nothing gets sent anywhere unless you say so.

## Requirements

- **macOS.** Collection logic is macOS-only. (The output schema is written to
  tolerate other platforms later, but nothing else is scanned today.)
- **Node.js 18 or newer.** That's the only runtime dependency.

The richest results come from a normal user account — the scan reads what
*your* login can see (your MCP configs, your `~/Applications`, your login
items). It never asks for elevated privileges.

## Install

No install step needed — `npx` fetches and runs the latest version on demand:

```bash
npx agent-inventory scan
```

Prefer a permanent command? Install it globally:

```bash
npm install -g agent-inventory
agent-inventory scan
```

Or run it from a clone:

```bash
git clone https://github.com/yiwei-ellen/harness-inventory
cd harness-inventory
npm install && npm run build
node dist/index.js scan
```

## Usage

```bash
# Walk the house and print the guest list
npx agent-inventory scan

# Machine-readable output — the full Component[] array
npx agent-inventory scan --json > inventory.json

# Print report URLs instead of opening a browser during the report flow
npx agent-inventory scan --no-browser

# Refresh the local catalog from this repo before scanning (the only
# network call this tool ever makes; off by default, announced before it runs)
npx agent-inventory scan --update-catalog

# Every app and package, not just the agent-related ones
npx agent-inventory scan --all

# Signing teams seen on this Mac that the catalog doesn't record yet —
# a starting point for a catalog pull request (nothing is sent or written)
npx agent-inventory catalog suggest

# Everything the CLI understands
npx agent-inventory scan --help
```

### Flags

| Flag | What it does |
| --- | --- |
| `--all` | List every app and package found, not just agent-related ones. |
| `--json` | Print the full `Component[]` array as JSON instead of the table (every component; `agentRelated` marks the ones the default table shows). Paths are generalized to `~`, so no username leaks into the output. |
| `--no-browser` | In the report flow, print the prefilled issue URLs for you to open yourself instead of launching a browser. |
| `--update-catalog` | Fetch the latest `known-agents.json` from this repo before scanning. This is the *only* network call the tool can make; it is off by default and logged to you before it happens. |
| `-h`, `--help` | Show usage and exit. |

### What a scan does

Run it, read the report, done — it runs once on invocation and exits. No
daemon, no scheduled runs, no telemetry. Each run:

1. Reads your local sources: Homebrew, npm, pip, `.app` bundles, launch agents
   and daemons, login items, agent CLIs on your `PATH`, browser extensions and
   native messaging hosts, and the MCP configs for Claude Desktop (including its
   extensions), Claude Code, Codex, Cursor, VS Code, Cline, Windsurf, Zed,
   Gemini CLI, Qwen Code, GitHub Copilot CLI, LM Studio, and OpenCode.
2. Merges anything found in more than one place into a single entry, and links
   each MCP server to the app or CLI that configured it, and each browser
   extension to the bridge and app it talks to.
3. Checks signatures, then matches against the catalog to recognize known
   agents and compare their signing team to the catalog's record.
4. Adds what's true right now: which agents are running and what's running
   under them, their macOS privacy permissions (when readable), and what they
   keep on disk.
5. Reports it as plain facts, with no scores or alarm coloring. By default the
   table shows agent-related components only — known agents, MCP servers, and
   anything unidentified. `--all` lists every app and package the sources saw.

Piping the output (or using `--json`) is non-interactive: the report prompt
below is skipped and no network action is taken.

## Example output

```
NAME                       INSTALLED VIA   SIGNED      STATUS        FIRST SEEN
Claude                     app bundle      notarized   identified    2026-02-14
  └ github                 mcp config      —           identified    2026-03-02
  └ Claude browser bridge  browser bridge  notarized   identified    2026-06-20
    └ Claude               browser ext     —           identified    2026-06-20
Cursor                     app bundle      notarized   identified    2026-01-02
  └ filesystem             mcp config      —           identified    2026-01-02
Claude Code                on PATH         notarized   identified    2026-03-11
  └ sentry                 mcp config      —           identified    2026-04-09
unknown-binary             launch item     unsigned    unidentified  2026-09-01

9 agent-related components · 8 identified · 1 unidentified · 212 other apps or packages not shown (--all lists everything)

DETAILS

Claude Code  ·  on PATH  ·  ~/.local/share/claude/versions/2.0.0
  Publisher     Developer ID Application: Anthropic PBC (Q6L2SF6YDW) · signing team matches the catalog
  Inherits      when run in iTerm2: Full Disk Access
  MCP servers   sentry (http · mcp.sentry.dev · passes header:Authorization)
  Keeps on disk ~/.claude/projects   transcripts   212 MB · 1,402 files · changed 2026-09-29
                ~/.claude/CLAUDE.md  instructions  4.1 KB · changed 2026-09-12
  Running now   yes · underneath it: zsh, git push, node @modelcontextprotocol/server-github

Codex CLI  ·  not found installed on this Mac  ·  its config and data remain
  Keeps on disk ~/.codex/sessions    transcripts   38 MB · 211 files · changed 2026-07-30
                ~/.codex/auth.json   credentials   1.2 KB · changed 2026-07-30
```

(Illustrative. Details list only the lines that have something to say.)

## 🪪 Trust, explained honestly

Not every guest carries the same paperwork, and we're not going to pretend otherwise.

**Signed** means the binary carries a verifiable publisher identity — the software equivalent of an ID card. We show this wherever it's actually checkable.

**Notarized** is a step further, but it only applies to things that came in through Apple's front door — downloaded `.app` bundles, mostly. Something installed via Homebrew or npm never passes through that checkpoint at all, so asking whether it's "notarized" doesn't really make sense for it — not a fail, just not applicable. We show `—`, not a fake pass or a scary red flag.

Beyond that, identification comes from an open, community-maintained catalog — not a single checkmark, but a few honest signals side by side. You decide what they add up to; we just show you the pieces, no scoring attached.

**Publisher check.** For agents the catalog knows, it records the Apple Developer team that ships them (Anthropic's, for example, is `Q6L2SF6YDW`). The details then say one of: *signing team matches the catalog*, *signing team differs from the catalog's record*, or *catalog has no signing team on file yet*. A difference isn't a verdict — vendors do change teams — it's a fact worth a look. Scripts and npm packages carry no signature, so there's nothing to check and the line says so.

**What stays private.** MCP configs often hold API keys. The scan records the *names* of the environment variables and headers a server is given, the host of a remote server, and the package a launcher runs — never values, full URLs, or full argument lists. Data locations are measured (size, file count, last change) and never opened. Process details show the program and one argument (`git push`), nothing after it.

**Privacy permissions.** macOS keeps its permission records (Accessibility, Screen Recording, Full Disk Access, …) in files that only a Full-Disk-Access app can read. The scan never asks for more privileges: if your terminal has Full Disk Access, permissions appear; if not, the summary says they weren't readable and everything else works the same.

## 🤷 Run into a stranger?

If a scan turns up something unidentified, you'll be asked once — and only once — whether you'd like to report it. You don't need to know what it is; that's the whole point of it being unidentified. The tool hands you a pre-filled GitHub issue with the boring technical details already in it (a fingerprint hash, install path, signing status), you look it over, and you hit submit yourself. Nothing goes out the door without you.

## What this is not

- **Not a security or antivirus tool.** No scores, no red alerts, no making your laptop feel like a crime scene. Just an honest guest list.
- **Not a background service.** It shows up when you call it, and only then.
- **Not a way to block or control agents.** This tool checks IDs — it doesn't run the door.

## The catalog

`catalog/known-agents.json` is plain JSON, CC0, and meant to be edited by people who've never read the code. An entry looks like this:

```json
{
  "id": "anthropic.claude-code",
  "kind": "cli",
  "identity": { "displayName": "Claude Code", "publisher": "Anthropic", "homepage": "https://claude.com/product/claude-code" },
  "detect": {
    "cliNames": ["claude"],
    "npmPackages": ["@anthropic-ai/claude-code"],
    "brewNames": ["claude-code"]
  },
  "signing": { "teamIds": ["Q6L2SF6YDW"], "evidence": "where you saw it" },
  "dataPaths": [
    { "path": "~/.claude/projects", "kind": "transcripts" },
    { "path": "~/.claude/CLAUDE.md", "kind": "instructions" }
  ]
}
```

- **`detect`** lists exact identifiers, each tied to the kind of install it applies to: `bundleIds`, `appNames` (exact `.app` names), `cliNames` (looked up on `PATH`), `npmPackages` (a trailing `*` is a prefix match), `brewNames`, `pipPackages`, `nativeHostNames`, `extensionIds`. Any one matching is a match. No fuzzy names, no guessing.
- **`signing.teamIds`** — leave empty until you've seen it. `agent-inventory catalog suggest` prints the teams it saw on your Mac for known agents; cite where it came from in `evidence`.
- **`dataPaths`** — where the agent keeps things. Kinds: `transcripts`, `history`, `instructions`, `credentials`, `models`, `config`, `logs`, `data`.
- The original `match` blocks (every non-null field must match) still work exactly as before.

## License

Code is licensed under [Apache 2.0](./LICENSE). The agent catalog (`catalog/known-agents.json`) is released separately under [CC0](./catalog/LICENSE) — public domain, free for anyone to use or build on.
