/**
 * Turns HTTP statuses and page signals into page-level failures. Messages are fixed sentences:
 * the only variable parts are numbers and a media type reduced to a safe token.
 */
import type { PageSignals } from '../extract/types.ts'
import { WebError } from '../errors.ts'
import { header, type SafeResponse } from '../net/safe-http.ts'

/**
 * A challenge page is recognized by what it says about itself, not by a topic word: a page that
 * merely discusses CAPTCHAs or "access denied" errors must still be readable.
 */
const CHALLENGE_TITLE =
  /^(?:\d{3}\s*[-:]?\s*)?(?:just a moment|attention required|access denied|forbidden|verif(?:y|ying)(?: that)? you are(?: a)? human|are you a (?:human|robot)|security check|checking your browser|pardon our interruption|request blocked|bot verification|human verification)[.!\u2026]*(?:\s*[|\u2013\u2014:-]\s.*)?$/iu
const CHALLENGE_PHRASES = [
  'verify you are human',
  'verifying you are human',
  'verify that you are human',
  'checking your browser before',
  'needs to review the security of your connection',
  'complete the security check',
  'unusual traffic from your computer network',
  'enable javascript and cookies to continue',
  'please complete the captcha',
  'solve the captcha',
]
/** A prompt to authenticate, as opposed to a page that merely mentions signing in. */
const LOGIN_PROMPT =
  /(?:please |you must |you need to )(?:sign|log) ?in\b|(?:sign|log) ?in to (?:continue|view|read|access|see)|(?:sign|log) ?in (?:is )?required|subscribe to (?:continue|read|unlock|view)|(?:subscribers?|members?)[- ]only|create (?:a free |an )account to (?:continue|read|view)|\u8bf7(?:\u5148)?\u767b\u5f55|\u767b\u5f55\u540e|\u8ba2\u9605\u540e/iu
const SCRIPT_PHRASES = [
  'enable javascript',
  'requires javascript',
  'javascript is required',
  'javascript is disabled',
]
const CHALLENGE_MARKUP =
  /<title[^>]*>\s*(?:just a moment|attention required|access denied|verify (?:you|your)|security check|pardon our interruption)|cf-chl-|challenge-platform|id=["']captcha|px-captcha|captcha-delivery|_incapsula_/iu
const LOGIN_PATH =
  /(?:^|[/._-])(?:log-?in|sign-?in|signin|sso|auth|authenticate|session\/new)(?:[/._?-]|$)/iu
const SHORT_PAGE_CHARS = 1200
const VERY_SHORT_PAGE_CHARS = 600
const EMPTY_SHELL_CHARS = 200
const TINY_PAGE_CHARS = 50
const MAX_RETRY_AFTER_S = 24 * 3600

function includesAny(text: string, phrases: string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase))
}

/** `Retry-After` is either seconds or an HTTP date. */
function retryAfterSeconds(value: string, now: Date): number | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const seconds = /^\d+$/u.test(trimmed)
    ? Number(trimmed)
    : Math.ceil((Date.parse(trimmed) - now.getTime()) / 1000)
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return Math.min(seconds, MAX_RETRY_AFTER_S)
}

function blockedByStatus(status: number): WebError {
  return new WebError(
    'blocked',
    `The site refused automated access (HTTP ${status}); try another source from web_search.`,
  )
}

function challenge(): WebError {
  return new WebError(
    'blocked',
    'The site answered with a bot challenge instead of the page; it was not bypassed. Try another source from web_search.',
  )
}

function rateLimited(response: SafeResponse, now: Date): WebError {
  const retry = retryAfterSeconds(header(response, 'retry-after'), now)
  const advice = retry === undefined ? 'retry later' : `retry after ${retry}s`
  return new WebError(
    'rate_limited',
    `The site is rate limiting this client (HTTP 429); ${advice} or use another source.`,
    retry,
  )
}

/** Undefined means the status is a success and the body should be read. */
export function classifyStatus(response: SafeResponse, now: Date): WebError | undefined {
  const { status } = response
  if (status >= 200 && status < 300) return undefined
  if (status === 404 || status === 410)
    return new WebError(
      'not_found',
      `The page does not exist (HTTP ${status}); check the address or search for a current one.`,
    )
  if (status === 401 || status === 403 || status === 451) return blockedByStatus(status)
  if (status === 402)
    return new WebError(
      'payment_required',
      'The site asks for payment (HTTP 402); nothing was paid. Try another source.',
    )
  if (status === 429) return rateLimited(response, now)
  if (CHALLENGE_MARKUP.test(response.body.subarray(0, 65_536).toString('latin1')))
    return challenge()
  return new WebError(
    'upstream_error',
    `The site answered HTTP ${status}; retry later or try another source.`,
  )
}

export interface PageContext {
  requested: URL
  final: URL
}

function redirectedToLogin(context: PageContext): boolean {
  if (context.requested.href === context.final.href) return false
  const target = `${context.final.pathname}${context.final.search}`
  return LOGIN_PATH.test(target) && !LOGIN_PATH.test(context.requested.pathname)
}

function looksLikeChallenge(signals: PageSignals): boolean {
  if (signals.textChars >= SHORT_PAGE_CHARS) return false
  return (
    CHALLENGE_TITLE.test(signals.title) ||
    includesAny(signals.textSample.slice(0, VERY_SHORT_PAGE_CHARS), CHALLENGE_PHRASES)
  )
}

function looksLikeLogin(signals: PageSignals, context: PageContext): boolean {
  if (redirectedToLogin(context)) return true
  if (signals.passwordField && signals.textChars < SHORT_PAGE_CHARS) return true
  return signals.textChars < VERY_SHORT_PAGE_CHARS && LOGIN_PROMPT.test(signals.textSample)
}

/**
 * Little text alone is not enough: short pages are legitimate. A shell also has scripts, and
 * either no text to speak of, an empty framework mount point, or a request to turn scripts on.
 */
function looksLikeEmptyShell(signals: PageSignals): boolean {
  if (signals.scriptCount === 0) return false
  if (signals.textChars < TINY_PAGE_CHARS) return true
  if (signals.textChars < EMPTY_SHELL_CHARS && signals.scriptCount >= 3 && signals.scriptShell)
    return true
  return (
    signals.textChars < VERY_SHORT_PAGE_CHARS && includesAny(signals.textSample, SCRIPT_PHRASES)
  )
}

/** A 200 response that is not the page: a challenge, a login wall, or a script-only shell. */
export function classifyContent(signals: PageSignals, context: PageContext): WebError | undefined {
  if (looksLikeChallenge(signals)) return challenge()
  if (looksLikeLogin(signals, context))
    return new WebError(
      'login_required',
      'The page requires signing in or a subscription; only public pages can be read. Try another source.',
    )
  if (looksLikeEmptyShell(signals))
    return new WebError(
      'needs_javascript',
      'The page is an empty app shell that only shows content after running JavaScript; try another source or a text or API version of it.',
    )
  return undefined
}

export function unreadable(): WebError {
  return new WebError(
    'parse_failed',
    'No readable text could be extracted from the page; try another source.',
  )
}

function readableSize(bytes: number | undefined): string {
  if (bytes === undefined) return 'unknown size'
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`
}

/** The media type is site-controlled, so only a well-formed type/subtype token is echoed. */
export function mediaType(contentType: string): string {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return /^[a-z0-9][\w.+-]{0,40}\/[a-z0-9][\w.+-]{0,60}$/u.test(type) ? type : ''
}

export function unsupportedType(contentType: string, bytes: number | undefined): WebError {
  const type = mediaType(contentType) || 'an unrecognized content type'
  return new WebError(
    'unsupported_content_type',
    `${type} (${readableSize(bytes)}) cannot be read as text; look for an HTML or text version.`,
  )
}

const TEXT_TYPES =
  /^(?:text\/(?!html)[\w.+-]+|application\/(?:json|xml|javascript|x-yaml|yaml|toml|x-ndjson|[\w.+-]+\+(?:json|xml)))$/u

/** How a body will be read: converted from HTML, taken verbatim as text, or refused. */
export function contentKind(contentType: string): 'html' | 'text' | 'unsupported' {
  const type = mediaType(contentType)
  if (type === '' || type === 'text/html' || type === 'application/xhtml+xml') return 'html'
  return TEXT_TYPES.test(type) ? 'text' : 'unsupported'
}
