// Server-side trace tap: every JSON-RPC message in and out of /mcp is recorded here and
// streamed to the UI, so the trace panel can only show traffic that really happened.
export interface TraceEntry {
  id: number
  ts: string
  dir: 'in' | 'out'
  message: unknown
}

export class TraceTap {
  private entries: TraceEntry[] = []
  private nextId = 1
  private listeners = new Set<(entry: TraceEntry) => void>()

  constructor(private readonly max = 2000) {} // stateful push adds a notification and a read per update

  record(dir: 'in' | 'out', message: unknown): TraceEntry {
    const entry: TraceEntry = { id: this.nextId++, ts: new Date().toISOString(), dir, message }
    this.entries.push(entry)
    if (this.entries.length > this.max) this.entries.shift()
    for (const listener of this.listeners) listener(entry)
    return entry
  }

  list(sinceId = 0): TraceEntry[] {
    return this.entries.filter((entry) => entry.id > sinceId)
  }

  subscribe(listener: (entry: TraceEntry) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
