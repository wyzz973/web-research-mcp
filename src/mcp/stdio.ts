#!/usr/bin/env node
/** Executable entry for MCP clients: `web-research-mcp`. stdout carries protocol messages only. */
import { runMcpStdio } from './run.ts'

runMcpStdio().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unable to start'
  process.stderr.write(`web-research-mcp: ${message}\n`)
  process.exitCode = 1
})
