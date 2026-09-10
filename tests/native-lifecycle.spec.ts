import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const directories: string[] = []
const children: ChildProcess[] = []
const runners: string[] = []

async function freePort() {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing bound address')
  await new Promise<void>((done) => server.close(() => done()))
  return address.port
}

async function fixture(options: { unhealthy?: boolean; stubborn?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'native-mcp-'))
  directories.push(directory)
  const runner = join(directory, 'runner.mjs')
  const service = join(directory, 'service.mjs')
  await writeFile(
    service,
    `
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(join(directory, 'child.json'))}, JSON.stringify({pid:process.pid,secret:process.env.NATIVE_TEST_SECRET ?? null}))
const server=createServer((req,res)=>{res.statusCode=${options.unhealthy ? 503 : 200};res.end('OK')})
server.listen(Number(process.argv[2]),'127.0.0.1')
process.on('SIGTERM',()=>{ ${options.stubborn ? '' : 'server.close(()=>process.exit(0))'} })
`,
  )
  await writeFile(
    runner,
    `
import { createNativeController, controlRequest, serviceEnvironment, parsePort } from ${JSON.stringify(resolve('scripts/native-control.mjs'))}
import { readFile, writeFile } from 'node:fs/promises'
const paths={source:${JSON.stringify(directory)},settings:'unused',data:'unused'}
const controller=createNativeController({ directory:${JSON.stringify(directory)}, startupTimeout:1200,
supervisor:{command:process.execPath,args:[import.meta.filename],env:serviceEnvironment(paths)},
service:port=>({command:process.execPath,args:[${JSON.stringify(service)},String(port)],env:serviceEnvironment(paths)}) })
const [command,...args]=process.argv.slice(2)
try {
const portIndex=args.indexOf('--port');const port=portIndex<0?18888:parsePort(args[portIndex+1])
if(command==='run') await controller.run(port,args.includes('--managed-instance')?args[args.indexOf('--managed-instance')+1]:undefined)
else if(command==='wrong-token') { const state=JSON.parse(await readFile(controller.stateFile)); await controlRequest(controller.socketPath,{...state,token:'0'.repeat(64)},'stop') }
else if(command==='start') console.log(JSON.stringify(await controller.start(port)))
else console.log(JSON.stringify(await controller[command]()))
} catch(error) { console.error(error.message); process.exitCode=1 }
`,
  )
  runners.push(runner)
  return { directory, runner, port: await freePort() }
}

function call(runner: string, command: string, port?: number) {
  return execute(process.execPath, [runner, command, ...(port ? ['--port', String(port)] : [])], {
    timeout: 20000,
    env: { ...process.env, NATIVE_TEST_SECRET: 'must-not-reach-service' },
  })
}

afterEach(async () => {
  for (const runner of runners.splice(0)) {
    await call(runner, 'stop').catch(() => undefined)
  }
  for (const child of children.splice(0)) child.kill()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe('native SearXNG process ownership', () => {
  it('starts a real child, exposes authenticated status, strips secrets and waits for shutdown', async () => {
    const { directory, runner, port } = await fixture()
    const started = await call(runner, 'start', port)
    expect(JSON.parse(started.stdout)).toMatchObject({ status: 'ready', port })
    expect(JSON.parse((await call(runner, 'status')).stdout)).toMatchObject({
      status: 'ready',
      port,
    })
    const child = JSON.parse(await readFile(join(directory, 'child.json'), 'utf8')) as {
      pid: number
      secret: unknown
    }
    expect(child.secret).toBeNull()
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    for (const filename of ['state.json', 'control.sock', 'service.log']) {
      expect((await stat(join(directory, filename))).mode & 0o777).toBe(0o600)
    }
    await expect(call(runner, 'wrong-token')).rejects.toThrow('authentication failed')
    expect(JSON.parse((await call(runner, 'status')).stdout)).toMatchObject({ status: 'ready' })
    expect(JSON.parse((await call(runner, 'stop')).stdout)).toEqual({ status: 'stopped' })
    expect(() => process.kill(child.pid, 0)).toThrow()
    await expect(stat(join(directory, 'control.sock'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse((await call(runner, 'stop')).stdout)).toEqual({ status: 'stopped' })
  })

  it('serializes concurrent starts and stops with one service instance', async () => {
    const { runner, port } = await fixture()
    const starts = await Promise.all([call(runner, 'start', port), call(runner, 'start', port)])
    const first = JSON.parse(starts[0]?.stdout ?? '{}') as { instance: string }
    expect(JSON.parse(starts[1]?.stdout ?? '{}')).toMatchObject({ instance: first.instance })
    const stops = await Promise.all([call(runner, 'stop'), call(runner, 'stop')])
    expect(stops.map((result) => JSON.parse(result.stdout))).toEqual([
      { status: 'stopped' },
      { status: 'stopped' },
    ])
  })

  it('refuses an occupied port without disturbing its owner', async () => {
    const { runner, port } = await fixture()
    const server = createServer((socket) => socket.end('untouched'))
    await new Promise<void>((done) => server.listen(port, '127.0.0.1', done))
    try {
      await expect(call(runner, 'start', port)).rejects.toThrow(
        'Another service or Docker may own it',
      )
      expect(server.listening).toBe(true)
      expect(JSON.parse((await call(runner, 'status')).stdout)).toEqual({ status: 'stopped' })
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
    }
  })

  it('cleans up its unhealthy child after startup deadline', async () => {
    const { runner, port, directory } = await fixture({ unhealthy: true })
    await expect(call(runner, 'start', port)).rejects.toThrow('did not become healthy')
    const child = JSON.parse(await readFile(join(directory, 'child.json'), 'utf8')) as {
      pid: number
    }
    expect(() => process.kill(child.pid, 0)).toThrow()
    expect(JSON.parse((await call(runner, 'status')).stdout)).toEqual({ status: 'stopped' })
  })

  it('refuses live unresponsive state without signalling that PID', async () => {
    const { runner, directory, port } = await fixture()
    await writeFile(
      join(directory, 'state.json'),
      JSON.stringify({
        version: 1,
        instance: 'unrelated',
        token: '0'.repeat(64),
        port,
        pid: process.pid,
      }),
    )
    await expect(call(runner, 'stop')).rejects.toThrow('refusing to signal an unverified PID')
    expect(process.kill(process.pid, 0)).toBe(true)
  })

  it('foreground SIGTERM waits for the owned service to exit and removes control state', async () => {
    const { runner, directory, port } = await fixture()
    const supervisor = spawn(process.execPath, [runner, 'run', '--port', String(port)], {
      stdio: 'ignore',
    })
    children.push(supervisor)
    const exit = new Promise<void>((done) => supervisor.once('exit', () => done()))
    await expect
      .poll(async () => JSON.parse((await call(runner, 'status')).stdout).status)
      .toBe('ready')
    const service = JSON.parse(await readFile(join(directory, 'child.json'), 'utf8')) as {
      pid: number
    }
    supervisor.kill('SIGTERM')
    await exit
    expect(() => process.kill(service.pid, 0)).toThrow()
    await expect(stat(join(directory, 'state.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cancels an in-progress background start and waits for owned service cleanup', async () => {
    const { runner, directory, port } = await fixture({ unhealthy: true })
    const starter = spawn(process.execPath, [runner, 'start', '--port', String(port)], {
      stdio: 'ignore',
    })
    children.push(starter)
    const exit = new Promise<void>((done) => starter.once('exit', () => done()))
    await expect
      .poll(async () =>
        stat(join(directory, 'child.json')).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true)
    const service = JSON.parse(await readFile(join(directory, 'child.json'), 'utf8')) as {
      pid: number
    }
    starter.kill('SIGTERM')
    await exit
    expect(() => process.kill(service.pid, 0)).toThrow()
    expect(JSON.parse((await call(runner, 'status')).stdout)).toEqual({ status: 'stopped' })
  })

  it('recovers dead state without sending signals to the recorded PID', async () => {
    const { runner, directory, port } = await fixture()
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
    await new Promise<void>((done) => dead.once('exit', () => done()))
    await writeFile(
      join(directory, 'state.json'),
      JSON.stringify({ version: 1, instance: 'stale', token: '0'.repeat(64), port, pid: dead.pid }),
    )
    expect(JSON.parse((await call(runner, 'status')).stdout)).toMatchObject({ status: 'stale' })
    expect(JSON.parse((await call(runner, 'start', port)).stdout)).toMatchObject({
      status: 'ready',
    })
  })

  it('preserves an unknown live Unix socket instead of replacing it', async () => {
    const { runner, directory, port } = await fixture()
    const socketPath = join(directory, 'control.sock')
    const server = createServer((socket) => socket.end())
    await new Promise<void>((done) => server.listen(socketPath, done))
    try {
      await expect(call(runner, 'start', port)).rejects.toThrow('unidentified service owns')
      expect(server.listening).toBe(true)
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
    }
  })

  it('escalates an owned child that ignores TERM and confirms actual exit', async () => {
    const { runner, directory, port } = await fixture({ stubborn: true })
    await call(runner, 'start', port)
    const service = JSON.parse(await readFile(join(directory, 'child.json'), 'utf8')) as {
      pid: number
    }
    await call(runner, 'stop')
    expect(() => process.kill(service.pid, 0)).toThrow()
  }, 12000)

  it.each(['0', '1023', '65536', '3.5', 'NaN', '-1'])(
    'rejects invalid port %s before creating a child',
    async (port) => {
      const { runner, directory } = await fixture()
      await expect(execute(process.execPath, [runner, 'start', '--port', port])).rejects.toThrow(
        'Port must be an integer',
      )
      await expect(stat(join(directory, 'child.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )
})
