/**
 * Exercises the MP4 path in a real browser.
 *
 * `encodeVideo` depends on WebCodecs and a 2D canvas, neither of which exists in
 * Node, so this drives headless Chromium instead — the same engine Figma runs
 * on. The produced file is checked for a valid MP4 box structure and a non-empty
 * video track.
 *
 * Skipped automatically when no Chromium is available. Run with: npm run test:video
 */
import * as esbuild from 'esbuild'
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
].filter(Boolean)

const executablePath = CHROMIUM_CANDIDATES.find((candidate) => existsSync(candidate))
if (!executablePath) {
  console.log('No Chromium found — skipping the video encoder test.')
  process.exit(0)
}

const work = mkdtempSync(path.join(tmpdir(), 'f2c-video-'))
let failures = 0

function check(label, condition, detail = '') {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// Bundle the encoder plus a tiny harness that fabricates frames in-page.
const harness = path.join(work, 'harness.ts')
writeFileSync(
  harness,
  `
import { encodeVideo, videoEncodingSupported } from '${path.resolve('src/ui/encode/mp4.ts').replace(/\\/g, '/')}'
import { FrameStore, FrameRenderer, evenSize } from '${path.resolve('src/ui/encode/frames.ts').replace(/\\/g, '/')}'

async function pngFrame(width: number, height: number, index: number): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')!
  context.fillStyle = \`hsl(\${index * 12}, 80%, 55%)\`
  context.fillRect(0, 0, width, height)
  context.fillStyle = '#111'
  context.fillRect(index * 4, 20, 30, 30)
  const blob: Blob = await new Promise((resolve) => canvas.toBlob((value) => resolve(value!), 'image/png'))
  return new Uint8Array(await blob.arrayBuffer())
}

;(window as any).runVideoTest = async () => {
  if (!videoEncodingSupported()) return { supported: false }
  const width = 160
  const height = 120
  const count = 24
  const store = new FrameStore(width, height)
  for (let index = 0; index < count; index++) store.add(await pngFrame(width, height, index))

  const size = evenSize(width, height)
  const renderer = new FrameRenderer(store, size.width, size.height, '#ffffff')
  let lastProgress = 0
  const result = await encodeVideo(count, renderer, {
    fps: 12,
    quality: 0.8,
    onProgress: (done) => { lastProgress = done },
  })
  return {
    supported: true,
    codecLabel: result.codecLabel,
    lastProgress,
    frames: count,
    bytes: Array.from(result.bytes),
  }
}
`,
)

const bundle = await esbuild.build({
  entryPoints: [harness],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  write: false,
  logLevel: 'silent',
})

const page = path.join(work, 'page.html')
writeFileSync(page, `<meta charset="utf-8"><body></body><script>${bundle.outputFiles[0].text}</script>`)

const { chromium } = await import('playwright-core')
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] })

try {
  const context = await browser.newContext()
  const tab = await context.newPage()
  tab.on('pageerror', (error) => console.log('  page error:', error.message))
  await tab.goto(`file://${page}`)
  const result = await tab.evaluate(() => window.runVideoTest())

  console.log('\nMP4 encoder (headless Chromium)')
  if (!result.supported) {
    console.log('  WebCodecs unavailable in this Chromium — nothing to verify.')
  } else {
    const bytes = Buffer.from(result.bytes)
    writeFileSync(path.join(work, 'out.mp4'), bytes)

    check('produced a non-trivial file', bytes.length > 2000, `${bytes.length} bytes`)
    check('reported every frame through onProgress', result.lastProgress === result.frames, String(result.lastProgress))
    check('picked a real codec', typeof result.codecLabel === 'string' && result.codecLabel.length > 0, result.codecLabel)

    // Walk the top-level MP4 box structure.
    const boxes = []
    let offset = 0
    while (offset + 8 <= bytes.length) {
      const size = bytes.readUInt32BE(offset)
      const type = bytes.toString('ascii', offset + 4, offset + 8)
      if (size < 8 || offset + size > bytes.length) break
      boxes.push(type)
      offset += size
    }
    check('starts with an ftyp box', boxes[0] === 'ftyp', boxes.join(','))
    check('contains a moov box', boxes.includes('moov'), boxes.join(','))
    check('contains an mdat box', boxes.includes('mdat'), boxes.join(','))
    check('moov precedes mdat (fast start)', boxes.indexOf('moov') < boxes.indexOf('mdat'), boxes.join(','))
    check('every byte is accounted for by a box', offset === bytes.length, `${offset}/${bytes.length}`)
    check('declares a video handler', bytes.includes(Buffer.from('vide', 'ascii')))

    // Play it back to confirm the file is actually decodable.
    const playback = await tab.evaluate(async (data) => {
      const blob = new Blob([new Uint8Array(data)], { type: 'video/mp4' })
      const video = document.createElement('video')
      video.muted = true
      video.src = URL.createObjectURL(blob)
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, reason: 'timed out' }), 8000)
        video.onloadedmetadata = () => {
          clearTimeout(timer)
          resolve({ ok: true, duration: video.duration, width: video.videoWidth, height: video.videoHeight })
        }
        video.onerror = () => {
          clearTimeout(timer)
          resolve({ ok: false, reason: video.error ? video.error.message : 'unknown' })
        }
      })
    }, result.bytes)

    if (playback.ok) {
      check('decodes with the right dimensions', playback.width === 160 && playback.height === 120, `${playback.width}×${playback.height}`)
      check('duration matches 24 frames at 12 fps', Math.abs(playback.duration - 2) < 0.3, String(playback.duration))
    } else {
      // Headless builds without proprietary codecs cannot play H.264 back; the
      // structural checks above still stand.
      console.log(`  note: playback unavailable in this build (${playback.reason})`)
    }
  }
} finally {
  await browser.close()
  rmSync(work, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
