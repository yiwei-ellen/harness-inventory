# agent-inventory

**Your Mac has guests. This tells you who they are, how they got in, and whether anyone can vouch for them.**

AI agents move in quietly — an `npm install` here, an MCP config there — and before long you've got a houseful of software with access to your files, and nobody's checked a single ID. `agent-inventory` is a free, open-source CLI that walks the halls of your Mac, takes attendance, and gives it to you straight: who's here, what they can prove about themselves, and who's the stranger in the corner nobody recognizes.

## Why this exists

No agent vendor is ever going to hand you a guest list that includes their competitors — they have no reason to. `agent-inventory` doesn't care who made what. It just checks IDs at *your* door, not theirs.

## 🔍 What it does

- **Takes attendance** — MCP servers, agent CLIs, and agent-adjacent apps, wherever they're hiding: Homebrew, npm, pip, `.app` bundles, launch agents, MCP client configs.
- **Keeps the family tree straight** — an MCP server shows up linked to the app that configured it, not swallowed inside it.
- **Checks whatever ID is actually available** — see [Trust, explained honestly](#trust-explained-honestly) below; not everything carries the same kind of paperwork.
- **Doesn't bluff** — an unidentified component stays labeled unidentified. No guessing, no made-up names.
- **Shows up, does the walkthrough, leaves** — no background process, no scheduled visits, no telemetry. Nothing gets sent anywhere unless you say so.

## Install

```bash
npx agent-inventory scan
```

No install step — `npx` grabs the latest version on demand.

## Usage

```bash
# Scan and print a report
npx agent-inventory scan

# Get machine-readable output
npx agent-inventory scan --json > inventory.json
```

## Example output

```
NAME                  INSTALLED VIA    SIGNED         STATUS          FIRST SEEN
Claude Code           npm              —              ✅ identified    2026-03-11
Cursor                app bundle       notarized      ✅ identified    2026-01-02
  └ github-mcp         mcp config       —              ✅ identified    2026-01-02
  └ filesystem-mcp      mcp config       —              ✅ identified    2026-01-02
unknown-binary         —                unsigned       ❓ unidentified  2026-09-01

5 components found · 4 identified · 1 unidentified
```

## 🪪 Trust, explained honestly

Not every guest carries the same paperwork, and we're not going to pretend otherwise.

**Signed** means the binary carries a verifiable publisher identity — the software equivalent of an ID card. We show this wherever it's actually checkable.

**Notarized** is a step further, but it only applies to things that came in through Apple's front door — downloaded `.app` bundles, mostly. Something installed via Homebrew or npm never passes through that checkpoint at all, so asking whether it's "notarized" doesn't really make sense for it — not a fail, just not applicable. We show `—`, not a fake pass or a scary red flag.

Beyond that, identification comes from an open, community-maintained catalog — not a single checkmark, but a few honest signals side by side. You decide what they add up to; we just show you the pieces, no scoring attached.

## 🤷 Run into a stranger?

If a scan turns up something unidentified, you'll be asked once — and only once — whether you'd like to report it. You don't need to know what it is; that's the whole point of it being unidentified. The tool hands you a pre-filled GitHub issue with the boring technical details already in it (a fingerprint hash, install path, signing status), you look it over, and you hit submit yourself. Nothing goes out the door without you.

## What this is not

- **Not a security or antivirus tool.** No scores, no red alerts, no making your laptop feel like a crime scene. Just an honest guest list.
- **Not a background service.** It shows up when you call it, and only then.
- **Not a way to block or control agents.** This tool checks IDs — it doesn't run the door.

## License

Code is licensed under [Apache 2.0](./LICENSE). The agent catalog (`catalog/known-agents.json`) is released separately under [CC0](./catalog/LICENSE) — public domain, free for anyone to use or build on.
