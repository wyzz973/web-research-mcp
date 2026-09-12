import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureOwnedGroups,
  stopOwnedProcesses,
  type OwnedProcessGroups,
} from '../src/fetch/browser-processes.ts'

const children: Array<{ child: ChildProcessWithoutNullStreams; owned?: OwnedProcessGroups }> = []
afterEach(async () => {
  for (const entry of children.splice(0)) await stopOwnedProcesses(entry.child, entry.owned)
})
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}
async function nextMessage(
  child: ChildProcessWithoutNullStreams,
): Promise<{ root: number; browser: number; renderer: number }> {
  const [chunk]: unknown[] = await once(child.stdout, 'data')
  if (!Buffer.isBuffer(chunk)) throw new Error('Missing process fixture output')
  const result: unknown = JSON.parse(chunk.toString('utf8').trim())
  if (
    !result ||
    typeof result !== 'object' ||
    !('root' in result) ||
    typeof result.root !== 'number' ||
    !('browser' in result) ||
    typeof result.browser !== 'number' ||
    !('renderer' in result) ||
    typeof result.renderer !== 'number'
  )
    throw new Error('Invalid process fixture output')
  return { root: result.root, browser: result.browser, renderer: result.renderer }
}
async function browserTree(ignoreTerm = false) {
  const renderer = `process.on('SIGTERM',()=>{${ignoreTerm ? '' : 'process.exit(0)'}});setInterval(()=>{},1000)`
  const browser = `
    const {spawn}=require('node:child_process');
    let child=spawn(process.execPath,['-e',${JSON.stringify(renderer)}],{stdio:'ignore'});
    let quitting=false;
    const report=()=>process.stdout.write(JSON.stringify({browser:process.pid,renderer:child.pid})+'\\n');
    process.on('SIGTERM',()=>{${ignoreTerm ? '' : "quitting=true;child.kill('SIGTERM')"}});
    child.on('exit',()=>{if(quitting)process.exit(0)});
    process.stdin.on('data',()=>{child=spawn(process.execPath,['-e',${JSON.stringify(renderer)}],{stdio:'ignore'});report()});
    setTimeout(report,100);setInterval(()=>{},1000);
  `
  const root = `
    const {spawn}=require('node:child_process');
    const browser=spawn(process.execPath,['-e',${JSON.stringify(browser)}],{detached:true,stdio:['pipe','pipe','pipe']});
    let quitting=false;
    browser.stdout.on('data',chunk=>process.stdout.write(JSON.stringify({root:process.pid,...JSON.parse(chunk.toString())})+'\\n'));
    browser.on('exit',()=>{if(quitting)process.exit(0)});
    process.on('SIGTERM',()=>{quitting=true;browser.kill('SIGTERM')});
    process.stdin.on('data',data=>{if(data.toString().startsWith('orphan'))process.exit(0);if(data.toString().startsWith('spawn'))browser.stdin.write('spawn');else{quitting=true;browser.kill('SIGTERM')}});
    setInterval(()=>{},1000);
  `
  const child = spawn(process.execPath, ['-e', root], {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.resume()
  const entry: { child: ChildProcessWithoutNullStreams; owned?: OwnedProcessGroups } = { child }
  children.push(entry)
  const pids = await nextMessage(child)
  const owned = await captureOwnedGroups(pids.root)
  entry.owned = owned
  return { child, owned, pids }
}

describe('owned browser process groups', () => {
  it('captures the separately detached browser through the actual parent chain', async () => {
    const { child, owned, pids } = await browserTree()
    expect(owned.rootPid).toBe(child.pid)
    expect(owned.groups).toContain(pids.root)
    expect(owned.groups).toContain(pids.browser)
    expect(owned.groups).not.toContain(pids.renderer)
    await stopOwnedProcesses(child, owned)
    expect(alive(pids.root)).toBe(false)
    expect(alive(pids.browser)).toBe(false)
    expect(alive(pids.renderer)).toBe(false)
  })
  it('checks that all recorded groups are gone after a cooperative worker exit', async () => {
    const { child, owned, pids } = await browserTree()
    const exited = once(child, 'exit')
    child.stdin.write('finish\n')
    await exited
    await stopOwnedProcesses(child, owned)
    expect(alive(pids.browser)).toBe(false)
    expect(alive(pids.renderer)).toBe(false)
  })
  it('cleans a recorded detached browser even after its original parent has exited', async () => {
    const { child, owned, pids } = await browserTree()
    const exited = once(child, 'exit')
    child.stdin.write('orphan\n')
    await exited
    expect(alive(pids.browser)).toBe(true)
    await stopOwnedProcesses(child, owned)
    expect(alive(pids.browser)).toBe(false)
    expect(alive(pids.renderer)).toBe(false)
  })
  it('escalates to KILL for a browser and renderer that ignore TERM', async () => {
    const { child, owned, pids } = await browserTree(true)
    await stopOwnedProcesses(child, owned)
    expect(alive(pids.root)).toBe(false)
    expect(alive(pids.browser)).toBe(false)
    expect(alive(pids.renderer)).toBe(false)
  }, 10_000)
  it('covers a renderer born after capture without claiming an unrelated detached sibling', async () => {
    const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    if (!other.pid) throw new Error('Fixture did not start')
    const otherOwned = await captureOwnedGroups(other.pid)
    children.push({ child: other, owned: otherOwned })
    const { child, owned } = await browserTree(true)
    const message = nextMessage(child)
    child.stdin.write('spawn\n')
    const late = await message
    await stopOwnedProcesses(child, owned)
    expect(alive(late.renderer)).toBe(false)
    expect(alive(other.pid)).toBe(true)
  }, 10_000)
  it('refuses to claim this process or a process outside its direct children', async () => {
    await expect(captureOwnedGroups(process.pid)).rejects.toMatchObject({
      code: 'EXTRACTION_FAILED',
    })
    await expect(captureOwnedGroups(process.ppid)).rejects.toMatchObject({
      code: 'EXTRACTION_FAILED',
    })
  })
  it('rejects an unregistered capability and a capability belonging to another worker', async () => {
    const a = await browserTree()
    const b = await browserTree()
    await expect(
      stopOwnedProcesses(a.child, { rootPid: a.owned.rootPid, groups: a.owned.groups }),
    ).rejects.toMatchObject({ code: 'EXTRACTION_FAILED' })
    await expect(stopOwnedProcesses(a.child, b.owned)).rejects.toMatchObject({
      code: 'EXTRACTION_FAILED',
    })
    expect(alive(a.pids.root)).toBe(true)
    expect(alive(b.pids.root)).toBe(true)
  })
})
