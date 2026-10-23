import { PublishCommand } from '@aws-sdk/client-sns'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../server/app.js'
import { cleanSubject, openNotifier, requireTopicArn, SnsNotifier, type AlertEvent } from '../server/notify.js'
import { buildShiftReport } from '../server/report.js'
import { SqliteStore } from '../server/store-sqlite.js'

const ARN = 'arn:aws:sns:us-east-1:123456789012:lineledger-alerts'

describe('SnsNotifier', () => {
  it('publishes to the topic with a one-line subject of at most 100 characters', async () => {
    const send = vi.fn().mockResolvedValue({})
    await new SnsNotifier({ send }, ARN).publish({ subject: `a\nb ${'x'.repeat(200)}`, message: 'm' })
    const input = (send.mock.calls[0]![0] as PublishCommand).input
    expect(input.TopicArn).toBe(ARN)
    expect(input.Subject).toHaveLength(100)
    expect(input.Subject).not.toMatch(/\n/)
    expect(cleanSubject('  a \n b ')).toBe('a b')
  })

  it('logs and swallows a publish failure', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(new SnsNotifier({ send: vi.fn().mockRejectedValue(new Error('boom')) }, ARN).publish({ subject: 's', message: 'm' })).resolves.toBeUndefined()
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })
})

describe('openNotifier', () => {
  it('is off by default and refuses unknown modes', () => {
    expect(openNotifier({}).kind).toBe('none')
    expect(() => openNotifier({ LINELEDGER_NOTIFY: 'sqs' })).toThrow(/none or sns/)
  })
  it('refuses a bad topic ARN and a missing project profile', () => {
    expect(() => requireTopicArn('arn:aws:sns:us-east-1:123:x')).toThrow(/not an SNS topic ARN/)
    expect(requireTopicArn(ARN).region).toBe('us-east-1')
    expect(() => openNotifier({ LINELEDGER_NOTIFY: 'sns', LINELEDGER_SNS_TOPIC_ARN: ARN, AWS_PROFILE: 'default' })).toThrow(/AWS_PROFILE must be "lineledger"/)
  })
})

describe('follow-up alert through the MCP server', () => {
  it('publishes once per new follow-up, and not for reads', async () => {
    const events: AlertEvent[] = []
    const store = SqliteStore.open()
    const app = createApp({ store, notifier: { kind: 'sns', publish: async (e) => void events.push(e) }, allowedOrigins: [] })
    const http = await new Promise<import('node:http').Server>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s))
    })
    const client = new Client({ name: 't', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`)))
    await client.callTool({ name: 'list_follow_ups', arguments: {} })
    expect(events).toHaveLength(0)
    await client.callTool({ name: 'create_follow_up', arguments: { title: 'Re-check guard', owner: 'Ravi', line_id: 'L1' } })
    expect(events).toHaveLength(1)
    expect(events[0]!.message).toContain('Owner: Ravi')
    await client.close()
    http.close()
    await store.close()
  })
})

describe('buildShiftReport', () => {
  it('summarises the latest shift, stock to reorder and overdue follow-ups', async () => {
    const store = SqliteStore.open()
    const report = await buildShiftReport(store, '2999-01-01')
    expect(report.subject).toMatch(/^LineLedger shift \d{4}-\d\d-\d\d [ABC]: \d line\(s\) need attention, \d to reorder$/)
    expect(report.message).toContain('L1 Line 1')
    expect(report.message).toMatch(/Open follow-ups: \d+, overdue: \d+/)
    await store.close()
  })
})
