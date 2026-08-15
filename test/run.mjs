/**
 * Verification for the parts of this plugin that are hand-written binary format
 * code, where a subtle mistake produces a file that silently fails to open:
 * the GIF encoder, the ZIP writer, and the transform maths behind rotation.
 *
 * The GIF is validated by decoding it with `omggif` (an independent
 * implementation) and comparing pixels; the ZIP by running the system `unzip`.
 *
 * Run with: npm test
 */
import * as esbuild from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { GifReader } from 'omggif'

const work = mkdtempSync(path.join(tmpdir(), 'f2c-test-'))
let failures = 0
let checks = 0

function check(label, condition, detail = '') {
  checks++
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function near(a, b, tolerance = 1e-6) {
  return Math.abs(a - b) <= tolerance
}

/** Bundles a TypeScript module to ESM so it can be imported by Node. */
async function load(entry) {
  const outfile = path.join(work, `${path.basename(entry, '.ts')}.mjs`)
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2020',
    logLevel: 'silent',
  })
  return import(pathToFileURL(outfile).href)
}

/* ------------------------------------------------------------------ poses */

async function testPose() {
  console.log('\ntransform maths')
  const { poseToTransform, transformToPose, EASINGS } = await load('src/main/pose.ts')

  // Figma reports a 90° rotation as the matrix [[0, 1, tx], [-1, 0, ty]].
  const rotated = poseToTransform(100, 40, { x: 0, y: 0, rotation: 90 })
  check('90° matrix matches Figma orientation', near(rotated[0][0], 0) && near(rotated[0][1], 1) && near(rotated[1][0], -1) && near(rotated[1][1], 0), JSON.stringify(rotated))

  // A rotation about the centre leaves the centre where it was.
  const width = 120
  const height = 60
  for (const angle of [0, 15, 90, -37, 180, 270]) {
    const transform = poseToTransform(width, height, { x: 10, y: 20, rotation: angle })
    const centreX = transform[0][0] * (width / 2) + transform[0][1] * (height / 2) + transform[0][2]
    const centreY = transform[1][0] * (width / 2) + transform[1][1] * (height / 2) + transform[1][2]
    check(`centre is pinned at ${angle}°`, near(centreX, 10 + width / 2, 1e-9) && near(centreY, 20 + height / 2, 1e-9), `${centreX},${centreY}`)
  }

  // Round-tripping a pose through the matrix must be lossless.
  for (const pose of [
    { x: 0, y: 0, rotation: 0 },
    { x: -33.5, y: 12.25, rotation: 45 },
    { x: 400, y: 900, rotation: -120 },
  ]) {
    const back = transformToPose(width, height, poseToTransform(width, height, pose))
    check(
      `pose round-trips at ${pose.rotation}°`,
      near(back.x, pose.x, 1e-9) && near(back.y, pose.y, 1e-9) && near(back.rotation, pose.rotation, 1e-9),
      JSON.stringify(back),
    )
  }

  check('easings are anchored at 0 and 1', ['linear', 'easeIn', 'easeOut', 'easeInOut'].every((name) => near(EASINGS[name](0), 0, 1e-4) && near(EASINGS[name](1), 1, 1e-4)))
  check('easeInOut is symmetric about its midpoint', near(EASINGS.easeInOut(0.5), 0.5, 1e-3), String(EASINGS.easeInOut(0.5)))
  check('easeOut leads linear', EASINGS.easeOut(0.25) > 0.25)
  check('easeIn lags linear', EASINGS.easeIn(0.25) < 0.25)
}

/* -------------------------------------------------------------------- GIF */

function makeImageData(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y)
      const offset = (y * width + x) * 4
      data[offset] = r
      data[offset + 1] = g
      data[offset + 2] = b
      data[offset + 3] = a
    }
  }
  return { width, height, data }
}

async function testGif() {
  console.log('\nGIF encoder')
  const { encodeGif } = await load('src/ui/encode/gif.ts')

  const width = 64
  const height = 48
  const palette = [
    [255, 0, 0],
    [0, 200, 0],
    [0, 0, 255],
    [250, 250, 250],
  ]

  // Four flat-colour frames with a moving square: exercises the global palette,
  // the dirty-rectangle diff and the per-frame delays all at once.
  const frames = palette.map((color, index) =>
    makeImageData(width, height, (x, y) => {
      const inSquare = x >= index * 8 && x < index * 8 + 12 && y >= 10 && y < 22
      return inSquare ? [20, 20, 20, 255] : [...color, 255]
    }),
  )

  const bytes = await encodeGif(frames.length, async (index) => frames[index], {
    width,
    height,
    fps: 10,
    loop: true,
    dither: false,
    colors: 64,
  })

  writeFileSync(path.join(work, 'test.gif'), bytes)
  check('starts with the GIF89a signature', Buffer.from(bytes.subarray(0, 6)).toString('ascii') === 'GIF89a')
  check('ends with the GIF trailer', bytes[bytes.length - 1] === 0x3b)

  const reader = new GifReader(Buffer.from(bytes))
  check('decoder agrees on dimensions', reader.width === width && reader.height === height, `${reader.width}×${reader.height}`)
  check('decoder finds every frame', reader.numFrames() === frames.length, String(reader.numFrames()))
  check('delay is 10cs at 10 fps', reader.frameInfo(0).delay === 10, String(reader.frameInfo(0).delay))
  check('loops forever', reader.loopCount() === 0, String(reader.loopCount()))

  // Decode each frame onto a persistent canvas, exactly as a viewer would, and
  // compare against the source pixels.
  const canvas = new Uint8Array(width * height * 4)
  let worstError = 0
  for (let index = 0; index < frames.length; index++) {
    reader.decodeAndBlitFrameRGBA(index, canvas)
    const source = frames[index].data
    for (let pixel = 0; pixel < width * height; pixel++) {
      for (let channel = 0; channel < 3; channel++) {
        const delta = Math.abs(canvas[pixel * 4 + channel] - source[pixel * 4 + channel])
        if (delta > worstError) worstError = delta
      }
    }
  }
  check('decoded pixels match the source', worstError <= 4, `worst channel error ${worstError}`)

  // A gradient forces the palette to actually quantize, and dithering on.
  const gradient = [
    makeImageData(width, height, (x, y) => [(x * 255) / width, (y * 255) / height, 128, 255]),
    makeImageData(width, height, (x, y) => [(y * 255) / height, (x * 255) / width, 128, 255]),
  ]
  const ditheredBytes = await encodeGif(gradient.length, async (index) => gradient[index], {
    width,
    height,
    fps: 25,
    loop: false,
    dither: true,
    colors: 256,
  })
  const ditheredReader = new GifReader(Buffer.from(ditheredBytes))
  check('dithered gradient decodes', ditheredReader.numFrames() === 2)

  const gradientCanvas = new Uint8Array(width * height * 4)
  ditheredReader.decodeAndBlitFrameRGBA(0, gradientCanvas)
  let totalError = 0
  for (let pixel = 0; pixel < width * height; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      totalError += Math.abs(gradientCanvas[pixel * 4 + channel] - gradient[0].data[pixel * 4 + channel])
    }
  }
  const meanError = totalError / (width * height * 3)
  check('quantized gradient stays close to the original', meanError < 6, `mean channel error ${meanError.toFixed(2)}`)

  // Transparency switches the encoder to full-frame repaints with a
  // transparent palette index.
  const punched = [
    makeImageData(width, height, (x, y) => (x < 20 && y < 20 ? [0, 0, 0, 0] : [10, 120, 220, 255])),
    makeImageData(width, height, (x, y) => (x > 40 && y > 24 ? [0, 0, 0, 0] : [10, 120, 220, 255])),
  ]
  const alphaBytes = await encodeGif(punched.length, async (index) => punched[index], {
    width,
    height,
    fps: 12,
    loop: true,
    dither: false,
    colors: 32,
  })
  const alphaReader = new GifReader(Buffer.from(alphaBytes))
  check('transparent frames declare a transparent index', alphaReader.frameInfo(0).transparent_index !== null)
  check('transparent frames use restore-to-background disposal', alphaReader.frameInfo(0).disposal === 2, String(alphaReader.frameInfo(0).disposal))

  const alphaCanvas = new Uint8Array(width * height * 4)
  alphaReader.decodeAndBlitFrameRGBA(0, alphaCanvas)
  check('the punched hole is still transparent', alphaCanvas[3] === 0, `alpha ${alphaCanvas[3]}`)
  const opaqueOffset = ((30 * width) + 50) * 4
  check('opaque pixels stay opaque', alphaCanvas[opaqueOffset + 3] === 255)

  // Identical consecutive frames should collapse to a near-empty diff.
  const still = makeImageData(width, height, () => [90, 90, 90, 255])
  const repeated = await encodeGif(12, async () => still, {
    width,
    height,
    fps: 12,
    loop: true,
    dither: false,
    colors: 8,
  })
  check('repeated frames compress to a tiny file', repeated.length < 1500, `${repeated.length} bytes`)
  check('repeated frames still decode', new GifReader(Buffer.from(repeated)).numFrames() === 12)
}

/* -------------------------------------------------------------------- ZIP */

async function testZip() {
  console.log('\nZIP writer')
  const { makeZip } = await load('src/ui/encode/zip.ts')

  const encoder = new TextEncoder()
  const files = [
    { name: 'frame-0000.png', bytes: encoder.encode('first file contents') },
    { name: 'frame-0001.png', bytes: encoder.encode('second file, a little longer') },
    { name: 'nested/deep name.txt', bytes: new Uint8Array(5000).fill(65) },
    { name: 'empty.bin', bytes: new Uint8Array(0) },
  ]

  const zip = makeZip(files)
  const zipPath = path.join(work, 'test.zip')
  writeFileSync(zipPath, zip)

  check('starts with the local file header signature', zip[0] === 0x50 && zip[1] === 0x4b && zip[2] === 0x03 && zip[3] === 0x04)

  let integrity = ''
  try {
    integrity = execFileSync('unzip', ['-t', zipPath], { encoding: 'utf8' })
  } catch (error) {
    integrity = `unzip failed: ${error.stdout ?? error.message}`
  }
  check('passes unzip -t integrity check', integrity.includes('No errors detected'), integrity.trim().split('\n').pop())

  const listing = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' })
  check('every entry is listed', files.every((file) => listing.includes(file.name)))

  const extracted = execFileSync('unzip', ['-p', zipPath, 'frame-0001.png'], { encoding: 'utf8' })
  check('contents survive the round trip', extracted === 'second file, a little longer', JSON.stringify(extracted))

  const big = execFileSync('unzip', ['-p', zipPath, 'nested/deep name.txt'], { encoding: 'latin1' })
  check('a 5 kB entry round-trips exactly', big.length === 5000 && big[0] === 'A')
}

/* ------------------------------------------------------------------- main */

try {
  await testPose()
  await testGif()
  await testZip()
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
