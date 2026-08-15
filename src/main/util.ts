import type { MainToUi, NodeSummary, SelectionState } from '../shared/types'

export function post(message: MainToUi): void {
  figma.ui.postMessage(message)
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

/** Reports a failure to both the UI panel and Figma's own toast. */
export function fail(err: unknown): void {
  const message = errorMessage(err)
  post({ type: 'error', message })
  figma.notify(message, { error: true })
}

export function summarize(node: SceneNode): NodeSummary {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    width: 'width' in node ? Math.round(node.width) : 0,
    height: 'height' in node ? Math.round(node.height) : 0,
    visible: node.visible,
    hasExportSettings: 'exportSettings' in node && node.exportSettings.length > 0,
    childCount: 'children' in node ? node.children.length : 0,
  }
}

export function selectionState(): SelectionState {
  return {
    pageName: figma.currentPage.name,
    nodes: figma.currentPage.selection.map(summarize),
  }
}

export type FrameLike = FrameNode | ComponentNode | ComponentSetNode | InstanceNode | SectionNode

export function isFrameLike(node: BaseNode): node is FrameLike {
  return (
    node.type === 'FRAME' ||
    node.type === 'COMPONENT' ||
    node.type === 'COMPONENT_SET' ||
    node.type === 'INSTANCE' ||
    node.type === 'SECTION'
  )
}

/** Nodes that can be rendered on their own — i.e. everything `exportAsync` accepts. */
export function isExportable(node: BaseNode): node is SceneNode {
  return 'exportAsync' in node && node.type !== 'PAGE'
}

export function hexToRgb(hex: string): RGB {
  const clean = hex.trim().replace(/^#/, '')
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`"${hex}" is not a valid hex colour`)
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255,
  }
}

export function rgbToHex(color: RGB): string {
  const part = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0')
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`
}

/** Loads every font used by a text node so its characters can be edited. */
export async function loadFontsFor(node: TextNode): Promise<void> {
  const length = node.characters.length
  if (length === 0) {
    // `getRangeAllFontNames` rejects an empty range, so fall back to the node font.
    const font = node.fontName
    if (font !== figma.mixed) await figma.loadFontAsync(font)
    return
  }
  const fonts = node.getRangeAllFontNames(0, length)
  await Promise.all(fonts.map((font) => figma.loadFontAsync(font)))
}

export function walk(node: SceneNode, visit: (node: SceneNode) => void): void {
  visit(node)
  if ('children' in node) {
    for (const child of node.children) walk(child, visit)
  }
}

/** Yields to Figma's event loop so long jobs keep the editor responsive. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'untitled'
  )
}
