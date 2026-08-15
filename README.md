# Figma to Claude Plugin

A Figma plugin for working on designs and assets in bulk, and for turning frames
into motion — exported as animated GIF, MP4 video, or a PNG sequence.

Everything runs locally inside the plugin. The manifest declares no network
access, so nothing about your document leaves your machine.

## What it does

### Design

Bulk operations on the current selection:

- **Rename** with a pattern (`Icon/{name}-{n}` — tokens are `{n}`, `{name}`, `{type}`, `{w}`, `{h}`)
- **Colour** — set fill or stroke on everything selected, keeping existing paint opacity
- **Appearance** — opacity and corner radius
- **Auto layout** — apply direction, gap and padding across many frames at once
- **Find & replace** across every text layer in the selection, loading fonts as needed
- **Select similar** — everything on the page matching the selection's type and size
- **Copy design spec** — the selection as a Markdown outline (geometry, colours,
  type, layout, effects) to paste into a chat with Claude

### Assets

Scans the selection — plus any nested layer that already has export settings —
and exports as PNG, JPG, SVG or PDF at several scales at once. One file downloads
directly; several arrive as a ZIP.

### Motion

Two ways to build an animation, both rendered by Figma itself so the output
matches the canvas exactly.

**Smart animate** — pick two or more frames and the plugin tweens between them
the way Figma's Smart Animate does: layers are paired by name within each parent,
matched layers interpolate position, size, rotation, opacity, fill, corner radius
and font size; layers only in the source fade out; layers only in the destination
are copied in and fade up. *Build from prototype* follows your existing prototype
connections and imports their durations and easing curves.

**Timeline** — keyframe individual layers inside one frame. Tracks drive X and Y
offset, scale, rotation and opacity, with per-keyframe easing. Presets (fade,
slide, pop, spin, float, pulse) generate tracks you can then edit by hand.

Output is GIF, MP4, or a ZIP of PNG frames, with control over frame rate, render
scale, maximum width, matte colour or transparency, dithering, looping and video
quality. Rendered frames are previewed in-panel with a scrubber before export.

## Install

```bash
npm install
npm run build
```

Then in Figma: **Plugins → Development → Import plugin from manifest…** and pick
`manifest.json` from this folder. `npm run watch` rebuilds on save.

## How it works

Figma's plugin API has no animation timeline and no video export — `exportAsync`
produces PNG, JPG, SVG and PDF, one still at a time. So the plugin renders motion
frame by frame and encodes the video itself:

1. **Sandbox** (`src/main`) clones the source frame to an off-canvas *stage*,
   applies the interpolated state for each moment in time, exports the stage as a
   PNG, and streams the bytes to the UI. The clone is always removed afterwards,
   so your artwork is never touched.
2. **UI** (`src/ui`) collects the frames as PNG blobs and encodes them —
   GIF through a hand-written GIF89a encoder, MP4 through WebCodecs plus
   `mp4-muxer`, PNG sequences through a small ZIP writer.

A few details worth knowing:

- **Rotation** is written straight into `relativeTransform` rather than via
  `node.rotation`, which keeps the pivot at the layer's centre.
- **Scale** uses `rescale`, so font sizes, stroke weights and corner radii scale
  with the box instead of the layout stretching.
- **Auto layout** recomputes child positions on every change, which silently
  undoes anything an animation writes. "Unlock auto layout" (on by default)
  converts the stage's auto-layout frames to free positioning first — the
  laid-out result is preserved, but layers become movable.
- **GIFs** share one median-cut palette across all frames, optionally dithered,
  and each frame is cropped to the rectangle that actually changed. Held frames
  therefore cost almost nothing.
- **Delays** are rounded per frame with the error carried forward, so a 30 fps
  GIF still runs the right total length despite GIF's centisecond timebase.

## Limits

- Smart animate pairs layers **by name**. Rename a layer between frames and it
  will cross-fade instead of moving.
- Instances nested inside other instances cannot be detached, so auto layout
  inside them stays locked and those layers will not move.
- A render is capped at 900 frames. Lower the frame rate or shorten the timing
  if you hit it.
- GIF stores delays in centiseconds, so frame rates above 50 fps are not
  represented accurately — most viewers also clamp very short delays.
- MP4 needs WebCodecs. Where it is missing the plugin says so and GIF or PNG
  sequence still work. H.264 is preferred, with VP9-in-MP4 as a fallback.
- Exports also appear as links in the **Downloads** strip at the bottom of the
  panel. The plugin iframe is sandboxed, so if an automatic download is blocked,
  click the link there.

## Tests

The hand-written binary formats are the parts most likely to fail silently, so
they are verified against independent implementations:

```bash
npm test         # GIF decoded with omggif, ZIP checked with unzip, transform maths
npm run test:video   # MP4 encoded and played back in headless Chromium
```

`npm run test:video` skips itself when no Chromium is available.

## Layout

```
manifest.json          Figma plugin manifest
build.mjs              esbuild build; inlines JS + CSS into a single ui.html
src/shared/types.ts    message contracts shared by both sides
src/main/              plugin sandbox: scene graph, exporting, the render engine
  motion.ts              smart-animate matching, timeline sampling, frame render
  pose.ts                easing curves and transform maths
src/ui/                plugin iframe: panel UI and encoders
  encode/gif.ts          GIF89a encoder (median cut, dithering, LZW)
  encode/mp4.ts          WebCodecs + mp4-muxer
  encode/zip.ts          stored-method ZIP writer
test/                  verification for the above
```
