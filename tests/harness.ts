// Store harnesses for the shared server tests. SQLite always runs. DynamoDB runs when
// LINELEDGER_TEST_DYNAMODB_ENDPOINT points at a local DynamoDB (for example http://127.0.0.1:8000);
// every test gets its own new table, deleted afterwards. No AWS account is involved.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { createLocalTable, deleteLocalTable, DynamoDbStore, keys, localClient } from '../server/store-dynamodb.js'
import { SqliteStore } from '../server/store-sqlite.js'
import type { ShiftOutputRow, Store, StoreKind } from '../server/store.js'

export interface Harness {
  name: StoreKind
  /** A new, seeded, empty-of-user-data store. */
  open(): Promise<Store>
  /** Two opens of the same storage, to test persistence across a restart. */
  reopenable(): Promise<{ open(): Promise<Store>; cleanup(): Promise<void> }>
  putShift(store: Store, row: ShiftOutputRow): Promise<void>
  setOnHand(store: Store, sku: string, onHand: number): Promise<void>
  dispose(store: Store): Promise<void>
}

const sqlite: Harness = {
  name: 'sqlite',
  open: async () => SqliteStore.open(),
  reopenable: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lineledger-'))
    const file = join(dir, 'test.sqlite')
    return { open: async () => SqliteStore.open(file), cleanup: async () => rmSync(dir, { recursive: true, force: true }) }
  },
  putShift: async (store, r) => {
    ;(store as SqliteStore).db
      .prepare('INSERT INTO shift_output VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.line_id, r.shift_date, r.shift, r.target_units, r.produced_units, r.downtime_min)
  },
  setOnHand: async (store, sku, onHand) => {
    ;(store as SqliteStore).db.prepare('UPDATE stock_items SET on_hand = ? WHERE sku = ?').run(onHand, sku)
  },
  dispose: (store) => store.close(),
}

export const DYNAMODB_ENDPOINT = process.env.LINELEDGER_TEST_DYNAMODB_ENDPOINT

function dynamodb(endpoint: string): Harness {
  const newTable = async () => {
    const table = `lineledger-test-${randomUUID()}`
    await createLocalTable(endpoint, table)
    return table
  }
  const openOn = async (table: string) => {
    const store = new DynamoDbStore({ client: localClient(endpoint), table })
    await store.ensureSeeded()
    return store
  }
  return {
    name: 'dynamodb',
    open: async () => openOn(await newTable()),
    reopenable: async () => {
      const table = await newTable()
      return { open: () => openOn(table), cleanup: () => deleteLocalTable(endpoint, table) }
    },
    putShift: async (store, row) => {
      const s = store as DynamoDbStore
      await s.doc.send(new PutCommand({ TableName: s.table, Item: { ...keys.shift(row), ...row } }))
    },
    setOnHand: async (store, sku, onHand) => {
      const s = store as DynamoDbStore
      await s.doc.send(
        new UpdateCommand({ TableName: s.table, Key: keys.stock(sku), UpdateExpression: 'SET on_hand = :n', ExpressionAttributeValues: { ':n': onHand } }),
      )
    },
    dispose: async (store) => {
      const table = (store as DynamoDbStore).table
      await store.close()
      await deleteLocalTable(endpoint, table)
    },
  }
}

export const HARNESSES: Harness[] = [sqlite, ...(DYNAMODB_ENDPOINT ? [dynamodb(DYNAMODB_ENDPOINT)] : [])]
