/** Install the optional, hash-pinned Crawl4AI renderer and its managed Chromium. */
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))

export function crawl4aiPaths(root = projectRoot) {
  root = path.resolve(root)
  const manifestFile = path.join(root, 'deploy/crawl4ai/source.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  if (
    manifest.format !== 1 ||
    manifest.python !== '3.12.11' ||
    manifest.crawl4ai !== '0.9.3' ||
    manifest.playwright !== '1.62.0'
  )
    throw new Error('Invalid Crawl4AI runtime manifest.')
  const directory = path.join(root, '.cache/crawl4ai')
  return {
    root,
    directory,
    manifest,
    manifestFile,
    python: path.join(directory, 'venv/bin/python'),
    browsers: path.join(directory, 'browsers'),
    data: path.join(directory, 'data'),
    lockfile: path.join(root, 'deploy/crawl4ai/requirements.lock'),
    receipt: path.join(directory, 'installation.json'),
  }
}

/** Only installation variables, never ambient model keys, proxies or Python overrides. */
export function crawl4aiEnvironment(paths) {
  return {
    ...Object.fromEntries(
      ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP'].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]]] : [],
      ),
    ),
    PYTHONNOUSERSITE: '1',
    UV_NO_CONFIG: '1',
    PLAYWRIGHT_BROWSERS_PATH: paths.browsers,
    CRAWL4_AI_BASE_DIRECTORY: paths.data,
    LITELLM_LOCAL_MODEL_COST_MAP: 'True',
    HF_HUB_OFFLINE: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
  }
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Crawl4AI runtime directory must not be a symlink.')
  await chmod(directory, 0o700)
}

async function fingerprint(paths) {
  return createHash('sha256')
    .update(await readFile(paths.manifestFile))
    .update(await readFile(paths.lockfile))
    .update(`crawl4ai-install-v1:${process.platform}:${process.arch}`)
    .digest('hex')
}

function command(bin, args, paths, { signal, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const child = spawn(bin, args, {
      cwd: paths.root,
      env: crawl4aiEnvironment(paths),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let failure
    let timer
    const kill = (name) => {
      if (!child.pid || child.exitCode !== null) return
      try {
        process.kill(-child.pid, name)
      } catch (error) {
        if (error.code !== 'ESRCH') failure ??= error
      }
    }
    const cancel = () => {
      failure ??= signal.reason ?? new Error('Crawl4AI installation cancelled.')
      kill('SIGTERM')
      timer = setTimeout(() => kill('SIGKILL'), 5000)
    }
    signal?.addEventListener('abort', cancel, { once: true })
    child.stdout.on('data', (chunk) => {
      output = (output + chunk).slice(-64 * 1024)
      if (!quiet) process.stderr.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (!quiet) process.stderr.write(chunk)
    })
    child.once('error', (error) => {
      failure = new Error(`Cannot run ${bin}: ${error.message}`)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      if (failure) reject(failure)
      else if (code !== 0)
        reject(new Error(`${bin} exited with ${code}. Install uv, then rerun pnpm crawl4ai:setup.`))
      else resolve(output.trim())
    })
    if (signal?.aborted) cancel()
  })
}

async function probe(paths, signal) {
  const script = `import asyncio, os, sys, platform, importlib.metadata as m\nfrom playwright.async_api import async_playwright\nimport crawl4ai\nassert platform.python_version() == sys.argv[2]\nassert sys.prefix != sys.base_prefix and os.path.realpath(sys.prefix) == os.path.realpath(sys.argv[1])\nassert m.version('crawl4ai') == sys.argv[3]\nassert m.version('playwright') == sys.argv[4]\nasync def check():\n async with async_playwright() as p:\n  assert os.path.isfile(p.chromium.executable_path), 'Chromium missing'\n  browser = await p.chromium.launch(headless=True, chromium_sandbox=True, proxy={'server':'http://127.0.0.1:9','bypass':'<-loopback>'}, args=['--proxy-bypass-list=<-loopback>','--disable-background-networking','--disable-quic'])\n  await browser.close()\nasyncio.run(check())\nprint('ready')`
  await command(
    paths.python,
    [
      '-c',
      script,
      path.dirname(path.dirname(paths.python)),
      paths.manifest.python,
      paths.manifest.crawl4ai,
      paths.manifest.playwright,
    ],
    paths,
    { signal, quiet: true },
  )
}

/** Inspect a receipt and actually import the packages/launch bundled Chromium. */
export async function ensureCrawl4aiInstalled(root = projectRoot) {
  const paths = crawl4aiPaths(root)
  try {
    const receipt = JSON.parse(await readFile(paths.receipt, 'utf8'))
    if (receipt.fingerprint !== (await fingerprint(paths))) throw new Error('Stale receipt')
    await probe(paths, AbortSignal.timeout(30_000))
    return paths
  } catch {
    throw new Error('Crawl4AI is unavailable; run pnpm crawl4ai:setup to install or repair it.')
  }
}

export async function installCrawl4ai({ root = projectRoot } = {}) {
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error('Native Crawl4AI setup currently supports macOS and Linux.')
  const paths = crawl4aiPaths(root)
  await privateDirectory(paths.directory)
  const lock = path.join(paths.directory, 'install.lock')
  try {
    await mkdir(lock, { mode: 0o700 })
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        'Crawl4AI setup is already running; inspect install.lock if a previous process was killed.',
      )
    throw error
  }
  const controller = new AbortController()
  const stop = () => controller.abort(new Error('Crawl4AI setup cancelled.'))
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), {
      mode: 0o600,
    })
    await privateDirectory(paths.data)
    await privateDirectory(paths.browsers)
    try {
      const receipt = JSON.parse(await readFile(paths.receipt, 'utf8'))
      if (receipt.fingerprint === (await fingerprint(paths))) {
        await probe(paths, controller.signal)
        process.stderr.write('Crawl4AI and managed Chromium are already ready.\n')
        return paths
      }
    } catch {
      /* A missing or damaged runtime is repaired from the frozen lock below. */
    }
    controller.signal.throwIfAborted()
    await rm(paths.receipt, { force: true })
    await command(
      'uv',
      [
        'venv',
        '--python',
        paths.manifest.python,
        '--managed-python',
        '--allow-existing',
        path.dirname(path.dirname(paths.python)),
      ],
      paths,
      { signal: controller.signal },
    )
    await command(
      'uv',
      [
        'pip',
        'sync',
        '--python',
        paths.python,
        '--require-hashes',
        '--only-binary',
        ':all:',
        '--reinstall',
        '--index-url',
        'https://pypi.org/simple',
        paths.lockfile,
      ],
      paths,
      { signal: controller.signal },
    )
    await command(paths.python, ['-m', 'playwright', 'install', 'chromium'], paths, {
      signal: controller.signal,
    })
    await probe(paths, controller.signal)
    const temporary = `${paths.receipt}.${randomUUID()}.tmp`
    await writeFile(
      temporary,
      JSON.stringify(
        {
          format: 1,
          fingerprint: await fingerprint(paths),
          installed_at: new Date().toISOString(),
          python: paths.manifest.python,
          crawl4ai: paths.manifest.crawl4ai,
          playwright: paths.manifest.playwright,
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    )
    await rename(temporary, paths.receipt)
    process.stderr.write(
      'Crawl4AI and managed Chromium are ready; no Docker or API key required.\n',
    )
    return paths
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    await rm(lock, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await installCrawl4ai()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
