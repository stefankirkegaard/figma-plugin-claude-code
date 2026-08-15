import { asBlobPart, formatBytes, h } from './dom'

let panel: HTMLElement | null = null

export function mountDownloads(container: HTMLElement): void {
  panel = container
}

/**
 * Hands a finished file to the user.
 *
 * The plugin iframe is sandboxed, so a programmatic `click()` on an anchor is
 * not guaranteed to start a download. Every file therefore also lands in a
 * persistent list of real links, which always works even when the automatic
 * attempt is blocked.
 */
export function offerDownload(bytes: Uint8Array, filename: string, mime: string): void {
  const blob = new Blob([asBlobPart(bytes)], { type: mime })
  const url = URL.createObjectURL(blob)

  const link = h('a', { class: 'download-link', text: filename, title: `Save ${filename}` })
  link.href = url
  link.download = filename

  if (panel) {
    const entry = h(
      'div',
      { class: 'download' },
      link,
      h('span', { class: 'download-size', text: formatBytes(blob.size) }),
    )
    panel.prepend(entry)
    panel.classList.remove('empty')
  }

  try {
    link.click()
  } catch {
    // Blocked by the sandbox — the visible link in the panel is the fallback.
  }
}

export function clearDownloads(): void {
  if (!panel) return
  while (panel.firstChild) panel.removeChild(panel.firstChild)
  panel.classList.add('empty')
}

/** `navigator.clipboard` is often unavailable in the plugin sandbox. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* fall through to the legacy path */
  }

  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  area.remove()
  return copied
}
