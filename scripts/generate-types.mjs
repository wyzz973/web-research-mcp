/** Generate wire types from the author-owned JSON Schema files. */
import { compile } from 'json-schema-to-typescript'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
await mkdir(new URL('src/generated/', root), { recursive: true })
const check = process.argv.includes('--check')
// Inline common schemas for clients that cannot resolve repository-relative $refs.
const metadata = JSON.parse(
  await readFile(new URL('schemas/source-metadata.schema.json', root), 'utf8'),
)
const search = JSON.parse(
  await readFile(new URL('schemas/websearch.output.schema.json', root), 'utf8'),
)
for (const name of ['websearch.output', 'webfetch.output']) {
  const target = new URL(`schemas/${name}.schema.json`, root)
  const document = JSON.parse(await readFile(target, 'utf8'))
  const definitions = {
    source_metadata: metadata,
    ...(name === 'webfetch.output'
      ? { evidence: search.$defs.evidence, relevance: search.$defs.relevance }
      : {}),
  }
  for (const [key, value] of Object.entries(definitions)) {
    if (JSON.stringify(document.$defs[key]) !== JSON.stringify(value)) {
      if (check) throw new Error(`Stale embedded ${key} schema: ${name}`)
      document.$defs[key] = value
    }
  }
  if (!check) await writeFile(target, JSON.stringify(document, null, 2) + '\n')
}
function normalizeReferences(value) {
  if (Array.isArray(value)) return value.map(normalizeReferences)
  if (!value || typeof value !== 'object') return value
  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalizeReferences(item)]),
  )
  // The generator otherwise drops siblings of $ref, which 2020-12 treats as conjuncts.
  if (normalized.$ref && Object.keys(normalized).length > 1) {
    const { $ref, ...constraints } = normalized
    return { allOf: [{ $ref }, constraints] }
  }
  return normalized
}
for (const [filename, name] of [
  ['websearch.input', 'WebSearchInput'],
  ['websearch.output', 'WebSearchOutput'],
  ['webfetch.input', 'WebFetchInput'],
  ['webfetch.output', 'WebFetchOutput'],
  ['config', 'RuntimeConfiguration'],
  ['source-metadata', 'SourceMetadata'],
]) {
  const schema = JSON.parse(
    await readFile(new URL(`schemas/${filename}.schema.json`, root), 'utf8'),
  )
  schema.title = name
  const output = await compile(normalizeReferences(schema), name, {
    bannerComment: '/** Generated from schemas. Do not edit. */',
    style: { semi: false, singleQuote: true, printWidth: 100 },
    maxItems: -1,
  })
  const target = new URL(`src/generated/${filename}.ts`, root)
  if (check) {
    if ((await readFile(target, 'utf8')) !== output)
      throw new Error(`Stale generated type: ${filename}`)
  } else await writeFile(target, output)
}
