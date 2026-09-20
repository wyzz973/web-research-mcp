/**
 * Which encoding to read a response in when nobody says. The standard fallback is windows-1252,
 * but browsers look at the bytes first, and so must we: most undeclared pages today are UTF-8,
 * and reading them as windows-1252 turns every non-ASCII word into noise.
 */

const META_PRESCAN_BYTES = 4096
const META_CHARSET = /<meta[^>]+charset\s*=/iu

export function headerCharset(contentType: string): string | undefined {
  return /charset\s*=\s*["']?([\w.:-]{1,40})/iu.exec(contentType)?.[1]
}

export function bomCharset(bytes: Uint8Array): 'utf-8' | 'utf-16le' | 'utf-16be' | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  return undefined
}

/** True when the document itself names an encoding where a parser would look for it. */
export function declaresCharsetInMeta(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, META_PRESCAN_BYTES)).toString('latin1')
  return META_CHARSET.test(head)
}

export function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * The encoding to force on an HTML parser, or undefined to let it follow the document: a header
 * wins; a byte order mark or a <meta> declaration is the parser's business; otherwise bytes that
 * are valid UTF-8 are read as UTF-8, and only the rest falls back to the parser's default.
 */
export function htmlCharset(contentType: string, bytes: Uint8Array): string | undefined {
  const declared = headerCharset(contentType)
  if (declared) return declared
  if (bomCharset(bytes) || declaresCharsetInMeta(bytes)) return undefined
  return isValidUtf8(bytes) ? 'utf-8' : undefined
}
