import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../../src/contract.ts'
import { WebError } from '../../src/errors.ts'
import { createCooldowns } from '../../src/search/cooldown.ts'
import {
  buildLineup,
  cooldownKey,
  walkLineup,
  type Admit,
  type LineupInput,
} from '../../src/search/select.ts'
import { createSqliteStore } from '../../src/store/sqlite.ts'
import { fakeSource } from './helpers.ts'

let store: Store

beforeEach(async () => {
  store = await createSqliteStore(':memory:')
})

afterEach(() => {
  store.close()
})

function clock(start = new Date(2026, 8, 21, 10, 0, 0)) {
  let now = start.getTime()
  return { now: () => new Date(now), advance: (seconds: number) => (now += seconds * 1000) }
}

function input(overrides: Partial<LineupInput>): LineupInput {
  return {
    sources: [],
    cooldowns: createCooldowns(() => new Date(), store),
    callsToday: () => 0,
    wantsFilters: false,
    ...overrides,
  }
}

const admitAll: Admit = () => undefined

/** The admitted sources in order, and what was passed over on the way. */
function walk(overrides: Partial<LineupInput>, admit: Admit = admitAll) {
  const cursor = walkLineup(buildLineup(input(overrides)), admit)
  const usable: string[] = []
  for (let adapter = cursor.next(); adapter; adapter = cursor.next()) usable.push(adapter.id)
  return { usable, skipped: cursor.skipped() }
}

describe('buildLineup', () => {
  const exa = fakeSource('exa', [])
  const parallel = fakeSource('parallel', [])
  const tavily = fakeSource('tavily', [], { paid: 0.008, nativeFilters: true })

  it('puts keyed sources before anonymous ones and keeps registration order otherwise', () => {
    expect(walk({ sources: [exa, parallel, tavily] }).usable).toEqual(['tavily', 'exa', 'parallel'])
  })

  it('rotates: within a tier the source used least today goes first', () => {
    const calls: Record<string, number> = { exa: 12, parallel: 3, tavily: 50 }
    const { usable } = walk({
      sources: [exa, parallel, tavily],
      callsToday: (id) => calls[id] ?? 0,
    })
    expect(usable).toEqual(['tavily', 'parallel', 'exa'])
  })

  it('passes over a source whose calls could not be booked, and says why', () => {
    const refuse: Admit = (adapter) => {
      if (adapter.id === 'tavily') return { kind: 'budget' }
      return adapter.id === 'exa' ? { kind: 'cap' } : undefined
    }
    const { usable, skipped } = walk({ sources: [exa, parallel, tavily] }, refuse)
    expect(usable).toEqual(['parallel'])
    expect(skipped).toEqual([
      { id: 'tavily', status: 'skipped', detail: 'daily budget reached' },
      { id: 'exa', status: 'skipped', detail: 'daily anonymous cap reached' },
    ])
  })

  it('books a source only when the walk reaches it, and only once', () => {
    const asked: string[] = []
    const lineup = buildLineup(input({ sources: [exa, parallel, tavily] }))
    const cursor = walkLineup(lineup, (adapter) => {
      asked.push(adapter.id)
      return undefined
    })
    expect(cursor.next()?.id).toBe('tavily')
    expect(asked).toEqual(['tavily'])
    expect(cursor.next()?.id).toBe('exa')
    expect(asked).toEqual(['tavily', 'exa'])
  })

  it('never reads the ledger to decide: the counts of the day only order the sources', () => {
    // Far over any cap by the count, yet admitted: the reservation is the only gate.
    const { usable } = walk({ sources: [exa, parallel], callsToday: () => 1_000_000 })
    expect(usable).toEqual(['exa', 'parallel'])
  })

  it('prefers sources that filter upstream when the request restricts sites or dates', () => {
    const keyedWithoutFilters = fakeSource('plain', [], { paid: 0.001 })
    const anonymousWithFilters = fakeSource('filtering', [], { nativeFilters: true })
    const sources = [keyedWithoutFilters, exa, anonymousWithFilters]
    expect(walk({ sources, wantsFilters: false }).usable).toEqual(['plain', 'exa', 'filtering'])
    expect(walk({ sources, wantsFilters: true }).usable).toEqual(['filtering', 'plain', 'exa'])
  })
})

describe('walkLineup', () => {
  it('hands out usable sources in order and reports the cooling ones it passed over', () => {
    const cooldowns = createCooldowns(clock().now, store)
    cooldowns.fail('exa', new WebError('rate_limited', 'limited'))
    const sources = [fakeSource('exa', []), fakeSource('parallel', []), fakeSource('tavily', [])]
    const cursor = walkLineup(buildLineup(input({ sources, cooldowns })), admitAll)

    expect(cursor.next()?.id).toBe('parallel')
    expect(cursor.skipped()).toEqual([
      {
        id: 'exa',
        status: 'skipped',
        retry_after_s: 300,
        detail: 'cooling down after rate_limited',
      },
    ])
    expect(cursor.next()?.id).toBe('tavily')
    expect(cursor.next()).toBeUndefined()
  })

  it('does not report a held source that was never reached', () => {
    const cooldowns = createCooldowns(() => new Date(), store)
    cooldowns.fail('tavily', new WebError('timeout', 'slow'))
    const sources = [fakeSource('exa', []), fakeSource('tavily', [])]
    const cursor = walkLineup(buildLineup(input({ sources, cooldowns })), admitAll)
    expect(cursor.next()?.id).toBe('exa')
    expect(cursor.skipped()).toEqual([])
  })

  it('never probes a source whose quota is used up: it is excluded until local midnight', () => {
    const time = clock(new Date(2026, 8, 21, 22, 30, 0))
    const cooldowns = createCooldowns(time.now, store)
    const tavily = fakeSource('tavily', [], { paid: 0.008 })
    expect(cooldownKey(tavily)).toBe('tavily:keyed')
    cooldowns.fail(cooldownKey(tavily), new WebError('budget_exhausted', 'quota is used up'))
    const sources = [tavily, fakeSource('exa', [])]
    const asked: string[] = []
    const cursor = walkLineup(buildLineup(input({ sources, cooldowns })), (adapter) => {
      asked.push(adapter.id)
      return undefined
    })

    expect(cursor.next()?.id).toBe('exa')
    expect(cursor.skipped()).toEqual([
      {
        id: 'tavily',
        status: 'skipped',
        retry_after_s: 5400,
        detail: 'quota used up; not tried again before local midnight',
      },
    ])
    // A source on hold is not booked at all, so there is nothing to give back.
    expect(asked).toEqual(['exa'])
    time.advance(5400)
    expect(cooldowns.get(cooldownKey(tavily))).toBeUndefined()
  })
})

describe('createCooldowns', () => {
  it('cools a refused source for 300 s and any other failure for 30 s', () => {
    const time = clock()
    const cooldowns = createCooldowns(time.now, store)
    cooldowns.fail('exa', new WebError('rate_limited', 'x'))
    cooldowns.fail('parallel', new WebError('blocked', 'x'))
    cooldowns.fail('tavily', new WebError('timeout', 'x'))
    cooldowns.fail('other', new WebError('parse_failed', 'x'))
    expect(cooldowns.get('exa')).toEqual({ code: 'rate_limited', retryAfterS: 300 })
    expect(cooldowns.get('parallel')?.retryAfterS).toBe(300)
    expect(cooldowns.get('tavily')).toEqual({ code: 'timeout', retryAfterS: 30 })
    expect(cooldowns.get('other')?.retryAfterS).toBe(30)

    time.advance(29)
    expect(cooldowns.get('tavily')?.retryAfterS).toBe(1)
    time.advance(1)
    expect(cooldowns.get('tavily')).toBeUndefined()
    expect(cooldowns.get('exa')?.retryAfterS).toBe(270)
    expect(cooldowns.get('never-failed')).toBeUndefined()
  })

  it('honours a longer retry-after from the vendor', () => {
    const cooldowns = createCooldowns(clock().now, store)
    cooldowns.fail('exa', new WebError('rate_limited', 'x', 900))
    cooldowns.fail('tavily', new WebError('rate_limited', 'x', 5))
    expect(cooldowns.get('exa')?.retryAfterS).toBe(900)
    expect(cooldowns.get('tavily')?.retryAfterS).toBe(300)
  })

  it('doubles with every consecutive failure and starts over after a success', () => {
    const time = clock()
    const cooldowns = createCooldowns(time.now, store)
    const fail = () => cooldowns.fail('exa', new WebError('upstream_error', 'x'))
    fail()
    time.advance(31)
    fail()
    expect(cooldowns.get('exa')?.retryAfterS).toBe(60)
    time.advance(61)
    fail()
    expect(cooldowns.get('exa')?.retryAfterS).toBe(120)
    for (let round = 0; round < 10; round += 1) fail()
    expect(cooldowns.get('exa')?.retryAfterS).toBe(3600)

    cooldowns.succeed('exa')
    expect(cooldowns.get('exa')).toBeUndefined()
    fail()
    expect(cooldowns.get('exa')?.retryAfterS).toBe(30)
  })

  it('lives in the store, so a new process does not knock on a door that was just closed', () => {
    const time = clock()
    createCooldowns(time.now, store).fail('exa', new WebError('blocked', 'HTTP 403'))

    const nextProcess = createCooldowns(time.now, store)
    expect(nextProcess.get('exa')).toEqual({ code: 'blocked', retryAfterS: 300 })
    // Escalation carries over as well, and so does the all-clear.
    time.advance(301)
    nextProcess.fail('exa', new WebError('blocked', 'HTTP 403'))
    expect(createCooldowns(time.now, store).get('exa')?.retryAfterS).toBe(600)
    nextProcess.succeed('exa')
    expect(createCooldowns(time.now, store).get('exa')).toBeUndefined()
  })

  it('still works within the process when the store cannot be used', () => {
    const broken: Store = {
      ...store,
      getRecord() {
        throw new Error('database is locked')
      },
      putRecord() {
        throw new Error('database is locked')
      },
    }
    const cooldowns = createCooldowns(clock().now, broken)
    cooldowns.fail('exa', new WebError('timeout', 'x'))
    expect(cooldowns.get('exa')?.retryAfterS).toBe(30)
    cooldowns.succeed('exa')
    expect(cooldowns.get('exa')).toBeUndefined()
  })
})
