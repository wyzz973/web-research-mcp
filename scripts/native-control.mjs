import { spawn } from 'node:child_process'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, createConnection } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export function parsePort(value = '18888') {
  if (!/^\d+$/.test(String(value)))
    throw new Error('Port must be an integer between 1024 and 65535')
  const port = Number(value)
  if (port < 1024 || port > 65535) throw new Error('Port must be an integer between 1024 and 65535')
  return port
}

export function serviceEnvironment(paths) {
  const env = {}
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP']) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return {
    ...env,
    PYTHONPATH: paths.source,
    PYTHONNOUSERSITE: '1',
    SEARXNG_SETTINGS_PATH: paths.settings,
    // This pinned SearXNG revision derives SQLite caches from tempfile.gettempdir().
    // Do not share the OS temp cache between independently signed local instances.
    TMPDIR: paths.data,
    TMP: paths.data,
    TEMP: paths.data,
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await stat(path)
  if (info.uid !== process.getuid())
    throw new Error(`Runtime directory is owned by another user: ${path}`)
  await chmod(path, 0o700)
}

async function readState(file) {
  try {
    const state = JSON.parse(await readFile(file, 'utf8'))
    if (
      state.version !== 1 ||
      typeof state.instance !== 'string' ||
      typeof state.token !== 'string' ||
      state.token.length !== 64 ||
      !Number.isInteger(state.port) ||
      !Number.isInteger(state.pid)
    )
      throw new Error('Invalid native state; inspect the private runtime directory before retrying')
    return state
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

async function saveState(file, state) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function controlRequest(socketPath, state, action, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let text = ''
    const finish = (error, result) => {
      socket.destroy()
      if (error) reject(error)
      else resolve(result)
    }
    socket.setTimeout(timeout, () => finish(new Error('Native control request timed out')))
    socket.once('error', (error) => finish(error))
    socket.once('connect', () => {
      socket.write(JSON.stringify({ token: state.token, instance: state.instance, action }) + '\n')
    })
    socket.on('data', (chunk) => {
      text += chunk
      if (text.length > 8192) return finish(new Error('Invalid native control response'))
      if (!text.includes('\n')) return
      try {
        const result = JSON.parse(text.split('\n')[0])
        if (result.instance !== state.instance || result.error) {
          finish(new Error(result.error ?? 'Native control identity mismatch'))
        } else finish(undefined, result)
      } catch (error) {
        finish(error)
      }
    })
    socket.once('end', () => {
      if (!text.includes('\n')) finish(new Error('Native control closed without a response'))
    })
  })
}

async function waitForExit(exit, milliseconds) {
  let timer
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function probeHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1000),
      redirect: 'error',
    })
    await response.body?.cancel()
    return response.status === 200
  } catch {
    return false
  }
}

async function assertPortAvailable(port) {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', (error) =>
      reject(
        new Error(
          `127.0.0.1:${port} is unavailable (${error.code}). Another service or Docker may own it; stop it yourself or choose --port.`,
        ),
      ),
    )
    server.listen(port, '127.0.0.1', resolve)
  })
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}

/**
 * Serialize installation and lifecycle mutations for one native runtime directory.
 * The timeout bounds lock acquisition only; the callback owns its cancellation and cleanup.
 * Managed run children must not acquire this lock while their start parent owns it.
 * @template T
 * @param {string} directory
 * @param {() => Promise<T>} operation
 * @param {{ waitTimeoutMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withNativeLifecycleLock(
  directory,
  operation,
  { waitTimeoutMs = 75000 } = {},
) {
  await privateDirectory(directory)
  if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs <= 0)
    throw new Error('Lock waitTimeoutMs must be positive')
  const lockDirectory = join(directory, 'lifecycle.lock')
  const deadline = Date.now() + waitTimeoutMs
  const owner = { pid: process.pid, id: randomUUID() }
  while (true) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 })
      await writeFile(join(lockDirectory, 'owner.json'), JSON.stringify(owner), { mode: 0o600 })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const previous = JSON.parse(await readFile(join(lockDirectory, 'owner.json'), 'utf8'))
        if (Number.isInteger(previous.pid) && !isAlive(previous.pid)) {
          try {
            await mkdir(join(lockDirectory, 'recovery'), { mode: 0o700 })
          } catch (claimError) {
            if (['EEXIST', 'ENOENT'].includes(claimError.code)) {
              await delay(50)
              continue
            }
            throw claimError
          }
          const claimed = JSON.parse(await readFile(join(lockDirectory, 'owner.json'), 'utf8'))
          if (claimed.id !== previous.id || isAlive(claimed.pid)) {
            await rm(join(lockDirectory, 'recovery'), { recursive: true, force: true })
            await delay(50)
            continue
          }
          await rm(lockDirectory, { recursive: true, force: true })
          continue
        }
      } catch (readError) {
        if (readError.code !== 'ENOENT') throw readError
      }
      if (Date.now() > deadline)
        throw new Error('Another native lifecycle operation still holds the lock')
      await delay(100)
    }
  }
  try {
    return await operation()
  } finally {
    await rm(lockDirectory, { recursive: true, force: true })
  }
}

/** Owns only children it spawns. Existing processes are contacted through authenticated control. */
export function createNativeController(options) {
  const directory = options.directory
  const stateFile = join(directory, 'state.json')
  const socketPath = join(directory, 'control.sock')
  const startupTimeout = options.startupTimeout ?? 60000

  const withLock = (operation) =>
    withNativeLifecycleLock(directory, operation, { waitTimeoutMs: startupTimeout + 15000 })

  async function inspect() {
    const state = await readState(stateFile)
    if (!state) return { status: 'stopped' }
    try {
      const result = await controlRequest(socketPath, state, 'status')
      return { ...result, url: `http://127.0.0.1:${state.port}`, port: state.port }
    } catch (error) {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
        return { status: isAlive(state.pid) ? 'unresponsive' : 'stale', port: state.port }
      }
      throw error
    }
  }

  async function clearStale() {
    const status = await inspect()
    if (status.status === 'stale') {
      await rm(socketPath, { force: true })
      await rm(stateFile, { force: true })
    } else if (status.status === 'stopped') {
      // An orphaned socket is removed only after a refused connection, never by PID or port.
      try {
        await new Promise((resolve, reject) => {
          const socket = createConnection(socketPath)
          socket.once('connect', () => {
            socket.destroy()
            resolve()
          })
          socket.once('error', reject)
          socket.setTimeout(1000, () => {
            socket.destroy()
            reject(new Error('Unknown control socket timed out'))
          })
        })
        throw new Error('An unidentified service owns the native control socket')
      } catch (error) {
        if (!['ECONNREFUSED', 'ENOENT'].includes(error.code)) throw error
        await rm(socketPath, { force: true })
      }
    }
    return status
  }

  async function waitStopped(state, timeout = 15000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const current = await readState(stateFile)
      if (!current || current.instance !== state.instance) return
      await delay(100)
    }
    throw new Error('Native service did not confirm cleanup; it has not been reported as stopped')
  }

  async function stop() {
    return withLock(async () => {
      const status = await clearStale()
      if (status.status === 'stopped' || status.status === 'stale') return { status: 'stopped' }
      if (status.status === 'unresponsive')
        throw new Error('Native supervisor is unresponsive; refusing to signal an unverified PID')
      const state = await readState(stateFile)
      await controlRequest(socketPath, state, 'stop')
      await waitStopped(state)
      return { status: 'stopped' }
    })
  }

  async function start(port = 18888) {
    port = parsePort(port)
    let interrupted = false
    const onInterrupt = () => {
      interrupted = true
    }
    process.on('SIGINT', onInterrupt)
    process.on('SIGTERM', onInterrupt)
    try {
      return await withLock(async () => {
        if (interrupted) throw new Error('Native startup cancelled')
        let owned = false
        const status = await clearStale()
        if (status.status === 'ready' || status.status === 'starting') {
          if (status.port !== port)
            throw new Error(
              `Native SearXNG already owns port ${status.port}; stop it before changing ports`,
            )
          if (status.status === 'ready') return status
        } else if (status.status === 'unresponsive') {
          throw new Error(
            'Native supervisor is unresponsive; refusing to replace an unverified process',
          )
        } else {
          await options.ensureInstalled?.()
          await assertPortAvailable(port)
          if (interrupted) throw new Error('Native startup cancelled')
          const instance = randomUUID()
          const token = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
          const log = await open(join(directory, 'service.log'), 'a', 0o600)
          await log.chmod(0o600)
          // The child waits for its state file, so a very fast spawn cannot read incomplete state.
          const child = spawn(
            options.supervisor.command,
            [
              ...options.supervisor.args,
              'run',
              '--port',
              String(port),
              '--managed-instance',
              instance,
            ],
            { detached: true, stdio: ['ignore', log.fd, log.fd], env: options.supervisor.env },
          )
          const spawned = new Promise((resolve, reject) => {
            child.once('spawn', resolve)
            child.once('error', reject)
          })
          try {
            await spawned
          } finally {
            await log.close()
          }
          await saveState(stateFile, { version: 1, instance, token, port, pid: child.pid })
          owned = true
          child.unref()
        }
        const state = await readState(stateFile)
        const deadline = Date.now() + startupTimeout
        while (Date.now() < deadline && !interrupted) {
          const current = await inspect()
          if (current.status === 'ready') return current
          if (current.status === 'stopped' || current.status === 'stale') break
          await delay(150)
        }
        if (!owned)
          throw new Error(
            interrupted ? 'Native startup cancelled' : 'Existing SearXNG did not become healthy',
          )
        // Shutdown still requires token identity; never kill a PID read from disk.
        try {
          if ((await readState(stateFile))?.instance === state.instance) {
            const cleanupDeadline = Date.now() + 5000
            while (true) {
              try {
                await controlRequest(socketPath, state, 'stop')
                break
              } catch (error) {
                if (
                  !['ENOENT', 'ECONNREFUSED'].includes(error.code) ||
                  Date.now() > cleanupDeadline
                )
                  throw error
                if (!(await readState(stateFile))) break
                await delay(50)
              }
            }
            await waitStopped(state)
          }
        } catch (error) {
          throw new Error(
            `Startup failed and cleanup could not be confirmed: ${error.message}. Inspect ${join(directory, 'service.log')}`,
          )
        }
        throw new Error(
          interrupted
            ? 'Native startup cancelled; supervised service stopped'
            : `SearXNG did not become healthy; inspect ${join(directory, 'service.log')}`,
        )
      })
    } finally {
      process.removeListener('SIGINT', onInterrupt)
      process.removeListener('SIGTERM', onInterrupt)
    }
  }

  async function run(port = 18888, managedInstance) {
    port = parsePort(port)
    let state
    if (managedInstance) {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        state = await readState(stateFile)
        if (state?.instance === managedInstance) break
        await delay(30)
      }
      if (
        !state ||
        state.instance !== managedInstance ||
        state.pid !== process.pid ||
        state.port !== port
      ) {
        throw new Error('Managed supervisor identity does not match private state')
      }
    } else {
      await withLock(async () => {
        const status = await clearStale()
        if (!['stopped', 'stale'].includes(status.status))
          throw new Error('Native SearXNG is already running')
        await options.ensureInstalled?.()
        await assertPortAvailable(port)
        state = {
          version: 1,
          instance: randomUUID(),
          token: randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
          port,
          pid: process.pid,
        }
        await saveState(stateFile, state)
      })
    }
    let child
    let childExit
    let stopping
    let exited = false
    let ready = false
    const connections = new Set()
    const server = createServer((socket) => {
      connections.add(socket)
      socket.on('error', () => socket.destroy())
      socket.once('close', () => connections.delete(socket))
      socket.setTimeout(2000, () => socket.destroy())
      let buffer = ''
      socket.on('data', (data) => {
        buffer += data
        if (buffer.length > 4096) return socket.destroy()
        if (!buffer.includes('\n')) return
        socket.removeAllListeners('data')
        let request
        try {
          request = JSON.parse(buffer.split('\n')[0])
        } catch {
          return socket.destroy()
        }
        const token = Buffer.from(typeof request.token === 'string' ? request.token : '')
        const expected = Buffer.from(state.token)
        if (
          token.length !== expected.length ||
          !timingSafeEqual(token, expected) ||
          request.instance !== state.instance
        ) {
          socket.end(JSON.stringify({ error: 'Native control authentication failed' }) + '\n')
          return
        }
        if (request.action !== 'status' && request.action !== 'stop') {
          socket.end(
            JSON.stringify({ instance: state.instance, error: 'Unknown control action' }) + '\n',
          )
          return
        }
        socket.end(
          JSON.stringify({
            instance: state.instance,
            status: stopping ? 'stopping' : ready ? 'ready' : 'starting',
          }) + '\n',
        )
        if (request.action === 'stop') void shutdown()
      })
    })
    async function cleanup() {
      const current = await readState(stateFile)
      if (current?.instance === state.instance) {
        await rm(socketPath, { force: true })
        await rm(stateFile, { force: true })
      }
    }
    let groupFinished = false
    function groupAlive() {
      if (groupFinished || !child?.pid) return false
      try {
        process.kill(-child.pid, 0)
        return true
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
        groupFinished = true
        return false
      }
    }
    async function waitChildGroup(milliseconds) {
      const deadline = Date.now() + milliseconds
      if (
        !(await waitForExit(
          childExit.catch(() => {}),
          milliseconds,
        ))
      )
        return false
      while (groupAlive() && Date.now() < deadline) await delay(50)
      return !groupAlive()
    }
    function signalChild(signal) {
      if (!groupAlive()) return
      try {
        process.kill(-child.pid, signal)
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
        groupFinished = true
      }
    }
    function shutdown() {
      if (stopping) return stopping
      stopping = (async () => {
        const serverClosed = new Promise((resolve) => server.close(() => resolve()))
        for (const socket of connections) socket.end()
        signalChild('SIGTERM')
        if (childExit) {
          const done = await waitChildGroup(7000)
          if (!done) signalChild('SIGKILL')
          const killed = await waitChildGroup(3000)
          if (!killed) throw new Error('Supervised child did not exit after SIGKILL')
        }
        for (const socket of connections) socket.destroy()
        await serverClosed
        await cleanup()
      })()
      return stopping
    }
    const onSignal = () => {
      void shutdown().catch((error) => {
        process.stderr.write(error.message + '\n')
        process.exitCode = 1
      })
    }
    process.on('SIGTERM', onSignal)
    process.on('SIGINT', onSignal)
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolve)
      })
      await chmod(socketPath, 0o600)
      if (stopping) return
      await options.ensureInstalled?.()
      if (stopping) return
      const service = options.service(port)
      const previousMask = process.umask(0o077)
      try {
        child = spawn(service.command, service.args, {
          cwd: service.cwd,
          env: service.env,
          detached: true,
          stdio: ['ignore', 'inherit', 'inherit'],
        })
      } finally {
        process.umask(previousMask)
      }
      childExit = new Promise((resolve, reject) => {
        child.once('error', (error) => {
          exited = true
          reject(error)
        })
        child.once('exit', (code, signal) => {
          exited = true
          resolve({ code, signal })
        })
      })
      // Immediately observe rejection while readiness is being checked.
      void childExit.catch(() => {})
      while (!exited && !stopping) {
        ready = await probeHealth(port)
        if (ready) break
        await delay(100)
      }
      const result = await childExit
      if (!stopping && result.code !== 0)
        throw new Error(`SearXNG exited (${result.code ?? result.signal})`)
    } finally {
      await shutdown()
      process.removeListener('SIGTERM', onSignal)
      process.removeListener('SIGINT', onSignal)
    }
  }

  return { start, stop, status: inspect, run, socketPath, stateFile }
}
