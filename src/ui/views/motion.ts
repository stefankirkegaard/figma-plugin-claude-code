import type { Easing, ExportedFile, MotionMode, Track, TrackProp } from '../../shared/types'
import { button, clear, field, formatBytes, h, numberInput, row, select } from '../dom'
import { evenSize, fitWithin, FrameRenderer } from '../encode/frames'
import { encodeGif } from '../encode/gif'
import { encodeVideo, videoEncodingSupported } from '../encode/mp4'
import { makeZip } from '../encode/zip'
import { renderStore } from '../render-store'
import { notify, send, state, update, type OutputFormat } from '../state'
import { section, type View } from './design'

const EASING_OPTIONS: { value: Easing; label: string }[] = [
  { value: 'easeInOut', label: 'Ease in-out' },
  { value: 'easeOut', label: 'Ease out' },
  { value: 'easeIn', label: 'Ease in' },
  { value: 'linear', label: 'Linear' },
  { value: 'easeOutBack', label: 'Overshoot' },
  { value: 'easeOutBounce', label: 'Bounce' },
]

const PROP_OPTIONS: { value: TrackProp; label: string }[] = [
  { value: 'x', label: 'X offset (px)' },
  { value: 'y', label: 'Y offset (px)' },
  { value: 'scale', label: 'Scale (×)' },
  { value: 'rotation', label: 'Rotation (°)' },
  { value: 'opacity', label: 'Opacity (0-1)' },
]

type Preset = 'fadeIn' | 'fadeOut' | 'slideUp' | 'slideIn' | 'popIn' | 'spin' | 'float' | 'pulse'

export function createMotionView(): View {
  /* ------------------------------------------------------------- mode */
  const modeTabs = h('div', { class: 'segmented' })
  const modeButtons: Record<MotionMode, HTMLButtonElement> = {
    sequence: h('button', {
      class: 'segment',
      text: 'Smart animate',
      onclick: () => update({ motionMode: 'sequence' }),
    }),
    timeline: h('button', {
      class: 'segment',
      text: 'Timeline',
      onclick: () => update({ motionMode: 'timeline' }),
    }),
  }
  modeTabs.append(modeButtons.sequence, modeButtons.timeline)

  /* --------------------------------------------------------- sequence */
  const frameList = h('div', { class: 'list' })
  const stepList = h('div', { class: 'list' })

  const sequencePanel = section(
    'Frames',
    h('p', {
      class: 'hint',
      text: 'Add two or more frames. Each hop is tweened the way Smart Animate does it — layers are matched by name, matched layers move, resize and fade between their two states.',
    }),
    row(
      button('Refresh frames', () => send({ type: 'motion:listFrames' })),
      button('Build from prototype', () => {
        const start = state.frames[0]
        const selected = state.selection.nodes[0]
        const frameId = selected && state.frames.some((frame) => frame.id === selected.id) ? selected.id : start?.id
        if (!frameId) {
          notify('No frames on this page to follow.', 'error')
          return
        }
        send({ type: 'motion:sequenceFromPrototype', frameId })
      }),
    ),
    frameList,
    h('h3', { class: 'sub-title', text: 'Sequence' }),
    stepList,
  )

  /* --------------------------------------------------------- timeline */
  const stageSelect = select([], '')
  stageSelect.addEventListener('change', () => {
    update({ stageFrameId: stageSelect.value, tracks: [] })
    send({ type: 'motion:listLayers', frameId: stageSelect.value })
  })

  const durationInput = numberInput(state.duration, 0.1, 120, 0.1)
  durationInput.addEventListener('change', () => update({ duration: Number(durationInput.value) }))

  const layerSelect = select([], '')
  const presetRow = h('div', { class: 'row wrap' })
  for (const [preset, label] of [
    ['fadeIn', 'Fade in'],
    ['fadeOut', 'Fade out'],
    ['slideUp', 'Slide up'],
    ['slideIn', 'Slide in'],
    ['popIn', 'Pop in'],
    ['spin', 'Spin'],
    ['float', 'Float'],
    ['pulse', 'Pulse'],
  ] as [Preset, string][]) {
    presetRow.append(
      h('button', {
        class: 'btn btn-ghost tiny',
        text: label,
        onclick: () => addPreset(preset),
      }),
    )
  }

  const trackList = h('div', { class: 'list' })

  const timelinePanel = section(
    'Timeline',
    h('p', {
      class: 'hint',
      text: 'Animate layers inside one frame. Values are relative to where the layer sits: X/Y are pixel offsets, rotation is in degrees, scale is a multiplier and opacity is absolute.',
    }),
    row(field('Frame', stageSelect), field('Duration (s)', durationInput)),
    row(field('Layer', layerSelect)),
    presetRow,
    trackList,
  )

  /* ----------------------------------------------------------- output */
  const formatSelect = select(
    [
      { value: 'GIF', label: 'Animated GIF' },
      { value: 'MP4', label: 'MP4 video' },
      { value: 'PNG_SEQUENCE', label: 'PNG sequence (ZIP)' },
    ],
    state.outputFormat,
  )
  formatSelect.addEventListener('change', () => update({ outputFormat: formatSelect.value as OutputFormat }))

  const fpsInput = numberInput(state.fps, 1, 60)
  fpsInput.addEventListener('change', () => update({ fps: Number(fpsInput.value) }))

  const scaleSelect = select(
    [
      { value: '0.5', label: '0.5×' },
      { value: '1', label: '1×' },
      { value: '2', label: '2×' },
    ],
    '1',
  )
  scaleSelect.addEventListener('change', () => update({ renderScale: Number(scaleSelect.value) }))

  const maxWidthInput = numberInput(state.maxWidth, 64, 4096, 16)
  maxWidthInput.addEventListener('change', () => update({ maxWidth: Number(maxWidthInput.value) }))

  const transparentBox = h('input', { type: 'checkbox', checked: state.transparent })
  transparentBox.addEventListener('change', () => update({ transparent: transparentBox.checked }))

  const backgroundInput = h('input', { class: 'color', type: 'color', value: state.background })
  backgroundInput.addEventListener('change', () => update({ background: backgroundInput.value }))

  const ditherBox = h('input', { type: 'checkbox', checked: state.dither })
  ditherBox.addEventListener('change', () => update({ dither: ditherBox.checked }))

  const loopBox = h('input', { type: 'checkbox', checked: state.loop })
  loopBox.addEventListener('change', () => update({ loop: loopBox.checked }))

  const unlockBox = h('input', { type: 'checkbox', checked: state.unlockAutoLayout })
  unlockBox.addEventListener('change', () => update({ unlockAutoLayout: unlockBox.checked }))

  const qualityInput = h('input', { class: 'slider', type: 'range', min: 20, max: 100, value: state.quality * 100 })
  qualityInput.addEventListener('change', () => update({ quality: Number(qualityInput.value) / 100 }))

  const gifOptions = row(
    h('label', { class: 'check' }, ditherBox, h('span', { text: 'Dither' })),
    h('label', { class: 'check' }, loopBox, h('span', { text: 'Loop forever' })),
  )
  const videoOptions = field('Quality', qualityInput)

  const progressBar = h('div', { class: 'progress-bar' })
  const progressLabel = h('span', { class: 'dim' })
  const progressWrap = h('div', { class: 'stack hidden' }, h('div', { class: 'progress' }, progressBar), progressLabel)

  const renderButton = button('Render & export', () => startRender(), 'primary')
  const cancelButton = button('Cancel', () => send({ type: 'motion:cancel' }))

  const outputPanel = section(
    'Export',
    row(field('Format', formatSelect), field('Frame rate', fpsInput), field('Render at', scaleSelect)),
    row(field('Max width (px)', maxWidthInput), field('Matte', backgroundInput)),
    row(
      h('label', { class: 'check' }, transparentBox, h('span', { text: 'Transparent background' })),
      h('label', { class: 'check' }, unlockBox, h('span', { text: 'Unlock auto layout' })),
    ),
    gifOptions,
    videoOptions,
    progressWrap,
    row(renderButton, cancelButton),
  )

  /* ---------------------------------------------------------- preview */
  const previewCanvas = h('canvas', { class: 'preview-canvas' })
  const previewScrub = h('input', { class: 'slider', type: 'range', min: 0, max: 0, value: 0 })
  const previewLabel = h('span', { class: 'dim', text: 'No frames yet' })
  const playButton = button('Play', () => togglePlay())
  const previewPanel = section(
    'Preview',
    h('div', { class: 'preview' }, previewCanvas),
    row(playButton, previewScrub, previewLabel),
  )

  let playing = false
  let playHandle = 0
  let previewIndex = 0

  previewScrub.addEventListener('input', () => {
    previewIndex = Number(previewScrub.value)
    drawPreview()
  })

  const element = h('div', { class: 'view' }, modeTabs, sequencePanel, timelinePanel, outputPanel, previewPanel)

  /* ------------------------------------------------------- behaviour */

  function addPreset(preset: Preset): void {
    const nodeId = layerSelect.value
    const layer = state.layers.find((candidate) => candidate.id === nodeId)
    if (!layer) {
      notify('Pick a layer to animate first.', 'error')
      return
    }
    const tracks = buildPreset(preset, layer.id, layer.name, state.duration)
    update({ tracks: [...state.tracks, ...tracks] })
  }

  function startRender(): void {
    if (state.motionMode === 'sequence' && state.steps.length < 2) {
      notify('Add at least two frames to animate between.', 'error')
      return
    }
    if (state.motionMode === 'timeline' && state.tracks.length === 0) {
      notify('Add at least one animation track.', 'error')
      return
    }
    if (state.outputFormat === 'MP4' && !videoEncodingSupported()) {
      notify('This build of Figma cannot encode video. Choose GIF or PNG sequence.', 'error')
      return
    }
    renderStore.store = null
    send({
      type: 'motion:render',
      request: {
        mode: state.motionMode,
        fps: state.fps,
        scale: state.renderScale,
        steps: state.steps,
        stageFrameId: state.stageFrameId,
        duration: state.duration,
        tracks: state.tracks,
        unlockAutoLayout: state.unlockAutoLayout,
        maxFrames: 900,
      },
    })
  }

  function togglePlay(): void {
    const store = renderStore.store
    if (!store || store.count === 0) return
    playing = !playing
    playButton.textContent = playing ? 'Pause' : 'Play'
    if (playing) {
      let last = performance.now()
      const step = (now: number) => {
        if (!playing) return
        if (now - last >= 1000 / state.fps) {
          last = now
          previewIndex = (previewIndex + 1) % store.count
          previewScrub.value = String(previewIndex)
          void drawPreview()
        }
        playHandle = requestAnimationFrame(step)
      }
      playHandle = requestAnimationFrame(step)
    } else {
      cancelAnimationFrame(playHandle)
    }
  }

  async function drawPreview(): Promise<void> {
    const store = renderStore.store
    if (!store || store.count === 0) return
    const index = Math.min(previewIndex, store.count - 1)
    const bitmap = await store.bitmap(index)
    const context = previewCanvas.getContext('2d')
    if (!context) return
    const scale = Math.min(1, 420 / bitmap.width)
    previewCanvas.width = Math.max(1, Math.round(bitmap.width * scale))
    previewCanvas.height = Math.max(1, Math.round(bitmap.height * scale))
    context.clearRect(0, 0, previewCanvas.width, previewCanvas.height)
    context.drawImage(bitmap, 0, 0, previewCanvas.width, previewCanvas.height)
    bitmap.close()
    previewLabel.textContent = `Frame ${index + 1} of ${store.count} · ${formatBytes(store.totalBytes)}`
  }

  /* ------------------------------------------------------------ lists */

  function renderFrameList(): void {
    clear(frameList)
    if (state.frames.length === 0) {
      frameList.append(h('p', { class: 'summary muted', text: 'No top-level frames on this page.' }))
      return
    }
    for (const frame of state.frames) {
      frameList.append(
        h(
          'div',
          { class: 'list-item' },
          h('span', { class: 'ellipsis grow', text: frame.name }),
          h('span', { class: 'dim', text: `${frame.width}×${frame.height}` }),
          frame.reactions.length > 0 ? h('span', { class: 'tag', text: `${frame.reactions.length}→` }) : null,
          h('button', {
            class: 'btn btn-ghost tiny',
            text: 'Add',
            onclick: () =>
              update({
                steps: [
                  ...state.steps,
                  { frameId: frame.id, frameName: frame.name, duration: 0.5, hold: 0.3, easing: 'easeInOut' },
                ],
              }),
          }),
        ),
      )
    }
  }

  function renderStepList(): void {
    clear(stepList)
    if (state.steps.length === 0) {
      stepList.append(h('p', { class: 'summary muted', text: 'No steps yet. Add frames above, in playback order.' }))
      return
    }

    state.steps.forEach((step, index) => {
      const duration = numberInput(step.duration, 0, 30, 0.05)
      duration.addEventListener('change', () => {
        step.duration = Number(duration.value)
      })
      const hold = numberInput(step.hold, 0, 30, 0.05)
      hold.addEventListener('change', () => {
        step.hold = Number(hold.value)
      })
      const easing = select(EASING_OPTIONS, step.easing)
      easing.addEventListener('change', () => {
        step.easing = easing.value as Easing
      })

      stepList.append(
        h(
          'div',
          { class: 'card-inline' },
          h(
            'div',
            { class: 'list-item' },
            h('span', { class: 'index', text: String(index + 1) }),
            h('span', { class: 'ellipsis grow', text: step.frameName }),
            h('button', {
              class: 'btn btn-ghost tiny',
              text: '↑',
              title: 'Move earlier',
              onclick: () => moveStep(index, -1),
            }),
            h('button', {
              class: 'btn btn-ghost tiny',
              text: '↓',
              title: 'Move later',
              onclick: () => moveStep(index, 1),
            }),
            h('button', {
              class: 'btn btn-ghost tiny',
              text: '✕',
              title: 'Remove',
              onclick: () => update({ steps: state.steps.filter((_, i) => i !== index) }),
            }),
          ),
          row(
            field(index === 0 ? 'Transition (unused)' : 'Transition (s)', duration),
            field('Hold (s)', hold),
            field('Easing', easing),
          ),
        ),
      )
    })
  }

  function moveStep(index: number, delta: number): void {
    const target = index + delta
    if (target < 0 || target >= state.steps.length) return
    const steps = [...state.steps]
    const [moved] = steps.splice(index, 1)
    steps.splice(target, 0, moved)
    update({ steps })
  }

  function renderTrackList(): void {
    clear(trackList)
    if (state.tracks.length === 0) {
      trackList.append(h('p', { class: 'summary muted', text: 'No tracks yet. Pick a layer and apply a preset.' }))
      return
    }

    state.tracks.forEach((track, trackIndex) => {
      const propSelect = select(PROP_OPTIONS, track.prop)
      propSelect.addEventListener('change', () => {
        track.prop = propSelect.value as TrackProp
      })

      const keys = h('div', { class: 'keys' })
      const renderKeys = () => {
        clear(keys)
        track.keys.forEach((key, keyIndex) => {
          const time = numberInput(key.t, 0, 120, 0.05)
          time.addEventListener('change', () => {
            key.t = Number(time.value)
          })
          const value = numberInput(key.value, -10000, 10000, 0.01)
          value.addEventListener('change', () => {
            key.value = Number(value.value)
          })
          const easing = select(EASING_OPTIONS, key.easing)
          easing.addEventListener('change', () => {
            key.easing = easing.value as Easing
          })
          keys.append(
            h(
              'div',
              { class: 'key-row' },
              h('span', { class: 'dim', text: 'at' }),
              time,
              h('span', { class: 'dim', text: 's →' }),
              value,
              easing,
              h('button', {
                class: 'btn btn-ghost tiny',
                text: '✕',
                onclick: () => {
                  track.keys.splice(keyIndex, 1)
                  renderKeys()
                },
              }),
            ),
          )
        })
      }
      renderKeys()

      trackList.append(
        h(
          'div',
          { class: 'card-inline' },
          h(
            'div',
            { class: 'list-item' },
            h('span', { class: 'ellipsis grow', text: track.nodeName }),
            propSelect,
            h('button', {
              class: 'btn btn-ghost tiny',
              text: '✕',
              title: 'Remove track',
              onclick: () => update({ tracks: state.tracks.filter((_, i) => i !== trackIndex) }),
            }),
          ),
          keys,
          row(
            h('button', {
              class: 'btn btn-ghost tiny',
              text: '+ keyframe',
              onclick: () => {
                const last = track.keys[track.keys.length - 1]
                track.keys.push({
                  t: Math.min(state.duration, (last?.t ?? 0) + 0.3),
                  value: last?.value ?? 0,
                  easing: 'easeInOut',
                })
                renderKeys()
              },
            }),
          ),
        ),
      )
    })
  }

  /* --------------------------------------------------------- lifecycle */

  return {
    element,
    update() {
      const sequence = state.motionMode === 'sequence'
      modeButtons.sequence.classList.toggle('active', sequence)
      modeButtons.timeline.classList.toggle('active', !sequence)
      sequencePanel.classList.toggle('hidden', !sequence)
      timelinePanel.classList.toggle('hidden', sequence)

      gifOptions.classList.toggle('hidden', state.outputFormat !== 'GIF')
      videoOptions.classList.toggle('hidden', state.outputFormat !== 'MP4')
      backgroundInput.disabled = state.transparent && state.outputFormat !== 'MP4'

      const busy = state.progress !== null

      // A render posts an update per frame. Rebuilding the editors that often
      // would stall the panel, and none of them can change mid-render anyway.
      if (!busy) {
        syncOptions(stageSelect, state.frames.map((frame) => ({ value: frame.id, label: frame.name })), state.stageFrameId)
        syncOptions(
          layerSelect,
          state.layers.map((layer) => ({ value: layer.id, label: `${layer.name} (${layer.type.toLowerCase()})` })),
        )
        renderFrameList()
        renderStepList()
        renderTrackList()
      }

      renderButton.disabled = busy
      cancelButton.disabled = !busy
      progressWrap.classList.toggle('hidden', !busy)
      if (state.progress) {
        const { done, total, stage } = state.progress
        const percent = total === 0 ? 0 : Math.round((done / total) * 100)
        progressBar.style.width = `${percent}%`
        progressLabel.textContent = `${stage === 'rendering' ? 'Rendering frames' : 'Encoding'} — ${done}/${total} (${percent}%)`
      }

      const store = renderStore.store
      previewPanel.classList.toggle('hidden', !store || store.count === 0)
      if (store && store.count > 0) {
        previewScrub.max = String(store.count - 1)
        // While frames stream in, follow the newest one as a live preview.
        if (state.progress?.stage === 'rendering') {
          previewIndex = store.count - 1
          previewScrub.value = String(previewIndex)
        }
        void drawPreview()
      }
    },
  }
}

/** Rebuilds a `<select>` only when its options actually changed, to keep focus. */
function syncOptions(element: HTMLSelectElement, options: { value: string; label: string }[], preferred?: string): void {
  const signature = options.map((option) => `${option.value}:${option.label}`).join('|')
  if (element.dataset.signature === signature) {
    if (preferred && element.value !== preferred) element.value = preferred
    return
  }
  element.dataset.signature = signature
  const previous = element.value
  clear(element)
  for (const option of options) element.append(h('option', { value: option.value, text: option.label }))
  const next = preferred || previous
  if (next && options.some((option) => option.value === next)) element.value = next
  else if (options.length > 0) element.value = options[0].value
}

function track(nodeId: string, nodeName: string, prop: TrackProp, keys: Track['keys']): Track {
  return { nodeId, nodeName, prop, keys }
}

function buildPreset(preset: Preset, nodeId: string, nodeName: string, duration: number): Track[] {
  const short = Math.min(0.6, duration)
  const half = duration / 2

  switch (preset) {
    case 'fadeIn':
      return [
        track(nodeId, nodeName, 'opacity', [
          { t: 0, value: 0, easing: 'linear' },
          { t: short, value: 1, easing: 'easeOut' },
        ]),
      ]
    case 'fadeOut':
      return [
        track(nodeId, nodeName, 'opacity', [
          { t: Math.max(0, duration - short), value: 1, easing: 'linear' },
          { t: duration, value: 0, easing: 'easeIn' },
        ]),
      ]
    case 'slideUp':
      return [
        track(nodeId, nodeName, 'y', [
          { t: 0, value: 48, easing: 'linear' },
          { t: short, value: 0, easing: 'easeOut' },
        ]),
        track(nodeId, nodeName, 'opacity', [
          { t: 0, value: 0, easing: 'linear' },
          { t: short * 0.8, value: 1, easing: 'easeOut' },
        ]),
      ]
    case 'slideIn':
      return [
        track(nodeId, nodeName, 'x', [
          { t: 0, value: -64, easing: 'linear' },
          { t: short, value: 0, easing: 'easeOut' },
        ]),
        track(nodeId, nodeName, 'opacity', [
          { t: 0, value: 0, easing: 'linear' },
          { t: short * 0.8, value: 1, easing: 'easeOut' },
        ]),
      ]
    case 'popIn':
      return [
        track(nodeId, nodeName, 'scale', [
          { t: 0, value: 0.85, easing: 'linear' },
          { t: short * 0.7, value: 1.05, easing: 'easeOut' },
          { t: short, value: 1, easing: 'easeInOut' },
        ]),
        track(nodeId, nodeName, 'opacity', [
          { t: 0, value: 0, easing: 'linear' },
          { t: short * 0.5, value: 1, easing: 'easeOut' },
        ]),
      ]
    case 'spin':
      return [
        track(nodeId, nodeName, 'rotation', [
          { t: 0, value: 0, easing: 'linear' },
          { t: duration, value: -360, easing: 'linear' },
        ]),
      ]
    case 'float':
      return [
        track(nodeId, nodeName, 'y', [
          { t: 0, value: 0, easing: 'easeInOut' },
          { t: half, value: -14, easing: 'easeInOut' },
          { t: duration, value: 0, easing: 'easeInOut' },
        ]),
      ]
    case 'pulse':
      return [
        track(nodeId, nodeName, 'scale', [
          { t: 0, value: 1, easing: 'easeInOut' },
          { t: half, value: 1.08, easing: 'easeInOut' },
          { t: duration, value: 1, easing: 'easeInOut' },
        ]),
      ]
  }
}

/* ------------------------------------------------------------- encoding */

/**
 * Turns the rendered frames into the chosen deliverable. Called by the message
 * router once the sandbox reports that every frame has arrived.
 */
/**
 * Encodes the frames of the last render into the chosen output format and
 * returns the finished file. Callers decide what to do with it: the panel
 * offers it as a download, the bridge hands it to Claude.
 */
export async function exportRenderedFrames(): Promise<ExportedFile | null> {
  const store = renderStore.store
  if (!store || store.count === 0) {
    notify('The render produced no frames.', 'error')
    return null
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const fitted = fitWithin(store.sourceWidth, store.sourceHeight, state.maxWidth)

  try {
    if (state.outputFormat === 'PNG_SEQUENCE') {
      update({ progress: { stage: 'encoding', done: 0, total: store.count } })
      const files: { name: string; bytes: Uint8Array }[] = []
      for (let index = 0; index < store.count; index++) {
        files.push({ name: `frame-${String(index).padStart(4, '0')}.png`, bytes: await store.bytesAt(index) })
        update({ progress: { stage: 'encoding', done: index + 1, total: store.count } })
      }
      notify(`Encoded ${files.length} PNG frames.`)
      return { name: `figma-motion-${stamp}.zip`, bytes: makeZip(files), mime: 'application/zip' }
    }

    if (state.outputFormat === 'GIF') {
      const renderer = new FrameRenderer(
        store,
        fitted.width,
        fitted.height,
        state.transparent ? null : state.background,
      )
      update({ progress: { stage: 'encoding', done: 0, total: store.count * 2 } })
      const bytes = await encodeGif(store.count, (index) => renderer.imageData(index), {
        width: fitted.width,
        height: fitted.height,
        fps: state.fps,
        loop: state.loop,
        dither: state.dither,
        colors: 256,
        onProgress: (done, total) => update({ progress: { stage: 'encoding', done, total } }),
      })
      notify(`GIF ready — ${formatBytes(bytes.length)}, ${store.count} frames at ${state.fps} fps.`)
      return { name: `figma-motion-${stamp}.gif`, bytes, mime: 'image/gif' }
    }

    // MP4: codecs need even dimensions and cannot carry alpha, so the matte
    // colour is always composited in.
    const size = evenSize(fitted.width, fitted.height)
    const renderer = new FrameRenderer(store, size.width, size.height, state.background)
    update({ progress: { stage: 'encoding', done: 0, total: store.count } })
    const result = await encodeVideo(store.count, renderer, {
      fps: state.fps,
      quality: state.quality,
      onProgress: (done, total) => update({ progress: { stage: 'encoding', done, total } }),
    })
    notify(`MP4 ready — ${result.codecLabel}, ${formatBytes(result.bytes.length)}.`)
    return { name: `figma-motion-${stamp}.mp4`, bytes: result.bytes, mime: 'video/mp4' }
  } finally {
    update({ progress: null })
  }
}
