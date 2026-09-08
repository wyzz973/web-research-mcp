/** Fixed anonymous webpage adapters. This is not a configurable paid-service switch. */
export const KEYLESS_ENGINES = ['duckduckgo', 'bing', 'google', 'brave', 'mojeek'] as const

/** Validate a configured infrastructure endpoint even when other search settings are absent. */
export function validSearchEndpoint(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}
