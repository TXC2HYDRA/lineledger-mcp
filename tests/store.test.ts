import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dynamoClientFromEnv, requireLoopbackEndpoint, requireProjectProfile } from '../server/store-dynamodb.js'
import { openStore, storeKind, type Store } from '../server/store.js'
import { DYNAMODB_ENDPOINT, HARNESSES } from './harness.js'

describe.each(HARNESSES)('$name store', (h) => {
  let store: Store
  beforeEach(async () => {
    store = await h.open()
  })
  afterEach(async () => {
    await h.dispose(store)
  })

  it('continues ids after the seed and never repeats one under concurrent writes', async () => {
    const created_at = new Date().toISOString()
    const notes = await Promise.all(Array.from({ length: 8 }, (_, i) => store.addNote({ line_id: null, author: 'T', text: `n${i}`, created_at })))
    expect(notes.map((n) => n.id).sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7, 8, 9, 10])
    const followUp = await store.addFollowUp({ title: 't', owner: 'o', line_id: 'L1', due_date: null, created_at })
    expect(followUp.id).toBe(3)
    // same created_at: newest first falls back to id order
    expect((await store.listNotes({ limit: 3 })).map((n) => n.id)).toEqual([10, 9, 8])
  })

  it('closes a follow-up once and tells not-found from already-closed', async () => {
    const closed = await store.closeFollowUp(1, '2026-10-22T10:00:00.000Z')
    expect(closed).toMatchObject({ id: 1, status: 'closed', closed_at: '2026-10-22T10:00:00.000Z', owner: 'Ravi' })
    expect(await store.closeFollowUp(1, '2026-10-22T11:00:00.000Z')).toBe('already_closed')
    expect(await store.closeFollowUp(424242, '2026-10-22T11:00:00.000Z')).toBe('not_found')
    expect((await store.listFollowUps({ status: 'closed' })).map((f) => f.closed_at)).toEqual(['2026-10-22T10:00:00.000Z'])
  })

  it('keeps the simulation state: none at first, then the latest text', async () => {
    expect(await store.getSimState()).toBeUndefined()
    await store.putSimState('{"n":1}')
    await store.putSimState('{"n":2,"big":"' + 'x'.repeat(100_000) + '"}')
    expect(JSON.parse((await store.getSimState())!).n).toBe(2)
  })

  it('sorts follow-ups by due date with no due date last, then id', async () => {
    const created_at = '2026-10-22T09:00:00.000Z'
    await store.addFollowUp({ title: 'no date', owner: 'o', line_id: null, due_date: null, created_at })
    await store.addFollowUp({ title: 'early', owner: 'o', line_id: 'L1', due_date: '2026-10-01', created_at })
    await store.addFollowUp({ title: 'same day', owner: 'o', line_id: null, due_date: '2026-10-22', created_at })
    const titles = (await store.listFollowUps({ status: 'all' })).map((f) => f.title)
    expect(titles).toEqual(['early', 'Re-check Line 2 sealer jaw temperature', 'same day', 'Order spare heater band', 'no date'])
    expect((await store.listFollowUps({ status: 'open', line_id: 'L1' })).map((f) => f.title)).toEqual(['early'])
  })
})

// Every read path must return the same rows from both stores (seeded data plus a few writes).
describe.runIf(DYNAMODB_ENDPOINT)('sqlite and dynamodb return the same rows', () => {
  const [sqlite, dynamodb] = HARNESSES as [(typeof HARNESSES)[0], (typeof HARNESSES)[0]]
  let a: Store
  let b: Store
  beforeEach(async () => {
    a = await sqlite.open()
    b = await dynamodb.open()
    for (const s of [a, b]) {
      await s.addNote({ line_id: 'L1', author: 'T', text: 'later', created_at: '2026-10-22T07:00:00.000Z' })
      await s.addNote({ line_id: null, author: 'T', text: 'no line', created_at: '2026-10-21T07:00:00.000Z' })
      await s.addFollowUp({ title: 'x', owner: 'o', line_id: 'L1', due_date: null, created_at: '2026-10-22T07:00:00.000Z' })
      await s.closeFollowUp(2, '2026-10-22T08:00:00.000Z')
    }
    await sqlite.putShift(a, { line_id: 'L1', shift_date: '2026-10-21', shift: 'C', target_units: 1, produced_units: 1, downtime_min: 0 })
    await dynamodb.putShift(b, { line_id: 'L1', shift_date: '2026-10-21', shift: 'C', target_units: 1, produced_units: 1, downtime_min: 0 })
  })
  afterEach(async () => {
    await sqlite.dispose(a)
    await dynamodb.dispose(b)
  })

  const same = async <T>(read: (s: Store) => Promise<T>) => {
    const [x, y] = await Promise.all([read(a), read(b)])
    expect(y).toEqual(x)
    return x
  }

  it('shifts', async () => {
    for (const filter of [{}, { shift: 'A' }, { shift: 'C' }, { shift_date: '2026-10-18' }, { shift_date: '2026-10-18', shift: 'B' }, { shift_date: '2020-01-01' }]) {
      await same((s) => s.latestShift(filter))
    }
    expect(await same((s) => s.latestShift({}))).toEqual({ shift_date: '2026-10-21', shift: 'C' })
    await same((s) => s.shiftLines('2026-10-21', 'A'))
    expect((await same((s) => s.shiftLines('2026-10-21', 'C'))).map((r) => r.line_id)).toEqual(['L1'])
    for (const limit of [1, 2, 3, 14, 15, 60]) await same((s) => s.recentShifts(limit))
  })

  it('notes, follow-ups and stock', async () => {
    for (const limit of [1, 2, 3, 50]) {
      await same((s) => s.listNotes({ limit }))
      await same((s) => s.listNotes({ line_id: 'L1', limit }))
    }
    await same((s) => s.listNotes({ line_id: 'L9', limit: 10 }))
    for (const status of ['open', 'closed', 'all'] as const) {
      await same((s) => s.listFollowUps({ status }))
      await same((s) => s.listFollowUps({ status, line_id: 'L2' }))
    }
    for (const q of ['hdpe', 'HEATER', 'l', 'STL-040', '-', 'nothing-like-this']) await same((s) => s.findStock(q))
    for (const id of ['L1', 'L2', 'L9', '']) await same((s) => s.lineExists(id))
  })
})

describe('store selection and AWS guards (no network)', () => {
  const home = '/home/someone'
  const project = {
    HOME: home,
    AWS_PROFILE: 'lineledger',
    AWS_CONFIG_FILE: `${home}/.aws-lineledger/config`,
    AWS_SHARED_CREDENTIALS_FILE: `${home}/.aws-lineledger/credentials`,
  }

  it('LINELEDGER_STORE defaults to sqlite and rejects unknown values', () => {
    expect(storeKind(undefined)).toBe('sqlite')
    expect(storeKind(' DynamoDB ')).toBe('dynamodb')
    expect(() => storeKind('postgres')).toThrow(/LINELEDGER_STORE/)
  })

  it('accepts only the project profile and files inside ~/.aws-lineledger/', () => {
    expect(() => requireProjectProfile(project)).not.toThrow()
    expect(() => requireProjectProfile({ ...project, AWS_CONFIG_FILE: '~/.aws-lineledger/config' })).not.toThrow()
    const bad: Record<string, string | undefined>[] = [
      { AWS_PROFILE: undefined },
      { AWS_PROFILE: 'default' },
      { AWS_CONFIG_FILE: undefined },
      { AWS_SHARED_CREDENTIALS_FILE: `${home}/.aws/credentials` },
      { AWS_CONFIG_FILE: `${home}/.aws-lineledger-evil/config` },
      { AWS_CONFIG_FILE: `${home}/.aws-lineledger/../.aws/config` },
      { AWS_ACCESS_KEY_ID: 'test-not-a-real-key' },
      { AWS_SESSION_TOKEN: 'x' },
    ]
    for (const change of bad) expect(() => requireProjectProfile({ ...project, ...change }), JSON.stringify(change)).toThrow()
  })

  it('DynamoDB Local endpoints must be loopback', () => {
    for (const ok of ['http://127.0.0.1:8000', 'http://localhost:8000', 'http://[::1]:8000']) expect(requireLoopbackEndpoint(ok)).toBe(ok)
    for (const bad of ['https://dynamodb.us-east-1.amazonaws.com', 'http://10.0.0.5:8000', 'not a url']) {
      expect(() => requireLoopbackEndpoint(bad)).toThrow(/LINELEDGER_DYNAMODB_ENDPOINT/)
    }
  })

  it('refuses to build a real AWS client without the project profile, before any network call', async () => {
    expect(() => dynamoClientFromEnv({ HOME: home })).toThrow(/AWS_PROFILE/)
    expect(() => dynamoClientFromEnv({ ...project, LINELEDGER_AWS_REGION: 'moon-1' })).toThrow(/Region/)
    expect(() => dynamoClientFromEnv({ ...project, LINELEDGER_DYNAMODB_TABLE: 'a b' })).toThrow(/table name/)
    await expect(openStore({ LINELEDGER_STORE: 'dynamodb', HOME: home })).rejects.toThrow(/AWS_PROFILE/)
    const local = dynamoClientFromEnv({ LINELEDGER_DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000' })
    expect(local.target).toBe('DynamoDB Local http://127.0.0.1:8000')
    expect(local.table).toBe('lineledger')
    local.client.destroy()
    const aws = dynamoClientFromEnv(project)
    expect(aws.target).toBe('Amazon DynamoDB us-east-1')
    expect(await aws.client.config.region()).toBe('us-east-1')
    aws.client.destroy()
  })
})
