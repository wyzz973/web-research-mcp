/** Domain interfaces shared by replaceable infrastructure and tool orchestration. */
import type { CursorToken, SnapshotId, SourceId } from './ids.ts'
import type { SourceMetadata } from '../generated/source-metadata.ts'
export interface DomainScope {
  readonly sites: readonly string[]
  readonly exclude_domains: readonly string[]
  readonly include_subdomains: boolean
}

export interface SearchSource {
  readonly url: string
  readonly title: string
  readonly snippet: string
  readonly publishedAt: string | null
  readonly engines: readonly string[]
}

export interface SearchPage {
  readonly sources: readonly SearchSource[]
  readonly errors: readonly string[]
  readonly exhausted: boolean
}

export interface SearchPageRequest {
  readonly query: string
  readonly language: string
  readonly timeRange: 'any' | 'day' | 'month' | 'year'
  readonly site?: string
  readonly page: number
}

export interface SearchProvider {
  searchPage(request: SearchPageRequest, signal: AbortSignal): Promise<SearchPage>
  close(): Promise<void>
}

export type FetchEngine = 'static' | 'crawl4ai' | 'auto'

export interface LoadedDocument {
  readonly fetchBackend?: 'static' | 'crawl4ai'
  readonly sourceMetadata?: SourceMetadata
  readonly url: string
  readonly finalUrl: string
  readonly title: string
  readonly contentType: string
  readonly text: string
  readonly markdown: string
  readonly fetchedAt: string
  readonly extractorVersion: string
  readonly warnings: readonly string[]
}

export interface DocumentLoader {
  load(
    url: string,
    options: { signal: AbortSignal; scope?: DomainScope; engine?: FetchEngine },
  ): Promise<LoadedDocument>
  close(): Promise<void>
}

export interface Segment {
  readonly id: string
  readonly text: string
  readonly start_char: number
  readonly end_char: number
}

export interface DocumentSnapshot {
  readonly fetchBackend?: 'static' | 'crawl4ai'
  readonly sourceMetadata?: SourceMetadata
  readonly sourceId: SourceId
  readonly snapshotId: SnapshotId
  readonly url: string
  readonly finalUrl: string
  readonly title: string
  readonly fetchedAt: string
  readonly expiresAt: string
  readonly contentType: string
  readonly format: 'text' | 'markdown'
  readonly content: string
  readonly contentSha256: string
  readonly extractorVersion: string
  readonly segments: readonly Segment[]
  readonly warnings: readonly string[]
}

export interface CursorRecord {
  readonly kind: 'fetch' | 'search'
  readonly payload: unknown
  readonly expiresAt: string
}

export interface SnapshotStore {
  saveDocument(document: LoadedDocument, format: 'text' | 'markdown'): DocumentSnapshot
  getDocument(snapshotId: string): DocumentSnapshot
  createCursor(kind: 'fetch' | 'search', payload: unknown, expiresAt: string): CursorToken
  getCursor(token: string, kind: 'fetch' | 'search'): CursorRecord
  putSearch(id: string, payload: unknown, expiresAt: string): void
  getSearch(id: string): unknown
  putEvidence(id: string, payload: unknown, expiresAt: string): void
  getEvidence(id: string): unknown
  close(): void
}

export interface Relevance {
  readonly score: number | null
  readonly method: 'lexical_coverage_v1' | 'none'
  readonly version: string | null
  readonly basis: 'title_snippet' | 'quote'
  readonly matched_terms: string[]
  readonly reasons: string[]
}

export interface Passage {
  readonly quote: string
  readonly start_char: number
  readonly end_char: number
  readonly segment_id: string
  readonly segment_ids: readonly string[]
  readonly relevance: Relevance
}
