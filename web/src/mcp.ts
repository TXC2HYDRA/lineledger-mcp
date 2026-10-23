import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js'

export type ToolResult = {
  isError?: boolean
  structuredContent?: Record<string, any>
  content: { type: string; text?: string }[]
}

// Same-origin /mcp (Vite proxies it to the server), so no CORS is needed.
// Works against both server modes. Stateless: no session, nothing to recover. Stateful: the server
// issues a session id, pushes "data_changed" notices on the GET stream, and answers 404 for a session
// it no longer knows (after a restart). The SDK client does not re-initialize on that 404 by itself
// (modelcontextprotocol/typescript-sdk issue #1708), so call() reconnects once and retries.
export class McpConnection {
  private client!: Client
  private reconnecting: Promise<void> | undefined
  private baseUrl = ''
  protocolVersion: string | undefined
  sessionId: string | undefined
  /** Called when the server says a resource changed (stateful mode only). */
  onChange: (resource: string) => void = () => {}
  /** Called after the connection was re-established following a lost session. */
  onReconnect: () => void = () => {}

  async connect(baseUrl: string = location.href): Promise<void> {
    this.baseUrl = baseUrl
    const client = new Client({ name: 'lineledger-web', version: '0.1.0' })
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      const data = n.params.data as { event?: string; resource?: string } | undefined
      if (data?.event === 'data_changed' && data.resource) this.onChange(data.resource)
    })
    // The push stream drops when the server restarts; the next call() reconnects, so just stay quiet here.
    client.onerror = () => {}
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl))
    await client.connect(transport)
    void this.client?.close().catch(() => {})
    this.client = client
    this.protocolVersion = transport.protocolVersion
    this.sessionId = transport.sessionId
  }

  private async recover<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (e) {
      // 404 = the server forgot the session. TypeError = fetch failed outright, for example on a socket
      // that died with the old server. In both cases one fresh session and one retry; a real outage
      // makes the reconnect throw its own error.
      const lost = (e instanceof StreamableHTTPError && e.code === 404) || e instanceof TypeError
      if (!this.sessionId || !lost) throw e
      this.reconnecting ??= this.connect(this.baseUrl)
        .then(() => this.onReconnect())
        .finally(() => (this.reconnecting = undefined))
      await this.reconnecting
      return run()
    }
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return (await this.recover(() => this.client.callTool({ name, arguments: args }))) as ToolResult
  }

  async close(): Promise<void> {
    await this.client?.close()
  }

  async listTools() {
    return (await this.recover(() => this.client.listTools())).tools
  }
}
