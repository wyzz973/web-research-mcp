import type { SourceMetadata } from '../generated/source-metadata.ts'
import { createSourceMetadata, safeMetadataUrl } from '../shared/source-metadata.ts'

/** Plain text only; output must be rendered as text rather than injected HTML by clients. */
function text(value: string | null | undefined, limit: number): string | null {
  const cleaned = value
    ?.replace(/<[^>]*>/gu, '')
    // Page-controlled control characters are removed from display text intentionally.
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return cleaned ? Array.from(cleaned).slice(0, limit).join('') : null
}

function date(value: string | null): string | null {
  // Date-only declarations use UTC midnight; reject vague localized date guesses.
  if (
    !value ||
    !/^\d{4}-\d{2}-\d{2}(?:$|T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$)/u.test(value)
  )
    return null
  const day = value.slice(0, 10)
  const calendarDay = Date.parse(`${day}T00:00:00Z`)
  // Date.parse normalizes impossible dates such as February 30; do not invent a publication day.
  if (!Number.isFinite(calendarDay) || new Date(calendarDay).toISOString().slice(0, 10) !== day)
    return null
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function hasType(object: Record<string, unknown>, names: readonly string[]): boolean {
  const types = Array.isArray(object['@type']) ? object['@type'] : [object['@type']]
  return types.some(
    (type) =>
      typeof type === 'string' &&
      names.includes(type.replace(/^(?:https?:\/\/)?schema\.org\//u, '')),
  )
}

function belongsToPage(object: Record<string, unknown>, finalUrl: string): boolean {
  const origin = new URL(finalUrl).origin
  return ['url', '@id'].every((key) => {
    const value = object[key]
    if (value === undefined) return true
    if (typeof value !== 'string') return false
    try {
      return new URL(value, finalUrl).origin === origin
    } catch {
      return false
    }
  })
}

function declaredLogo(object: Record<string, unknown>, base: string): string | null {
  const image = record(object.logo)
  const candidate = image ? (image.contentUrl ?? image.url ?? image['@id']) : object.logo
  return typeof candidate === 'string' ? safeMetadataUrl(candidate, base) : null
}

function jsonLdLogo(document: Document, base: string, finalUrl: string): string | null {
  let remainingCharacters = 256_000
  let remainingNodes = 2000
  // A site declaration outranks its explicit publisher, then a top-level organization.
  // Within each class, document/graph order wins; unrelated nested mentions are never visited.
  const candidates: (string | null)[] = [null, null, null]
  const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 20)
  for (const script of scripts) {
    const raw = script.textContent ?? ''
    if (raw.length > 64_000 || raw.length > remainingCharacters) continue
    remainingCharacters -= raw.length
    let root: unknown
    try {
      root = JSON.parse(raw)
    } catch {
      // Invalid optional page declarations must not prevent readable article extraction.
      continue
    }
    const pending: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }]
    while (pending.length && remainingNodes > 0) {
      const entry = pending.pop()
      if (!entry) break
      remainingNodes--
      const { value, depth } = entry
      if (!value || typeof value !== 'object' || depth > 16) continue
      const object = record(value)
      if (object && belongsToPage(object, finalUrl)) {
        if (hasType(object, ['WebSite'])) candidates[0] ??= declaredLogo(object, base)
        if (hasType(object, ['Article', 'NewsArticle', 'BlogPosting', 'WebPage', 'WebSite'])) {
          const publisher = record(object.publisher)
          if (
            publisher &&
            belongsToPage(publisher, finalUrl) &&
            (publisher['@type'] === undefined || hasType(publisher, ['Organization', 'WebSite']))
          ) {
            candidates[1] ??= declaredLogo(publisher, base)
          }
        }
        if (hasType(object, ['Organization'])) candidates[2] ??= declaredLogo(object, base)
      }
      // Only top-level arrays and @graph containers expose further site declarations.
      // mentions, about, author, and other arbitrary object properties do not establish ownership.
      const children: unknown[] = Array.isArray(value)
        ? value
        : object && Array.isArray(object['@graph'])
          ? object['@graph']
          : []
      const allowance = Math.max(0, remainingNodes - pending.length)
      for (const child of children.slice(0, allowance).reverse())
        pending.push({ value: child, depth: depth + 1 })
    }
  }
  return candidates.find((candidate) => candidate !== null) ?? null
}

/** Extract page declarations before Readability mutates the DOM; no declaration is a verified asset or identity. */
export function extractSourceMetadata(document: Document, finalUrl: string): SourceMetadata {
  const result = createSourceMetadata(finalUrl, finalUrl)
  result.metadata_source = 'html'
  const base = document.baseURI
  const meta = new Map<string, string>()
  for (const element of document.querySelectorAll('meta[property],meta[name]')) {
    const key = (
      element.getAttribute('property') ??
      element.getAttribute('name') ??
      ''
    ).toLowerCase()
    const content = element.getAttribute('content')
    if (content && !meta.has(key)) meta.set(key, content)
  }
  const siteName = text(meta.get('og:site_name'), 300)
  const applicationName = text(meta.get('application-name'), 300)
  if (siteName || applicationName) {
    result.site_name = siteName ?? applicationName ?? result.site_name
    result.provenance.site_name = siteName ? 'opengraph' : 'application_name'
  }
  result.description = text(meta.get('og:description'), 1000) ?? text(meta.get('description'), 1000)
  result.language =
    text(document.documentElement.getAttribute('lang'), 64) ?? text(meta.get('og:locale'), 64)
  result.image_url = safeMetadataUrl(meta.get('og:image'), base)
  if (result.image_url) result.provenance.image_url = 'opengraph'
  result.logo_url = jsonLdLogo(document, base, finalUrl)
  if (result.logo_url) result.provenance.logo_url = 'json_ld'
  let appleIcon: string | null = null
  let icon: string | null = null
  for (const link of document.querySelectorAll('link[rel][href]')) {
    const rels = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/u)
    const url = safeMetadataUrl(link.getAttribute('href'), base)
    if (!url) continue
    if (rels.includes('canonical') && !result.canonical_url) {
      result.canonical_url = url
      result.provenance.canonical_url = 'html_link'
    }
    if (rels.includes('icon') && !icon) icon = url
    if (rels.includes('apple-touch-icon') && !appleIcon) appleIcon = url
  }
  if (icon || appleIcon) {
    result.favicon_url = icon ?? appleIcon
    result.provenance.favicon_url = 'html_link'
  }
  result.published_at = date(
    text(meta.get('article:published_time') ?? meta.get('datepublished') ?? meta.get('date'), 100),
  )
  result.modified_at = date(
    text(
      meta.get('article:modified_time') ?? meta.get('datemodified') ?? meta.get('last-modified'),
      100,
    ),
  )
  return result
}
