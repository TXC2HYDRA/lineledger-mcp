// Keeps the platform answering when the primary store (Amazon DynamoDB) is down or unreachable.
// Every call goes to the primary; if that throws or times out, the call is served by the secondary
// (the local SQLite file) and the primary is skipped until the cooldown ends, then tried again.
// The primary is opened lazily, so a primary that is down at startup is retried too.
//
// ponytail: the two stores are not synced. Rows written while the primary is down exist only in the
// secondary, and the primary's rows are not visible then. Add a replay/sync step if that matters.
import type { FollowUpRow, NoteRow, ShiftLineRow, ShiftOutputRow, StockRow, Store, StoreKind } from './store.js'

export interface FallbackOptions {
  cooldownMs?: number
  timeoutMs?: number
  now?: () => number
}

const withTimeout = <T>(work: () => Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
    work().then(resolve, reject).finally(() => clearTimeout(timer))
  })

export class FallbackStore implements Store {
  private primary?: Store
  private opening?: Promise<Store>
  private downUntil = 0
  private readonly cooldownMs: number
  private readonly timeoutMs: number
  private readonly now: () => number

  constructor(
    private readonly openPrimary: () => Promise<Store>,
    private readonly secondary: Store,
    { cooldownMs = 30_000, timeoutMs = 8_000, now = Date.now }: FallbackOptions = {},
    private readonly primaryKind: StoreKind = 'dynamodb',
  ) {
    this.cooldownMs = cooldownMs
    this.timeoutMs = timeoutMs
    this.now = now
  }

  get degraded(): boolean {
    return this.now() < this.downUntil
  }

  get kind(): StoreKind {
    return this.degraded ? this.secondary.kind : this.primaryKind
  }

  private getPrimary(): Promise<Store> {
    if (this.primary) return Promise.resolve(this.primary)
    this.opening ??= this.openPrimary().then(
      (store) => (this.primary = store),
      (error) => {
        this.opening = undefined
        throw error
      },
    )
    return this.opening
  }

  private async run<T>(call: (store: Store) => Promise<T>): Promise<T> {
    if (!this.degraded) {
      try {
        return await withTimeout(async () => call(await this.getPrimary()), this.timeoutMs)
      } catch (error) {
        this.downUntil = this.now() + this.cooldownMs
        console.error(`${this.primaryKind} store unavailable, using ${this.secondary.kind} for ${this.cooldownMs / 1000} s: ${error instanceof Error ? error.message : error}`)
      }
    }
    return call(this.secondary)
  }

  lineExists = (id: string) => this.run((s) => s.lineExists(id))
  latestShift = (filter: { shift_date?: string; shift?: string }) => this.run((s) => s.latestShift(filter))
  shiftLines = (date: string, shift: string): Promise<ShiftLineRow[]> => this.run((s) => s.shiftLines(date, shift))
  recentShifts = (limit: number): Promise<(ShiftOutputRow & { name: string })[]> => this.run((s) => s.recentShifts(limit))
  addNote = (note: Omit<NoteRow, 'id'>): Promise<NoteRow> => this.run((s) => s.addNote(note))
  listNotes = (filter: { line_id?: string; limit: number }): Promise<NoteRow[]> => this.run((s) => s.listNotes(filter))
  addFollowUp = (f: Parameters<Store['addFollowUp']>[0]): Promise<FollowUpRow> => this.run((s) => s.addFollowUp(f))
  listFollowUps = (filter: Parameters<Store['listFollowUps']>[0]): Promise<FollowUpRow[]> => this.run((s) => s.listFollowUps(filter))
  closeFollowUp = (id: number, closed_at: string) => this.run((s) => s.closeFollowUp(id, closed_at))
  findStock = (query: string): Promise<StockRow[]> => this.run((s) => s.findStock(query))

  async close(): Promise<void> {
    await Promise.allSettled([this.primary?.close(), this.secondary.close()])
  }
}
