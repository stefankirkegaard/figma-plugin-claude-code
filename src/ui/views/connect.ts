import { connectBridge, disconnectBridge } from '../bridge'
import { button, clear, h, row } from '../dom'
import { state, update } from '../state'
import { section, type View } from './design'

const LABELS: Record<string, { text: string; hint: string }> = {
  connected: { text: 'Connected', hint: 'Claude can read and edit this document.' },
  connecting: { text: 'Waiting for Claude…', hint: 'Run Claude Code in the plugin folder — the panel connects on its own.' },
  off: { text: 'Off', hint: 'The bridge is switched off. Claude cannot reach this document.' },
}

export function createConnectView(): View {
  const dot = h('span', { class: 'status-dot' })
  const label = h('span', { class: 'status-label' })
  const hint = h('p', { class: 'hint' })
  const target = h('p', { class: 'summary ellipsis' })
  const error = h('p', { class: 'hint error-text hidden' })

  const port = h('input', { class: 'input', type: 'number', min: 1024, max: 65535, value: state.bridgePort })
  port.addEventListener('change', () => {
    const value = Number(port.value)
    if (!Number.isFinite(value) || value < 1024 || value > 65535) {
      port.value = String(state.bridgePort)
      return
    }
    update({ bridgePort: value })
    disconnectBridge()
    connectBridge()
  })

  const toggle = button('Reconnect', () => {
    if (state.bridgeState === 'off') connectBridge()
    else disconnectBridge()
  })

  const activity = h('ul', { class: 'list activity' })

  const element = h(
    'div',
    { class: 'view' },
    section(
      'Claude',
      row(dot, label),
      hint,
      target,
      error,
      row(h('span', { class: 'field-label grow', text: 'Bridge port' }), port, toggle),
    ),
    section(
      'Recent commands',
      activity,
      h('p', {
        class: 'hint',
        text: 'Everything Claude does here runs through this panel, so it only ever touches the document you have open.',
      }),
    ),
    section(
      'Getting started',
      h('ol', { class: 'steps' },
        h('li', { text: 'Run `claude` in the plugin folder — it starts the bridge for you.' }),
        h('li', { text: 'Keep this panel open while you work.' }),
        h('li', { text: 'Ask Claude for what you want: "read my selection", "export these at 2x", "animate frames A → B as a GIF".' }),
      ),
    ),
  )

  return {
    element,
    update() {
      const status = LABELS[state.bridgeState] ?? LABELS.off
      dot.className = `status-dot ${state.bridgeState}`
      label.textContent = status.text
      hint.textContent = status.hint

      target.textContent =
        state.documentName || state.selection.pageName
          ? `${state.documentName || 'Untitled'} — ${state.selection.pageName}`
          : ''

      error.textContent = state.bridgeError ?? ''
      error.classList.toggle('hidden', !state.bridgeError || state.bridgeState === 'connected')

      toggle.textContent = state.bridgeState === 'off' ? 'Connect' : 'Disconnect'
      if (document.activeElement !== port) port.value = String(state.bridgePort)

      clear(activity)
      if (state.bridgeLog.length === 0) {
        activity.append(h('li', { class: 'list-item dim', text: 'Nothing yet.' }))
      } else {
        for (const line of state.bridgeLog) activity.append(h('li', { class: 'list-item', text: line }))
      }
    },
  }
}
