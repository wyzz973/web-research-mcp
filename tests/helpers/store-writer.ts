/** Child process for the multi-process store test: hammers one database file with writes. */
import { createSqliteStore } from '../../src/store/sqlite.ts'

const [location, label, count] = process.argv.slice(2)
if (!location || !label || !count) throw new Error('usage: store-writer <db> <label> <count>')
const store = await createSqliteStore(location)
const ids: string[] = []
for (let index = 0; index < Number(count); index += 1) {
  ids.push(store.insertRecord('stress', '', { label, index }, 60))
  store.addUsage(label, 1, 0.001)
}
store.close()
process.stdout.write(JSON.stringify(ids))
