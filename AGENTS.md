# Engineering rules

This repository builds `web_search` and `web_fetch` for LLM agents. Read [docs/design](docs/design/README.md) first.

- **One contract.** `src/contract.ts` is the only public shape. MCP, CLI, and the library are thin shells; the text view and JSON are renderings of the same object.
- **Two tools, clear roles.** `web_search` searches broadly and never downloads result pages. `web_fetch` reads the pages it is given and returns verbatim, locatable text.
- **Honest results.** Zero results, blocked, upstream failure, and parse failure are different states. Every truncation is announced with what was returned, what remains, and how to continue. Never report `empty` when every source failed.
- **Untrusted content.** Web text appears only inside nonce-closed `untrusted` blocks and never inside tool descriptions, errors, or notes.
- **Safe fetching is not optional.** Resolve, verify the address is public, pin the connection, and re-check every redirect.
- **No surprises with money or goodwill.** Paid sources are opt-in through environment keys and bounded by a daily budget; anonymous tiers are self-limited and never retried in a loop.
- **Secrets** come only from the environment and never reach logs, fixtures, or Git.
- **Dependencies** are pinned, few, and free of native builds. Discuss before adding one.
- **Tests guard behavior**, not implementation: recorded upstream responses, small HTML fixtures, and property tests for offsets. Network access happens only in `scripts/live-smoke.mjs`.
- `pnpm check` must pass before every commit. Offsets are UTF-16 code units everywhere.
