import type { MainToUi } from '../shared/types'
import { clear, formatBytes, h } from './dom'
import { copyText, mountDownloads, offerDownload } from './download'
import { FrameStore } from './encode/frames'
import { makeZip } from './encode/zip'
import { renderStore } from './render-store'
import { notify, send, state, subscribe, update, type Tab } from './state'
import { createAssetsView } from './views/assets'
import { createDesignView, type View } from './views/design'
import { createMotionView, exportRenderedFrames } from './views/motion'

const views: Record<Tab, View> = {
  design: createDesignView(),
  assets: createAssetsView(),
  motion: createMotionView(),
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'design', label: 'Design' },
  { id: 'assets', label: 'Assets' },
  { id: 'motion', label: 'Motion' },
]

const tabBar = h('nav', { class: 'tabs' })
const tabButtons = new Map<Tab, HTMLButtonElement>()
for (const tab of TABS) {
  const element = h('button', { class: 'tab', text: tab.label, onclick: () => update({ tab: tab.id }) })
  tabButtons.set(tab.id, element)
  tabBar.append(element)
}

const banner = h('div', { class: 'banner hidden' })
const bannerText = h('span', { class: 'grow' })
banner.append(
  bannerText,
  h('button', { class: 'btn btn-ghost tiny', text: '✕', onclick: () => update({ message: null }) }),
)

const viewport = h('main', { class: 'viewport' })
const downloads = h('div', { class: 'downloads empty' })

document.body.append(
  h('div', { class: 'app' }, tabBar, banner, viewport, h('div', { class: 'downloads-wrap' }, h('span', { class: 'downloads-title', text: 'Downloads' }), downloads)),
)
mountDownloads(downloads)

function render(): void {
  for (const [id, element] of tabButtons) element.classList.toggle('active', id === state.tab)

  const active = views[state.tab]
  if (viewport.firstChild !== active.element) {
    clear(viewport)
    viewport.append(active.element)
  }
  active.update()

  const message = state.message
  banner.classList.toggle('hidden', message === null)
  banner.classList.toggle('error', message?.tone === 'error')
  bannerText.textContent = message?.text ?? ''
}

subscribe(render)

/* ------------------------------------------------------- message routing */

window.onmessage = (event: MessageEvent) => {
  const message = event.data?.pluginMessage as MainToUi | undefined
  if (!message) return
  handle(message)
}

function handle(message: MainToUi): void {
  switch (message.type) {
    case 'selection':
      update({ selection: message.state })
      break

    case 'assets:list': {
      const ids = new Set(message.nodes.map((node) => node.id))
      // Drop selections for layers that no longer exist, keep the rest.
      const selection = new Set([...state.assetSelection].filter((id) => ids.has(id)))
      if (selection.size === 0) message.nodes.forEach((node) => selection.add(node.id))
      update({ assets: message.nodes, assetSelection: selection })
      break
    }

    case 'assets:progress':
      update({ assetProgress: { done: message.done, total: message.total } })
      break

    case 'assets:done': {
      const files = message.files
      if (files.length === 1) {
        offerDownload(files[0].bytes, files[0].name, files[0].mime)
      } else {
        const stamp = new Date().toISOString().slice(0, 10)
        offerDownload(makeZip(files), `figma-assets-${stamp}.zip`, 'application/zip')
      }
      const total = files.reduce((sum, file) => sum + file.bytes.length, 0)
      notify(`Exported ${files.length} file${files.length === 1 ? '' : 's'} (${formatBytes(total)}).`)
      update({ assetProgress: null })
      break
    }

    case 'motion:frames': {
      const stageFrameId =
        state.stageFrameId && message.frames.some((frame) => frame.id === state.stageFrameId)
          ? state.stageFrameId
          : (message.frames[0]?.id ?? '')
      update({ frames: message.frames, stageFrameId })
      if (stageFrameId && state.layers.length === 0) send({ type: 'motion:listLayers', frameId: stageFrameId })
      break
    }

    case 'motion:layers':
      update({ layers: message.layers })
      break

    case 'motion:sequence':
      update({ steps: message.steps })
      notify(`Built a ${message.steps.length}-frame sequence from the prototype.`)
      break

    case 'motion:renderStart':
      renderStore.store = new FrameStore(message.width, message.height)
      update({ progress: { stage: 'rendering', done: 0, total: message.total } })
      break

    case 'motion:frame':
      renderStore.store?.add(message.bytes)
      update({ progress: { stage: 'rendering', done: message.index + 1, total: message.total } })
      break

    case 'motion:renderDone':
      update({ progress: null })
      if (message.cancelled) {
        const count = renderStore.store?.count ?? 0
        notify(count > 0 ? `Render cancelled after ${count} frames.` : 'Render cancelled.')
      } else {
        void exportRenderedFrames()
      }
      break

    case 'clipboard':
      void copyText(message.text).then((copied) => {
        notify(
          copied
            ? `${message.label} copied — paste it into a chat with Claude.`
            : 'Could not reach the clipboard. Check the browser console for the text.',
          copied ? 'info' : 'error',
        )
        if (!copied) console.log(message.text)
      })
      break

    case 'busy':
      update({ busy: message.busy ? (message.label ?? 'Working…') : null })
      break

    case 'error':
      notify(message.message, 'error')
      break
  }
}

send({ type: 'ui:ready' })
send({ type: 'assets:scan' })
render()
