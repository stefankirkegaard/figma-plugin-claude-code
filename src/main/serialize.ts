import { rgbToHex } from './util'

const MAX_NODES = 400
const MAX_DEPTH = 8

/**
 * Describes the selection as Markdown: a layer tree annotated with geometry,
 * colour, type and layout. It is meant to be pasted into a chat with Claude as
 * context for building the design, so it favours the properties that matter for
 * implementation over a faithful dump of the document.
 */
export function selectionToMarkdown(): string {
  const selection = figma.currentPage.selection
  if (selection.length === 0) throw new Error('Select something to describe first.')

  const lines: string[] = []
  lines.push(`# ${figma.root.name} — ${figma.currentPage.name}`)
  lines.push('')

  let budget = MAX_NODES
  for (const node of selection) {
    budget = describe(node, 0, lines, budget)
    lines.push('')
  }

  const colors = collectColors(selection)
  if (colors.length > 0) {
    lines.push('## Colours used')
    for (const [hex, count] of colors) lines.push(`- \`${hex}\` ×${count}`)
    lines.push('')
  }

  const fonts = collectFonts(selection)
  if (fonts.length > 0) {
    lines.push('## Text styles')
    for (const font of fonts) lines.push(`- ${font}`)
    lines.push('')
  }

  if (budget <= 0) lines.push(`_Tree truncated at ${MAX_NODES} layers._`)
  return lines.join('\n')
}

function describe(node: SceneNode, depth: number, lines: string[], budget: number): number {
  if (budget <= 0) return budget
  const indent = '  '.repeat(depth)
  lines.push(`${indent}- **${node.name}** (${node.type.toLowerCase()})${details(node)}`)
  let left = budget - 1

  if ('children' in node && depth < MAX_DEPTH) {
    for (const child of node.children) {
      if (left <= 0) break
      left = describe(child, depth + 1, lines, left)
    }
  }
  return left
}

function details(node: SceneNode): string {
  const parts: string[] = []

  if ('width' in node) parts.push(`${Math.round(node.width)}×${Math.round(node.height)}`)
  if (!node.visible) parts.push('hidden')

  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    const frame = node as FrameNode
    parts.push(`auto layout ${frame.layoutMode.toLowerCase()}, gap ${Math.round(frame.itemSpacing)}`)
    const padding = [frame.paddingTop, frame.paddingRight, frame.paddingBottom, frame.paddingLeft].map(Math.round)
    if (padding.some((value) => value !== 0)) parts.push(`padding ${padding.join(' ')}`)
  }

  const fill = solidHex(node)
  if (fill) parts.push(`fill ${fill}`)

  if ('cornerRadius' in node && typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
    parts.push(`radius ${Math.round(node.cornerRadius)}`)
  }
  if ('opacity' in node && node.opacity < 1) parts.push(`opacity ${Math.round(node.opacity * 100)}%`)
  if ('effects' in node && node.effects.length > 0) {
    parts.push(node.effects.map((effect) => effect.type.toLowerCase().replace(/_/g, ' ')).join(', '))
  }

  if (node.type === 'TEXT') {
    const font = typeof node.fontSize === 'number' ? `${Math.round(node.fontSize)}px` : 'mixed size'
    const family = node.fontName !== figma.mixed ? ` ${node.fontName.family} ${node.fontName.style}` : ''
    parts.push(`${font}${family}`)
    parts.push(`text: ${JSON.stringify(truncate(node.characters, 120))}`)
  }

  return parts.length > 0 ? ` — ${parts.join(', ')}` : ''
}

function solidHex(node: SceneNode): string | null {
  if (!('fills' in node)) return null
  const fills = node.fills
  if (fills === figma.mixed || !Array.isArray(fills)) return null
  const solid = fills.find((paint) => paint.type === 'SOLID' && paint.visible !== false) as SolidPaint | undefined
  return solid ? rgbToHex(solid.color) : null
}

function collectColors(roots: readonly SceneNode[]): [string, number][] {
  const counts = new Map<string, number>()
  let budget = MAX_NODES
  const visit = (node: SceneNode) => {
    if (budget-- <= 0) return
    const hex = solidHex(node)
    if (hex) counts.set(hex, (counts.get(hex) ?? 0) + 1)
    if ('children' in node) node.children.forEach(visit)
  }
  roots.forEach(visit)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24)
}

function collectFonts(roots: readonly SceneNode[]): string[] {
  const fonts = new Set<string>()
  let budget = MAX_NODES
  const visit = (node: SceneNode) => {
    if (budget-- <= 0) return
    if (node.type === 'TEXT' && node.fontName !== figma.mixed) {
      const size = typeof node.fontSize === 'number' ? `${Math.round(node.fontSize)}px` : 'mixed'
      fonts.add(`${node.fontName.family} ${node.fontName.style} — ${size}`)
    }
    if ('children' in node) node.children.forEach(visit)
  }
  roots.forEach(visit)
  return [...fonts].sort().slice(0, 24)
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}
