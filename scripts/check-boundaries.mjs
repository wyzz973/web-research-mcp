/** Check runtime module ownership using the TypeScript parser, not source-text guesses. */
import ts from 'typescript'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../src/', import.meta.url))
const files = []
async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) await walk(full)
    else if (item.isFile() && full.endsWith('.ts') && !full.endsWith('.d.ts')) files.push(full)
  }
}
await walk(root)
const allowed = {
  mcp: ['mcp', 'tools', 'shared', 'generated'],
  workbench: ['workbench', 'tools', 'shared', 'generated'],
  tools: ['tools', 'search', 'fetch', 'ranking', 'storage', 'shared', 'generated'],
  search: ['search', 'shared', 'generated'],
  fetch: ['fetch', 'shared', 'generated'],
  ranking: ['ranking', 'shared', 'generated'],
  storage: ['storage', 'shared', 'generated'],
  shared: ['shared', 'generated'],
  generated: ['generated'],
}
const issues = []
const graph = new Map()
for (const file of files) {
  const relative = path.relative(root, file).split(path.sep).join('/')
  const owner = relative.split('/')[0]
  if (!allowed[owner]) {
    issues.push(`Unowned module: ${relative}`)
    continue
  }
  const ast = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const edges = []
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      issues.push(`${relative}: dynamic import/require is not an approved runtime boundary`)
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text
      if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(file), spec)
        const targetRelative = path.relative(root, target)
        const targetOwner = targetRelative.split(path.sep)[0]
        if (!spec.endsWith('.ts') || targetRelative.startsWith('..'))
          issues.push(`${relative}: invalid source import ${spec}`)
        if (relative !== 'mcp/stdio.ts' && !allowed[owner].includes(targetOwner))
          issues.push(`${relative}: cannot import ${targetOwner}`)
        edges.push(target)
      } else {
        if (spec.startsWith('@modelcontextprotocol/') && owner !== 'mcp')
          issues.push(`${relative}: SDK belongs to MCP adapter`)
        if (
          [
            'undici',
            'node:http',
            'node:https',
            'node:dns',
            'node:dns/promises',
            'node:net',
            'node:tls',
          ].includes(spec) &&
          owner !== 'fetch' &&
          relative !== 'search/searxng.ts' &&
          relative !== 'workbench/server.ts' &&
          relative !== 'shared/domain-scope.ts' &&
          relative !== 'shared/source-metadata.ts'
        )
          issues.push(`${relative}: network import outside approved boundary`)
        if (spec === 'better-sqlite3' && owner !== 'storage')
          issues.push(`${relative}: SQLite belongs to storage`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  graph.set(file, edges)
}
const visited = new Set()
const active = new Set()
function checkCycles(file) {
  if (active.has(file)) {
    issues.push(`Dependency cycle: ${path.relative(root, file)}`)
    return
  }
  if (visited.has(file)) return
  active.add(file)
  for (const next of graph.get(file) ?? []) checkCycles(next)
  active.delete(file)
  visited.add(file)
}
for (const file of files) checkCycles(file)
if (issues.length) throw new Error(issues.join('\n'))
process.stderr.write(`PASS: ${files.length} modules obey ownership and have no import cycles.\n`)
