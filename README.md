# agent-inventory

**Your Mac has guests. This tells you who they are, how they got in, and whether anyone can vouch for them.**

AI agents move in quietly — an `npm install` here, an MCP config there — and before long you've got a houseful of software with access to your files, and nobody's checked a single ID. `agent-inventory` is a free, open-source CLI that walks the halls of your Mac, takes attendance of the **AI agents** — and only the AI agents — and gives it to you straight: who's here, how they got in, and who can vouch for them.

## Why this exists

No agent vendor is ever going to hand you a guest list that includes their competitors — they have no reason to. `agent-inventory` doesn't care who made what. It just checks IDs at *your* door, not theirs.

## 🔍 What it does

- **Lists AI agents only** — agents, agent harnesses, and MCP servers. It scans everywhere they hide (Homebrew, npm, pip, `.app` bundles, launch agents/daemons, login items, MCP client configs) but reports a component **only if it's a known agent** in the [catalog](./catalog/known-agents.json) or a configured MCP server. Chrome, Safari, Steam, and the rest of your ordinary software never show up.
- **Shows the actual binary** — alongside each agent's name, the executable behind it (`Claude` → `Claude`, an MCP server → `npx`/`node`/its real binary).
- **Keeps the family tree straight** — an MCP server shows up linked to the app that configured it, not swallowed inside it.
- **Checks whatever ID is actually available** — see [Trust, explained honestly](#trust-explained-honestly) below; not everything carries the same kind of paperwork.
- **Doesn't bluff** — matching is exact (name, executable, bundle ID, or an exact catalog token); there's no fuzzy guessing. If it isn't a known agent or a declared MCP server, it's simply left out rather than mislabeled.
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

# Everything the CLI understands
npx agent-inventory scan --help
```

### Flags

| Flag | What it does |
| --- | --- |
| `--json` | Print the full `Component[]` array as JSON instead of the table. Paths are generalized to `~`, so no username leaks into the output. |
| `--no-browser` | In the report flow, print the prefilled issue URLs for you to open yourself instead of launching a browser. |
| `--update-catalog` | Fetch the latest `known-agents.json` from this repo before scanning. This is the *only* network call the tool can make; it is off by default and logged to you before it happens. |
| `-h`, `--help` | Show usage and exit. |

### What a scan does

Run it, read the report, done — it runs once on invocation and exits. No
daemon, no scheduled runs, no telemetry. Each run:

1. Reads your local sources (Homebrew, npm, pip, `.app` bundles, launch agents
   and daemons, login items, and the MCP configs for Claude Desktop, Cursor,
   Windsurf, and Zed).
2. Keeps only the AI agents: a component is reported only if it matches the
   [catalog](./catalog/known-agents.json) of known agents or is a configured MCP
   server. Everything else is dropped before any further work — which is also
   why the scan is fast: the expensive checks (code signing, bundle parsing) run
   only on the handful of agents that survive this filter.
3. Merges anything found in more than one place into a single entry, and links
   each MCP server to the app that configured it.
4. Reports each agent's name, its binary, how it was installed, its signing
   state, and whether it's identified — as plain facts, with no scores or alarm
   coloring.

Piping the output (or using `--json`) is non-interactive: the report prompt
below is skipped and no network action is taken.

## Example output

Only agents appear — the dozens of ordinary apps on the same machine are filtered out.

```
NAME          BINARY        INSTALLED VIA  SIGNED     STATUS        FIRST SEEN
Claude        Claude        app bundle     notarized  identified    2026-03-11
Cursor        Cursor        app bundle     notarized  identified    2026-01-02
  └ github    npx           mcp config     —          identified    2026-01-02
  └ filesystem npx          mcp config     —          identified    2026-01-02
Ollama        ollama        brew           signed     identified    2026-02-09
homemade-mcp  node          mcp config     —          unidentified  2026-09-01

6 agents found · 5 identified · 1 unidentified
```

The `BINARY` column shows the actual executable behind each row. `unidentified` here is `homemade-mcp` — an MCP server you configured that the catalog doesn't recognize yet (see below).

## 🪪 Trust, explained honestly

Not every guest carries the same paperwork, and we're not going to pretend otherwise.

**Signed** means the binary carries a verifiable publisher identity — the software equivalent of an ID card. We show this wherever it's actually checkable.

**Notarized** is a step further, but it only applies to things that came in through Apple's front door — downloaded `.app` bundles, mostly. Something installed via Homebrew or npm never passes through that checkpoint at all, so asking whether it's "notarized" doesn't really make sense for it — not a fail, just not applicable. We show `—`, not a fake pass or a scary red flag.

Beyond that, an agent's name and publisher come from an open, community-maintained [catalog](./catalog/known-agents.json) — matched exactly, never guessed. You decide what the signals add up to; we just show you the pieces, no scoring attached.

## 🤷 Run into a stranger?

Because the report is limited to known agents, the only thing that can turn up "unidentified" is an **MCP server you configured that the catalog doesn't recognize yet** — and that's worth surfacing, since an MCP server is an agent by definition. (Ordinary apps are never "unidentified"; they're simply not agents, so they're left out entirely.)

When that happens, you'll be asked once — and only once — whether you'd like to report the unrecognized MCP server. The tool hands you a pre-filled GitHub issue with the boring technical details already in it (a fingerprint hash, install path, signing status), you look it over, and you hit submit yourself. Nothing goes out the door without you.

## What this is not

- **Not a security or antivirus tool.** No scores, no red alerts, no making your laptop feel like a crime scene. Just an honest guest list.
- **Not a background service.** It shows up when you call it, and only then.
- **Not a way to block or control agents.** This tool checks IDs — it doesn't run the door.

## License

Code is licensed under [Apache 2.0](./LICENSE). The agent catalog (`catalog/known-agents.json`) is released separately under [CC0](./catalog/LICENSE) — public domain, free for anyone to use or build on.
