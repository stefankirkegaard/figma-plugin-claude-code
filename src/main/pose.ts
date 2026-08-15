import type { Easing } from '../shared/types'

/* --------------------------------------------------------------- easing */

/**
 * Solves a CSS-style cubic bezier `y` for a given `x` with Newton-Raphson and a
 * bisection fallback. Figma's built-in prototype easings are the same curves,
 * so imported transitions keep their feel.
 */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const curve = (a: number, b: number, t: number) => {
    const c = 3 * a
    const d = 3 * (b - a) - c
    const e = 1 - c - d
    return ((e * t + d) * t + c) * t
  }
  const slope = (a: number, b: number, t: number) => {
    const c = 3 * a
    const d = 3 * (b - a) - c
    const e = 1 - c - d
    return (3 * e * t + 2 * d) * t + c
  }

  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i++) {
      const error = curve(x1, x2, t) - x
      if (Math.abs(error) < 1e-5) return curve(y1, y2, t)
      const derivative = slope(x1, x2, t)
      if (Math.abs(derivative) < 1e-6) break
      t -= error / derivative
    }
    let low = 0
    let high = 1
    t = x
    for (let i = 0; i < 20; i++) {
      const value = curve(x1, x2, t)
      if (Math.abs(value - x) < 1e-5) break
      if (value > x) high = t
      else low = t
      t = (low + high) / 2
    }
    return curve(y1, y2, t)
  }
}

function easeOutBounce(t: number): number {
  const n = 7.5625
  const d = 2.75
  if (t < 1 / d) return n * t * t
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375
  return n * (t -= 2.625 / d) * t + 0.984375
}

export const EASINGS: Record<Easing, (t: number) => number> = {
  linear: (t) => t,
  easeIn: cubicBezier(0.42, 0, 1, 1),
  easeOut: cubicBezier(0, 0, 0.58, 1),
  easeInOut: cubicBezier(0.42, 0, 0.58, 1),
  easeOutBack: (t) => {
    const c1 = 1.70158
    const c3 = c1 + 1
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
  },
  easeOutBounce,
}

export function ease(name: Easing, t: number): number {
  const fn = EASINGS[name] ?? EASINGS.linear
  return fn(Math.max(0, Math.min(1, t)))
}

/** Maps Figma's prototype easing enum onto the plugin's easing names. */
export function easingFromFigma(easing: Easing_ | undefined): Easing {
  switch (easing?.type) {
    case 'EASE_IN':
    case 'EASE_IN_BACK':
      return 'easeIn'
    case 'EASE_OUT':
    case 'GENTLE':
      return 'easeOut'
    case 'EASE_OUT_BACK':
      return 'easeOutBack'
    case 'BOUNCY':
      return 'easeOutBounce'
    case 'LINEAR':
      return 'linear'
    default:
      return 'easeInOut'
  }
}

/** Structural stand-in for Figma's `Easing` type, which the typings do not export. */
type Easing_ = { type: string }

/* ---------------------------------------------------------- interpolation */

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function lerpColor(a: RGB, b: RGB, t: number): RGB {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) }
}

/* ------------------------------------------------------------- transforms */

export interface Pose {
  /** Top-left of the node's unrotated box, in parent coordinates. */
  x: number
  y: number
  /** Counter-clockwise degrees, matching Figma's rotation readout. */
  rotation: number
}

/**
 * Builds the `relativeTransform` that places a `width`×`height` box at `pose`,
 * rotated around its own centre.
 *
 * Figma's transform is a y-down affine matrix in which a rotation of θ is
 * `[[cos θ, sin θ], [-sin θ, cos θ]]`. Writing the matrix directly, rather than
 * assigning `node.rotation`, is what pins the pivot to the centre — which is
 * what animation needs, and what a corner pivot would visibly get wrong.
 */
export function poseToTransform(width: number, height: number, pose: Pose): Transform {
  const rad = (pose.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const halfW = width / 2
  const halfH = height / 2
  return [
    [cos, sin, pose.x + halfW - (cos * halfW + sin * halfH)],
    [-sin, cos, pose.y + halfH - (-sin * halfW + cos * halfH)],
  ]
}

/** Inverse of {@link poseToTransform}. */
export function transformToPose(width: number, height: number, transform: Transform): Pose {
  const [[cos, sin, tx], [, , ty]] = transform
  const halfW = width / 2
  const halfH = height / 2
  return {
    x: tx - halfW + (cos * halfW + sin * halfH),
    y: ty - halfH + (-sin * halfW + cos * halfH),
    rotation: (Math.atan2(sin, cos) * 180) / Math.PI,
  }
}

/**
 * Positions a node at `x`/`y` (top-left of its unrotated box, in parent
 * coordinates) rotated `degrees` counter-clockwise around its own centre.
 */
export function setPose(node: SceneNode, x: number, y: number, degrees: number): void {
  if (!('relativeTransform' in node)) return
  node.relativeTransform = poseToTransform(node.width, node.height, { x, y, rotation: degrees })
}

/**
 * Scales a node to `factor` times `baseWidth`/`baseHeight`.
 *
 * `rescale` is used rather than `resize` because it behaves like the Scale tool:
 * font sizes, stroke weights and corner radii scale with the box instead of the
 * layout stretching. It scales from the current size, so the delta is derived
 * from the node's current width.
 */
export function setScale(node: SceneNode, baseWidth: number, factor: number): void {
  if (!('rescale' in node) || baseWidth <= 0) return
  const target = Math.max(0.01, factor)
  const current = node.width / baseWidth
  if (current <= 0) return
  const delta = target / current
  // Figma rejects rescale factors below 0.01 and sub-pixel results are noise.
  if (!isFinite(delta) || Math.abs(delta - 1) < 1e-4) return
  try {
    node.rescale(Math.max(0.01, delta))
  } catch {
    // Some node types (e.g. certain instance sub-layers) refuse rescaling.
  }
}
