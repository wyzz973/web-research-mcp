/** Isolated Crawl4AI process; every browser HTTP request is fulfilled by our policy gateway. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  captureOwnedGroups,
  stopOwnedProcesses,
  type OwnedProcessGroups,
} from './browser-processes.ts'
import { createServer, type Socket } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { AppError, throwIfAborted } from '../shared/errors.ts'
import { noOpTraceRecorder } from '../shared/trace.ts'
import type { DocumentLoader, DomainScope, LoadedDocument } from '../shared/types.ts'
import type { FetchOptions } from './index.ts'
import { createBrowserGateway, type BrowserResourceRequest } from './browser-gateway.ts'
import { extractHtml } from './extractor.ts'
import { validateUrl, type FetchDependencies } from './network.ts'
import { Limiter } from './limiter.ts'

export interface Crawl4aiOptions extends FetchOptions {
  enabled: boolean
  waitMs: number
  concurrency: number
  /** Explicit local installation paths, injected by the composition root or test assembly. */
  pythonPath?: string
  workerPath?: string
  cacheDirectory?: string
}
export function crawl4aiPaths() {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const cacheDirectory = join(root, '.cache', 'crawl4ai')
  return {
    cacheDirectory,
    pythonPath: join(cacheDirectory, 'venv', 'bin', 'python'),
    workerPath: join(root, 'scripts', 'crawl4ai-worker.py'),
  }
}
export function crawl4aiStatus() {
  const paths = crawl4aiPaths()
  try {
    const receipt: unknown = JSON.parse(
      readFileSync(join(paths.cacheDirectory, 'installation.json'), 'utf8'),
    )
    return {
      installed:
        record(receipt) &&
        receipt.crawl4ai === '0.9.3' &&
        receipt.playwright === '1.62.0' &&
        existsSync(paths.pythonPath) &&
        existsSync(join(paths.cacheDirectory, 'browsers')),
      version: '0.9.3',
    }
  } catch {
    return { installed: false, version: '0.9.3' }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function browserRequest(value: Record<string, unknown>): BrowserResourceRequest {
  if (
    typeof value.url !== 'string' ||
    value.url.length > 8192 ||
    typeof value.resource_type !== 'string' ||
    typeof value.main_frame !== 'boolean' ||
    !Number.isInteger(value.redirect_depth) ||
    typeof value.redirect_depth !== 'number' ||
    value.redirect_depth < 0
  )
    throw new AppError('EXTRACTION_FAILED', 'Invalid Crawl4AI resource request.')
  return {
    url: value.url,
    resource_type: value.resource_type,
    main_frame: value.main_frame,
    redirect_depth: value.redirect_depth,
  }
}

export function createCrawl4aiLoader(
  options: Crawl4aiOptions,
  dependencies: FetchDependencies = {},
): DocumentLoader {
  const paths = {
    ...crawl4aiPaths(),
    ...Object.fromEntries(
      Object.entries({
        pythonPath: options.pythonPath,
        workerPath: options.workerPath,
        cacheDirectory: options.cacheDirectory,
      }).filter(([, v]) => v !== undefined),
    ),
  }
  const trace = options.tracer ?? noOpTraceRecorder
  const limiter = new Limiter(options.concurrency)
  const lifetime = new AbortController()
  const active = new Set<Promise<LoadedDocument>>()
  async function execute(
    raw: string,
    scope: DomainScope | undefined,
    parent: AbortSignal,
  ): Promise<LoadedDocument> {
    const initial = validateUrl(raw, scope)
    if (!options.enabled)
      throw new AppError('CONFIGURATION_REQUIRED', 'Crawl4AI is disabled by this deployment.')
    if (process.platform === 'win32')
      throw new AppError(
        'CONFIGURATION_REQUIRED',
        'Managed Crawl4AI currently supports macOS/Linux.',
      )
    if (!existsSync(paths.pythonPath) || !existsSync(paths.workerPath))
      throw new AppError(
        'CONFIGURATION_REQUIRED',
        'Crawl4AI is not installed. Run pnpm crawl4ai:setup first.',
      )
    const controller = new AbortController()
    const signal = AbortSignal.any([parent, lifetime.signal, controller.signal])
    const timer = setTimeout(
      () =>
        controller.abort(new AppError('TIMEOUT', 'Crawl4AI exceeded its total deadline.', true)),
      options.deadlineMs,
    )
    timer.unref()
    let release: (() => void) | undefined
    let jobDirectory: string | undefined
    let child: ChildProcessWithoutNullStreams | undefined
    let ownership: OwnedProcessGroups | undefined
    let writeDrain = Promise.resolve()
    let closeGateway: (() => Promise<void>) | undefined
    const sockets = new Set<Socket>()
    const deadProxy = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.destroy()
    })
    let listening = false
    const requests = new Set<Promise<void>>()
    let hadPrimaryError = false
    try {
      release = await limiter.acquire(signal)
      throwIfAborted(signal)
      await mkdir(join(paths.cacheDirectory, 'jobs'), { recursive: true, mode: 0o700 })
      jobDirectory = await mkdtemp(join(paths.cacheDirectory, 'jobs', 'render-'))
      await new Promise<void>((resolve, reject) => {
        deadProxy.once('error', reject)
        deadProxy.listen(0, '127.0.0.1', () => {
          listening = true
          deadProxy.removeListener('error', reject)
          resolve()
        })
      })
      const address = deadProxy.address()
      if (!address || typeof address === 'string')
        throw new AppError('EXTRACTION_FAILED', 'Unable to allocate browser isolation proxy.')
      const gateway = createBrowserGateway(
        { ...options, initialUrl: initial.href },
        dependencies,
        scope,
        signal,
      )
      closeGateway = () => gateway.close()
      trace.event('crawl4ai.start', 'ok', {
        engine: 'crawl4ai',
        version: '0.9.3',
        url: initial.href,
        deadline_ms: options.deadlineMs,
        wait_ms: options.waitMs,
        network_policy: 'parent_gateway_only',
      })
      child = spawn(paths.pythonPath, ['-u', paths.workerPath], {
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/bin:/bin',
          HOME: jobDirectory,
          TMPDIR: jobDirectory,
          TMP: jobDirectory,
          TEMP: jobDirectory,
          PYTHONNOUSERSITE: '1',
          PYTHONUNBUFFERED: '1',
          PLAYWRIGHT_BROWSERS_PATH: join(paths.cacheDirectory, 'browsers'),
          CRAWL4_AI_BASE_DIRECTORY: jobDirectory,
          NO_COLOR: '1',
          TERM: 'dumb',
          LITELLM_LOCAL_MODEL_COST_MAP: 'True',
          HF_HUB_OFFLINE: '1',
          HF_HUB_DISABLE_TELEMETRY: '1',
        },
      })
      const process = child
      let mainFailure: AppError | undefined
      let finalUrl: string | undefined
      let mainStatus: number | undefined
      let navigationCount = 0
      const warnings = new Set<string>()
      let pendingBytes = 0

      const write = (value: unknown) => {
        const line = JSON.stringify(value) + '\n'
        pendingBytes += Buffer.byteLength(line)
        if (pendingBytes > 16 * 1024 * 1024) {
          controller.abort(
            new AppError('RESPONSE_TOO_LARGE', 'Browser IPC output budget exceeded.'),
          )
          return
        }
        writeDrain = writeDrain.then(
          () =>
            new Promise<void>((resolve) => {
              if (process.stdin.destroyed) {
                pendingBytes -= Buffer.byteLength(line)
                resolve()
                return
              }
              process.stdin.write(line, () => {
                pendingBytes -= Buffer.byteLength(line)
                resolve()
              })
            }),
        )
      }
      process.stdin.on('error', () =>
        controller.abort(new AppError('EXTRACTION_FAILED', 'Crawl4AI input channel closed.')),
      )
      let stderrBytes = 0
      process.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length
        if (stderrBytes > 1024 * 1024)
          controller.abort(
            new AppError('RESPONSE_TOO_LARGE', 'Crawl4AI diagnostic output budget exceeded.'),
          )
      })
      const rendered = await trace.span(
        'crawl4ai.render',
        { url: initial.href, wait_ms: options.waitMs },
        () =>
          new Promise<{ html: string; url: string }>((resolve, reject) => {
            let buffer = ''
            let total = 0
            let settled = false
            let seenResult = false
            const ids = new Set<number>()
            let readyCount = 0
            const finish = (error?: unknown, result?: { html: string; url: string }) => {
              if (settled) return
              settled = true
              signal.removeEventListener('abort', abort)
              if (error) reject(error)
              else if (result) resolve(result)
            }
            const abort = () => {
              try {
                throwIfAborted(signal)
              } catch (error) {
                finish(error)
              }
            }
            signal.addEventListener('abort', abort, { once: true })
            process.once('error', () =>
              finish(
                new AppError(
                  'EXTRACTION_FAILED',
                  'Unable to launch Crawl4AI. Run pnpm crawl4ai:setup to repair.',
                ),
              ),
            )
            process.once('exit', () => {
              if (!seenResult)
                finish(
                  mainFailure ??
                    new AppError('EXTRACTION_FAILED', 'Crawl4AI exited without a complete result.'),
                )
            })
            process.stdout.setEncoding('utf8')
            process.stdout.on('data', (chunk: string) => {
              total += Buffer.byteLength(chunk)
              if (total > 16 * 1024 * 1024) {
                finish(
                  new AppError('RESPONSE_TOO_LARGE', 'Crawl4AI output exceeded its byte budget.'),
                )
                return
              }
              buffer += chunk
              let newline: number
              while ((newline = buffer.indexOf('\n')) >= 0 && !settled) {
                const line = buffer.slice(0, newline)
                buffer = buffer.slice(newline + 1)
                try {
                  const value: unknown = JSON.parse(line)
                  if (!record(value))
                    throw new AppError('EXTRACTION_FAILED', 'Malformed Crawl4AI response.')
                  if (value.type === 'ready') {
                    if (++readyCount > options.maxRedirects + 1 || !process.pid)
                      throw new AppError('EXTRACTION_FAILED', 'Invalid browser readiness sequence.')
                    const pid = process.pid
                    const task = captureOwnedGroups(pid)
                      .then((value) => {
                        ownership = value
                        write({ type: 'continue' })
                      })
                      .catch((error) => finish(error))
                      .finally(() => requests.delete(task))
                    requests.add(task)
                  } else if (value.type === 'request') {
                    if (
                      typeof value.id !== 'number' ||
                      !Number.isSafeInteger(value.id) ||
                      value.id < 1 ||
                      value.id > 100 ||
                      ids.has(value.id) ||
                      ids.size >= 100
                    )
                      throw new AppError(
                        'EXTRACTION_FAILED',
                        'Invalid Crawl4AI request identity or limit.',
                      )
                    ids.add(value.id)
                    if (!ownership)
                      throw new AppError(
                        'EXTRACTION_FAILED',
                        'Browser requested data before ownership handshake.',
                      )
                    const request = browserRequest(value)
                    const top = request.resource_type === 'document' && request.main_frame
                    if (top && ++navigationCount > options.maxRedirects + 1)
                      throw new AppError(
                        'FETCH_BLOCKED',
                        'Browser top-level navigation budget exceeded.',
                      )
                    const task = (async () => {
                      try {
                        const response = await gateway.request(request)
                        if (top) {
                          mainStatus = response.status
                          if (response.status >= 200 && response.status < 300)
                            finalUrl = validateUrl(request.url, scope).href
                        }
                        write({ type: 'response', id: value.id, ...response })
                      } catch (error) {
                        const failure =
                          error instanceof AppError
                            ? error
                            : new AppError('UPSTREAM_UNAVAILABLE', 'Browser resource unavailable.')
                        if (top) mainFailure = failure
                        else
                          warnings.add(
                            `Browser subresource blocked or unavailable: ${failure.code}`,
                          )
                        write({
                          type: 'response',
                          id: value.id,
                          error: { code: failure.code, message: failure.message },
                        })
                      }
                    })().finally(() => requests.delete(task))
                    requests.add(task)
                  } else if (value.type === 'result') {
                    seenResult = true
                    if (mainFailure) throw mainFailure
                    if (mainStatus === 403 || mainStatus === 429)
                      throw new AppError(
                        'UPSTREAM_BLOCKED',
                        'The browser origin denied access or rate limited the request.',
                        false,
                        mainStatus,
                      )
                    if (Array.isArray(value.resource_errors) && value.resource_errors.length) {
                      warnings.add(
                        'Some browser subresources failed or their redirects were blocked; rendered content may be incomplete.',
                      )
                      trace.event('crawl4ai.blocked', 'partial', {
                        worker_resource_errors: value.resource_errors.slice(0, 20),
                      })
                    }
                    if (value.success !== true) {
                      const code = record(value.error) ? value.error.code : undefined
                      throw new AppError(
                        code === 'TIMEOUT' ? 'TIMEOUT' : 'EXTRACTION_FAILED',
                        'Crawl4AI could not render a usable page.',
                      )
                    }
                    if (
                      typeof value.html !== 'string' ||
                      Buffer.byteLength(value.html) > options.maxDecompressedBytes ||
                      typeof value.url !== 'string' ||
                      !finalUrl
                    )
                      throw new AppError(
                        'EXTRACTION_FAILED',
                        'Invalid or oversized rendered page without an observed main response.',
                      )
                    const actual = validateUrl(value.url, scope)
                    if (actual.origin !== new URL(finalUrl).origin)
                      throw new AppError(
                        'FETCH_BLOCKED',
                        'Rendered page identity differs from its observed main response.',
                      )
                    if (actual.href !== finalUrl)
                      warnings.add(
                        'Page changed its client-side URL; evidence identity uses the observed main document response.',
                      )
                    finish(undefined, { html: value.html, url: finalUrl })
                  } else
                    throw new AppError('EXTRACTION_FAILED', 'Unexpected Crawl4AI protocol message.')
                } catch (error) {
                  finish(error)
                }
              }
            })
            write({
              type: 'init',
              url: initial.href,
              deadline_ms: options.deadlineMs,
              wait_ms: options.waitMs,
              proxy_url: `http://127.0.0.1:${address.port}`,
            })
            if (signal.aborted) abort()
          }),
        (value) => ({
          final_url: value.url,
          rendered_bytes: Buffer.byteLength(value.html),
          resources: gateway.inspect(),
        }),
      )
      throwIfAborted(signal)
      if (
        /<title[^>]*>\s*(?:just a moment|attention required|access denied|verify (?:you|your)|captcha)/i.test(
          rendered.html,
        ) ||
        /cf-chl-|challenge-platform|id=["']captcha/i.test(rendered.html)
      )
        throw new AppError('UPSTREAM_BLOCKED', 'The browser returned an anti-bot challenge page.')
      const fetchedAt = new Date().toISOString()
      const extracted = await trace.span(
        'crawl4ai.extract',
        {
          url: rendered.url,
          technology: 'Crawl4AI rendered DOM + Readability/Turndown normalization',
        },
        () =>
          extractHtml(
            Buffer.from(rendered.html),
            rendered.url,
            'text/html; charset=utf-8',
            signal,
            options.parserTimeoutMs,
            options.parserMemoryMb,
          ),
        (value) => ({
          title: value.title,
          text_chars: Array.from(value.text).length,
          text_preview: value.text.slice(0, 1200),
        }),
      )
      const result: LoadedDocument = {
        ...extracted,
        url: initial.href,
        finalUrl: rendered.url,
        contentType: 'text/html',
        fetchedAt,
        fetchBackend: 'crawl4ai',
        extractorVersion: 'crawl4ai-0.9.3+chromium+readability-0.6.0+gfm-v1',
        warnings: [...extracted.warnings, ...warnings],
        sourceMetadata: {
          ...extracted.sourceMetadata,
          source_url: initial.href,
          retrieved_at: fetchedAt,
        },
      }
      trace.event('crawl4ai.finish', result.warnings.length ? 'partial' : 'ok', {
        backend: 'crawl4ai',
        resources: gateway.inspect(),
        warnings: result.warnings,
      })
      return result
    } catch (error) {
      hadPrimaryError = true
      throw error
    } finally {
      controller.abort(new AppError('CANCELLED', 'Browser lifecycle cleanup.'))
      try {
        await closeGateway?.()
        await Promise.allSettled(requests)
      } finally {
        try {
          if (child) {
            try {
              await stopOwnedProcesses(child, ownership)
            } catch (error) {
              trace.event('crawl4ai.cleanup', 'error', {
                code: 'EXTRACTION_FAILED',
                reason: 'Owned browser processes could not be confirmed stopped.',
              })
              lifetime.abort(
                new AppError(
                  'EXTRACTION_FAILED',
                  'Browser cleanup failed; restart the service before another browser request.',
                ),
              )
              // eslint-disable-next-line no-unsafe-finally -- Cleanup failure must block a success, while preserving any earlier exception.
              if (!hadPrimaryError) throw error
            } finally {
              child.stdin.destroy()
              child.stdout.destroy()
              child.stderr.destroy()
              await writeDrain
            }
          }
        } finally {
          for (const socket of sockets) socket.destroy()
          if (listening) await new Promise<void>((resolve) => deadProxy.close(() => resolve()))
          try {
            if (jobDirectory) await rm(jobDirectory, { recursive: true, force: true })
          } finally {
            clearTimeout(timer)
            release?.()
          }
        }
      }
    }
  }
  return {
    load(url, { signal, scope }) {
      const task = execute(url, scope, signal).finally(() => active.delete(task))
      active.add(task)
      return task
    },
    async close() {
      lifetime.abort(new AppError('CANCELLED', 'Browser loader shutting down.'))
      await Promise.allSettled(active)
    },
  }
}
