/** Offsets are UTF-16 code units everywhere, so every cut has to mind surrogate pairs. */

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/** The first `units` code units of `text`, never ending on half of a surrogate pair. */
export function headOf(text: string, units: number): string {
  const end = Math.max(0, Math.min(units, text.length))
  const splitsPair = end < text.length && isHighSurrogate(text.charCodeAt(end - 1))
  return text.slice(0, splitsPair ? end - 1 : end)
}
