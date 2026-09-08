import robotsPackage from 'robots-parser'

interface RobotsPolicy {
  isAllowed(url: string, userAgent: string): boolean | undefined
  getCrawlDelay(userAgent: string): number | undefined
}
type RobotsFactory = (url: string, body: string) => RobotsPolicy

// robots-parser 3.0.1 ships an ESM-shaped declaration for its CommonJS callable
// export. Narrow the runtime default once here; do not weaken application types.
function isFactory(value: unknown): value is RobotsFactory {
  return typeof value === 'function'
}
export function parseRobots(url: string, body: string): RobotsPolicy {
  if (!isFactory(robotsPackage)) throw new Error('robots-parser did not export a callable parser.')
  return robotsPackage(url, body)
}
