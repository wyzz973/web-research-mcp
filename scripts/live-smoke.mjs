/**
 * Manual end-to-end check against the real network. Not part of `pnpm check`.
 * It spends a handful of free-tier searches and downloads two public pages.
 *
 *   pnpm smoke:live
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createWebResearch, renderFetch, renderSearch } from '../dist/index.js'

const dataDir = mkdtempSync(path.join(tmpdir(), 'wrm-smoke-'))
process.env.WEB_RESEARCH_DATA_DIR = dataDir
const research = await createWebResearch()
const failures = []
function check(name, condition, detail = '') {
  const mark = condition ? 'ok  ' : 'FAIL'
  console.log(`${mark}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!condition) failures.push(name)
}

try {
  const started = performance.now()
  const search = await research.search({
    query: 'AbortSignal timeout fetch Node.js',
    goal: 'how to cancel a slow fetch request',
    max_results: 8,
  })
  const searchMs = Math.round(performance.now() - started)
  console.log(renderSearch(search).split('\n').slice(0, 8).join('\n'))
  check('search returns results', search.results.length >= 3, `${search.results.length} results`)
  check('search is fast', searchMs < 12_000, `${searchMs} ms`)
  check(
    'every ref is a full ref',
    search.results.every((hit) => /^[a-z0-9]+:r\d+$/u.test(hit.ref)),
  )
  check('output respects the token budget', search.tokens <= 5_500, `~${search.tokens} tokens`)

  if (search.next_cursor) {
    const more = await research.search({ cursor: search.next_cursor })
    check('cursor page comes from the stored pool', more.usage.provider_calls === 0)
  }

  const refs = search.results.slice(0, 2).map((hit) => hit.ref)
  const evidence = await research.fetch({ refs, goal: 'how to cancel a slow fetch request' })
  console.log(renderFetch(evidence).split('\n').slice(0, 10).join('\n'))
  const okPages = evidence.pages.filter((page) => page.status === 'ok')
  check('evidence mode reads at least one page', okPages.length >= 1, `${okPages.length} ok`)
  check(
    'every passage is verbatim and locatable',
    okPages.every((page) =>
      page.parts.every((part) => part.end > part.start && part.text.length > 0),
    ),
  )

  const long = await research.fetch({
    url: 'https://www.rfc-editor.org/rfc/rfc9110.html',
    section: '13.1.2',
  })
  const page = long.pages[0]
  check('long page: section read works', page?.status === 'ok' && page.parts.length > 0)
  check(
    'long page: the section is the requested one',
    page?.parts[0]?.text.includes('If-None-Match') === true,
  )
  if (page?.snapshot) {
    const found = await research.fetch({ ref: page.snapshot, find: 'If-None-Match' })
    check('find locates a quote in the stored snapshot', (found.pages[0]?.find_total ?? 0) > 5)
  }

  const blocked = await research.fetch({ url: 'http://169.254.169.254/latest/meta-data/' })
  check('cloud metadata address is refused', blocked.pages[0]?.error?.code === 'unsafe_url')
} finally {
  await research.close()
  rmSync(dataDir, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`)
  process.exitCode = 1
} else console.log('\nall live checks passed')
