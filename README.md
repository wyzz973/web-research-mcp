# web-research-mcp

Web search and verbatim page reading for LLM agents. One engine, three ways to use it: an MCP server, a command line tool, and a TypeScript library.

> **Status: 2.0 alpha.** This branch is a from-scratch rebuild. The previous SearXNG-based implementation is kept at the `legacy-v0.5.0` tag.

Two tools, two jobs:

| Tool | Job | What the model gets |
| --- | --- | --- |
| `web_search` | Search the web broadly. It never downloads result pages, so it stays fast. | A ranked list with as many results as you ask for (`max_results`), each with a query-relevant excerpt |
| `web_fetch` | Read the pages you choose and find evidence in them. | Verbatim Markdown with a citable location for every passage, an outline for long pages, section reads, in-page `find`, and cursors |

What makes it different from a harness's built-in web tools:

- **Nothing is silently cut.** Every response states what was returned, what remains, and how to continue.
- **Nothing is paraphrased.** `web_fetch` returns the page's own text; `find` verifies a quote before you cite it.
- **Failures are not disguised as "no results".** Blocked, rate limited, not found, and parse failures are distinct, actionable states.
- **Long documents come with a map.** A 150,000-token RFC is an outline of about 1,400 tokens plus the sections you ask for.
- **No single search engine to depend on.** Sources are adapters (Exa, Parallel, Tavily today); keys are optional.
- **Web content is fenced.** Text from the web stays inside nonce-closed `untrusted` blocks that a hostile page cannot forge or close.

## Requirements

Node.js 22.13 or newer on Windows, macOS, or Linux. No Python, no Docker, no native build step.

## Quick start

No clone needed. The package is not on npm yet, so build a tarball from GitHub and install that (npm cannot build a Git dependency during a global install), then check the setup and try both tools:

```sh
npm pack github:wyzz973/web-research-mcp#v2          # about 30 s; writes web-research-mcp-2.0.0-alpha.1.tgz
npm install -g ./web-research-mcp-2.0.0-alpha.1.tgz
web-research doctor
web-research search "AbortSignal timeout fetch Node.js" --max-results 8
web-research fetch https://www.rfc-editor.org/rfc/rfc9110.html --section 13.1.2
```

npm may warn that the package's `prepare` script was not run; that is expected, the tarball is already built. `doctor` explains what will be used and why something does not work, without spending any search quota.

## Use it from an MCP client

After the global install the server command is `web-research-mcp`:

```json
{
  "mcpServers": {
    "web-research": { "command": "web-research-mcp" }
  }
}
```

For Claude Code: `claude mcp add web-research -- web-research-mcp`

Without installing anything, `npx` can start it straight from GitHub (about 15 seconds the first time, 4 seconds afterwards):

```json
{
  "mcpServers": {
    "web-research": { "command": "npx", "args": ["-y", "github:wyzz973/web-research-mcp#v2"] }
  }
}
```

Working on the code instead? `pnpm install && pnpm build`, then point the client at `node /absolute/path/to/web-research-mcp/dist/mcp/stdio.js`. Inside this repository a project-level [.mcp.json](.mcp.json) already does that.

Keys and settings are read from the server's environment, so pass them in the client's `env` block (or export them before starting the client):

```json
{ "command": "web-research-mcp", "env": { "TAVILY_API_KEY": "tvly-..." } }
```

The server returns a compact text view by default, because several harnesses pass only one of `content` / `structuredContent` to the model and JSON-escaped page text is hard to read. Set `WEB_RESEARCH_MCP_OUTPUT=json` to receive the result object instead; it is meant for programs: the content is still sized by `max_tokens`, but JSON escaping makes the serialized object 10–20% larger than the text view, and the hard output ceilings apply to the text view only.

## Search sources, keys, and cost

Without any configuration the tool uses the **anonymous free tiers** of Exa, Parallel, and Tavily. That means your queries are sent to those companies' public endpoints. These tiers are subsidized by the vendors and may be limited or withdrawn at any time, so the tool limits itself to 100 anonymous calls per source per day and never retries a failed source in a loop. Turn them off with `WEB_RESEARCH_ANONYMOUS_SOURCES=0`.

For dependable capacity add your own keys; the same adapter switches from the anonymous tier to the keyed API:

| Variable | Where to get a key | Free allowance (checked 2026-09-20) |
| --- | --- | --- |
| `TAVILY_API_KEY` | https://app.tavily.com | 1,000 searches per month, no card |
| `EXA_API_KEY` | https://dashboard.exa.ai | one-off credit on sign-up, then a monthly credit |
| `PARALLEL_API_KEY` | https://platform.parallel.ai | monthly credit, card required |

Spending is bounded: paid sources stop being selected once the day's estimated cost reaches `WEB_RESEARCH_DAILY_BUDGET_USD` (default 1). Search pages served from a cursor or from the cache cost nothing. See [.env.example](.env.example) for every setting.

`depth` controls how many sources one search uses: `fast` uses one, `standard` (default) adds a second only when the results look weak, and `deep` merges up to three.

## Use it as a library

```ts
import { createWebResearch } from 'web-research-mcp'

const research = await createWebResearch()
const found = await research.search({ query: 'sqlite fts5 bm25', max_results: 5 })
const refs = found.results.slice(0, 2).map((hit) => hit.ref)
const pages = await research.fetch({ refs, goal: 'default bm25 weights' })
await research.close()
```

Both methods never throw; failures are part of the returned object.

## Safety

- Fetching resolves the host, requires every address to be public, pins the connection to the verified address, and re-checks each redirect. Private, loopback, link-local, and cloud-metadata addresses are refused.
- robots.txt is honored and requests to one host are rate limited.
- The default configuration cannot stop a prompt-injected model from leaking data through a URL it chooses to fetch. If that matters in your setting, restrict the tool at the harness level.
- CAPTCHAs, paywalls, and logins are reported, never bypassed.

## How well does it search?

`pnpm bench` runs a sample of [evals/queries.json](evals/queries.json) against the live sources and checks whether a domain that ought to answer each query shows up near the top. It is a smoke signal, not a relevance judgment. The first recorded run ([evals/runs/2026-09-21-standard.json](evals/runs/2026-09-21-standard.json): 12 queries in English and Chinese, default `depth`, no API keys, cold cache):

| Measure | Result |
| --- | --- |
| Queries answered | 12 of 12 |
| Latency | median 1.6 s, 90th percentile 2.6 s |
| Expected domain in the top 3 / top 10 | 10 of 12 / 12 of 12 |
| Upstream calls | 13 (one escalation to a second source) |
| Output size for 10 results | about 3,800 tokens on average |

Concurrency, measured the same day in one process: 8 different searches started together finished in 2.9 s in total, spread over the three sources; repeating them was served entirely from the cache with no upstream call; reading 4 pages from 4 hosts in one `web_fetch` took 4.8 s.

## Development

```sh
pnpm check        # types, lint, format, tests (no network)
pnpm smoke:pack   # packs the build, installs the tarball elsewhere, drives the installed entry points
pnpm smoke:live   # real searches and fetches; spends a few free-tier calls
```

Design documents: [docs/design](docs/design/README.md). Engineering rules: [AGENTS.md](AGENTS.md). License: [MIT](LICENSE).
