import { expect, test, type Page } from '@playwright/test'

// One server for the whole file; the tests run in order and share its data.
test.describe.configure({ mode: 'serial' })

const STORE = process.env.LINELEDGER_TEST_DYNAMODB_ENDPOINT ? 'Amazon DynamoDB' : 'SQLite'

async function open(page: Page) {
  await page.goto('/')
  await expect(page.locator('#conn')).toHaveAttribute('data-state', 'connected')
  await expect(page.locator('#live-L1 .live-state')).toBeVisible()
}

/** Types a request into the composer and returns the assistant's reply. */
async function say(page: Page, text: string): Promise<string> {
  const entries = page.locator('#transcript li')
  const before = await entries.count()
  await page.fill('#text', text)
  await page.press('#text', 'Enter')
  await expect(entries).toHaveCount(before + 2)
  return (await entries.last().textContent()) ?? ''
}

test('the page opens a stateful MCP session and the simulation pushes live updates', async ({ page }) => {
  await open(page)
  await expect(page.locator('#conn-text')).toHaveText(new RegExp(`protocol 2025-11-25 · session [0-9a-f]{8} · store: ${STORE}`))
  await expect(page.locator('#conn')).toHaveAttribute('data-session', /^[0-9a-f-]{36}$/)
  await expect(page.locator('#live-L1 .live-state')).toHaveText(/LIVE RUNNING/)
  await expect(page.locator('#live-L1 .stations li')).toHaveText([/Slitter/, /Press/, /Packer/])
  // Plant time moves without any action on the page: the server pushes resource updates over the session.
  const clock = page.locator('#live-clock')
  await expect(clock).toContainText('Plant time')
  const first = await clock.textContent()
  await expect.poll(() => clock.textContent(), { timeout: 5_000 }).not.toBe(first)
  await expect(page.locator('#events li').last()).toContainText('Shift A started')
})

test('a station fault and its repair, with the JSON-RPC trace', async ({ page }) => {
  await open(page)
  await page.locator('#live-L1 .live-actions button', { hasText: 'Simulate fault' }).click()
  await expect(page.locator('#live-L1 .live-state')).toHaveText(/LIVE DOWN/)
  await expect(page.locator('#live-L1 .live-detail')).toContainText('Press')
  await expect(page.locator('#live-L1 .stations li[data-state="down"]')).toHaveText(/Press/)
  await expect(page.locator('#transcript li').last()).toContainText('Fault started on L1 Press')
  await expect(page.locator('#events li').first()).toContainText('L1 Press down')

  await page.locator('#live-L1 .live-actions button', { hasText: 'Clear fault' }).click()
  await expect(page.locator('#live-L1 .live-state')).toHaveText(/LIVE RUNNING/)
  await expect(page.locator('#transcript li').last()).toContainText('Cleared L1 Press')
  await expect(page.locator('#events li').first()).toContainText('back up')

  await page.locator('#trace-card').click()
  const trace = page.locator('#trace-list')
  await expect(trace).toContainText('tools/call inject_fault')
  await expect(trace).toContainText('tools/call clear_fault')
  await expect(trace).toContainText('← push notifications/resources/updated')
  await expect(trace).toContainText('resources/subscribe')
  await page.locator('#trace-close').click()
})

test('chat requests drive the simulation, stock and the shift records', async ({ page }) => {
  await open(page)
  expect(await say(page, 'receive 2500 kg hdpe')).toContain('Received 2500 of PLY-HDPE')
  expect(await say(page, 'stop line 1')).toContain('L1 stopped')
  await expect(page.locator('#live-L1 .live-state')).toHaveText(/LIVE STOPPED/)
  expect(await say(page, 'start line 1')).toContain('L1 started')
  await expect(page.locator('#live-L1 .live-state')).toHaveText(/LIVE RUNNING/)

  // A heater band failure needs a spare part, which is out of stock in the demo data.
  expect(await say(page, 'simulate a heater band failure on the sealer')).toContain('Fault started on L2 Sealer: Heater band failed')
  await expect(page.locator('#live-L2 .live-detail')).toContainText('needs a spare HTR-BAND')
  expect(await say(page, 'clear fault on line 2')).toMatch(/needs a spare HTR-BAND, which is out of stock/)
  await page.locator('#live-L2 .live-actions button', { hasText: 'Receive 6 heater bands' }).click()
  await expect(page.locator('#live-L2 .live-detail')).not.toContainText('needs a spare')
  expect(await say(page, 'clear fault on line 2')).toContain('Cleared L2 Sealer')
  expect(await say(page, 'stock of heater band')).toContain('5 pcs on hand') // 6 received, 1 fitted

  const status = await say(page, 'line status')
  expect(status).toMatch(/Plant time \d\d:\d\d, shift A\. Line 1 running/)
  expect(await say(page, 'factory events for line 2')).toContain('Latest events')
})

test('records persist across a reload, which opens a new session', async ({ page }) => {
  await open(page)
  const session = await page.locator('#conn').getAttribute('data-session')
  expect(await say(page, 'add handover note for line 2: e2e handover check')).toMatch(/Saved handover note \d+ for L2/)
  await expect(page.locator('#notes')).toContainText('e2e handover check')
  await page.locator('#followups button[aria-label^="Close follow-up 1:"]').click()
  await expect(page.locator('#transcript li').last()).toContainText('Closed follow-up 1')

  await page.reload()
  await expect(page.locator('#conn')).toHaveAttribute('data-state', 'connected')
  await expect(page.locator('#conn')).not.toHaveAttribute('data-session', session!)
  await expect(page.locator('#notes')).toContainText('e2e handover check')
  await expect(page.locator('#followups')).not.toContainText('#1 ')
  await expect(page.locator('#followup-count')).toHaveText('1')
})

test('the page reconnects when the server ends its MCP session', async ({ page }) => {
  await open(page)
  const session = (await page.locator('#conn').getAttribute('data-session'))!
  const ended = await page.request.delete('/mcp', { headers: { 'mcp-session-id': session } })
  expect(ended.status()).toBe(200)
  expect((await page.request.post('/mcp', { headers: { 'mcp-session-id': session, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status()).toBe(404)
  expect(await say(page, 'line status')).toContain('Plant time')
  await expect(page.locator('#conn')).not.toHaveAttribute('data-session', session)
  // live updates resume on the new session
  const clock = page.locator('#live-clock')
  const first = await clock.textContent()
  await expect.poll(() => clock.textContent(), { timeout: 5_000 }).not.toBe(first)
})

test('container load uses the open-source planner package', async ({ page }) => {
  await open(page)
  await page.locator('.hero .actions button', { hasText: 'Container load' }).click()
  await expect(page.locator('#transcript li').last()).toContainText(/\d+ boxes fit, limited by geometry/)
  await expect(page.locator('#container')).toContainText('Limited by geometry')
})
