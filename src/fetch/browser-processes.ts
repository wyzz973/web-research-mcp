import { execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { AppError } from '../shared/errors.ts'

interface ProcessIdentity {
  pid: number
  parent: number
  group: number
  born: string
}
interface Ownership {
  root: ProcessIdentity
  groups: Map<number, Map<number, string>>
}
/** An in-memory capability, created only from a verified child-parent relationship. */
export interface OwnedProcessGroups {
  readonly rootPid: number
  readonly groups: readonly number[]
}
const capabilities = new WeakMap<OwnedProcessGroups, Ownership>()
const exec = promisify(execFile)

async function processTable(): Promise<ProcessIdentity[]> {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new AppError(
      'CONFIGURATION_REQUIRED',
      'Browser process ownership requires macOS/Linux ps.',
    )
  let output: string
  try {
    const result = await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 8 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
    })
    output = result.stdout
  } catch {
    throw new AppError('EXTRACTION_FAILED', 'Unable to verify browser process ownership with ps.')
  }
  const result: ProcessIdentity[] = []
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match?.[1] || !match[2] || !match[3] || !match[4])
      throw new AppError('EXTRACTION_FAILED', 'Invalid process ownership snapshot.')
    const pid = Number(match[1])
    const parent = Number(match[2])
    const group = Number(match[3])
    if (![pid, parent, group].every(Number.isSafeInteger) || pid <= 0 || parent < 0 || group < 0)
      throw new AppError('EXTRACTION_FAILED', 'Invalid process identifiers in ownership snapshot.')
    result.push({ pid, parent, group, born: match[4] })
  }
  return result
}
function sameIdentity(current: ProcessIdentity, expected: ProcessIdentity): boolean {
  return (
    current.pid === expected.pid &&
    current.born === expected.born &&
    current.group === expected.group
  )
}
function addDescendants(ownership: Ownership, table: readonly ProcessIdentity[]): void {
  const root = table.find((p) => p.pid === ownership.root.pid)
  if (!root || root.parent !== process.pid || !sameIdentity(root, ownership.root)) return
  const descendants = new Set([root.pid])
  for (let changed = true; changed;) {
    changed = false
    for (const row of table)
      if (!descendants.has(row.pid) && descendants.has(row.parent)) {
        descendants.add(row.pid)
        changed = true
      }
  }
  for (const row of table) {
    if (!descendants.has(row.pid)) continue
    const leader = table.find((p) => p.pid === row.group)
    // A inherited group led outside the verified subtree is never ours to signal.
    if (!leader || !descendants.has(leader.pid) || leader.pid !== leader.group) continue
    let members = ownership.groups.get(row.group)
    if (!members) {
      members = new Map()
      ownership.groups.set(row.group, members)
    }
    members.set(row.pid, row.born)
  }
}
/** Capture after Chromium has launched but before permitting navigation. No command
 * lines, environment variables or ports are inspected or used to claim ownership. */
export async function captureOwnedGroups(rootPid: number): Promise<OwnedProcessGroups> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 1 || rootPid === process.pid)
    throw new AppError('EXTRACTION_FAILED', 'Invalid browser child identity.')
  const table = await processTable()
  const root = table.find((p) => p.pid === rootPid)
  if (!root || root.parent !== process.pid || root.group !== root.pid)
    throw new AppError(
      'EXTRACTION_FAILED',
      'Browser root is not a live detached child of this process.',
    )
  const ownership: Ownership = { root, groups: new Map() }
  addDescendants(ownership, table)
  const capability: OwnedProcessGroups = Object.freeze({
    rootPid,
    groups: Object.freeze([...ownership.groups.keys()]),
  })
  capabilities.set(capability, ownership)
  return capability
}
function exists(group: number): boolean {
  try {
    process.kill(-group, 0)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}
/** Confirm at least one recorded birth identity anchors the group before adopting
 * new same-group renderers. Reused PIDs/group leaders are never signalled. */
function validateGroups(ownership: Ownership, table: readonly ProcessIdentity[]): number[] {
  const live: number[] = []
  for (const [group, known] of ownership.groups) {
    const members = table.filter((p) => p.group === group)
    if (!members.length) {
      ownership.groups.delete(group)
      continue
    }
    const leader = members.find((p) => p.pid === group)
    const leaderBirth = known.get(group)
    if (leader && leaderBirth && leader.born !== leaderBirth) {
      ownership.groups.delete(group)
      continue
    }
    if (!members.some((p) => known.get(p.pid) === p.born))
      throw new AppError(
        'EXTRACTION_FAILED',
        'Browser process group lost its verified ownership anchor; refusing to signal it.',
      )
    for (const member of members) known.set(member.pid, member.born)
    live.push(group)
  }
  return live
}
async function signalGroups(
  ownership: Ownership,
  signal: NodeJS.Signals,
  includeRoot: boolean,
): Promise<void> {
  const initial = await processTable()
  addDescendants(ownership, initial)
  const groups = validateGroups(ownership, initial).sort(
    (a, b) => Number(a === ownership.root.pid) - Number(b === ownership.root.pid),
  )
  for (const group of groups) {
    if (!includeRoot && group === ownership.root.pid) continue
    // Refresh identity immediately before each destructive signal, not merely at ready.
    if (!validateGroups(ownership, await processTable()).includes(group)) continue
    try {
      process.kill(-group, signal)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
    }
  }
}
async function waitForGroups(
  ownership: Ownership,
  timeoutMs: number,
  includeRoot = true,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (
      ![...ownership.groups.keys()].some(
        (group) => (includeRoot || group !== ownership.root.pid) && exists(group),
      )
    )
      return true
    // kill(..., 0) is non-destructive. ps is reserved for capture and signal boundaries.
    await delay(40)
  }
  const live = validateGroups(ownership, await processTable())
  return !live.some((group) => includeRoot || group !== ownership.root.pid)
}
/** Stop only authenticated worker/browser groups, including detached Chromium groups.
 * Cleanup waits for the registered groups to disappear even after Python exits itself. */
export async function stopOwnedProcesses(
  child: ChildProcess,
  captured?: OwnedProcessGroups,
): Promise<void> {
  const pid = child.pid
  if (!pid) return
  if (!captured && (child.exitCode !== null || child.signalCode !== null)) {
    if (!exists(pid)) return
    throw new AppError(
      'EXTRACTION_FAILED',
      'Browser root exited before ownership capture; remaining group cannot safely be claimed.',
    )
  }
  const capability = captured ?? (await captureOwnedGroups(pid))
  const ownership = capabilities.get(capability)
  if (!ownership || capability.rootPid !== pid)
    throw new AppError('EXTRACTION_FAILED', 'Invalid browser process ownership capability.')
  if (!validateGroups(ownership, await processTable()).length) return
  await signalGroups(ownership, 'SIGTERM', true)
  if (await waitForGroups(ownership, 1500)) return
  // Reap detached browsers while their Python/driver parents can still observe exit.
  await signalGroups(ownership, 'SIGKILL', false)
  await waitForGroups(ownership, 1500, false)
  await signalGroups(ownership, 'SIGKILL', true)
  if (!(await waitForGroups(ownership, 2000)))
    throw new AppError(
      'EXTRACTION_FAILED',
      'Verified browser process groups did not finish cleanup.',
    )
}
