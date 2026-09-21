import type { OutlineEntry } from '../contract.ts'

/** No id or title is longer; what a caller sends beyond this cannot name a section. */
const MAX_REQUEST_CHARS = 300

function canonical(value: string): string {
  return value
    .trim()
    .slice(0, MAX_REQUEST_CHARS)
    .replace(/^(?:section|sec\.?|chapter|appendix|annex|§)\s*/iu, '')
    .replace(/[.\s]+$/u, '')
    .toLowerCase()
}

/** Accepts an outline id ("13.1.2", "Section 13.1.2", "a") or, failing that, an exact heading title. */
export function findSection(outline: OutlineEntry[], requested: string): OutlineEntry | undefined {
  const wanted = canonical(requested)
  if (wanted === '') return undefined
  const byId = outline.find((entry) => entry.id.toLowerCase() === wanted)
  if (byId) return byId
  const title = requested.trim().slice(0, MAX_REQUEST_CHARS).replace(/\s+/gu, ' ').toLowerCase()
  return outline.find(
    (entry) =>
      entry.title.toLowerCase() === title || `${entry.id} ${entry.title}`.toLowerCase() === title,
  )
}

function sharedPrefix(left: string, right: string): number {
  let length = 0
  while (length < left.length && left[length] === right[length]) length += 1
  return length
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row]
    for (let column = 1; column <= right.length; column += 1) {
      const change = left[row - 1] === right[column - 1] ? 0 : 1
      current.push(
        Math.min(
          (previous[column] ?? 0) + 1,
          (current[column - 1] ?? 0) + 1,
          (previous[column - 1] ?? 0) + change,
        ),
      )
    }
    previous = current
  }
  return previous[right.length] ?? 0
}

/** "13.9.9" does not exist but "13" does: offer that section and its direct children. */
function familySuggestions(outline: OutlineEntry[], wanted: string, count: number): string[] {
  const segments = wanted.split('.')
  for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
    const ancestorId = segments.slice(0, depth).join('.')
    const ancestor = outline.find((entry) => entry.id.toLowerCase() === ancestorId)
    if (!ancestor) continue
    const inside = outline.filter(
      (entry) => entry.start > ancestor.start && entry.end <= ancestor.end,
    )
    const childLevel = Math.min(...inside.map((entry) => entry.level))
    const children = inside.filter((entry) => entry.level === childLevel)
    return [ancestor, ...children].slice(0, count).map((entry) => entry.id)
  }
  return []
}

/** Ids a model most plausibly meant: the nearest existing ancestor's family, else the closest spellings. */
export function nearestSectionIds(outline: OutlineEntry[], requested: string, count = 5): string[] {
  const wanted = canonical(requested).slice(0, 24)
  const family = familySuggestions(outline, wanted, count)
  if (family.length > 0) return family
  return outline
    .map((entry, order) => {
      const id = entry.id.toLowerCase()
      return {
        id: entry.id,
        prefix: sharedPrefix(id, wanted),
        edits: editDistance(id, wanted),
        order,
      }
    })
    .sort(
      (left, right) =>
        right.prefix - left.prefix || left.edits - right.edits || left.order - right.order,
    )
    .slice(0, count)
    .map((entry) => entry.id)
}
