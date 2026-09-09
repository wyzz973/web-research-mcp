import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { getDomain } from 'tldts'
import type { SourceMetadata } from '../generated/source-metadata.ts'

/** A display URL filter, without DNS or asset requests. Consumers must still validate before fetching. */
export function safeMetadataUrl(value: string | null | undefined, base: string): string | null {
  if (!value || value.length > 4096) return null
  try {
    const url = new URL(value, base)
    const hostname = url.hostname
      .toLowerCase()
      .replace(/\.$/u, '')
      .replace(/^\[|\]$/gu, '')
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.href.length > 4096 ||
      (!hostname.includes('.') && isIP(hostname) === 0) ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      (isIP(hostname) !== 0 && ipaddr.parse(hostname).range() !== 'unicast')
    )
      return null
    return url.href
  } catch {
    return null
  }
}

/** URL-only metadata is not a page observation. finalUrl and retrievedAt are supplied only after a fetch. */
export function createSourceMetadata(
  sourceUrl: string,
  finalUrl?: string,
  retrievedAt?: string,
): SourceMetadata {
  const url = new URL(finalUrl ?? sourceUrl)
  const favicon = safeMetadataUrl('/favicon.ico', url.origin)
  return {
    source_url: sourceUrl,
    final_url: finalUrl ?? null,
    canonical_url: null,
    hostname: url.hostname,
    domain: getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname,
    origin: url.origin,
    display_url: `${url.host}${url.pathname}${url.search}`,
    site_name: url.hostname,
    description: null,
    language: null,
    favicon_url: favicon,
    logo_url: null,
    image_url: null,
    published_at: null,
    modified_at: null,
    retrieved_at: retrievedAt ?? null,
    metadata_source: 'url_only',
    metadata_url: finalUrl ?? null,
    assets_verified: false,
    provenance: {
      site_name: 'hostname',
      favicon_url: favicon ? 'origin_fallback' : 'none',
      logo_url: 'none',
      image_url: 'none',
      canonical_url: 'none',
    },
  }
}
