import { describe, expect, it, vi } from 'vitest'
import { FallbackStore } from '../server/store-fallback.js'
import { SqliteStore } from '../server/store-sqlite.js'
import { fallbackOff, type Store } from '../server/store.js'

// A store whose every method fails, like DynamoDB with no network.
const down = (): Store => new Proxy({} as Store, { get: (_t, p) => (p === 'then' ? undefined : p === 'kind' ? 'dynamodb' : () => Promise.reject(new Error('unreachable'))) })

function setup(openPrimary: () => Promise<Store>) {
  let now = 1000
  const secondary = SqliteStore.open()
  const store = new FallbackStore(openPrimary, secondary, { cooldownMs: 100, timeoutMs: 50, now: () => now })
  return { store, tick: (ms: number) => (now += ms) }
}

describe('FallbackStore', () => {
  it('uses the primary while it works', async () => {
    const primary = SqliteStore.open()
    const { store } = setup(async () => primary)
    expect(await store.lineExists('L1')).toBe(true)
    expect(store.degraded).toBe(false)
  })

  it('serves from the secondary when the primary fails, and retries the primary after the cooldown', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const primary = SqliteStore.open()
    const open = vi.fn().mockRejectedValueOnce(new Error('no credentials')).mockResolvedValue(primary)
    const { store, tick } = setup(open)
    // first call: primary cannot open, the call still succeeds from the secondary
    expect(await store.lineExists('L1')).toBe(true)
    expect(store.degraded).toBe(true)
    expect(store.kind).toBe('sqlite')
    expect(open).toHaveBeenCalledTimes(1)
    // during the cooldown the primary is not tried again, writes work
    const note = await store.addNote({ line_id: null, author: 'a', text: 'while down', created_at: new Date().toISOString() })
    expect(note.text).toBe('while down')
    expect(open).toHaveBeenCalledTimes(1)
    // after the cooldown the primary is tried again and used
    tick(101)
    expect(store.degraded).toBe(false)
    expect(await store.lineExists('L1')).toBe(true)
    expect(open).toHaveBeenCalledTimes(2)
    expect(store.kind).toBe('dynamodb')
    log.mockRestore()
  })

  it('falls back when a primary call throws or hangs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const throwing = setup(async () => down())
    expect((await throwing.store.findStock('')).length).toBeGreaterThan(0)
    expect(throwing.store.degraded).toBe(true)
    const hanging = setup(() => new Promise<Store>(() => {}))
    expect(await hanging.store.lineExists('L1')).toBe(true)
    expect(hanging.store.degraded).toBe(true)
    log.mockRestore()
  })

  it('LINELEDGER_FALLBACK=off is read case-insensitively', () => {
    expect(fallbackOff({ LINELEDGER_FALLBACK: ' OFF ' })).toBe(true)
    expect(fallbackOff({})).toBe(false)
  })
})
