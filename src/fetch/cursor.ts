/** What a `c_…` cursor remembers. Stored as JSON, so it is validated again when read back. */
export type CursorState =
  | { kind: 'read'; snapshot: string; offset: number; end?: number }
  | { kind: 'find'; snapshot: string; find: string; from: number }
  | { kind: 'goal'; snapshot: string; goal: string; shown: [number, number][] }

export const CURSOR_KIND = 'fetch_cursor'
/** Beyond this many shown passages a goal cursor stops being offered; `find` and `section` remain. */
export const MAX_SHOWN_RANGES = 200

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRange(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && isOffset(value[0]) && isOffset(value[1])
}

export function parseCursorState(value: unknown): CursorState | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const state = value as Record<string, unknown>
  if (typeof state.snapshot !== 'string') return undefined
  const snapshot = state.snapshot
  if (state.kind === 'read' && isOffset(state.offset)) {
    const read: CursorState = { kind: 'read', snapshot, offset: state.offset }
    if (isOffset(state.end)) read.end = state.end
    return read
  }
  if (state.kind === 'find' && typeof state.find === 'string' && isOffset(state.from))
    return { kind: 'find', snapshot, find: state.find, from: state.from }
  if (state.kind === 'goal' && typeof state.goal === 'string' && Array.isArray(state.shown))
    return { kind: 'goal', snapshot, goal: state.goal, shown: state.shown.filter(isRange) }
  return undefined
}
