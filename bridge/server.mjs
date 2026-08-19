#!/usr/bin/env node
/**
 * The bridge: an MCP server on stdio that relays commands to the Figma plugin
 * over a loopback WebSocket.
 *
 *   Claude Code ──stdio──► bridge ──ws://127.0.0.1:3055──► plugin panel ──► Figma
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

const port = Number(process.env.FIGMA_BRIDGE_PORT ?? 3055)
const outDir = path.resolve(process.env.FIGMA_BRIDGE_OUT_DIR ?? path.join(process.cwd(), 'figma-exports'))

/** stdout carries the MCP protocol, so every log line goes to stderr. */
const log = (message) => process.stderr.write(`[figma-bridge] ${message}\n`)

const channel = new Channel({ port, log })
try {
  await channel.listen()
} catch (error) {
  // Keep serving: the tools explain the problem far better than a dead process.
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
log(`ready — exports will be written to ${outDir}`)

const shutdown = () => {
  channel.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
