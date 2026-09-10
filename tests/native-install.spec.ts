import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const moduleUrl = new URL('../scripts/searxng-native-install.mjs', import.meta.url).href
const directories: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-install-'))
  directories.push(root)
  await mkdir(join(root, 'deploy/native'), { recursive: true })
  await writeFile(
    join(root, 'deploy/native/source.json'),
    await readFile(new URL('../deploy/native/source.json', import.meta.url)),
  )
  await writeFile(join(root, 'deploy/native/requirements.lock'), '# fixture\n')
  await writeFile(
    join(root, 'deploy/settings.template.yaml'),
    "server:\n  secret_key: '__LOCAL_RANDOM_SECRET__'\n",
  )
  return root
}

function run(script: string, env = process.env) {
  return execute(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const api = await import(${JSON.stringify(moduleUrl)});\n${script}`,
    ],
    { env },
  )
}

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe('native installer boundaries', () => {
  it('isolates all Python temporary caches to the managed private data directory', async () => {
    const controlUrl = new URL('../scripts/native-control.mjs', import.meta.url).href
    const { stdout } = await run(
      `const {serviceEnvironment}=await import(${JSON.stringify(controlUrl)}); const env=serviceEnvironment({source:'/source',settings:'/settings',data:'/private-data'}); console.log(JSON.stringify([env.TMPDIR,env.TMP,env.TEMP]));`,
    )
    expect(JSON.parse(stdout)).toEqual(['/private-data', '/private-data', '/private-data'])
  })
  it('resolves a managed environment without requiring Docker', async () => {
    const root = await fixture()
    const { stdout } = await run(
      `const p=api.nativePaths(${JSON.stringify(root)}); console.log(JSON.stringify({directory:p.directory,python:p.python,revision:p.manifest.revision}));`,
    )
    expect(JSON.parse(stdout)).toEqual({
      directory: join(root, '.cache/searxng-native'),
      python: join(root, '.cache/searxng-native/venv/bin/python'),
      revision: '3fdc6d753a339b5f4a7dc5842c94c0d8324726f1',
    })
  })

  it('rejects a source URL outside the pinned upstream', async () => {
    const root = await fixture()
    const manifest = JSON.parse(
      await readFile(join(root, 'deploy/native/source.json'), 'utf8'),
    ) as Record<string, unknown>
    manifest.archive_url = 'https://example.com/arbitrary.tar.gz'
    await writeFile(join(root, 'deploy/native/source.json'), JSON.stringify(manifest))
    await expect(run(`api.nativePaths(${JSON.stringify(root)});`)).rejects.toThrow(
      'Invalid pinned native source manifest',
    )
  })

  it('does not forward API keys, Python overrides or package-index credentials', async () => {
    const { stdout } = await run(
      'console.log(JSON.stringify(Object.keys(api.nativeEnvironment())));',
      {
        ...process.env,
        TEST_API_KEY: 'fixture',
        PYTHONPATH: '/unsafe/fixture',
        UV_INDEX_URL: 'https://fixture:fixture@example.org/simple',
      },
    )
    expect(JSON.parse(stdout)).not.toContain('TEST_API_KEY')
    expect(JSON.parse(stdout)).not.toContain('PYTHONPATH')
    expect(JSON.parse(stdout)).not.toContain('UV_INDEX_URL')
  })

  it('reports setup instructions when no installation receipt exists', async () => {
    const root = await fixture()
    await expect(run(`await api.ensureNativeInstalled(${JSON.stringify(root)});`)).rejects.toThrow(
      'pnpm searxng:native:setup',
    )
  })

  it('does not refresh a runtime which has a managed supervisor state', async () => {
    const root = await fixture()
    await mkdir(join(root, '.cache/searxng-native'), { recursive: true })
    await writeFile(join(root, '.cache/searxng-native/state.json'), '{}')
    await expect(
      run(
        `globalThis.fetch=()=>{throw new Error('unexpected download')}; await api.installNative({root:${JSON.stringify(root)}});`,
      ),
    ).rejects.toThrow('Stop native SearXNG')
    await expect(access(join(root, '.cache/searxng-native/lifecycle.lock'))).rejects.toThrow()
  })

  it('rejects an archive hash mismatch before extraction and cleans both operation locks', async () => {
    const root = await fixture()
    await expect(
      run(
        `globalThis.fetch=async()=>new Response('not the pinned archive'); await api.installNative({root:${JSON.stringify(root)}});`,
      ),
    ).rejects.toThrow('SHA-256 mismatch')
    await expect(access(join(root, '.cache/searxng-native/install.lock'))).rejects.toThrow()
    await expect(access(join(root, '.cache/searxng-native/lifecycle.lock'))).rejects.toThrow()
    await expect(access(join(root, '.cache/searxng-native/installation.json'))).rejects.toThrow()
  })
})
