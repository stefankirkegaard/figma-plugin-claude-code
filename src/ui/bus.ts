import type { MainToUi } from '../shared/types'

interface Waiter {
  type: MainToUi['type']
  resolve: (message: MainToUi) => void
  reject: (error: Error) => void
  timer: number
}

const waiters: Waiter[] = []

/**
 * The panel's own views are driven by state, but the bridge has to *await*
 * specific replies from the sandbox — a render finishing, a prototype sequence
 * arriving. Every inbound message passes through here so those awaits resolve.
 */
export function dispatch(message: MainToUi): void {
  if (waiters.length === 0) return
  for (const waiter of [...waiters]) {
    if (message.type === waiter.type) {
      settle(waiter)
      waiter.resolve(message)
    } else if (message.type === 'error') {
      // A sandbox error aborts whatever the bridge was waiting for.
      settle(waiter)
      waiter.reject(new Error(message.message))
    }
  }
}

function settle(waiter: Waiter): void {
  const index = waiters.indexOf(waiter)
  if (index !== -1) waiters.splice(index, 1)
  clearTimeout(waiter.timer)
}

export function waitFor<T extends MainToUi['type']>(
  type: T,
  timeoutMs = 60_000,
): Promise<Extract<MainToUi, { type: T }>> {
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      type,
      resolve: resolve as (message: MainToUi) => void,
      reject,
      timer: setTimeout(() => {
        settle(waiter)
        reject(new Error(`Figma did not answer with "${type}" in time.`))
      }, timeoutMs) as unknown as number,
    }
    waiters.push(waiter)
  })
}
