import { button, field, h, numberInput, row, select } from '../dom'
import { send, state } from '../state'

export interface View {
  element: HTMLElement
  update(): void
}

export function createDesignView(): View {
  const summary = h('p', { class: 'summary' })

  /* --- naming --- */
  const namePattern = h('input', {
    class: 'input',
    type: 'text',
    value: 'Layer {n}',
    placeholder: 'Icon/{name}-{n}',
  })

  const naming = section(
    'Rename',
    field('Pattern', namePattern, 'Tokens: {n} {name} {type} {w} {h}'),
    row(button('Rename selection', () => send({ type: 'design:rename', pattern: namePattern.value }), 'primary')),
  )

  /* --- colour --- */
  const colorPicker = h('input', { class: 'color', type: 'color', value: '#4c6ef5' })
  const colorHex = h('input', { class: 'input', type: 'text', value: '#4c6ef5' })
  colorPicker.addEventListener('input', () => {
    colorHex.value = colorPicker.value
  })
  colorHex.addEventListener('change', () => {
    if (/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(colorHex.value.trim())) {
      colorPicker.value = normalizeHex(colorHex.value)
    }
  })

  const colour = section(
    'Colour',
    row(colorPicker, colorHex),
    row(
      button('Set fill', () => send({ type: 'design:fill', hex: colorHex.value, target: 'fill' }), 'primary'),
      button('Set stroke', () => send({ type: 'design:fill', hex: colorHex.value, target: 'stroke' })),
    ),
  )

  /* --- geometry --- */
  const opacity = h('input', { class: 'slider', type: 'range', min: 0, max: 100, value: 100 })
  const opacityValue = h('span', { class: 'slider-value', text: '100%' })
  opacity.addEventListener('input', () => {
    opacityValue.textContent = `${opacity.value}%`
  })
  opacity.addEventListener('change', () =>
    send({ type: 'design:opacity', value: Number(opacity.value) / 100 }),
  )

  const radius = numberInput(8, 0, 999)
  const geometry = section(
    'Appearance',
    field('Opacity', row(opacity, opacityValue)),
    field('Corner radius', row(radius, button('Apply', () => send({ type: 'design:corner', value: Number(radius.value) })))),
  )

  /* --- auto layout --- */
  const direction = select(
    [
      { value: 'VERTICAL', label: 'Vertical' },
      { value: 'HORIZONTAL', label: 'Horizontal' },
    ],
    'VERTICAL',
  )
  const gap = numberInput(16, 0, 400)
  const padding = numberInput(16, 0, 400)
  const layout = section(
    'Auto layout',
    row(field('Direction', direction), field('Gap', gap), field('Padding', padding)),
    row(
      button(
        'Apply auto layout',
        () =>
          send({
            type: 'design:autoLayout',
            direction: direction.value as 'HORIZONTAL' | 'VERTICAL',
            gap: Number(gap.value),
            padding: Number(padding.value),
          }),
        'primary',
      ),
    ),
  )

  /* --- text --- */
  const findInput = h('input', { class: 'input', type: 'text', placeholder: 'Find' })
  const replaceInput = h('input', { class: 'input', type: 'text', placeholder: 'Replace with' })
  const matchCase = h('input', { type: 'checkbox' })
  const text = section(
    'Find & replace text',
    row(findInput, replaceInput),
    row(
      h('label', { class: 'check' }, matchCase, h('span', { text: 'Match case' })),
      button(
        'Replace',
        () =>
          send({
            type: 'design:replaceText',
            find: findInput.value,
            replace: replaceInput.value,
            matchCase: matchCase.checked,
          }),
        'primary',
      ),
    ),
  )

  /* --- handoff --- */
  const handoff = section(
    'Handoff',
    h('p', {
      class: 'hint',
      text: 'Copies the selected layers as a Markdown spec — sizes, colours, type and layout — ready to paste into a chat with Claude.',
    }),
    row(
      button('Copy design spec', () => send({ type: 'design:copyForClaude' }), 'primary'),
      button('Select similar layers', () => send({ type: 'design:selectSimilar' })),
    ),
  )

  const element = h('div', { class: 'view' }, summary, naming, colour, geometry, layout, text, handoff)

  return {
    element,
    update() {
      const { nodes, pageName } = state.selection
      if (nodes.length === 0) {
        summary.textContent = `Nothing selected on “${pageName}”. Pick some layers in the canvas.`
        summary.classList.add('muted')
        return
      }
      summary.classList.remove('muted')
      const kinds = new Set(nodes.map((node) => node.type.toLowerCase()))
      const first = nodes[0]
      summary.textContent =
        nodes.length === 1
          ? `Selected: ${first.name} — ${first.type.toLowerCase()}, ${first.width}×${first.height}`
          : `Selected ${nodes.length} layers (${[...kinds].join(', ')})`
    },
  }
}

export function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return h('section', { class: 'card' }, h('h2', { class: 'card-title', text: title }), ...children)
}

function normalizeHex(value: string): string {
  const clean = value.trim().replace(/^#/, '')
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((char) => char + char)
          .join('')
      : clean
  return `#${full.toLowerCase()}`
}
