import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

/** Envelope version. Bumped when the plugin/bridge message shape changes. */
export const PROTOCOL = 1

/** Figma's plugin iframe is sandboxed, so its origin is the string "null". */
const ALLOWED_ORIGINS = [undefined, '', 'null', 'https://www.figma.com', 'https://figma.com']

/**
 * Figma's manifest validator rejects IP literals, so the plugin has to dial
 * `ws://localhost`. Which address that resolves to is up to the machine — IPv6
 * first on most of them — so both loopback addresses are listened on.
 */
const LOOPBACK = ['127.0.0.1', '::1']

/**
 * The link between the MCP server and whichever Figma plugin panel is open.
 *
 * The plugin dials in — a browser tab cannot be asked to listen — so this is a
 * WebSocket *server* bound to loopback that the panel connects to and keeps
 * open. Requests are correlated by id; the panel answers each one exactly once.
 */
export class Channel {
  constructor({ port = 3056, log = () => {} } = {}) {
    this.port = port
    this.log = log
    this.servers = []
    /** Every live panel, newest last. The newest is the one commands go to. */
    this.clients = []
    this.listenError = null
    this.pending = new Map()
    this.nextId = 1
    this.waiters = []
  }

  async listen() {
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 * 1024 })

    const upgrade = (request, socket, head) => {
      const origin = request.headers.origin
      // Blocks ordinary web pages, which always send their real origin.
      if (!ALLOWED_ORIGINS.includes(origin)) {
        this.log(`refused a connection from origin ${origin}`)
        socket.destroy()
        return
      }
      sockets.handleUpgrade(request, socket, head, (client) => this.#adopt(client))
    }

    const failures = []
    for (const host of LOOPBACK) {
      try {
        this.servers.push(await this.#bind(host, upgrade))
        this.log(`listening on ws://${host === '::1' ? '[::1]' : host}:${this.port}`)
      } catch (error) {
        // A host without IPv6 is normal; both failing is not.
        failures.push(error)
      }
    }

    if (this.servers.length === 0) {
      this.listenError = failures.find((error) => error.code === 'EADDRINUSE') ?? failures[0]
      throw this.listenError
    }
  }

  #bind(host, upgrade) {
    return new Promise((resolve, reject) => {
      const server = createServer((_request, response) => {
        response.writeHead(426, { 'content-type': 'text/plain' })
        response.end('This port speaks WebSocket to the Figma to Claude plugin panel.\n')
      })
      server.on('upgrade', upgrade)
      server.once('error', reject)
      server.listen(this.port, host, () => {
        server.removeListener('error', reject)
        server.on('error', (error) => this.log(`server error: ${error.message}`))
        resolve(server)
      })
    })
  }

  #adopt(socket) {
    const client = { socket, document: null, page: null, connectedAt: Date.now() }
    this.clients.push(client)
    this.log('a Figma panel connected')

    socket.on('message', (data) => {
      let message
      try {
        message = JSON.parse(data.toString())
      } catch {
        this.log('ignored a malformed message')
        return
      }
      this.#handle(client, message)
    })

    socket.on('close', () => {
      this.clients = this.clients.filter((entry) => entry !== client)
      this.log('a Figma panel disconnected')
      for (const [id, entry] of this.pending) {
        if (entry.client !== client) continue
        this.pending.delete(id)
        entry.reject(new Error('The Figma panel closed while the command was running.'))
      }
    })

    socket.on('error', (error) => this.log(`socket error: ${error.message}`))
  }

  #handle(client, message) {
    if (message.type === 'hello') {
      client.document = message.document ?? null
      client.page = message.page ?? null
      this.log(`panel ready — ${client.document ?? 'untitled'} / ${client.page ?? '?'}`)
      const waiters = this.waiters
      this.waiters = []
      for (const resolve of waiters) resolve()
      return
    }

    if (message.type === 'context') {
      client.document = message.document ?? client.document
      client.page = message.page ?? client.page
      return
    }

    if (message.type === 'progress') {
      const entry = this.pending.get(message.id)
      if (entry?.onProgress) entry.onProgress(message)
      return
    }

    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.ok) entry.resolve(message.result)
    else entry.reject(new Error(message.error || 'The plugin reported an unknown failure.'))
  }

  get client() {
    return this.clients[this.clients.length - 1] ?? null
  }

  get connected() {
    return this.client !== null
  }

  status() {
    return {
      listening: this.servers.length > 0,
      url: `ws://localhost:${this.port}`,
      panels: this.clients.length,
      document: this.client?.document ?? null,
      page: this.client?.page ?? null,
    }
  }

  /** Resolves once a panel is connected, or rejects after `timeoutMs`. */
  waitForPanel(timeoutMs = 0) {
    if (this.connected) return Promise.resolve()
    if (timeoutMs <= 0) return Promise.reject(new Error(this.disconnectedReason()))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((entry) => entry !== onReady)
        reject(new Error('Timed out waiting for the Figma panel to connect.'))
      }, timeoutMs)
      const onReady = () => {
        clearTimeout(timer)
        resolve()
      }
      this.waiters.push(onReady)
    })
  }

  disconnectedReason() {
    if (this.listenError) {
      return this.listenError.code === 'EADDRINUSE'
        ? `Port ${this.port} is already taken — another copy of the bridge is probably running. Close it, or set FIGMA_BRIDGE_PORT to a free port in both .mcp.json and the plugin's Claude tab.`
        : `The bridge could not open ws://localhost:${this.port}: ${this.listenError.message}`
    }
    return 'No Figma panel is connected. In Figma, run Plugins → Development → Figma to Claude — the panel connects on its own.'
  }

  async call(command, params = {}, { timeoutMs = 60_000, onProgress } = {}) {
    await this.waitForPanel()
    const client = this.client
    const id = String(this.nextId++)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`"${command}" did not finish within ${Math.round(timeoutMs / 1000)}s.`))
      }, timeoutMs)

      this.pending.set(id, { client, resolve, reject, timer, onProgress })
      client.socket.send(JSON.stringify({ v: PROTOCOL, id, command, params }))
    })
  }

  close() {
    for (const client of this.clients) client.socket.close()
    for (const server of this.servers) server.close()
  }
}
