import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export type ToolResult = {
  isError?: boolean
  structuredContent?: Record<string, any>
  content: { type: string; text?: string }[]
}

// Same-origin /mcp (Vite proxies it to the server), so no CORS is needed.
export class McpConnection {
  private client = new Client({ name: 'lineledger-web', version: '0.1.0' })
  protocolVersion: string | undefined

  async connect(): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', location.href))
    await this.client.connect(transport)
    this.protocolVersion = transport.protocolVersion
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return (await this.client.callTool({ name, arguments: args })) as ToolResult
  }

  async listTools() {
    return (await this.client.listTools()).tools
  }
}
