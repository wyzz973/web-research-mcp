/** Generated from schemas. Do not edit. */

/**
 * Display metadata from the actual page or an explicitly marked URL-only fallback. URLs are not downloaded or certified.
 */
export interface SourceMetadata {
  source_url: string
  final_url: string | null
  canonical_url: string | null
  hostname: string
  domain: string
  origin: string
  display_url: string
  site_name: string
  description: string | null
  language: string | null
  favicon_url: string | null
  logo_url: string | null
  image_url: string | null
  published_at: string | null
  modified_at: string | null
  retrieved_at: string | null
  metadata_source: 'url_only' | 'html'
  metadata_url: string | null
  assets_verified: false
  provenance: {
    site_name: 'hostname' | 'opengraph' | 'application_name'
    favicon_url: 'html_link' | 'origin_fallback' | 'none'
    logo_url: 'json_ld' | 'none'
    image_url: 'opengraph' | 'none'
    canonical_url: 'html_link' | 'none'
  }
}
