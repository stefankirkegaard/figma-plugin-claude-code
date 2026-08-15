import type { UiToMain } from '../shared/types'
import * as assets from './assets'
import * as design from './design'
import * as motion from './motion'
import { selectionToMarkdown } from './serialize'
import { fail, post, selectionState, summarize } from './util'

figma.showUI(__html__, { width: 480, height: 680, themeColors: true })

const pushSelection = () => post({ type: 'selection', state: selectionState() })

figma.on('selectionchange', pushSelection)
figma.on('currentpagechange', () => {
  pushSelection()
  post({ type: 'motion:frames', frames: motion.listFrames() })
})

/** Runs a design operation and reports its outcome through Figma's toast. */
function runDesignOp(operation: () => string | Promise<string>): Promise<void> {
  return Promise.resolve()
    .then(operation)
    .then((summary) => {
      figma.notify(summary)
      pushSelection()
    })
    .catch(fail)
}

figma.ui.onmessage = async (message: UiToMain) => {
  try {
    switch (message.type) {
      case 'ui:ready':
        pushSelection()
        post({ type: 'motion:frames', frames: motion.listFrames() })
        break

      case 'ui:resize':
        figma.ui.resize(Math.max(360, Math.round(message.width)), Math.max(400, Math.round(message.height)))
        break

      case 'ui:notify':
        figma.notify(message.message, { error: message.error === true })
        break

      case 'design:rename':
        await runDesignOp(() => design.rename(message.pattern))
        break

      case 'design:fill':
        await runDesignOp(() => design.setColor(message.hex, message.target))
        break

      case 'design:opacity':
        await runDesignOp(() => design.setOpacity(message.value))
        break

      case 'design:corner':
        await runDesignOp(() => design.setCornerRadius(message.value))
        break

      case 'design:replaceText':
        await runDesignOp(() => design.replaceText(message.find, message.replace, message.matchCase))
        break

      case 'design:autoLayout':
        await runDesignOp(() => design.applyAutoLayout(message.direction, message.gap, message.padding))
        break

      case 'design:selectSimilar':
        await runDesignOp(() => design.selectSimilar())
        break

      case 'design:copyForClaude':
        post({ type: 'clipboard', text: selectionToMarkdown(), label: 'Design spec' })
        break

      case 'assets:scan':
        post({ type: 'assets:list', nodes: assets.scan() })
        break

      case 'assets:export': {
        post({ type: 'busy', busy: true, label: 'Exporting…' })
        try {
          const files = await assets.exportAssets(message.request)
          post({ type: 'assets:done', files })
        } finally {
          post({ type: 'busy', busy: false })
        }
        break
      }

      case 'motion:listFrames':
        post({ type: 'motion:frames', frames: motion.listFrames() })
        break

      case 'motion:listLayers': {
        const layers = await motion.listLayers(message.frameId)
        post({ type: 'motion:layers', layers: layers.map(summarize) })
        break
      }

      case 'motion:sequenceFromPrototype': {
        const steps = motion.sequenceFromPrototype(message.frameId)
        if (steps.length < 2) {
          throw new Error('That frame has no prototype connections to follow. Link frames in Prototype mode first.')
        }
        post({ type: 'motion:sequence', steps })
        break
      }

      case 'motion:render':
        // The renderer reports its own progress and completion.
        await motion.render(message.request)
        break

      case 'motion:cancel':
        motion.cancelRender()
        break

      case 'motion:zoomTo': {
        const node = await figma.getNodeByIdAsync(message.nodeId)
        if (node && node.type !== 'PAGE' && node.type !== 'DOCUMENT') {
          figma.currentPage.selection = [node as SceneNode]
          figma.viewport.scrollAndZoomIntoView([node as SceneNode])
        }
        break
      }
    }
  } catch (error) {
    fail(error)
    // A failed render must still release the UI's progress state.
    if (message.type === 'motion:render') post({ type: 'motion:renderDone', cancelled: true })
  }
}
