import { randomInt } from 'node:crypto'

/** Lowercase, no vowels or look-alikes: short ids stay easy for a model to copy and never spell words. */
const ALPHABET = 'bcdfghjkmnpqrstvwxz23456789'

export function randomId(length: number): string {
  let value = ''
  for (let index = 0; index < length; index += 1)
    value += ALPHABET[randomInt(ALPHABET.length)] ?? 'x'
  return value
}

/** "k7f2:r3" -> { searchId: "k7f2", hit: "r3" }. Returns undefined for anything else. */
export function parseRef(ref: string): { searchId: string; hit: string } | undefined {
  const match = /^([a-z0-9]{3,12}):(r\d{1,3})$/u.exec(ref.trim())
  if (!match?.[1] || !match[2]) return undefined
  return { searchId: match[1], hit: match[2] }
}

export function isSnapshotId(value: string): boolean {
  return /^s_[a-z0-9]{4,16}$/u.test(value.trim())
}

/** "s_k2m9qx:1820-2410" -> a citable location. */
export function parseLocation(
  value: string,
): { snapshot: string; start: number; end: number } | undefined {
  const match = /^(s_[a-z0-9]{4,16}):(\d+)-(\d+)$/u.exec(value.trim())
  if (!match?.[1] || !match[2] || !match[3]) return undefined
  const start = Number(match[2])
  const end = Number(match[3])
  return end > start ? { snapshot: match[1], start, end } : undefined
}
