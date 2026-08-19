import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

/** Inlining every export would swamp the model's context, so only a few go back as images. */
const MAX_INLINE_IMAGES = 4
const MAX_INLINE_BYTES = 1_500_000

const RENDER_TIMEOUT_MS = 15 * 60_000
const EXPORT_TIMEOUT_MS = 5 * 60_000

const EASINGS = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'easeOutBack', 'easeOutBounce']

const nodeIds = z
  .array(z.string())
  .optional()
  .describe('Layer ids to act on. Omit to use whatever is selected in Figma right now.')

function text(value) {
  return { content: [{ type: 'text', text: value }] }
}

function json(value) {
  return text(JSON.stringify(value, null, 2))
}

function safeName(name) {
  return name.replace(/[^\w.@-]+/g, '-').replace(/^-+|-+$/g, '') || 'export'
}

/**
 * Registers every Figma tool on `server`. Each one is a thin wrapper: the real
 * work happens inside the plugin, which is the only place with a Figma API.
 */
export function registerTools(server, channel, { outDir, log }) {
  const call = (command, params, options) => channel.call(command, params, options)

  async function writeOut(files) {
    await mkdir(outDir, { recursive: true })
    const written = []
    for (const file of files) {
      const target = path.join(outDir, safeName(file.name))
      const bytes = Buffer.from(file.base64, 'base64')
      await writeFile(target, bytes)
      written.push({ path: target, bytes: bytes.length, mime: file.mime, base64: file.base64 })
    }
    return written
  }

  const tool = (name, description, shape, handler) =>
    server.registerTool(name, { description, inputSchema: shape }, handler)

  /* ------------------------------------------------------------- reading */

  tool(
    'figma_status',
    'Check whether a Figma panel is connected to this bridge, and which document and page it has open. Call this first if anything else reports no connection.',
    {},
    async () => {
      const status = channel.status()
      if (!channel.connected) {
        return json({
          ...status,
          connected: false,
          hint: 'Open the plugin in Figma: Plugins → Development → Figma to Claude. It connects on its own.',
        })
      }
      const live = await call('status', {})
      return json({ ...status, connected: true, ...live })
    },
  )

  tool(
    'figma_get_selection',
    'The layers currently selected in Figma, with id, name, type and size. Use the ids to target other tools.',
    {},
    async () => json(await call('get_selection', {})),
  )

  tool(
    'figma_get_page',
    'The layer tree of the current page, depth limited. Use it to find what to work on when nothing is selected.',
    {
      depth: z.number().int().min(1).max(12).default(3).describe('How many levels deep to walk.'),
      includeHidden: z.boolean().default(false).describe('Include layers hidden on the canvas.'),
    },
    async (args) => json(await call('get_page', args)),
  )

  tool(
    'figma_find_nodes',
    'Search the current page for layers by name and/or type. Returns ids you can pass to the other tools.',
    {
      name: z.string().optional().describe('Case-insensitive substring of the layer name.'),
      type: z
        .string()
        .optional()
        .describe('Figma node type, e.g. FRAME, TEXT, COMPONENT, INSTANCE, RECTANGLE.'),
      limit: z.number().int().min(1).max(500).default(100),
    },
    async (args) => json(await call('find_nodes', args)),
  )

  tool(
    'figma_get_design_spec',
    'A Markdown spec of the selection (or the given layers): the layer tree annotated with geometry, colours, type, auto layout and effects, plus the palette and fonts used. This is the best context to read before writing code from a design.',
    { nodeIds },
    async (args) => text(await call('get_design_spec', args)),
  )

  tool(
    'figma_list_frames',
    'Top-level frames on the current page, with their prototype connections. Frame ids feed figma_render_motion.',
    {},
    async () => json(await call('list_frames', {})),
  )

  /* ------------------------------------------------------------- writing */

  tool(
    'figma_set_selection',
    'Select the given layers in Figma, optionally scrolling the viewport to them.',
    {
      nodeIds: z.array(z.string()).describe('Layer ids to select.'),
      zoom: z.boolean().default(false).describe('Scroll and zoom the canvas to fit them.'),
    },
    async (args) => text(await call('set_selection', args)),
  )

  tool(
    'figma_rename',
    'Rename layers from a pattern. Tokens: {n} index, {name} current name, {type} node type, {w} width, {h} height.',
    {
      pattern: z.string().describe('e.g. "Icon/{name}-{n}"'),
      nodeIds,
    },
    async (args) => text(await call('rename', args)),
  )

  tool(
    'figma_set_color',
    'Set a solid fill or stroke colour on layers, keeping each existing paint\'s opacity.',
    {
      hex: z.string().describe('Hex colour, e.g. "#1d4ed8" or "#fff".'),
      target: z.enum(['fill', 'stroke']).default('fill'),
      nodeIds,
    },
    async (args) => text(await call('set_color', args)),
  )

  tool(
    'figma_set_opacity',
    'Set the opacity of layers, from 0 (invisible) to 1 (opaque).',
    { value: z.number().min(0).max(1).describe('0 to 1.'), nodeIds },
    async (args) => text(await call('set_opacity', args)),
  )

  tool(
    'figma_set_corner_radius',
    'Set a uniform corner radius on layers that support one.',
    { value: z.number().min(0), nodeIds },
    async (args) => text(await call('set_corner_radius', args)),
  )

  tool(
    'figma_set_auto_layout',
    'Apply auto layout to frames: direction, item spacing and uniform padding.',
    {
      direction: z.enum(['HORIZONTAL', 'VERTICAL']).default('VERTICAL'),
      gap: z.number().min(0).default(0),
      padding: z.number().min(0).default(0),
      nodeIds,
    },
    async (args) => text(await call('set_auto_layout', args)),
  )

  tool(
    'figma_replace_text',
    'Find and replace across every text layer inside the target layers. Fonts are loaded automatically.',
    {
      find: z.string(),
      replace: z.string(),
      matchCase: z.boolean().default(false),
      nodeIds,
    },
    async (args) => text(await call('replace_text', args)),
  )

  tool(
    'figma_select_similar',
    'Select every layer on the page that shares the type and size of the target layers. Returns the new selection.',
    { nodeIds },
    async (args) => text(await call('select_similar', args)),
  )

  tool(
    'figma_notify',
    'Show a toast inside Figma. Useful to tell the user what you just did or are about to do.',
    { message: z.string(), error: z.boolean().default(false) },
    async (args) => text(await call('notify', args)),
  )

  /* ------------------------------------------------------------ exporting */

  tool(
    'figma_export',
    `Export layers as image files. Files are written to ${outDir} and the paths are returned; PNG and JPG exports also come back inline so they can be looked at directly.`,
    {
      nodeIds,
      format: z.enum(['PNG', 'JPG', 'SVG', 'PDF']).default('PNG'),
      scales: z
        .array(z.number().positive())
        .default([2])
        .describe('Raster scale factors. Ignored for SVG and PDF.'),
      inlineImages: z
        .boolean()
        .default(true)
        .describe('Return PNG/JPG results as images as well as files.'),
    },
    async (args) => {
      const result = await call(
        'export',
        { nodeIds: args.nodeIds, format: args.format, scales: args.scales },
        { timeoutMs: EXPORT_TIMEOUT_MS, onProgress: (p) => log(`export ${p.done}/${p.total}`) },
      )
      const written = await writeOut(result.files)

      const content = [
        {
          type: 'text',
          text: `Exported ${written.length} file${written.length === 1 ? '' : 's'}:\n${written
            .map((file) => `- ${file.path} (${file.bytes} bytes)`)
            .join('\n')}`,
        },
      ]

      if (args.inlineImages && (args.format === 'PNG' || args.format === 'JPG')) {
        for (const file of written.slice(0, MAX_INLINE_IMAGES)) {
          if (file.bytes > MAX_INLINE_BYTES) continue
          content.push({ type: 'image', data: file.base64, mimeType: file.mime })
        }
      }
      return { content }
    },
  )

  tool(
    'figma_render_motion',
    'Animate frames and encode the result as a GIF, MP4 or ZIP of PNG frames, written to disk. Two modes: "sequence" smart-animates between frames the way Figma\'s Smart Animate does (pass frameIds, or steps for per-hop timing, or fromPrototypeFrameId to follow existing prototype links); "timeline" keyframes layers inside one frame (pass stageFrameId, duration and tracks). Rendering is done by Figma itself, so the output matches the canvas.',
    {
      mode: z.enum(['sequence', 'timeline']).default('sequence'),
      format: z.enum(['GIF', 'MP4', 'PNG_SEQUENCE']).default('GIF'),
      frameIds: z
        .array(z.string())
        .optional()
        .describe('Sequence mode: frames to animate between, in order.'),
      steps: z
        .array(
          z.object({
            frameId: z.string(),
            duration: z.number().min(0).default(0.6).describe('Seconds morphing into this frame.'),
            hold: z.number().min(0).default(0.4).describe('Seconds held before the next transition.'),
            easing: z.enum(EASINGS).default('easeInOut'),
          }),
        )
        .optional()
        .describe('Sequence mode with explicit per-hop timing. Overrides frameIds.'),
      fromPrototypeFrameId: z
        .string()
        .optional()
        .describe('Sequence mode: build the steps by following this frame\'s prototype links.'),
      stepDuration: z.number().min(0).default(0.6).describe('Default transition seconds for frameIds.'),
      stepHold: z.number().min(0).default(0.4).describe('Default hold seconds for frameIds.'),
      easing: z.enum(EASINGS).default('easeInOut'),
      stageFrameId: z.string().optional().describe('Timeline mode: the frame that holds the layers.'),
      duration: z.number().min(0.1).default(2).describe('Timeline mode: length in seconds.'),
      tracks: z
        .array(
          z.object({
            nodeId: z.string(),
            prop: z.enum(['x', 'y', 'scale', 'rotation', 'opacity']),
            keys: z.array(
              z.object({
                t: z.number().min(0).describe('Seconds from the start.'),
                value: z.number(),
                easing: z.enum(EASINGS).default('easeInOut'),
              }),
            ),
          }),
        )
        .optional()
        .describe('Timeline mode: per-layer keyframes. x/y are offsets in px, scale is a multiplier, rotation is degrees, opacity is 0–1.'),
      fps: z.number().int().min(1).max(60).default(24),
      scale: z.number().min(0.1).max(4).default(1).describe('Render scale factor.'),
      maxWidth: z.number().int().min(16).max(4096).default(960),
      background: z.string().default('#ffffff').describe('Matte colour behind transparent pixels.'),
      transparent: z.boolean().default(false).describe('GIF and PNG only; MP4 always mattes.'),
      dither: z.boolean().default(true).describe('GIF only.'),
      loop: z.boolean().default(true).describe('GIF only.'),
      quality: z.number().min(0.1).max(1).default(0.8).describe('MP4 only.'),
      unlockAutoLayout: z
        .boolean()
        .default(true)
        .describe('Drop auto layout on the render stage so laid-out children can move.'),
      maxFrames: z.number().int().min(1).max(900).default(900),
    },
    async (args) => {
      const result = await call('render_motion', args, {
        timeoutMs: RENDER_TIMEOUT_MS,
        onProgress: (p) => log(`${p.label ?? 'render'} ${p.done}/${p.total}`),
      })
      const [file] = await writeOut([result.file])
      return text(
        `Rendered ${result.frames} frames at ${args.fps} fps.\n` +
          `${file.path} — ${(file.bytes / 1024).toFixed(1)} kB${result.note ? `\n${result.note}` : ''}`,
      )
    },
  )
}
