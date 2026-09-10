/** Install a hash-pinned SearXNG source tree and isolated Python environment, without Docker. */
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withNativeLifecycleLock } from './native-control.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const digest = (value) => createHash('sha256').update(value).digest('hex')

export function nativePaths(root = projectRoot) {
  root = path.resolve(root)
  const manifestFile = path.join(root, 'deploy/native/source.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  if (
    !/^[a-f0-9]{40}$/u.test(manifest.revision) ||
    !/^[a-f0-9]{64}$/u.test(manifest.archive_sha256) ||
    manifest.archive_url !==
      `https://codeload.github.com/searxng/searxng/tar.gz/${manifest.revision}` ||
    !/^3\.\d+\.\d+$/u.test(manifest.python)
  )
    throw new Error('Invalid pinned native source manifest.')
  const directory = path.join(root, '.cache/searxng-native')
  return {
    root,
    directory,
    manifest,
    manifestFile,
    receiptFile: path.join(directory, 'installation.json'),
    source: path.join(directory, `searxng-${manifest.revision}`),
    python: path.join(directory, 'venv/bin/python'),
    settings: path.join(directory, 'settings.yml'),
    data: path.join(directory, 'data'),
    lockfile: path.join(root, 'deploy/native/requirements.lock'),
  }
}

/** Explicit environment for installer/server subprocesses; no ambient API credentials or Python overrides. */
export function nativeEnvironment() {
  return {
    ...Object.fromEntries(
      ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP'].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]]] : [],
      ),
    ),
    PYTHONNOUSERSITE: '1',
    UV_NO_CONFIG: '1',
  }
}

async function exists(file) {
  try {
    await access(file)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Native runtime directory must not be a symlink.')
  await chmod(directory, 0o700)
}

async function privateWrite(file, data) {
  if (await exists(file)) {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('Native runtime state must be a regular file.')
  }
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
  await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
  await rename(temporary, file)
}

async function fingerprint(paths) {
  return digest(
    Buffer.concat([
      await readFile(paths.manifestFile),
      await readFile(paths.lockfile),
      await readFile(path.join(paths.root, 'deploy/settings.template.yaml')),
      Buffer.from(`native-install-v1:${process.platform}:${process.arch}`),
    ]),
  )
}

function frozenVersion(manifest) {
  // SearXNG supports version_frozen for exported archives. Do not accidentally discover the outer MCP Git repository.
  return `# Generated deployment version metadata for an upstream source archive.\nVERSION_STRING = ${JSON.stringify(manifest.version)}\nVERSION_TAG = ${JSON.stringify(manifest.version)}\nDOCKER_TAG = ${JSON.stringify(manifest.version.replace('+', '-'))}\nGIT_URL = "https://github.com/searxng/searxng"\nGIT_BRANCH = "master"\n`
}

function command(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason)
      return
    }
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: nativeEnvironment(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let failure
    let timer
    const abort = () => {
      failure ??= options.signal.reason ?? new Error('Native setup cancelled.')
      if (child.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch (error) {
          if (error.code !== 'ESRCH') failure = error
        }
        timer = setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch (error) {
            if (error.code !== 'ESRCH')
              process.stderr.write(`Native setup cleanup failed: ${error.message}\n`)
          }
        }, 5000)
      }
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-1024 * 1024)
      if (!options.quiet) process.stderr.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (!options.quiet) process.stderr.write(chunk)
    })
    child.once('error', (error) => {
      failure = new Error(`${bin} unavailable: ${error.message}. Install uv and retry setup.`)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code === 0) resolve(stdout.trim())
      else reject(new Error(`${bin} exited with ${code}; native setup did not complete.`))
    })
    if (options.signal?.aborted) abort()
  })
}

async function probeRuntime(paths, dependencies = true, signal = AbortSignal.timeout(20_000)) {
  const prefix = path.dirname(path.dirname(paths.python))
  const script = `import sys, os, platform\nassert platform.python_version() == sys.argv[2], 'Python version mismatch'\nassert sys.prefix != sys.base_prefix and os.path.realpath(sys.prefix) == os.path.realpath(sys.argv[1]), 'Not the managed virtual environment'\n${dependencies ? 'import flask, flask_babel, lxml, curl_cffi, yaml, granian, babel, pygments, dateutil, valkey, markdown_it, msgspec, typer, isodate, whitenoise, typing_extensions, setproctitle\n' : ''}print(platform.python_version())`
  return command(paths.python, ['-c', script, prefix, paths.manifest.python], {
    quiet: true,
    signal,
  })
}

/** Refuse stale receipts or altered generated settings instead of silently running another configuration. */
export async function ensureNativeInstalled(root = projectRoot) {
  const paths = nativePaths(root)
  try {
    if (await exists(path.join(paths.directory, 'install.lock')))
      throw new Error('Native installation is in progress.')
    const receipt = JSON.parse(await readFile(paths.receiptFile, 'utf8'))
    if (
      receipt.format !== 1 ||
      receipt.fingerprint !== (await fingerprint(paths)) ||
      receipt.revision !== paths.manifest.revision ||
      receipt.python !== paths.manifest.python ||
      receipt.settings_sha256 !== digest(await readFile(paths.settings)) ||
      (await readFile(path.join(paths.source, 'searx/version_frozen.py'), 'utf8')) !==
        frozenVersion(paths.manifest)
    ) {
      throw new Error('Native installation or configuration differs from its pinned receipt.')
    }
    await access(paths.python)
    await access(path.join(paths.source, 'searx/webapp.py'))
    await privateDirectory(paths.data)
    await probeRuntime(paths)
  } catch (error) {
    throw new Error(
      `Native SearXNG is not prepared (${error.message}). Run pnpm searxng:native:setup.`,
    )
  }
  return paths
}

/** Install/update only this project's private runtime, preserving a previously generated instance secret. */
export async function installNative({ root = projectRoot } = {}) {
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error('Native deployment currently supports macOS and Linux.')
  const paths = nativePaths(root)
  await privateDirectory(path.join(paths.root, '.cache'))
  await privateDirectory(paths.directory)
  return withNativeLifecycleLock(paths.directory, () => installLocked(paths))
}

async function installLocked(paths) {
  const root = paths.root
  try {
    await ensureNativeInstalled(root)
    process.stderr.write('Native SearXNG is already prepared.\n')
    return paths
  } catch {
    /* Receipt mismatch is resolved by setup below, never ignored by start. */
  }
  if (await exists(path.join(paths.directory, 'state.json')))
    throw new Error('Stop native SearXNG before refreshing its installation.')
  const lock = path.join(paths.directory, 'install.lock')
  if (await exists(lock)) {
    const info = await lstat(lock)
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('Inspect the unrecognized install.lock before retrying setup.')
    const owner = JSON.parse(await readFile(lock, 'utf8'))
    if (!Number.isInteger(owner.pid) || owner.pid <= 1)
      throw new Error('Inspect the unrecognized install.lock before retrying setup.')
    let alive = true
    try {
      process.kill(owner.pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') alive = false
      else throw error
    }
    if (alive) throw new Error('A native installer process still owns install.lock.')
    await rm(lock)
  }
  const handle = await open(lock, 'wx', 0o600).catch(() => {
    throw new Error(
      'Another native setup is running (or install.lock needs stale-lock inspection).',
    )
  })
  const controller = new AbortController()
  const cancel = () =>
    controller.abort(
      new Error('Native setup cancelled; rerun setup to repair any incomplete environment.'),
    )
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }),
    )
    await rm(paths.receiptFile, { force: true })
    const archive = path.join(paths.directory, 'source.tar.gz')
    if (await exists(archive)) {
      const info = await lstat(archive)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024)
        throw new Error('Cached source archive is not a bounded regular file.')
    }
    let data = (await exists(archive)) ? await readFile(archive) : null
    if (!data || digest(data) !== paths.manifest.archive_sha256) {
      const response = await fetch(paths.manifest.archive_url, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
      })
      if (!response.ok) throw new Error(`SearXNG source download failed: HTTP ${response.status}`)
      if (!response.body) throw new Error('SearXNG source download returned no body.')
      const chunks = []
      let bytes = 0
      for await (const chunk of response.body) {
        bytes += chunk.length
        if (bytes > 64 * 1024 * 1024) throw new Error('SearXNG archive exceeds its download limit.')
        chunks.push(chunk)
      }
      data = Buffer.concat(chunks)
      if (digest(data) !== paths.manifest.archive_sha256)
        throw new Error('Pinned source archive SHA-256 mismatch; refusing extraction.')
      await privateWrite(archive, data)
    }
    process.stderr.write(`Verified SearXNG ${paths.manifest.version} source SHA-256.\n`)
    const staging = path.join(paths.directory, `source-stage-${randomBytes(8).toString('hex')}`)
    await privateDirectory(staging)
    try {
      await command('tar', ['-xzf', archive, '-C', staging], {
        quiet: true,
        signal: controller.signal,
      })
      if (await exists(paths.source)) {
        const info = await lstat(paths.source)
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new Error('Existing source path is not a managed directory.')
        await rm(paths.source, { recursive: true })
      }
      await rename(path.join(staging, `searxng-${paths.manifest.revision}`), paths.source)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
    await privateWrite(
      path.join(paths.source, 'searx/version_frozen.py'),
      frozenVersion(paths.manifest),
    )
    const venv = path.join(paths.directory, 'venv')
    if (await exists(venv)) {
      const info = await lstat(venv)
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('The managed virtual environment must not be a symlink.')
    }
    if (!(await exists(paths.python)))
      await command('uv', ['venv', '--python', paths.manifest.python, venv], {
        signal: controller.signal,
      })
    const pythonVersion = await probeRuntime(paths, false, controller.signal)
    if (pythonVersion !== paths.manifest.python)
      throw new Error(
        `Expected Python ${paths.manifest.python}; found ${pythonVersion}. Remove only the stopped native venv and rerun setup.`,
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
      { signal: controller.signal },
    )
    await probeRuntime(paths, true, controller.signal)
    let secret
    if (await exists(paths.settings))
      secret = (await readFile(paths.settings, 'utf8')).match(
        /^\s*secret_key: '([a-f0-9]{64})'$/mu,
      )?.[1]
    secret ??= randomBytes(32).toString('hex')
    const template = await readFile(path.join(paths.root, 'deploy/settings.template.yaml'), 'utf8')
    await privateWrite(
      paths.settings,
      template
        .replace('__LOCAL_RANDOM_SECRET__', secret)
        .replace('\nserver:\n', '\nserver:\n  bind_address: 127.0.0.1\n'),
    )
    await privateDirectory(paths.data)
    controller.signal.throwIfAborted()
    const receipt = {
      format: 1,
      revision: paths.manifest.revision,
      python: pythonVersion,
      fingerprint: await fingerprint(paths),
      settings_sha256: digest(await readFile(paths.settings)),
      prepared_at: new Date().toISOString(),
    }
    await privateWrite(paths.receiptFile, JSON.stringify(receipt, null, 2) + '\n')
    process.stderr.write(
      'Native SearXNG installed in the project cache; settings secret is private.\n',
    )
    return paths
  } finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
    await handle.close()
    await rm(lock, { force: true })
  }
}
