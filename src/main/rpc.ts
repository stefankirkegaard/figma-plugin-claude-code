import type { ExportFormat, NodeSummary, RpcRequest } from '../shared/types'
import * as assets from './assets'
import * as design from './design'
import * as motion from './motion'
import { selectionToMarkdown } from './serialize'
import { hexToRgb, loadFontsFor, post, selectionState, summarize, walk } from './util'

/** Guard rails so a broad request cannot return a document-sized payload. */
const MAX_TREE_NODES = 2000
const MAX_FIND_RESULTS = 500

/** Figma rejects images larger than this on either axis. */
const MAX_IMAGE_SIZE = 4096

type Params = Record<string, unknown>
type Handler = (params: Params) => unknown | Promise<unknown>

interface TreeNode extends NodeSummary {
  children?: TreeNode[]
}

function str(params: Params, key: string, fallback = ''): string {
  const value = params[key]
  return typeof value === 'string' ? value : fallback
}

function num(params: Params, key: string, fallback: number): number {
  const value = params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(params: Params, key: string, fallback = false): boolean {
  const value = params[key]
  return typeof value === 'boolean' ? value : fallback
}

function ids(params: Params, key = 'nodeIds'): string[] | null {
  const value = params[key]
  if (!Array.isArray(value)) return null
  const list = value.filter((entry): entry is string => typeof entry === 'string')
  return list.length > 0 ? list : null
}

async function nodesById(list: string[]): Promise<SceneNode[]> {
  const found: SceneNode[] = []
  const missing: string[] = []
  for (const id of list) {
    const node = await figma.getNodeByIdAsync(id)
    if (node && node.type !== 'PAGE' && node.type !== 'DOCUMENT') found.push(node as SceneNode)
    else missing.push(id)
  }
  if (found.length === 0) {
    throw new Error(`None of those layer ids exist in this document: ${missing.join(', ')}`)
  }
  return found
}

/**
 * Every editing command works on the selection, exactly as the panel's buttons
 * do — so an explicit `nodeIds` list is applied by selecting those layers
 * first. The user then sees on canvas what was acted on.
 */
async function focus(params: Params): Promise<void> {
  const list = ids(params)
  if (!list) return
  const nodes = await nodesById(list)
  const onPage = nodes.filter((node) => isOnCurrentPage(node))
  if (onPage.length === 0) {
    throw new Error('Those layers are on another page. Switch to that page in Figma first.')
  }
  figma.currentPage.selection = onPage
}

function isOnCurrentPage(node: BaseNode): boolean {
  for (let current: BaseNode | null = node; current; current = current.parent) {
    if (current.id === figma.currentPage.id) return true
  }
  return false
}

function tree(node: SceneNode, depth: number, includeHidden: boolean, budget: { left: number }): TreeNode | null {
  if (budget.left <= 0) return null
  if (!includeHidden && !node.visible) return null
  budget.left--

  const entry: TreeNode = summarize(node)
  if (depth > 1 && 'children' in node && node.children.length > 0) {
    const children: TreeNode[] = []
    for (const child of node.children) {
      const built = tree(child, depth - 1, includeHidden, budget)
      if (built) children.push(built)
    }
    if (children.length > 0) entry.children = children
  }
  return entry
}


/**
 * Where a newly created layer goes: inside `parentId` when one is given, on the
 * current page otherwise. Position is set after appending, so x/y always mean
 * "relative to the parent" — which is what a caller laying out a frame expects.
 */
async function place(node: SceneNode, params: Params): Promise<void> {
  const parentId = str(params, 'parentId')
  if (parentId) {
    const parent = await figma.getNodeByIdAsync(parentId)
    if (!parent) throw new Error(`No layer with id ${parentId}.`)
    if (!('appendChild' in parent)) throw new Error(`"${parent.name}" cannot hold children.`)
    ;(parent as ChildrenMixin & BaseNode).appendChild(node)
  } else {
    figma.currentPage.appendChild(node)
  }

  if ('x' in params) node.x = num(params, 'x', 0)
  if ('y' in params) node.y = num(params, 'y', 0)
  if (typeof params.name === 'string') node.name = params.name
}

function paint(params: Params, key: string): SolidPaint[] | null {
  const hex = str(params, key)
  return hex ? [{ type: 'SOLID', color: hexToRgb(hex) }] : null
}

function created(node: SceneNode): NodeSummary & { parentId: string } {
  return { ...summarize(node), parentId: node.parent?.id ?? '' }
}

function bytesOf(params: Params): Uint8Array {
  const value = params.bytes
  if (value instanceof Uint8Array) return value
  // postMessage sometimes hands the sandbox a plain array-like clone.
  if (Array.isArray(value)) return Uint8Array.from(value as number[])
  if (value && typeof value === 'object' && 'length' in (value as ArrayLike<number>)) {
    return Uint8Array.from(value as ArrayLike<number>)
  }
  throw new Error('The image bytes did not survive the trip to Figma.')
}

const handlers: Record<string, Handler> = {
  status: () => ({
    document: figma.root.name,
    page: figma.currentPage.name,
    selection: selectionState(),
  }),

  get_selection: () => selectionState(),

  get_page: (params) => {
    const depth = Math.round(num(params, 'depth', 3))
    const includeHidden = bool(params, 'includeHidden')
    const budget = { left: MAX_TREE_NODES }
    const nodes: TreeNode[] = []
    for (const child of figma.currentPage.children) {
      const built = tree(child, depth, includeHidden, budget)
      if (built) nodes.push(built)
    }
    return {
      document: figma.root.name,
      page: figma.currentPage.name,
      nodes,
      truncated: budget.left <= 0,
    }
  },

  find_nodes: (params) => {
    const name = str(params, 'name').toLowerCase()
    const type = str(params, 'type').toUpperCase()
    const limit = Math.min(MAX_FIND_RESULTS, Math.round(num(params, 'limit', 100)))

    const matches: NodeSummary[] = []
    for (const root of figma.currentPage.children) {
      walk(root, (node) => {
        if (matches.length >= limit) return
        if (name && !node.name.toLowerCase().includes(name)) return
        if (type && node.type !== type) return
        matches.push(summarize(node))
      })
      if (matches.length >= limit) break
    }
    return { matches, truncated: matches.length >= limit }
  },

  get_design_spec: async (params) => {
    await focus(params)
    return selectionToMarkdown()
  },

  list_frames: () => motion.listFrames(),

  set_selection: async (params) => {
    await focus({ nodeIds: ids(params) ?? [] })
    const selection = figma.currentPage.selection
    if (bool(params, 'zoom') && selection.length > 0) {
      figma.viewport.scrollAndZoomIntoView(selection as SceneNode[])
    }
    return `Selected ${selection.length} layer${selection.length === 1 ? '' : 's'}: ${selection
      .map((node) => node.name)
      .join(', ')}`
  },

  notify: (params) => {
    const message = str(params, 'message')
    figma.notify(message, { error: bool(params, 'error') })
    return `Shown in Figma: ${message}`
  },

  rename: async (params) => {
    await focus(params)
    return design.rename(str(params, 'pattern'))
  },

  set_color: async (params) => {
    await focus(params)
    const target = str(params, 'target', 'fill') === 'stroke' ? 'stroke' : 'fill'
    return design.setColor(str(params, 'hex'), target)
  },

  set_opacity: async (params) => {
    await focus(params)
    return design.setOpacity(num(params, 'value', 1))
  },

  set_corner_radius: async (params) => {
    await focus(params)
    return design.setCornerRadius(num(params, 'value', 0))
  },

  set_auto_layout: async (params) => {
    await focus(params)
    const direction = str(params, 'direction', 'VERTICAL') === 'HORIZONTAL' ? 'HORIZONTAL' : 'VERTICAL'
    return design.applyAutoLayout(direction, num(params, 'gap', 0), num(params, 'padding', 0))
  },

  replace_text: async (params) => {
    await focus(params)
    return design.replaceText(str(params, 'find'), str(params, 'replace'), bool(params, 'matchCase'))
  },

  select_similar: async (params) => {
    await focus(params)
    return design.selectSimilar()
  },

  export: async (params) => {
    await focus(params)
    const targets = (ids(params) ?? figma.currentPage.selection.map((node) => node.id)).filter(Boolean)
    if (targets.length === 0) throw new Error('Select something to export, or pass nodeIds.')

    const scales = Array.isArray(params.scales)
      ? (params.scales as unknown[]).filter((value): value is number => typeof value === 'number' && value > 0)
      : [2]

    const files = await assets.exportAssets({
      nodeIds: targets,
      format: (str(params, 'format', 'PNG').toUpperCase() as ExportFormat) ?? 'PNG',
      scales: scales.length > 0 ? scales : [2],
      suffixScales: true,
    })

    return {
      files: files.map((file) => ({
        name: file.name,
        mime: file.mime,
        base64: figma.base64Encode(file.bytes),
      })),
    }
  },

  create_frame: async (params) => {
    const frame = figma.createFrame()
    frame.name = str(params, 'name', 'Frame')
    frame.resize(Math.max(1, num(params, 'width', 400)), Math.max(1, num(params, 'height', 300)))

    const fill = paint(params, 'fill')
    frame.fills = fill ?? [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]
    if ('cornerRadius' in params) frame.cornerRadius = num(params, 'cornerRadius', 0)

    const direction = str(params, 'layout').toUpperCase()
    if (direction === 'HORIZONTAL' || direction === 'VERTICAL') {
      frame.layoutMode = direction
      frame.itemSpacing = num(params, 'gap', 0)
      const padding = num(params, 'padding', 0)
      frame.paddingLeft = padding
      frame.paddingRight = padding
      frame.paddingTop = padding
      frame.paddingBottom = padding
      // An explicit size is a request, so only grow on the axis left unset.
      frame.primaryAxisSizingMode = 'FIXED'
      frame.counterAxisSizingMode = 'FIXED'
    }

    await place(frame, params)
    return created(frame)
  },

  create_text: async (params) => {
    const family = str(params, 'fontFamily', 'Inter')
    const style = str(params, 'fontStyle', 'Regular')
    try {
      await figma.loadFontAsync({ family, style })
    } catch {
      throw new Error(`Figma has no "${family} ${style}". Try a font already used in this document.`)
    }

    const text = figma.createText()
    text.fontName = { family, style }
    text.fontSize = Math.max(1, num(params, 'fontSize', 16))
    text.characters = str(params, 'characters')

    const width = num(params, 'width', 0)
    if (width > 0) {
      // Auto height only makes sense once the width is pinned.
      text.textAutoResize = 'HEIGHT'
      text.resize(width, text.height)
    }

    if ('lineHeight' in params) text.lineHeight = { value: num(params, 'lineHeight', 140), unit: 'PERCENT' }
    const align = str(params, 'align').toUpperCase()
    if (align === 'LEFT' || align === 'CENTER' || align === 'RIGHT' || align === 'JUSTIFIED') {
      text.textAlignHorizontal = align
    }

    const fill = paint(params, 'color')
    if (fill) text.fills = fill

    await place(text, { name: str(params, 'characters').slice(0, 40) || 'Text', ...params })
    return created(text)
  },

  create_rectangle: async (params) => {
    const rect = figma.createRectangle()
    rect.name = str(params, 'name', 'Rectangle')
    rect.resize(Math.max(1, num(params, 'width', 100)), Math.max(1, num(params, 'height', 100)))
    const fill = paint(params, 'fill')
    if (fill) rect.fills = fill
    if ('cornerRadius' in params) rect.cornerRadius = num(params, 'cornerRadius', 0)
    await place(rect, params)
    return created(rect)
  },

  place_image: async (params) => {
    const image = figma.createImage(bytesOf(params))
    const size = await image.getSizeAsync()
    if (size.width > MAX_IMAGE_SIZE || size.height > MAX_IMAGE_SIZE) {
      throw new Error(`Figma caps images at ${MAX_IMAGE_SIZE}px; this one is ${size.width}×${size.height}.`)
    }

    // Given only one dimension, the other follows the image's own proportions.
    let width = num(params, 'width', 0)
    let height = num(params, 'height', 0)
    if (width <= 0 && height <= 0) {
      width = size.width
      height = size.height
    } else if (width <= 0) {
      width = (height * size.width) / size.height
    } else if (height <= 0) {
      height = (width * size.height) / size.width
    }

    const scaleMode = str(params, 'scaleMode', 'FILL').toUpperCase()
    const rect = figma.createRectangle()
    rect.name = str(params, 'name', 'Image')
    rect.resize(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)))
    rect.fills = [
      {
        type: 'IMAGE',
        imageHash: image.hash,
        scaleMode: scaleMode === 'FIT' || scaleMode === 'CROP' || scaleMode === 'TILE' ? scaleMode : 'FILL',
      },
    ]
    if ('cornerRadius' in params) rect.cornerRadius = num(params, 'cornerRadius', 0)

    await place(rect, params)
    return { ...created(rect), sourceWidth: size.width, sourceHeight: size.height }
  },

  set_text: async (params) => {
    const [node] = await nodesById([str(params, 'nodeId')])
    if (node.type !== 'TEXT') throw new Error(`"${node.name}" is a ${node.type.toLowerCase()}, not a text layer.`)
    await loadFontsFor(node)
    node.characters = str(params, 'characters')
    return `Set the text of "${node.name}"`
  },

  delete_nodes: async (params) => {
    const nodes = await nodesById(ids(params) ?? [])
    const names = nodes.map((node) => node.name)
    for (const node of nodes) node.remove()
    return `Deleted ${names.length} layer${names.length === 1 ? '' : 's'}: ${names.join(', ')}`
  },

  prototype_steps: (params) => motion.sequenceFromPrototype(str(params, 'frameId')),

  resolve_frames: async (params) => {
    const list = ids(params, 'frameIds') ?? []
    const nodes = await nodesById(list)
    return nodes.map(summarize)
  },
}

/** Runs one bridge command and answers it exactly once. */
export async function handleRpc(request: RpcRequest): Promise<void> {
  const handler = handlers[request.command]
  if (!handler) {
    post({ type: 'rpc:result', response: { id: request.id, ok: false, error: `Unknown command "${request.command}".` } })
    return
  }
  try {
    const result = await handler(request.params ?? {})
    post({ type: 'rpc:result', response: { id: request.id, ok: true, result } })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    post({ type: 'rpc:result', response: { id: request.id, ok: false, error: message } })
  }
}
