import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isSnapshotId, parseLocation, parseRef, randomId } from '../src/ids.ts'
import { charsWithinTokens, estimateTokens } from '../src/tokens.ts'
import { VERSION } from '../src/version.ts'

describe('token estimates', () => {
  it('counts dense text (URLs, code) higher than prose of the same length', () => {
    const url = 'https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static'
    const prose = 'The quick brown fox jumps over the lazy dog and keeps running far away from here'
      .padEnd(url.length, ' again')
      .slice(0, url.length)
    expect(estimateTokens(url)).toBeGreaterThan(estimateTokens(prose))
  })

  it('treats CJK as about one token per character', () => {
    expect(estimateTokens('全文检索与中文分词')).toBe(9)
  })

  it('finds a prefix that fits the budget without splitting a surrogate pair', () => {
    const text = 'ab😀cd'.repeat(50)
    const cut = charsWithinTokens(text, 20)
    expect(estimateTokens(text.slice(0, cut))).toBeLessThanOrEqual(20)
    expect(text.slice(0, cut)).not.toMatch(/[\uD800-\uDBFF]$/u)
    expect(charsWithinTokens('short', 1000)).toBe(5)
  })
})

describe('ids', () => {
  it('generates ids from an unambiguous lowercase alphabet', () => {
    expect(randomId(12)).toMatch(/^[bcdfghjkmnpqrstvwxz2-9]{12}$/u)
  })

  it('parses full refs, snapshot ids, and citable locations, and rejects everything else', () => {
    expect(parseRef('k7f2:r12')).toEqual({ searchId: 'k7f2', hit: 'r12' })
    expect(parseRef('r12')).toBeUndefined()
    expect(isSnapshotId('s_k2m9qx')).toBe(true)
    expect(isSnapshotId('k7f2:r1')).toBe(false)
    expect(parseLocation('s_k2m9qx:1820-2410')).toEqual({
      snapshot: 's_k2m9qx',
      start: 1820,
      end: 2410,
    })
    expect(parseLocation('s_k2m9qx:2410-1820')).toBeUndefined()
  })
})

describe('version', () => {
  it('matches package.json', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      version: string
    }
    expect(VERSION).toBe(manifest.version)
  })
})

describe('createWebResearch', () => {
  it('says which state file could not be opened and how to move it', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const { createWebResearch } = await import('../src/index.ts')
    const directory = mkdtempSync(path.join(tmpdir(), 'wrm-state-'))
    // A file where the data directory should be: mkdir fails the same way on every platform.
    const blocker = path.join(directory, 'not-a-directory')
    writeFileSync(blocker, '')
    const storePath = path.join(blocker, 'nested', 'state.sqlite')
    await expect(createWebResearch({ storePath })).rejects.toThrow(
      /Cannot open the state database at .*state\.sqlite \(E[A-Z]+\)\. Set WEB_RESEARCH_DATA_DIR/u,
    )
    rmSync(directory, { recursive: true, force: true })
  })
})
