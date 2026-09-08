import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'
import { parse } from 'tldts'
import { AppError } from './errors.ts'
import type { DomainScope } from './types.ts'

/** Accept DNS names, not URLs or IP literals. Uses the pinned tldts PSL, including private suffixes. */
function normalizeDomain(value: string): string {
  if (!value || value.trim() !== value || /[\s/:@*?#\\]/u.test(value)) {
    throw new AppError('INVALID_ARGUMENT', 'Sites must contain DNS hostnames only.')
  }
  const host = domainToASCII(value).toLowerCase().replace(/\.$/u, '')
  const labels = host.split('.')
  if (
    host.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) ||
    isIP(host) !== 0 ||
    !parse(host, { allowPrivateDomains: true }).domain
  ) {
    throw new AppError(
      'INVALID_ARGUMENT',
      'Sites must be registrable DNS hostnames, not public suffixes.',
    )
  }
  // Reject alternative IPv4 spellings that WHATWG URL would interpret as addresses.
  try {
    if (isIP(new URL(`https://${host}`).hostname) !== 0) {
      throw new AppError('INVALID_ARGUMENT', 'IP addresses are not supported in sites.')
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('INVALID_ARGUMENT', 'Invalid site hostname.')
  }
  return host
}

function includesHost(host: string, domain: string, subdomains: boolean): boolean {
  return host === domain || (subdomains && host.endsWith(`.${domain}`))
}

export function resolveScope(input: {
  sites?: readonly string[]
  include_domains?: readonly string[]
  exclude_domains?: readonly string[]
  include_subdomains?: boolean
}): DomainScope {
  if (input.sites !== undefined && input.include_domains !== undefined) {
    throw new AppError('INVALID_ARGUMENT', 'Use sites or include_domains, not both.')
  }
  const sites = [...new Set((input.sites ?? input.include_domains ?? []).map(normalizeDomain))]
  const excludeDomains = [...new Set((input.exclude_domains ?? []).map(normalizeDomain))]
  const subdomains = input.include_subdomains ?? true
  if (
    sites.length > 0 &&
    sites.every((site) => excludeDomains.some((domain) => includesHost(site, domain, subdomains)))
  ) {
    throw new AppError('INVALID_ARGUMENT', 'Excluded domains completely cover the requested sites.')
  }
  return { sites, exclude_domains: excludeDomains, include_subdomains: subdomains }
}

/** Domain scope is independent of public-network safety; loaders still enforce their network policy. */
export function matchesScope(value: string, scope: DomainScope): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return false
  const host = url.hostname.toLowerCase().replace(/\.$/u, '')
  const match = (domain: string) => includesHost(host, domain, scope.include_subdomains)
  return (scope.sites.length === 0 || scope.sites.some(match)) && !scope.exclude_domains.some(match)
}

const TRACKING_PARAMETERS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'dclid',
  'fbclid',
  'msclkid',
])

/** Removes fragments and named tracking parameters only; query order and semantic parameters survive. */
export function canonicalUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AppError('INVALID_ARGUMENT', 'Invalid result URL.')
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new AppError('INVALID_ARGUMENT', 'Result URL must use HTTP(S) without credentials.')
  }
  url.hash = ''
  // Preserve original percent encoding and duplicate parameter order for signed or semantic URLs.
  if (url.search) {
    const parts = url.search
      .slice(1)
      .split('&')
      .filter((part) => {
        const key = new URLSearchParams(part).keys().next().value
        return key === undefined || !TRACKING_PARAMETERS.has(key.toLowerCase())
      })
    url.search = parts.length > 0 ? `?${parts.join('&')}` : ''
  }
  return url.href
}
