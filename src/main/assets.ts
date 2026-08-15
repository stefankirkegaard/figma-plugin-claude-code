import type { ExportedFile, ExportRequest, NodeSummary } from '../shared/types'
import { isExportable, post, sanitizeFilename, summarize, tick, walk } from './util'

const MIME: Record<ExportRequest['format'], string> = {
  PNG: 'image/png',
  JPG: 'image/jpeg',
  SVG: 'image/svg+xml',
  PDF: 'application/pdf',
}

const EXTENSION: Record<ExportRequest['format'], string> = {
  PNG: 'png',
  JPG: 'jpg',
  SVG: 'svg',
  PDF: 'pdf',
}

/**
 * Candidate assets: the selection when there is one, otherwise every top-level
 * layer on the page. Layers that already carry export settings are listed first
 * so an existing export set-up is easy to re-run.
 */
export function scan(): NodeSummary[] {
  const selection = figma.currentPage.selection
  const roots: readonly SceneNode[] = selection.length > 0 ? selection : figma.currentPage.children

  const found: SceneNode[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    if (isExportable(root) && !seen.has(root.id)) {
      seen.add(root.id)
      found.push(root)
    }
    // Nested layers with explicit export settings are usually the real assets.
    walk(root, (node) => {
      if (node.id === root.id || seen.has(node.id)) return
      if ('exportSettings' in node && node.exportSettings.length > 0) {
        seen.add(node.id)
        found.push(node)
      }
    })
  }

  return found
    .map(summarize)
    .sort((a, b) => Number(b.hasExportSettings) - Number(a.hasExportSettings))
}

export async function exportAssets(request: ExportRequest): Promise<ExportedFile[]> {
  if (request.nodeIds.length === 0) throw new Error('Pick at least one layer to export.')

  const vector = request.format === 'SVG' || request.format === 'PDF'
  const scales = vector ? [1] : dedupe(request.scales.filter((scale) => scale > 0)).sort((a, b) => a - b)
  if (scales.length === 0) throw new Error('Pick at least one scale.')

  const files: ExportedFile[] = []
  const used = new Set<string>()
  const total = request.nodeIds.length

  for (let index = 0; index < total; index++) {
    const node = await figma.getNodeByIdAsync(request.nodeIds[index])
    if (!node || !isExportable(node)) continue

    for (const scale of scales) {
      const settings = exportSettings(request.format, scale)
      const bytes = await node.exportAsync(settings)
      const suffix = !vector && (request.suffixScales || scales.length > 1) && scale !== 1 ? `@${scale}x` : ''
      const name = uniqueName(used, `${sanitizeFilename(node.name)}${suffix}.${EXTENSION[request.format]}`)
      files.push({ name, bytes, mime: MIME[request.format] })
    }

    post({ type: 'assets:progress', done: index + 1, total })
    await tick()
  }

  if (files.length === 0) throw new Error('None of the chosen layers could be exported.')
  return files
}

function exportSettings(format: ExportRequest['format'], scale: number): ExportSettings {
  switch (format) {
    case 'SVG':
      return { format: 'SVG' }
    case 'PDF':
      return { format: 'PDF' }
    default:
      return { format, constraint: { type: 'SCALE', value: scale } }
  }
}

function dedupe(values: number[]): number[] {
  return [...new Set(values)]
}

function uniqueName(used: Set<string>, name: string): string {
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  const dot = name.lastIndexOf('.')
  const stem = dot === -1 ? name : name.slice(0, dot)
  const extension = dot === -1 ? '' : name.slice(dot)
  for (let counter = 2; ; counter++) {
    const candidate = `${stem}-${counter}${extension}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
}
