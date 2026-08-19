# Figma to Claude

A Figma plugin for working on designs and assets in bulk, for turning frames
into motion — animated GIF, MP4 video or a PNG sequence — and for handing the
whole lot to Claude Code over MCP.

Everything runs locally. The one connection the plugin makes is to a bridge
process on your own machine, so nothing about your document leaves it.

## Quick start

```bash
npm install && npm run build
```

1. In the **Figma desktop app**: *Plugins → Development → Import plugin from
   manifest…* and pick `manifest.json` from this folder. It is now in the
   Plugins menu of every file you open.
2. Run the plugin in any Figma file. It opens on the **Claude** tab and starts
   looking for the bridge.
3. Run `claude` in this folder. `.mcp.json` starts the bridge for you, the
   panel's dot turns green, and Claude can read and edit the open document.

Then just ask:

> read my selection and build it as a React component
> export every icon on this page as SVG
> animate Home → Search → Results as a 24 fps GIF

Claude Code remembers the server per project, so from the second session on it
is: open the plugin, run `claude`, connected.

## What it does

### Claude

The plugin is an MCP server. With the panel open, Claude Code gets these tools:

| Tool | What it does |
| --- | --- |
| `figma_status` | Whether a panel is connected, and which document it has open |
| `figma_get_selection` | The current selection: ids, names, types, sizes |
| `figma_get_page` | The page's layer tree, depth limited |
| `figma_find_nodes` | Search the page by name and/or type |
| `figma_get_design_spec` | The selection as a Markdown spec — the fastest context for writing code from a design |
| `figma_list_frames` | Top-level frames and their prototype connections |
| `figma_set_selection` | Select layers, optionally zooming the canvas to them |
| `figma_rename` | Pattern rename |
| `figma_set_color` | Fill or stroke colour |
| `figma_set_opacity`, `figma_set_corner_radius` | Appearance |
| `figma_set_auto_layout` | Direction, gap and padding across many frames |
| `figma_replace_text` | Find and replace across every text layer |
| `figma_select_similar` | Everything matching the selection's type and size |
| `figma_export` | PNG, JPG, SVG or PDF at any scales — written to `figma-exports/`, and PNGs come back inline so Claude can look at them |
| `figma_render_motion` | Smart animate or a keyframe timeline, encoded as GIF, MP4 or a PNG sequence |
| `figma_notify` | A toast inside Figma |

Editing tools act on the current selection unless they are given `nodeIds`, in
which case those layers are selected first — so you always see on canvas what
Claude just touched. A Claude-driven render fills in the Motion tab as it runs
and its file lands in the Downloads strip too.

#### Figma's own MCP server

This bridge and [Figma's MCP server](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server)
solve different halves of the problem and are worth running together:

```bash
claude plugin install figma@claude-plugins-official
```

Figma's server talks to Figma's backend — Code Connect, design system rules,
variables, creating native content — and needs no plugin, but it has no idea
which document is in front of you and cannot animate anything. This bridge
drives *the file you are looking at*, including the bulk operations and the
motion export below, which have no equivalent in the Figma API.

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

## Deploying it further

A plugin imported from a manifest is a *development* plugin: it shows up in
every file you open, but only for you, on that machine, in the desktop app —
Figma in the browser cannot read a local manifest. `npm run watch` rebuilds on
save; Figma picks the new build up when you re-run the plugin.

To get it to other people, [publish it](https://help.figma.com/hc/en-us/articles/360042293394-Publish-plugins-to-the-Figma-Community):
privately to your organization if you are on an Organization or Enterprise plan
(no review, and it then works in the browser too), or publicly to the Community,
which goes through Figma's review. Everyone who uses it still needs the bridge
running locally — the plugin is only ever one end of the wire.

## How it works

### The bridge

```
Claude Code ──stdio──► bridge/server.mjs ──ws://localhost:3055──► panel ──► Figma
```

A Figma plugin cannot accept incoming connections and has no filesystem, and
the Figma API only exists inside Figma — so the panel dials out to a small Node
process that is at once an MCP server on stdio and a WebSocket server on
loopback. Every MCP tool becomes a request the open panel answers.

Most commands are forwarded straight to the sandbox (`src/main/rpc.ts`), which
runs the same functions the panel's own buttons call. `figma_render_motion` is
answered by the UI instead, because that is where the encoders live: it drives a
real render, encodes the result, ships the bytes back as base64, and the bridge
writes them to `figma-exports/`.

Two consequences worth knowing. The panel is the whole permission model — Claude
can only reach the document you have open, and closing the panel cuts the link.
And because the bridge is the WebSocket *server*, a second one cannot start on
the same port; the panel's Claude tab has a port field for that case, and the
manifest allows 3055–3059.

Figma's manifest validator rejects IP literals — `ws://127.0.0.1:3055` fails to
load with "must be a valid URL" — so the panel dials `ws://localhost`. Which
address that resolves to is the machine's business, and IPv6 usually wins, so
the bridge listens on both `127.0.0.1` and `::1`.

### Motion

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
- The bridge serves whichever panel connected most recently. Two Figma windows
  with the plugin open means the second one wins.
- Changing the bridge port needs it changed in three places: the panel's Claude
  tab, `FIGMA_BRIDGE_PORT` in `.mcp.json`, and `allowedDomains` in
  `manifest.json` if you go outside 3055–3059.

## Tests

The hand-written binary formats are the parts most likely to fail silently, so
they are verified against independent implementations:

```bash
npm test         # GIF decoded with omggif, ZIP checked with unzip, transform maths
npm run test:bridge  # MCP tools driven end to end against a stand-in panel
npm run test:video   # MP4 encoded and played back in headless Chromium
```

`npm run test:bridge` runs the real bridge process, connects a fake panel to it,
and calls every kind of tool through an MCP client — the wire between the two
has no types protecting it. `npm run test:video` skips itself when no Chromium
is available.

## Layout

```
manifest.json          Figma plugin manifest
.mcp.json              registers the bridge with Claude Code
build.mjs              esbuild build; inlines JS + CSS into a single ui.html
bridge/                the MCP server, plain Node — not part of the plugin bundle
  server.mjs             entry: stdio MCP + loopback WebSocket in one process
  channel.mjs            the socket, connection tracking and request correlation
  tools.mjs              tool definitions and their schemas
src/shared/types.ts    message contracts shared by both sides
src/main/              plugin sandbox: scene graph, exporting, the render engine
  rpc.ts                 the commands the bridge can run
  motion.ts              smart-animate matching, timeline sampling, frame render
  pose.ts                easing curves and transform maths
src/ui/                plugin iframe: panel UI and encoders
  bridge.ts              WebSocket client, reconnect, UI-side commands
  views/connect.ts       the Claude tab
  encode/gif.ts          GIF89a encoder (median cut, dithering, LZW)
  encode/mp4.ts          WebCodecs + mp4-muxer
  encode/zip.ts          stored-method ZIP writer
test/                  verification for the above
```
