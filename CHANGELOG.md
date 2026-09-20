# Changelog

This project follows [Semantic Versioning](https://semver.org/). Until 2.0.0 is released, alpha
versions may change tool fields without a major version bump; every such change is listed here.

## 2.0.0-alpha.1 (unreleased)

A from-scratch rebuild. The SearXNG-based 0.x implementation is archived at the tag
`legacy-v0.5.0`; nothing from it is required any more (no Docker, no Python, no native modules).

### Added

- `web_search`: broad search that never downloads result pages. `max_results` (default 10, up to
  50), `max_tokens` (default 5,000), `depth` (`fast`, `standard`, `deep`), `goal`, `sites`,
  `recency`, up to five `queries` per call, and cursors that page through a stored result pool
  without calling a source again.
- `web_fetch`: verbatim Markdown with a citable `snapshot:start-end` location for every passage.
  Reads up to five pages per call by URL or by search `ref`; modes are `cursor`, `find`, `section`,
  `goal`, and a default read with an outline for long pages.
- One contract (`src/contract.ts`) rendered two ways: a compact text view for models and JSON for
  programs. Available as an MCP stdio server, a CLI (`web-research`), and a TypeScript library.
- Source adapters for Exa, Parallel, and Tavily. Each works anonymously and switches to the keyed
  API when its environment key is present. Keyed sources are preferred; anonymous use is capped per
  source per day; paid use stops at a daily budget.
- Multi-source fusion (reciprocal rank fusion) for `deep`, and automatic escalation to a second
  source for `standard` when the first result set looks weak.
- State in one SQLite file using the built-in `node:sqlite`: search cache, result pools, page
  snapshots, usage ledger, and source cooldowns, shared safely between processes.
- Safe fetching: address verification with a pinned connection, per-redirect re-checks, size and
  time limits, robots.txt, per-host pacing. HTML conversion runs in a terminable worker with a
  memory limit.
- Untrusted-content envelope with a per-block random nonce; imitated tags and protocol lines are
  neutralized and counted.
- `web-research doctor`: explains configuration, state, and reachability without spending quota.
- Checks: unit and replay tests without network, a packed-tarball entry test (`pnpm smoke:pack`),
  a live smoke test (`pnpm smoke:live`), and a small live benchmark (`pnpm bench`). CI runs on
  Linux, macOS, and Windows with Node 22 and 24.
