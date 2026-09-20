/**
 * Child process for the cap test: keeps asking for one more call under a shared cap and reports
 * how many it was granted. `naive` does what the engine used to do (read, then write) so that the
 * test can show the race it guards against.
 */
import { createSqliteStore } from '../../src/store/sqlite.ts'

const [location, cap, attempts, mode] = process.argv.slice(2)
if (!location || !cap || !attempts) throw new Error('usage: store-reserver <db> <cap> <attempts>')
const store = await createSqliteStore(location)
let granted = 0
for (let index = 0; index < Number(attempts); index += 1) {
  if (mode === 'naive') {
    if (store.usageTodayBySource('shared').calls + 1 > Number(cap)) continue
    await new Promise((resolve) => setImmediate(resolve))
    store.addUsage('shared', 1, 0)
    granted += 1
  } else if (store.reserveUsage('shared', 1, Number(cap))) granted += 1
}
store.close()
process.stdout.write(String(granted))
