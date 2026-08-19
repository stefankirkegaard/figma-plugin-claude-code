/**
 * End-to-end verification of the MCP bridge.
 *
 * A real Figma panel is replaced by a WebSocket client that answers commands
 * the way `src/ui/bridge.ts` does, and Claude Code is replaced by an MCP client
 * on the bridge's stdio. What is checked is the part that has no types to
 * protect it: the wire between the two.
 *
 * Run with: npm run test:bridge
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { WebSocket } from 'ws'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outDir = mkdtempSync(path.join(tmpdir(), 'f2c-bridge-'))
const PORT = 3157

let failures = 0
let checks = 0

function check(label, condition, detail = '') {
  checks++
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** A stand-in for the plugin panel: connects, says hello, answers commands. */
function fakePanel(port, respond) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    const seen = []

    socket.on('open', () => {
      socket.send(JSON.stringify({ v: 1, type: 'hello', document: 'Test Doc', page: 'Page 1' }))
      resolve({ socket, seen })
    })
    socket.on('error', reject)
    socket.on('message', async (data) => {
      const request = JSON.parse(data.toString())
      seen.push(request)
      try {
        const result = await respond(request)
        socket.send(JSON.stringify({ v: 1, id: request.id, ok: true, result }))
      } catch (error) {
        socket.send(JSON.stringify({ v: 1, id: request.id, ok: false, error: error.message }))
      }
    })
  })
}

const PNG_PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const responses = {
  status: () => ({ document: 'Test Doc', page: 'Page 1', selection: { pageName: 'Page 1', nodes: [] } }),
  get_selection: () => ({ pageName: 'Page 1', nodes: [{ id: '1:2', name: 'Card', type: 'FRAME' }] }),
  get_design_spec: () => '# Test Doc — Page 1\n\n- **Card** (frame) — 320×200',
  find_nodes: (params) => ({ matches: [{ id: '1:2', name: params.name ?? '', type: 'FRAME' }] }),
  set_color: (params) => `Set ${params.target} on 1 layer`,
  export: () => ({ files: [{ name: 'Card@2x.png', mime: 'image/png', base64: PNG_PIXEL }] }),
  render_motion: () => ({ file: { name: 'motion.gif', mime: 'image/gif', base64: 'R0lGODlhAQABAAAAACw=' }, frames: 12 }),
  boom: () => {
    throw new Error('Select at least one layer first.')
  },
}

const client = new Client({ name: 'bridge-test', version: '0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'bridge', 'server.mjs')],
  env: { ...process.env, FIGMA_BRIDGE_PORT: String(PORT), FIGMA_BRIDGE_OUT_DIR: outDir },
  stderr: 'ignore',
})

let panel
try {
  await client.connect(transport)
  console.log('\nMCP surface')

  const { tools } = await client.listTools()
  const names = tools.map((tool) => tool.name).sort()
  check('exposes the read tools', ['figma_get_selection', 'figma_get_page', 'figma_get_design_spec'].every((name) => names.includes(name)), names.join(', '))
  check('exposes the editing tools', ['figma_rename', 'figma_set_color', 'figma_replace_text'].every((name) => names.includes(name)))
  check('exposes export and motion', names.includes('figma_export') && names.includes('figma_render_motion'))
  check('every tool is described', tools.every((tool) => (tool.description ?? '').length > 20))

  console.log('\nWithout a panel')
  const orphan = await client.callTool({ name: 'figma_status', arguments: {} })
  check('figma_status reports no connection', orphan.content[0].text.includes('"connected": false'))

  const refused = await client.callTool({ name: 'figma_get_selection', arguments: {} })
  check('other tools explain how to connect', refused.isError === true && /Plugins/.test(refused.content[0].text), refused.content[0].text)

  console.log('\nWith a panel connected')
  panel = await fakePanel(PORT, (request) => {
    const handler = responses[request.command]
    if (!handler) throw new Error(`Unknown command "${request.command}".`)
    return handler(request.params)
  })

  const status = await client.callTool({ name: 'figma_status', arguments: {} })
  check('figma_status sees the panel', status.content[0].text.includes('"document": "Test Doc"'), status.content[0].text)

  const selection = await client.callTool({ name: 'figma_get_selection', arguments: {} })
  check('the selection round-trips', selection.content[0].text.includes('"name": "Card"'))

  const spec = await client.callTool({ name: 'figma_get_design_spec', arguments: {} })
  check('the design spec comes back as Markdown', spec.content[0].text.startsWith('# Test Doc'))

  const found = await client.callTool({ name: 'figma_find_nodes', arguments: { name: 'card' } })
  check('arguments reach the panel', found.content[0].text.includes('"name": "card"'))

  await client.callTool({ name: 'figma_set_color', arguments: { hex: '#ff0000', target: 'stroke' } })
  const colorCall = panel.seen.find((request) => request.command === 'set_color')
  check('defaults are applied before dispatch', colorCall.params.target === 'stroke' && colorCall.params.hex === '#ff0000')

  console.log('\nBinary results')
  const exported = await client.callTool({ name: 'figma_export', arguments: { format: 'PNG', scales: [2] } })
  const written = path.join(outDir, 'Card@2x.png')
  const bytes = readFileSync(written)
  check('the export is written to disk', bytes.length === Buffer.from(PNG_PIXEL, 'base64').length)
  check('it is a real PNG', bytes.subarray(1, 4).toString() === 'PNG')
  check('the path is reported', exported.content[0].text.includes(written))
  check('PNGs come back inline as an image', exported.content.some((part) => part.type === 'image' && part.mimeType === 'image/png'))

  const rendered = await client.callTool({ name: 'figma_render_motion', arguments: { frameIds: ['1:2', '1:3'], format: 'GIF' } })
  check('a render lands on disk', readFileSync(path.join(outDir, 'motion.gif')).length > 0)
  check('the render is reported with its frame count', rendered.content[0].text.includes('12 frames'))

  console.log('\nFailures')
  const failed = await client.callTool({ name: 'figma_rename', arguments: { pattern: 'x' } })
  check('a panel error reaches the caller', failed.isError === true && failed.content[0].text.includes('Unknown command'), failed.content[0].text)

  panel.socket.close()
  await new Promise((resolve) => setTimeout(resolve, 200))
  const afterClose = await client.callTool({ name: 'figma_get_selection', arguments: {} })
  check('closing the panel disconnects cleanly', afterClose.isError === true && /No Figma panel/.test(afterClose.content[0].text))
} finally {
  panel?.socket.close()
  await client.close().catch(() => {})
  rmSync(outDir, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
