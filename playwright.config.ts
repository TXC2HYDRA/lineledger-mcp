// End-to-end tests: a real browser drives the web client, which talks over stateful MCP to the real server
// with the production-line simulation running (random faults off, so every fault in a test is one it made).
// Store: SQLite in memory by default; DynamoDB Local when LINELEDGER_TEST_DYNAMODB_ENDPOINT is set.
// Own ports (8790 and 5190), so a dev server on the default ports can keep running.
import { defineConfig } from '@playwright/test'

const SERVER_PORT = 8790
const WEB_PORT = 5190
const dynamodb = process.env.LINELEDGER_TEST_DYNAMODB_ENDPOINT

const serverEnv: Record<string, string> = {
  PORT: String(SERVER_PORT),
  WEB_PORT: String(WEB_PORT),
  LINELEDGER_DB: ':memory:',
  LINELEDGER_SIM_FAULTS: 'off',
  LINELEDGER_SIM_SPEED: '60',
  ...(dynamodb && {
    LINELEDGER_STORE: 'dynamodb',
    LINELEDGER_DYNAMODB_ENDPOINT: dynamodb,
    LINELEDGER_DYNAMODB_TABLE: process.env.LINELEDGER_E2E_TABLE ?? `lineledger-e2e-${process.pid}`,
  }),
}

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${WEB_PORT}`, viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
  webServer: [
    {
      command: dynamodb ? 'npx tsx scripts/dynamodb.ts create-local && npx tsx server/main.ts' : 'npx tsx server/main.ts',
      url: `http://127.0.0.1:${SERVER_PORT}/api/health`,
      env: serverEnv,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npx vite',
      url: `http://127.0.0.1:${WEB_PORT}`,
      env: { PORT: String(SERVER_PORT), WEB_PORT: String(WEB_PORT) },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
})
