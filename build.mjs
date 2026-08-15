import * as esbuild from 'esbuild'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(root, 'dist')
const watch = process.argv.includes('--watch')

/** The main-thread bundle runs in Figma's plugin sandbox: no DOM, no modules. */
const mainOptions = {
  entryPoints: [path.join(root, 'src/main/index.ts')],
  outfile: path.join(outDir, 'code.js'),
  bundle: true,
  format: 'iife',
  target: 'es2017',
  legalComments: 'none',
  logLevel: 'silent',
}

/**
 * The UI bundle runs inside the plugin iframe. Figma loads the UI from a single
 * HTML file, so JS and CSS are inlined into `dist/ui.html`.
 */
const uiOptions = {
  entryPoints: [path.join(root, 'src/ui/main.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  legalComments: 'none',
  logLevel: 'silent',
  write: false,
  loader: { '.css': 'text' },
}

async function buildUi() {
  const result = await esbuild.build(uiOptions)
  const js = result.outputFiles[0].text
  const css = await readFile(path.join(root, 'src/ui/style.css'), 'utf8')
  const template = await readFile(path.join(root, 'src/ui/index.html'), 'utf8')
  const html = template
    .replace('/* INJECT_CSS */', () => css)
    .replace('// INJECT_JS', () => js)
  await mkdir(outDir, { recursive: true })
  await writeFile(path.join(outDir, 'ui.html'), html)
  return html.length
}

async function buildAll() {
  await mkdir(outDir, { recursive: true })
  const [, uiBytes] = await Promise.all([esbuild.build(mainOptions), buildUi()])
  const code = await readFile(path.join(outDir, 'code.js'), 'utf8')
  return { code: code.length, ui: uiBytes }
}

function kb(n) {
  return `${(n / 1024).toFixed(1)} kB`
}

if (watch) {
  // esbuild's own watch only covers code.js; the UI is rebuilt through a plugin
  // hook so the HTML shell and CSS are re-inlined on every change.
  const uiCtx = await esbuild.context({
    ...uiOptions,
    write: false,
    plugins: [
      {
        name: 'inline-ui',
        setup(build) {
          build.onEnd(async (res) => {
            if (res.errors.length) return
            await buildUi()
            console.log('[figma-to-claude] rebuilt ui.html')
          })
        },
      },
    ],
  })
  const mainCtx = await esbuild.context(mainOptions)
  await Promise.all([mainCtx.watch(), uiCtx.watch()])
  console.log('[figma-to-claude] watching for changes…')
} else {
  try {
    const sizes = await buildAll()
    console.log(`[figma-to-claude] code.js ${kb(sizes.code)} · ui.html ${kb(sizes.ui)}`)
  } catch (err) {
    console.error(err.message ?? err)
    process.exit(1)
  }
}
