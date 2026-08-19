import type { ExportFormat, NodeSummary, RpcRequest } from '../shared/types'
import * as assets from './assets'
import * as design from './design'
import * as motion from './motion'
import { selectionToMarkdown } from './serialize'
import { post, selectionState, summarize, walk } from './util'

/** Guard rails so a broad request cannot return a document-sized payload. */
const MAX_TREE_NODES = 2000
const MAX_FIND_RESULTS = 500

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
