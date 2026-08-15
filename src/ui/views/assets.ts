import type { ExportFormat } from '../../shared/types'
import { button, clear, h, row, select } from '../dom'
import { notify, send, state, update } from '../state'
import { section, type View } from './design'

const SCALES = [0.5, 1, 2, 3, 4]

export function createAssetsView(): View {
  const list = h('div', { class: 'list' })
  const count = h('span', { class: 'pill' })

  const format = select(
    [
      { value: 'PNG', label: 'PNG' },
      { value: 'JPG', label: 'JPG' },
      { value: 'SVG', label: 'SVG' },
      { value: 'PDF', label: 'PDF' },
    ],
    state.assetFormat,
  )
  format.addEventListener('change', () => update({ assetFormat: format.value as ExportFormat }))

  const scaleRow = h('div', { class: 'row wrap' })
  for (const scale of SCALES) {
    const box = h('input', { type: 'checkbox', checked: state.assetScales.has(scale) })
    box.addEventListener('change', () => {
      if (box.checked) state.assetScales.add(scale)
      else state.assetScales.delete(scale)
      update()
    })
    scaleRow.append(h('label', { class: 'check' }, box, h('span', { text: `${scale}×` })))
  }

  const progress = h('div', { class: 'progress hidden' })
  const progressBar = h('div', { class: 'progress-bar' })
  progress.append(progressBar)

  const exportButton = button(
    'Export selected',
    () => {
      const nodeIds = [...state.assetSelection]
      if (nodeIds.length === 0) {
        notify('Tick at least one layer to export.', 'error')
        return
      }
      send({
        type: 'assets:export',
        request: {
          nodeIds,
          format: state.assetFormat,
          scales: [...state.assetScales],
          suffixScales: true,
        },
      })
    },
    'primary',
  )

  const element = h(
    'div',
    { class: 'view' },
    section(
      'Assets',
      h('p', {
        class: 'hint',
        text: 'Layers in your selection, plus anything with export settings already attached. Exports arrive as a ZIP when there is more than one file.',
      }),
      row(
        button('Rescan page', () => send({ type: 'assets:scan' })),
        button('Select all', () => {
          state.assets.forEach((node) => state.assetSelection.add(node.id))
          update()
        }),
        button('Select none', () => {
          state.assetSelection.clear()
          update()
        }),
        count,
      ),
      list,
    ),
    section('Output', row(h('span', { class: 'field-label', text: 'Format' }), format), scaleRow, progress, row(exportButton)),
  )

  return {
    element,
    update() {
      const vector = state.assetFormat === 'SVG' || state.assetFormat === 'PDF'
      scaleRow.classList.toggle('disabled', vector)
      count.textContent = `${state.assetSelection.size} of ${state.assets.length} selected`

      const busy = state.busy !== null
      exportButton.disabled = busy
      progress.classList.toggle('hidden', !busy)
      const done = state.assetProgress?.done ?? 0
      const total = state.assetProgress?.total ?? 0
      progressBar.style.width = `${total === 0 ? 0 : Math.round((done / total) * 100)}%`

      renderList(list)
    },
  }

  function renderList(container: HTMLElement) {
    clear(container)
    if (state.assets.length === 0) {
      container.append(h('p', { class: 'summary muted', text: 'Nothing scanned yet — select layers and hit Rescan page.' }))
      return
    }
    for (const node of state.assets) {
      const box = h('input', { type: 'checkbox', checked: state.assetSelection.has(node.id) })
      box.addEventListener('change', () => {
        if (box.checked) state.assetSelection.add(node.id)
        else state.assetSelection.delete(node.id)
        update()
      })
      container.append(
        h(
          'div',
          { class: 'list-item' },
          h('label', { class: 'check grow' }, box, h('span', { class: 'ellipsis', text: node.name })),
          node.hasExportSettings ? h('span', { class: 'tag', text: 'export set' }) : null,
          h('span', { class: 'dim', text: `${node.width}×${node.height}` }),
          h('button', {
            class: 'btn btn-ghost tiny',
            text: 'Show',
            onclick: () => send({ type: 'motion:zoomTo', nodeId: node.id }),
          }),
        ),
      )
    }
  }
}
