/** Validate schema syntax and every constructed tool request/response. */
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { readdir, readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const ajv = new Ajv2020({ strict: false, allErrors: true })
addFormats(ajv)
const validators = new Map()
for (const file of await readdir(new URL('schemas/', root))) {
  const schema = JSON.parse(await readFile(new URL(`schemas/${file}`, root), 'utf8'))
  validators.set(file, ajv.compile(schema))
}
let count = 0
for (const file of await readdir(new URL('examples/', root))) {
  if (!file.endsWith('.json')) continue
  const direction = file.includes('.input.') ? 'input' : 'output'
  const validate = validators.get(`${file.split('.')[0]}.${direction}.schema.json`)
  if (!validate) throw new Error(`No schema for ${file}`)
  const value = JSON.parse(await readFile(new URL(`examples/${file}`, root), 'utf8'))
  if (!validate(value)) throw new Error(`${file}: ${ajv.errorsText(validate.errors)}`)
  count++
}
process.stderr.write(`Validated ${validators.size} schemas and ${count} examples.\n`)
