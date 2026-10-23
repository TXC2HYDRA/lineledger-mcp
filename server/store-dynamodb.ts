// Opt-in store (LINELEDGER_STORE=dynamodb): one Amazon DynamoDB table with string keys pk / sk.
//
//   lines        pk=LINE   sk=<line id>
//   shift output pk=OUT    sk=<YYYY-MM-DD>#<shift>#<line id>   (reverse Query = latest shift first)
//   notes        pk=NOTE   sk=N#<created_at ISO>#<id, 10 digits> (reverse Query = newest first)
//   follow-ups   pk=FUP    sk=F#<id, 10 digits>
//   stock        pk=STOCK  sk=<sku>
//   id counters  pk=CTR    sk=note | followup                  (atomic UpdateItem, ids never repeat)
//   seed marker  pk=META   sk=seed
//
// The table is provisioned 5 RCU / 5 WCU with no index, stream, backup or replica (scripts/create-table.sh),
// which stays inside the DynamoDB always-free allowance. Reads are strongly consistent so a note or follow-up
// is visible in the very next list call. Partitions hold demo-sized data; list calls read a whole partition.
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import {
  ConditionalCheckFailedException,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  type CreateTableCommandInput,
} from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { SEED_FOLLOW_UPS, SEED_LINES, SEED_NOTES, SEED_SHIFT_OUTPUT, SEED_STOCK, seedHistory } from './seed.js'
import type { FollowUpRow, LineRow, NoteRow, ShiftLineRow, ShiftOutputRow, StockRow, Store } from './store.js'

export const PROJECT_PROFILE = 'lineledger'
export const DEFAULT_TABLE = 'lineledger'
export const DEFAULT_REGION = 'us-east-1'
const SEED_VERSION = 1
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const KEY_VARIABLES = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN']
const REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-\d$/
const TABLE_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/

type Item = Record<string, unknown>
type Key = { pk: string; sk: string }

const pad = (id: number) => String(id).padStart(10, '0')
export const keys = {
  line: (id: string): Key => ({ pk: 'LINE', sk: id }),
  shift: (r: Pick<ShiftOutputRow, 'shift_date' | 'shift' | 'line_id'>): Key => ({ pk: 'OUT', sk: `${r.shift_date}#${r.shift}#${r.line_id}` }),
  note: (created_at: string, id: number): Key => ({ pk: 'NOTE', sk: `N#${created_at}#${pad(id)}` }),
  followUp: (id: number): Key => ({ pk: 'FUP', sk: `F#${pad(id)}` }),
  stock: (sku: string): Key => ({ pk: 'STOCK', sk: sku }),
  counter: (name: 'note' | 'followup'): Key => ({ pk: 'CTR', sk: name }),
  seed: { pk: 'META', sk: 'seed' } as Key,
}

const str = (v: unknown) => String(v)
const num = (v: unknown) => Number(v)
const strOrNull = (v: unknown) => (v === undefined || v === null ? null : String(v))
const toLine = (i: Item): LineRow => ({ id: str(i.id), name: str(i.name), product: str(i.product) })
const toShift = (i: Item): ShiftOutputRow => ({
  line_id: str(i.line_id),
  shift_date: str(i.shift_date),
  shift: str(i.shift),
  target_units: num(i.target_units),
  produced_units: num(i.produced_units),
  downtime_min: num(i.downtime_min),
})
const toNote = (i: Item): NoteRow => ({
  id: num(i.id),
  line_id: strOrNull(i.line_id),
  author: str(i.author),
  text: str(i.text),
  created_at: str(i.created_at),
})
const toFollowUp = (i: Item): FollowUpRow => ({
  id: num(i.id),
  title: str(i.title),
  owner: str(i.owner),
  line_id: strOrNull(i.line_id),
  due_date: strOrNull(i.due_date),
  status: i.status === 'closed' ? 'closed' : 'open',
  created_at: str(i.created_at),
  closed_at: strOrNull(i.closed_at),
})
const toStock = (i: Item): StockRow => ({
  sku: str(i.sku),
  name: str(i.name),
  unit: str(i.unit),
  on_hand: num(i.on_hand),
  reorder_point: num(i.reorder_point),
  reorder_qty: num(i.reorder_qty),
  lead_days: num(i.lead_days),
  supplier: str(i.supplier),
})

// Same order as SQLite's ORDER BY due_date IS NULL, due_date, id (binary string comparison).
const byDueDate = (a: FollowUpRow, b: FollowUpRow): number => {
  if ((a.due_date === null) !== (b.due_date === null)) return a.due_date === null ? 1 : -1
  if (a.due_date !== b.due_date) return a.due_date! < b.due_date! ? -1 : 1
  return a.id - b.id
}

const isConditionalFailure = (error: unknown) =>
  error instanceof ConditionalCheckFailedException || (error as { name?: string })?.name === 'ConditionalCheckFailedException'

export class DynamoDbStore implements Store {
  readonly kind = 'dynamodb' as const
  readonly table: string
  readonly doc: DynamoDBDocumentClient
  private readonly client: DynamoDBClient

  constructor({ client, table }: { client: DynamoDBClient; table: string }) {
    this.client = client
    this.table = table
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } })
  }

  private async get(key: Key): Promise<Item | undefined> {
    const { Item } = await this.doc.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }))
    return Item
  }

  /** One Query page at a time over a partition, optionally limited to a sort-key prefix. */
  private async *pages(pk: string, opts: { prefix?: string; forward?: boolean; pageSize?: number } = {}): AsyncGenerator<Item[]> {
    let ExclusiveStartKey: Item | undefined
    do {
      const page = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: opts.prefix ? 'pk = :pk AND begins_with(sk, :prefix)' : 'pk = :pk',
          ExpressionAttributeValues: opts.prefix ? { ':pk': pk, ':prefix': opts.prefix } : { ':pk': pk },
          ScanIndexForward: opts.forward ?? true,
          Limit: opts.pageSize,
          ExclusiveStartKey,
          ConsistentRead: true,
        }),
      )
      yield page.Items ?? []
      ExclusiveStartKey = page.LastEvaluatedKey
    } while (ExclusiveStartKey)
  }

  private async all(pk: string, opts: { prefix?: string; forward?: boolean } = {}): Promise<Item[]> {
    const items: Item[] = []
    for await (const page of this.pages(pk, opts)) items.push(...page)
    return items
  }

  private async lineMap(): Promise<Map<string, LineRow>> {
    return new Map((await this.all('LINE')).map((i) => [str(i.id), toLine(i)]))
  }

  /** Atomic counter: ids only ever increase, so a retried write can skip a number but never repeat one. */
  private async nextId(name: 'note' | 'followup'): Promise<number> {
    const { Attributes } = await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: keys.counter(name),
        UpdateExpression: 'SET #n = if_not_exists(#n, :zero) + :one',
        ExpressionAttributeNames: { '#n': 'n' },
        ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
        ReturnValues: 'UPDATED_NEW',
      }),
    )
    return num(Attributes?.n)
  }

  private async putNew(item: Item): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: item, ConditionExpression: 'attribute_not_exists(pk)' }))
  }

  async lineExists(id: string): Promise<boolean> {
    if (id === '') return false // an empty string is not a valid DynamoDB key value
    return (await this.get(keys.line(id))) !== undefined
  }

  async latestShift({ shift_date, shift }: { shift_date?: string; shift?: string }) {
    const prefix = shift_date ? `${shift_date}#` : undefined
    for await (const page of this.pages('OUT', { prefix, forward: false, pageSize: shift ? 50 : 1 })) {
      const hit = page.find((i) => shift === undefined || i.shift === shift)
      if (hit) return { shift_date: str(hit.shift_date), shift: str(hit.shift) }
    }
    return undefined
  }

  async shiftLines(shift_date: string, shift: string): Promise<ShiftLineRow[]> {
    const [rows, lines] = await Promise.all([this.all('OUT', { prefix: `${shift_date}#${shift}#` }), this.lineMap()])
    return rows.flatMap((i) => {
      const line = lines.get(str(i.line_id))
      return line ? [{ ...toShift(i), name: line.name, product: line.product }] : [] // inner join, as in SQL
    })
  }

  async recentShifts(limit: number): Promise<(ShiftOutputRow & { name: string })[]> {
    const shifts: string[] = []
    const rows: Item[] = []
    newestFirst: for await (const page of this.pages('OUT', { forward: false, pageSize: 100 })) {
      for (const i of page) {
        const shiftKey = `${str(i.shift_date)}#${str(i.shift)}`
        if (shifts.at(-1) !== shiftKey) {
          if (shifts.length === limit) break newestFirst
          shifts.push(shiftKey)
        }
        rows.push(i)
      }
    }
    const lines = await this.lineMap()
    return rows.reverse().flatMap((i) => {
      const line = lines.get(str(i.line_id))
      return line ? [{ ...toShift(i), name: line.name }] : []
    })
  }

  async addNote({ line_id, author, text, created_at }: Omit<NoteRow, 'id'>): Promise<NoteRow> {
    const note: NoteRow = { id: await this.nextId('note'), line_id, author, text, created_at }
    await this.putNew({ ...keys.note(created_at, note.id), ...note })
    return note
  }

  async listNotes({ line_id, limit }: { line_id?: string; limit: number }): Promise<NoteRow[]> {
    const notes: NoteRow[] = []
    for await (const page of this.pages('NOTE', { forward: false, pageSize: line_id ? 100 : limit })) {
      for (const i of page) {
        if (line_id !== undefined && i.line_id !== line_id) continue
        notes.push(toNote(i))
        if (notes.length === limit) return notes
      }
    }
    return notes
  }

  async addFollowUp({ title, owner, line_id, due_date, created_at }: Pick<FollowUpRow, 'title' | 'owner' | 'line_id' | 'due_date' | 'created_at'>): Promise<FollowUpRow> {
    const row: FollowUpRow = { id: await this.nextId('followup'), title, owner, line_id, due_date, status: 'open', created_at, closed_at: null }
    await this.putNew({ ...keys.followUp(row.id), ...row })
    return row
  }

  async listFollowUps({ status, line_id }: { status: 'open' | 'closed' | 'all'; line_id?: string }): Promise<FollowUpRow[]> {
    return (await this.all('FUP'))
      .map(toFollowUp)
      .filter((f) => (status === 'all' || f.status === status) && (line_id === undefined || f.line_id === line_id))
      .sort(byDueDate)
  }

  async closeFollowUp(id: number, closed_at: string): Promise<FollowUpRow | 'not_found' | 'already_closed'> {
    try {
      const { Attributes } = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: keys.followUp(id),
          UpdateExpression: 'SET #status = :closed, closed_at = :at',
          ConditionExpression: 'attribute_exists(pk) AND #status = :open',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':closed': 'closed', ':open': 'open', ':at': closed_at },
          ReturnValues: 'ALL_NEW',
        }),
      )
      return toFollowUp(Attributes ?? {})
    } catch (error) {
      if (!isConditionalFailure(error)) throw error
      return (await this.get(keys.followUp(id))) ? 'already_closed' : 'not_found'
    }
  }

  async findStock(query: string): Promise<StockRow[]> {
    const q = query.toLowerCase()
    return (await this.all('STOCK'))
      .map(toStock)
      .filter((s) => s.sku.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
  }

  async putShiftOutput(row: ShiftOutputRow): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...keys.shift(row), ...toShift(row as unknown as Item) } }))
  }

  async setStockOnHand(sku: string, onHand: number): Promise<void> {
    if (sku === '') return
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: keys.stock(sku),
        UpdateExpression: 'SET on_hand = :n',
        ConditionExpression: 'attribute_exists(pk)', // never create a stock item from a stray update
        ExpressionAttributeValues: { ':n': onHand },
      }),
    ).catch((error: unknown) => {
      if (!isConditionalFailure(error)) throw error
    })
  }

  async addLine(line: LineRow): Promise<void> {
    await this.putNew({ ...keys.line(line.id), ...line }).catch((error: unknown) => {
      if (!isConditionalFailure(error)) throw error
    })
  }

  async putStockItem(item: StockRow): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...keys.stock(item.sku), ...toStock(item as unknown as Item) } }))
  }

  /** Writes the synthetic demo data once per table. Returns true when it seeded. */
  async ensureSeeded(): Promise<boolean> {
    if (await this.get(keys.seed)) return false
    const items: Item[] = [
      ...SEED_LINES.map((l) => ({ ...keys.line(l.id), ...l })),
      ...[...SEED_SHIFT_OUTPUT, ...seedHistory()].map((r) => ({ ...keys.shift(r), ...r })),
      ...SEED_NOTES.map((n, i) => ({ ...keys.note(n.created_at, i + 1), id: i + 1, ...n })),
      ...SEED_FOLLOW_UPS.map((f, i) => ({ ...keys.followUp(i + 1), id: i + 1, ...f, status: 'open', closed_at: null })),
      ...SEED_STOCK.map((s) => ({ ...keys.stock(s.sku), ...s })),
    ]
    // A few writes at a time: a new 5 WCU table has little burst capacity. Existing items are kept.
    for (let i = 0; i < items.length; i += 4) {
      await Promise.all(
        items.slice(i, i + 4).map((item) =>
          this.putNew(item).catch((error: unknown) => {
            if (!isConditionalFailure(error)) throw error
          }),
        ),
      )
    }
    const startAt = (name: 'note' | 'followup', n: number) =>
      this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: keys.counter(name),
          UpdateExpression: 'SET #n = if_not_exists(#n, :n)',
          ExpressionAttributeNames: { '#n': 'n' },
          ExpressionAttributeValues: { ':n': n },
        }),
      )
    await startAt('note', SEED_NOTES.length)
    await startAt('followup', SEED_FOLLOW_UPS.length)
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...keys.seed, version: SEED_VERSION, seeded_at: new Date().toISOString() } }))
    return true
  }

  async close(): Promise<void> {
    this.client.destroy()
  }
}

// ---- table definition and clients ----------------------------------------------------------------

/** Provisioned 5/5, no index: the definition scripts/create-table.sh uses on AWS. */
export const tableDefinition = (TableName: string): CreateTableCommandInput => ({
  TableName,
  AttributeDefinitions: [
    { AttributeName: 'pk', AttributeType: 'S' },
    { AttributeName: 'sk', AttributeType: 'S' },
  ],
  KeySchema: [
    { AttributeName: 'pk', KeyType: 'HASH' },
    { AttributeName: 'sk', KeyType: 'RANGE' },
  ],
  BillingMode: 'PROVISIONED',
  ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
})

export function requireLoopbackEndpoint(endpoint: string): string {
  let host: string
  try {
    host = new URL(endpoint).hostname
  } catch {
    throw new Error(`LINELEDGER_DYNAMODB_ENDPOINT is not a URL: ${endpoint}`)
  }
  if (!LOOPBACK.has(host)) throw new Error(`LINELEDGER_DYNAMODB_ENDPOINT must be a loopback URL (DynamoDB Local), got ${endpoint}`)
  return endpoint
}

/**
 * Refuses to reach real AWS unless the project-only profile is used: AWS_PROFILE=lineledger and both
 * AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE inside ~/.aws-lineledger/, with no key variables set.
 * This keeps the machine's default ~/.aws profile from being picked up silently.
 */
export function requireProjectProfile(env: NodeJS.ProcessEnv): void {
  if (env.AWS_PROFILE !== PROJECT_PROFILE) {
    throw new Error(
      `AWS_PROFILE must be "${PROJECT_PROFILE}" for the DynamoDB store, got ${JSON.stringify(env.AWS_PROFILE ?? null)}. ` +
        'For DynamoDB Local set LINELEDGER_DYNAMODB_ENDPOINT instead.',
    )
  }
  const home = env.HOME || homedir()
  const base = resolve(home, '.aws-lineledger')
  for (const name of ['AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']) {
    const value = env[name]
    if (!value) throw new Error(`${name} must be set to a file inside ${base}`)
    const path = resolve(value.replace(/^~(?=$|\/)/, home))
    if (!path.startsWith(base + sep)) throw new Error(`${name} must point inside ${base}, got ${path}`)
  }
  const present = KEY_VARIABLES.filter((k) => env[k] !== undefined)
  if (present.length > 0) throw new Error(`key variables are not allowed, use the project credentials file: ${present.join(', ')}`)
}

export function requireRegion(region: string): string {
  if (!REGION_PATTERN.test(region)) throw new Error(`LINELEDGER_AWS_REGION is not an AWS Region name: ${region}`)
  return region
}

export function localClient(endpoint: string, region = DEFAULT_REGION): DynamoDBClient {
  // DynamoDB Local accepts any credentials; these are placeholders, not keys.
  return new DynamoDBClient({ region, endpoint: requireLoopbackEndpoint(endpoint), credentials: { accessKeyId: 'local', secretAccessKey: 'local' } })
}

export function dynamoClientFromEnv(env: NodeJS.ProcessEnv = process.env): { client: DynamoDBClient; table: string; target: string } {
  const table = env.LINELEDGER_DYNAMODB_TABLE || DEFAULT_TABLE
  if (!TABLE_PATTERN.test(table)) throw new Error(`LINELEDGER_DYNAMODB_TABLE is not a valid table name: ${table}`)
  const region = requireRegion(env.LINELEDGER_AWS_REGION || DEFAULT_REGION)
  const endpoint = env.LINELEDGER_DYNAMODB_ENDPOINT
  if (endpoint) return { client: localClient(endpoint, region), table, target: `DynamoDB Local ${endpoint}` }
  requireProjectProfile(env)
  process.env.AWS_EC2_METADATA_DISABLED = 'true' // never fall back to instance credentials
  return { client: new DynamoDBClient({ region, profile: PROJECT_PROFILE, maxAttempts: 6 }), table, target: `Amazon DynamoDB ${region}` }
}

export async function openDynamoDbStore(env: NodeJS.ProcessEnv = process.env): Promise<DynamoDbStore> {
  const { client, table, target } = dynamoClientFromEnv(env)
  const store = new DynamoDbStore({ client, table })
  try {
    await store.ensureSeeded()
  } catch (error) {
    await store.close()
    const why = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    throw new Error(
      `DynamoDB table "${table}" on ${target} is not usable (${why}). ` +
        'Create it first: scripts/create-table.sh on AWS, or npm run dynamodb:local-table for DynamoDB Local.',
    )
  }
  return store
}

/** For DynamoDB Local only: creates the table and waits until it is ACTIVE. */
export async function createLocalTable(endpoint: string, table: string, region = DEFAULT_REGION): Promise<void> {
  const client = localClient(endpoint, region)
  try {
    await client.send(new CreateTableCommand(tableDefinition(table)))
    for (let i = 0; i < 300; i++) {
      const { Table } = await client.send(new DescribeTableCommand({ TableName: table }))
      if (Table?.TableStatus === 'ACTIVE') return
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`table ${table} did not become ACTIVE`)
  } finally {
    client.destroy()
  }
}

/** For DynamoDB Local only. */
export async function deleteLocalTable(endpoint: string, table: string, region = DEFAULT_REGION): Promise<void> {
  const client = localClient(endpoint, region)
  try {
    await client.send(new DeleteTableCommand({ TableName: table }))
  } finally {
    client.destroy()
  }
}
