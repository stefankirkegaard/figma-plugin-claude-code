type Child = Node | string | null | undefined | false

interface Props {
  class?: string
  text?: string
  html?: string
  title?: string
  type?: string
  value?: string | number
  placeholder?: string
  min?: string | number
  max?: string | number
  step?: string | number
  checked?: boolean
  disabled?: boolean
  selected?: boolean
  onclick?: (event: MouseEvent) => void
  onchange?: (event: Event) => void
  oninput?: (event: Event) => void
  dataset?: Record<string, string>
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  const { class: className, text, html, dataset, onclick, onchange, oninput, ...rest } = props

  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  if (html !== undefined) element.innerHTML = html
  if (onclick) element.addEventListener('click', onclick as EventListener)
  if (onchange) element.addEventListener('change', onchange)
  if (oninput) element.addEventListener('input', oninput)
  if (dataset) for (const [key, value] of Object.entries(dataset)) element.dataset[key] = value

  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined || value === false) continue
    if (key in element) (element as unknown as Record<string, unknown>)[key] = value
    else element.setAttribute(key, String(value))
  }

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    element.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return element
}

export function clear(element: HTMLElement): void {
  while (element.firstChild) element.removeChild(element.firstChild)
}

export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), control, hint ? h('span', { class: 'hint', text: hint }) : null)
}

export function row(...children: Child[]): HTMLElement {
  return h('div', { class: 'row' }, ...children)
}

export function button(label: string, onclick: () => void, variant: 'primary' | 'secondary' | 'ghost' = 'secondary'): HTMLButtonElement {
  return h('button', { class: `btn btn-${variant}`, text: label, onclick })
}

export function numberInput(value: number, min: number, max: number, step = 1): HTMLInputElement {
  return h('input', { class: 'input', type: 'number', value, min, max, step })
}

export function select(options: { value: string; label: string }[], value?: string): HTMLSelectElement {
  const element = h('select', { class: 'input' })
  for (const option of options) {
    element.append(h('option', { value: option.value, text: option.label, selected: option.value === value }))
  }
  if (value !== undefined) element.value = value
  return element
}

/**
 * TypeScript 5.7 types `Uint8Array` over `ArrayBufferLike`, which `BlobPart`
 * rejects because it could in principle be a `SharedArrayBuffer`. Nothing here
 * ever produces one, and `Blob` copies the bytes anyway — so this cast avoids
 * an otherwise pointless duplicate of every exported file.
 */
export function asBlobPart(bytes: Uint8Array): BlobPart {
  return bytes as unknown as BlobPart
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
