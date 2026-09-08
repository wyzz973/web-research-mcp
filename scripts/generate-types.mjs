/** Generate wire types from the author-owned JSON Schema files. */
import { compile } from 'json-schema-to-typescript'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
await mkdir(new URL('src/generated/', root), { recursive: true })
const check = process.argv.includes('--check')
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
