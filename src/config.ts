import { homedir } from 'node:os'
import path from 'node:path'

/** Deployment settings. Tool arguments may narrow these limits but never raise them. */
export interface Config {
  dataDir: string
  userAgent: string
  limits: {
    /** Ceiling for one tool response. 10,000 is the largest size every major harness passes through untruncated. */
    maxOutputTokens: number
    /** Character ceiling for one response; several harnesses cap tool output by characters, not tokens. */
    maxOutputChars: number
    searchDefaultTokens: number
    fetchDefaultTokens: number
    searchDefaultResults: number
    searchMaxResults: number
    fetchMaxPages: number
    /** Daily ceiling on estimated paid spend. Free sources keep working once it is reached. */
    dailyBudgetUsd: number
  }
  sources: {
    /** Vendor-subsidized anonymous tiers (no key, no login). */
    anonymous: boolean
    /** Self-imposed daily ceiling per anonymous source, so one install never drains a shared free tier. */
    anonymousDailyCap: number
    exaApiKey: string | undefined
    parallelApiKey: string | undefined
    tavilyApiKey: string | undefined
  }
  ttl: {
    searchSeconds: number
    snapshotSeconds: number
    queryCacheSeconds: number
  }
  fetch: {
    timeoutMs: number
    maxBytes: number
    maxRedirects: number
    extractTimeoutMs: number
    extractMemoryMb: number
  }
}

function defaultDataDir(env: NodeJS.ProcessEnv): string {
  if (env.WEB_RESEARCH_DATA_DIR) return env.WEB_RESEARCH_DATA_DIR
  const name = 'web-research-mcp'
  if (process.platform === 'win32')
    return path.join(env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'), name)
  if (process.platform === 'darwin')
    return path.join(homedir(), 'Library', 'Application Support', name)
  return path.join(env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share'), name)
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  return !['0', 'false', 'off', 'no'].includes(value.toLowerCase())
}

/** Secrets come only from the environment and are never written to logs, traces, or the store. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    dataDir: defaultDataDir(env),
    userAgent:
      env.WEB_RESEARCH_USER_AGENT ??
      'web-research-mcp/2.0 (+https://github.com/wyzz973/web-research-mcp)',
    limits: {
      maxOutputTokens: positive(env.WEB_RESEARCH_MAX_OUTPUT_TOKENS, 10_000),
      maxOutputChars: positive(env.WEB_RESEARCH_MAX_OUTPUT_CHARS, 30_000),
      searchDefaultTokens: 5_000,
      fetchDefaultTokens: 8_000,
      searchDefaultResults: 10,
      searchMaxResults: 50,
      fetchMaxPages: 5,
      dailyBudgetUsd: positive(env.WEB_RESEARCH_DAILY_BUDGET_USD, 1),
    },
    sources: {
      anonymous: flag(env.WEB_RESEARCH_ANONYMOUS_SOURCES, true),
      anonymousDailyCap: positive(env.WEB_RESEARCH_ANONYMOUS_DAILY_CAP, 100),
      exaApiKey: env.EXA_API_KEY || undefined,
      parallelApiKey: env.PARALLEL_API_KEY || undefined,
      tavilyApiKey: env.TAVILY_API_KEY || undefined,
    },
    ttl: {
      searchSeconds: 24 * 3600,
      snapshotSeconds: 30 * 24 * 3600,
      queryCacheSeconds: 6 * 3600,
    },
    fetch: {
      timeoutMs: 20_000,
      maxBytes: 8 * 1024 * 1024,
      maxRedirects: 5,
      extractTimeoutMs: 10_000,
      extractMemoryMb: 256,
    },
  }
}

export function databasePath(config: Config): string {
  return path.join(config.dataDir, 'state-v2.sqlite')
}
