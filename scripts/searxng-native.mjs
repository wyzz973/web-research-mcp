import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { createNativeController, parsePort, serviceEnvironment } from './native-control.mjs'
import { installNative, ensureNativeInstalled, nativePaths } from './searxng-native-install.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function main(args = process.argv.slice(2)) {
  if (!['darwin', 'linux'].includes(process.platform)) {
    throw new Error(
      'Native SearXNG currently supports macOS and Linux only; Windows is unsupported',
    )
  }
  const [command, ...rest] = args
  if (!['setup', 'start', 'run', 'status', 'stop'].includes(command)) {
    throw new Error(
      'Usage: node scripts/searxng-native.mjs setup|start|run|status|stop [--port 18888]',
    )
  }
  let port = 18888
  let instance
  const seen = new Set()
  for (let index = 0; index < rest.length; index += 2) {
    const option = rest[index]
    const value = rest[index + 1]
    if (!value || seen.has(option)) throw new Error(`Invalid or repeated option: ${option}`)
    seen.add(option)
    if (option === '--port' && ['start', 'run'].includes(command)) port = parsePort(value)
    else if (option === '--managed-instance' && command === 'run') instance = value
    else throw new Error(`Unsupported option: ${option}`)
  }
  if (command === 'setup') {
    await installNative({ root })
    return
  }
  const paths = nativePaths(root)
  const controller = createNativeController({
    directory: paths.directory,
    ensureInstalled: () => ensureNativeInstalled(root),
    supervisor: {
      command: process.execPath,
      args: [fileURLToPath(import.meta.url)],
      env: serviceEnvironment(paths),
    },
    service: (servicePort) => ({
      command: paths.python,
      args: [
        '-m',
        'granian',
        '--interface',
        'wsgi',
        '--host',
        '127.0.0.1',
        '--port',
        String(servicePort),
        '--workers',
        '1',
        '--blocking-threads',
        '4',
        'searx.webapp:app',
      ],
      cwd: paths.source,
      env: serviceEnvironment(paths),
    }),
  })
  if (command === 'run') await controller.run(port, instance)
  else {
    const result = command === 'start' ? await controller.start(port) : await controller[command]()
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Native SearXNG: ${error.message}\n`)
    process.exitCode = 1
  })
}
