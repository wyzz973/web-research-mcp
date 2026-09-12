import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const moduleUrl = new URL('../scripts/crawl4ai-setup.mjs', import.meta.url).href
const directories: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'crawl4ai-install-'))
  directories.push(root)
  await mkdir(join(root, 'deploy/crawl4ai'), { recursive: true })
  await writeFile(
    join(root, 'deploy/crawl4ai/source.json'),
    await readFile(new URL('../deploy/crawl4ai/source.json', import.meta.url)),
  )
  await writeFile(join(root, 'deploy/crawl4ai/requirements.lock'), '# fixture\n')
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

describe('Crawl4AI installation boundaries', () => {
  it('keeps browsers and Python in the project managed cache', async () => {
    const root = await fixture()
    const { stdout } = await run(
      `const p=api.crawl4aiPaths(${JSON.stringify(root)}); console.log(JSON.stringify([p.python,p.browsers,p.manifest.crawl4ai]));`,
    )
    expect(JSON.parse(stdout)).toEqual([
      join(root, '.cache/crawl4ai/venv/bin/python'),
      join(root, '.cache/crawl4ai/browsers'),
      '0.9.3',
    ])
  })

  it('does not forward model credentials, proxies, or Python import overrides', async () => {
    const root = await fixture()
    const { stdout } = await run(
      `console.log(JSON.stringify(api.crawl4aiEnvironment(api.crawl4aiPaths(${JSON.stringify(root)}))));`,
      {
        ...process.env,
        OPENAI_API_KEY: 'fixture',
        HTTPS_PROXY: 'http://fixture.invalid',
        PYTHONPATH: '/unsafe',
        UV_INDEX_URL: 'https://fixture:password@fixture.invalid',
      },
    )
    const environment = JSON.parse(stdout) as Record<string, string>
    expect(environment).not.toHaveProperty('OPENAI_API_KEY')
    expect(environment).not.toHaveProperty('HTTPS_PROXY')
    expect(environment).not.toHaveProperty('PYTHONPATH')
    expect(environment).not.toHaveProperty('UV_INDEX_URL')
    expect(environment['LITELLM_LOCAL_MODEL_COST_MAP']).toBe('True')
    expect(environment['HF_HUB_OFFLINE']).toBe('1')
  })

  it('refuses a manifest with an unreviewed package version before running uv', async () => {
    const root = await fixture()
    await writeFile(
      join(root, 'deploy/crawl4ai/source.json'),
      JSON.stringify({ format: 1, python: '3.12.11', crawl4ai: '99.0', playwright: '1.62.0' }),
    )
    await expect(run(`api.crawl4aiPaths(${JSON.stringify(root)});`)).rejects.toThrow(
      'Invalid Crawl4AI runtime manifest',
    )
  })

  it('gives repair instructions for a missing or stale receipt', async () => {
    const root = await fixture()
    await expect(
      run(`await api.ensureCrawl4aiInstalled(${JSON.stringify(root)});`),
    ).rejects.toThrow('pnpm crawl4ai:setup')
    await mkdir(join(root, '.cache/crawl4ai'), { recursive: true })
    await writeFile(
      join(root, '.cache/crawl4ai/installation.json'),
      JSON.stringify({ fingerprint: 'stale' }),
    )
    await expect(
      run(`await api.ensureCrawl4aiInstalled(${JSON.stringify(root)});`),
    ).rejects.toThrow('pnpm crawl4ai:setup')
  })

  it('refuses concurrent installation without touching its existing lock owner', async () => {
    const root = await fixture()
    const lock = join(root, '.cache/crawl4ai/install.lock')
    await mkdir(lock, { recursive: true })
    await writeFile(join(lock, 'owner.json'), 'existing-owner')
    await expect(run(`await api.installCrawl4ai({root:${JSON.stringify(root)}});`)).rejects.toThrow(
      'already running',
    )
    expect(await readFile(join(lock, 'owner.json'), 'utf8')).toBe('existing-owner')
  })

  it('refuses a symlinked runtime directory before changing an external target', async () => {
    const root = await fixture()
    const target = await mkdtemp(join(tmpdir(), 'crawl4ai-target-'))
    directories.push(target)
    await mkdir(join(root, '.cache'))
    await symlink(target, join(root, '.cache/crawl4ai'))
    await expect(run(`await api.installCrawl4ai({root:${JSON.stringify(root)}});`)).rejects.toThrow(
      'must not be a symlink',
    )
  })
})
