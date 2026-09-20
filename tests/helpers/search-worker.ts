/**
 * Child process for the multi-process limit tests: a real searcher on a shared state file with a
 * source that only counts how often it was really called. Prints that count as JSON.
 *
 *   search-worker <db> <free|paid> <searches> <start at, epoch ms> <label>
 *
 * The cap and the budget come from the environment, exactly as in production.
 */
import { loadConfig } from '../../src/config.ts'
import { createSearcher, type SourceAdapter } from '../../src/search/index.ts'
import { createSqliteStore } from '../../src/store/sqlite.ts'

const [location, tier, searches, startAt, label] = process.argv.slice(2)
if (!location || !tier || !searches || !startAt || !label)
  throw new Error('usage: search-worker <db> <free|paid> <searches> <start at> <label>')

let calls = 0
const counting: SourceAdapter = {
  id: 'counting',
  free: () => tier === 'free',
  unitCostUsd: () => (tier === 'free' ? 0 : 0.3),
  search() {
    calls += 1
    return Promise.resolve([
      { url: `https://example.com/${label}/${calls}`, title: 'A page', passages: ['Some text.'] },
    ])
  },
}

const store = await createSqliteStore(location)
const searcher = createSearcher({ config: loadConfig(), store, sources: [counting] })
const never = new AbortController().signal

// Every process starts at the same moment, so they race for the same last calls.
await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(startAt) - Date.now())))
const statuses: Record<string, number> = {}
for (let index = 0; index < Number(searches); index += 1) {
  // Distinct queries: a cache hit would hide the call we want to count.
  const result = await searcher.search({ query: `${label} query ${index}`, depth: 'fast' }, never)
  const outcome = result.error?.code ?? result.status
  statuses[outcome] = (statuses[outcome] ?? 0) + 1
}
await searcher.close()
store.close()
process.stdout.write(JSON.stringify({ calls, statuses }))
