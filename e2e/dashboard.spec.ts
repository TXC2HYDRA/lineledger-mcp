import { expect, test, type Page } from '@playwright/test'

// One server for the whole file: the Tarnby Works plant profile, story day from 12:55 at x120 (the scripted
// Line 2 sealer trip at 13:23 comes about 14 s after the server starts). Tests run in order and share data.
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

test('the page opens a stateful MCP session and the plant pushes live updates', async ({ page }) => {
  await open(page)
  await expect(page.locator('#conn-text')).toHaveText(new RegExp(`protocol 2025-11-25 · session [0-9a-f]{8} · store: ${STORE}`))
  await expect(page.locator('#conn')).toHaveAttribute('data-session', /^[0-9a-f-]{36}$/)
  await expect(page.locator('#shift article')).toHaveCount(7)
  await expect(page.locator('#live-clock')).toContainText('Tarnby Works (fictional)')
  // The clock moves without any action on the page: the server pushes resource updates over the session.
  const chip = page.locator('#sim-chip')
  await expect(chip).toHaveText(/SIM \d\d:\d\d · ×120/)
  const first = await chip.textContent()
  await expect.poll(() => chip.textContent(), { timeout: 5_000 }).not.toBe(first)
  await expect(page.locator('#events li').first()).toBeVisible()
})

test('the scripted sealer overheat stops Line 2, and the chat and the trace explain it', async ({ page }) => {
  await open(page)
  await expect(page.locator('#live-L2 .live-state')).toHaveText(/STOPPED/, { timeout: 40_000 })
  await expect(page.locator('#live-L2 .live-detail')).toContainText('SEALER_FAULT')
  await expect(page.locator('#live-L2 .signal')).toHaveAttribute('data-level', /trip|warn/)
  await expect(page.locator('#live-L2 .live-alarm')).toContainText('M3-HEAT-OVR')
  await expect(page.locator('#events')).toContainText('M3-HEAT-OVR')

  const why = await say(page, 'why is line 2 down')
  expect(why).toMatch(/Line 2 stopped on a fault, sealer fault for \d+ minutes/)
  expect(why).toContain('M3-HEAT-OVR')

  await page.locator('#trace-card').click()
  const trace = page.locator('#trace-list')
  await expect(trace).toContainText('resources/subscribe')
  await expect(trace).toContainText('← push notifications/resources/updated')
  await expect(trace).toContainText('resources/read')
  await expect(trace).toContainText('tools/call get_live_line_status')
  await page.locator('#trace-close').click()
})

test('the operator questions work through the rule-based planner', async ({ page }) => {
  await open(page)
  expect(await say(page, 'how are the lines doing right now')).toMatch(/Plant time \d\d:\d\d, shift [AB]\. \d+ running/)
  expect(await say(page, 'is the sealer temperature normal')).toMatch(/sealer jaw temp [\d.]+ degrees, warn at 190, trip at 200/)
  expect(await say(page, 'shift summary')).toMatch(/in progress\. Line 1 [\d.]+ percent of target to date/)
  expect(await say(page, 'shift summary for shift A')).toMatch(/Shift A on 2026-10-22/)
  expect(await say(page, 'stock of heater band')).toMatch(/Heater band 230V: [23] pcs on hand/)
  expect(await say(page, 'show the trend for the last 10 shifts')).toMatch(/finished shifts/)
  expect(await say(page, 'receive 20000 kg hdpe')).toContain('Received 20000 kg of PLY-HDPE')
  expect(await say(page, 'add handover note for line 2: sealer jaw ran hot again, tripped 13:23')).toMatch(/Saved handover note \d+ for L2/)
  expect(await say(page, 'add follow-up: inspect sealer thermocouple, owner Ravi, due 2026-10-24, line 2')).toMatch(/Created follow-up \d+: inspect sealer thermocouple/)
  await expect(page.locator('#notes')).toContainText('sealer jaw ran hot again')
})

test('nothing on the page controls a line', async ({ page }) => {
  await open(page)
  for (const text of await page.locator('button').allTextContents()) expect(text).not.toMatch(/simulate|stop line|start line|clear fault/i)
  const reply = await say(page, 'stop line 1')
  expect(reply).not.toMatch(/stopped by|L1 stopped/)
})

test('records persist across a reload, which opens a new session', async ({ page }) => {
  await open(page)
  const session = await page.locator('#conn').getAttribute('data-session')
  await page.locator('#followups button[aria-label^="Close follow-up 1:"]').click()
  await expect(page.locator('#transcript li').last()).toContainText('Closed follow-up 1')
  await page.reload()
  await expect(page.locator('#conn')).toHaveAttribute('data-state', 'connected')
  await expect(page.locator('#conn')).not.toHaveAttribute('data-session', session!)
  await expect(page.locator('#notes')).toContainText('sealer jaw ran hot again')
  await expect(page.locator('#followups')).not.toContainText('#1 ')
})

test('the page reconnects when the server ends its MCP session', async ({ page }) => {
  await open(page)
  const session = (await page.locator('#conn').getAttribute('data-session'))!
  const ended = await page.request.delete('/mcp', { headers: { 'mcp-session-id': session } })
  expect(ended.status()).toBe(200)
  expect((await page.request.post('/mcp', { headers: { 'mcp-session-id': session, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status()).toBe(404)
  expect(await say(page, 'how are the lines doing right now')).toContain('Plant time')
  await expect(page.locator('#conn')).not.toHaveAttribute('data-session', session)
  // live updates resume on the new session
  const chip = page.locator('#sim-chip')
  const first = await chip.textContent()
  await expect.poll(() => chip.textContent(), { timeout: 5_000 }).not.toBe(first)
})

test('container load uses the open-source planner package', async ({ page }) => {
  await open(page)
  await page.locator('.hero .actions button', { hasText: 'Container load' }).click()
  await expect(page.locator('#transcript li').last()).toContainText(/\d+ boxes fit, limited by geometry/)
  await expect(page.locator('#container')).toContainText('Limited by geometry')
})
