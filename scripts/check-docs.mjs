/** Check authored text and local inline Markdown file links without network access. */
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const ignored = new Set(['.git', 'node_modules', 'dist', 'coverage', 'data', 'artifacts', '.cache'])
const checkedExtensions = new Set(['.md', '.json', '.mjs', '.ts', '.yml', '.yaml'])

/** Enumerate authored files; symlinks are not followed. */
async function collect(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collect(filename)))
    else if (entry.isFile() && checkedExtensions.has(path.extname(filename))) files.push(filename)
  }
  return files.sort()
}

/** Remove fenced examples before inspecting inline Markdown links. */
function withoutFences(text) {
  const output = []
  let fence = null
  for (const line of text.split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/u)?.[1]
    if (marker && !fence) fence = marker
    else if (marker && fence && marker[0] === fence[0] && marker.length >= fence.length)
      fence = null
    else if (!fence) output.push(line)
  }
  return output.join('\n')
}

async function main() {
  const issues = []
  const files = await collect(root)
  let jsonCount = 0
  let linkCount = 0
  for (const filename of files) {
    const name = path.relative(root, filename)
    const text = await readFile(filename, 'utf8')
    if (!text.endsWith('\n') || text.endsWith('\n\n'))
      issues.push(`${name}: expected one final newline`)
    if (text.includes('\r')) issues.push(`${name}: expected LF line endings`)
    if (/[^\S\n]+$/mu.test(text)) issues.push(`${name}: trailing whitespace`)
    if (filename.endsWith('.json')) {
      jsonCount += 1
      try {
        JSON.parse(text)
      } catch (error) {
        issues.push(`${name}: invalid JSON: ${error.message}`)
      }
    }
    if (!filename.endsWith('.md')) continue
    for (const match of withoutFences(text).matchAll(/\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/gu)) {
      const target = match[1].replace(/^<|>$/gu, '')
      if (/^[a-z][a-z\d+.-]*:/iu.test(target) || target.startsWith('#')) continue
      const filePart = target.split('#')[0]
      if (!filePart) continue
      linkCount += 1
      try {
        const resolved = path.resolve(path.dirname(filename), decodeURIComponent(filePart))
        const relative = path.relative(root, resolved)
        if (
          relative === '..' ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          issues.push(`${name}: local link escapes project: ${target}`)
          continue
        }
        await stat(resolved)
      } catch (error) {
        issues.push(
          `${name}: invalid or missing local target: ${target} (${error.code ?? error.name})`,
        )
      }
    }
  }
  if (issues.length) {
    process.stderr.write(`${issues.join('\n')}\n`)
    process.exitCode = 1
    return
  }
  process.stderr.write(
    `PASS: ${files.length} authored files, ${jsonCount} JSON files, ${linkCount} local file links. Schema semantics and heading anchors are not checked.\n`,
  )
}

main().catch((error) => {
  process.stderr.write(`Document check failed: ${error.message}\n`)
  process.exitCode = 1
})
