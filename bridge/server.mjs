#!/usr/bin/env node
/**
 * The bridge: an MCP server on stdio that relays commands to the Figma plugin
 * over a loopback WebSocket.
 *
 *   Claude Code ──stdio──► bridge ──ws://localhost:3056──► plugin panel ──► Figma
 *
 * Figma's plugin API only exists inside Figma, and a plugin cannot accept
 * incoming connections — so the panel dials out to this process and holds the
 * socket open. Every MCP tool is therefore a request the panel answers.
 */
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Channel } from './channel.mjs'
import { registerTools } from './tools.mjs'

const port = Number(process.env.FIGMA_BRIDGE_PORT ?? 3056)
const outDir = path.resolve(process.env.FIGMA_BRIDGE_OUT_DIR ?? path.join(process.cwd(), 'figma-exports'))

/** stdout carries the MCP protocol, so every log line goes to stderr. */
const log = (message) => process.stderr.write(`[figma-bridge] ${message}\n`)

/**
 * Run by hand (`npm run bridge`) there is nobody on stdio to read an excuse, so
 * a bridge that cannot listen is simply a failure. As an MCP child process it
 * is the opposite: staying up lets every tool explain the problem in place.
 */
const standalone = process.argv.includes('--standalone')

const channel = new Channel({ port, log })
try {
  await channel.listen()
} catch (error) {
  if (standalone) {
    log(`cannot listen on port ${port}: ${error.message}`)
    log(
      error.code === 'EADDRINUSE'
        ? `Another bridge is already running on ${port}. Close it, or set FIGMA_BRIDGE_PORT to 3057.`
        : 'The bridge cannot accept connections, so the plugin has nothing to connect to.',
    )
    process.exit(1)
  }
  log(`could not listen on port ${port}: ${error.message}`)
}

const server = new McpServer(
  { name: 'figma', version: '0.1.0' },
  {
    instructions:
      'Drives a Figma document through the "Figma to Claude" plugin panel, which must be open in Figma. ' +
      'Start with figma_status to confirm the panel is connected, then figma_get_selection or figma_get_page ' +
      'to find layer ids. figma_get_design_spec is the fastest way to understand a design before writing code. ' +
      'Editing tools act on the current selection unless nodeIds are given.',
  },
)

registerTools(server, channel, { outDir, log })

await server.connect(new StdioServerTransport())
log(
  standalone
    ? `ready on ws://localhost:${port} — open the plugin in Figma`
    : `ready — exports will be written to ${outDir}`,
)

const shutdown = () => {
  channel.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
