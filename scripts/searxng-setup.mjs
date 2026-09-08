import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const directory = new URL('../.cache/searxng/', import.meta.url)
const destination = new URL('settings.yml', directory)
const template = await readFile(
  new URL('../deploy/settings.template.yaml', import.meta.url),
  'utf8',
)
await mkdir(directory, { recursive: true, mode: 0o700 })
await chmod(directory, 0o700)
let secret
try {
  const existing = await readFile(destination, 'utf8')
  secret = existing.match(/^\s*secret_key: '([a-f0-9]{64})'$/mu)?.[1]
} catch (error) {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
    throw error
}
secret ??= randomBytes(32).toString('hex')
await writeFile(destination, template.replace('__LOCAL_RANDOM_SECRET__', secret), { mode: 0o600 })
await chmod(destination, 0o600)
process.stderr.write(`SearXNG settings prepared in ${fileURLToPath(directory)}; secret omitted.\n`)
