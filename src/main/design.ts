import { hexToRgb, loadFontsFor, walk } from './util'

function selection(): readonly SceneNode[] {
  const nodes = figma.currentPage.selection
  if (nodes.length === 0) throw new Error('Select at least one layer first.')
  return nodes
}

/**
 * Renames every selected layer. Supported tokens: `{n}` (1-based index),
 * `{name}`, `{type}`, `{w}`, `{h}`. `{n}` is zero-padded to the width of the
 * largest index so names sort correctly.
 */
export function rename(pattern: string): string {
  const nodes = selection()
  if (!pattern.trim()) throw new Error('Enter a name pattern.')
  const pad = String(nodes.length).length

  nodes.forEach((node, index) => {
    node.name = pattern
      .replace(/\{n\}/g, String(index + 1).padStart(pad, '0'))
      .replace(/\{name\}/g, node.name)
      .replace(/\{type\}/g, node.type.toLowerCase())
      .replace(/\{w\}/g, 'width' in node ? String(Math.round(node.width)) : '0')
      .replace(/\{h\}/g, 'height' in node ? String(Math.round(node.height)) : '0')
  })
  return `Renamed ${nodes.length} layer${nodes.length === 1 ? '' : 's'}`
}

export function setColor(hex: string, target: 'fill' | 'stroke'): string {
  const color = hexToRgb(hex)
  const nodes = selection()
  let changed = 0

  for (const node of nodes) {
    if (target === 'fill') {
      if (!('fills' in node)) continue
      const fills = node.fills
      const existing = fills !== figma.mixed && Array.isArray(fills) ? fills : []
      // Keep the first paint's opacity and blend mode so only the hue changes.
      const base = existing.find((paint) => paint.type === 'SOLID') as SolidPaint | undefined
      node.fills = [{ type: 'SOLID', color, opacity: base?.opacity ?? 1 }]
      changed++
    } else {
      if (!('strokes' in node)) continue
      const base = node.strokes.find((paint) => paint.type === 'SOLID') as SolidPaint | undefined
      node.strokes = [{ type: 'SOLID', color, opacity: base?.opacity ?? 1 }]
      if ('strokeWeight' in node && node.strokeWeight === 0) node.strokeWeight = 1
      changed++
    }
  }
  if (changed === 0) throw new Error(`Nothing in the selection accepts a ${target}.`)
  return `Set ${target} on ${changed} layer${changed === 1 ? '' : 's'}`
}

export function setOpacity(value: number): string {
  const nodes = selection()
  const clamped = Math.max(0, Math.min(1, value))
  let changed = 0
  for (const node of nodes) {
    if (!('opacity' in node)) continue
    node.opacity = clamped
    changed++
  }
  return `Set opacity to ${Math.round(clamped * 100)}% on ${changed} layer${changed === 1 ? '' : 's'}`
}

export function setCornerRadius(value: number): string {
  const nodes = selection()
  const radius = Math.max(0, value)
  let changed = 0
  for (const node of nodes) {
    if (!('cornerRadius' in node)) continue
    try {
      ;(node as { cornerRadius: number }).cornerRadius = radius
      changed++
    } catch {
      /* node does not support a uniform radius */
    }
  }
  if (changed === 0) throw new Error('Nothing in the selection has corner radii.')
  return `Set radius to ${radius} on ${changed} layer${changed === 1 ? '' : 's'}`
}

export function applyAutoLayout(direction: 'HORIZONTAL' | 'VERTICAL', gap: number, padding: number): string {
  const nodes = selection()
  let changed = 0
  for (const node of nodes) {
    if (!('layoutMode' in node)) continue
    try {
      const frame = node as FrameNode
      frame.layoutMode = direction
      frame.itemSpacing = Math.max(0, gap)
      frame.paddingLeft = padding
      frame.paddingRight = padding
      frame.paddingTop = padding
      frame.paddingBottom = padding
      frame.primaryAxisSizingMode = 'AUTO'
      frame.counterAxisSizingMode = 'AUTO'
      changed++
    } catch {
      /* instances refuse layout changes */
    }
  }
  if (changed === 0) throw new Error('Select a frame, component or group to apply auto layout.')
  return `Applied auto layout to ${changed} frame${changed === 1 ? '' : 's'}`
}

export async function replaceText(find: string, replace: string, matchCase: boolean): Promise<string> {
  if (!find) throw new Error('Enter the text to find.')
  const nodes = selection()

  const texts: TextNode[] = []
  for (const node of nodes) {
    walk(node, (child) => {
      if (child.type === 'TEXT') texts.push(child)
    })
  }
  if (texts.length === 0) throw new Error('No text layers in the selection.')

  const pattern = new RegExp(escapeRegExp(find), matchCase ? 'g' : 'gi')
  let changed = 0

  for (const text of texts) {
    const before = text.characters
    const after = before.replace(pattern, replace)
    if (after === before) continue
    // Setting `characters` requires every font used by the node to be loaded.
    await loadFontsFor(text)
    text.characters = after
    changed++
  }
  if (changed === 0) throw new Error(`No text layer contains "${find}".`)
  return `Updated ${changed} text layer${changed === 1 ? '' : 's'}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Selects every layer on the page sharing the type and size of the current selection. */
export function selectSimilar(): string {
  const nodes = selection()
  const signatures = new Set(
    nodes.map((node) => `${node.type}:${Math.round('width' in node ? node.width : 0)}x${Math.round('height' in node ? node.height : 0)}`),
  )

  const matches: SceneNode[] = []
  for (const root of figma.currentPage.children) {
    walk(root, (node) => {
      const signature = `${node.type}:${Math.round('width' in node ? node.width : 0)}x${Math.round('height' in node ? node.height : 0)}`
      if (signatures.has(signature)) matches.push(node)
    })
  }

  figma.currentPage.selection = matches
  return `Selected ${matches.length} similar layer${matches.length === 1 ? '' : 's'}`
}
