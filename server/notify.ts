// Alerts. LINELEDGER_NOTIFY=none (default) | local | sns.
//   sns    one Amazon SNS topic; if SNS fails (or is misconfigured) the alert goes to the local channel instead
//   local  self-hosted: appended to a JSONL file and, if set, POSTed to a webhook (ntfy, Mattermost, Slack-style)
// A notifier never throws into the tool call that triggered it.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns'
import { fallbackOff } from './store.js'
import { PROJECT_PROFILE, requireProjectProfile, requireRegion } from './store-dynamodb.js'

export interface AlertEvent {
  subject: string
  message: string
}

export interface Notifier {
  readonly kind: 'none' | 'sns' | 'local'
  publish(event: AlertEvent): Promise<void>
}

export const noNotifier: Notifier = { kind: 'none', publish: async () => {} }

const TOPIC_ARN = /^arn:aws:sns:([a-z]{2}(?:-gov)?-[a-z]+-\d):\d{12}:[A-Za-z0-9_-]{1,256}$/
const SEND_TIMEOUT_MS = 5000

export function requireTopicArn(arn: string | undefined): { arn: string; region: string } {
  const match = arn ? TOPIC_ARN.exec(arn) : null
  if (!arn || !match) throw new Error(`LINELEDGER_SNS_TOPIC_ARN is not an SNS topic ARN: ${arn ?? 'unset'}`)
  return { arn, region: requireRegion(match[1]!) }
}

/** SNS subjects: one line, at most 100 characters. */
export const cleanSubject = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 100)

/** Throws when the publish fails, so a FallbackNotifier can take over. */
export class SnsNotifier implements Notifier {
  readonly kind = 'sns' as const
  constructor(private readonly client: Pick<SNSClient, 'send'>, private readonly topicArn: string) {}

  async publish({ subject, message }: AlertEvent): Promise<void> {
    await this.client.send(new PublishCommand({ TopicArn: this.topicArn, Subject: cleanSubject(subject), Message: message }), {
      abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
  }
}

export class LocalNotifier implements Notifier {
  readonly kind = 'local' as const
  constructor(private readonly file: string, private readonly webhook?: string) {}

  async publish({ subject, message }: AlertEvent): Promise<void> {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, JSON.stringify({ at: new Date().toISOString(), subject, message }) + '\n')
    } catch (error) {
      console.error(`local alert file failed: ${error instanceof Error ? error.message : error}`)
    }
    if (!this.webhook) return
    try {
      const res = await fetch(this.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject, message, text: `${subject}\n${message}` }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
      if (!res.ok) console.error(`alert webhook returned HTTP ${res.status}`)
    } catch (error) {
      console.error(`alert webhook failed: ${error instanceof Error ? error.message : error}`)
    }
  }
}

/** Tries the primary; on any failure logs it and hands the alert to the fallback. */
export class FallbackNotifier implements Notifier {
  constructor(private readonly primary: Notifier, private readonly fallback: Notifier) {}
  get kind() {
    return this.primary.kind
  }
  async publish(event: AlertEvent): Promise<void> {
    try {
      await this.primary.publish(event)
    } catch (error) {
      console.error(`${this.primary.kind} alert failed, using ${this.fallback.kind}: ${error instanceof Error ? error.name : 'error'}`)
      await this.fallback.publish(event)
    }
  }
}

function openLocal(env: NodeJS.ProcessEnv): LocalNotifier {
  const webhook = env.LINELEDGER_WEBHOOK_URL?.trim()
  if (webhook && !/^https?:\/\//.test(webhook)) throw new Error('LINELEDGER_WEBHOOK_URL must be an http(s) URL')
  return new LocalNotifier(env.LINELEDGER_ALERT_FILE || 'data/alerts.jsonl', webhook || undefined)
}

export function openNotifier(env: NodeJS.ProcessEnv = process.env): Notifier {
  const mode = (env.LINELEDGER_NOTIFY ?? 'none').trim().toLowerCase() || 'none'
  if (mode === 'none') return noNotifier
  if (mode === 'local') return openLocal(env)
  if (mode !== 'sns') throw new Error(`LINELEDGER_NOTIFY must be none, local or sns, got "${env.LINELEDGER_NOTIFY}"`)
  const fallback = fallbackOff(env) ? noNotifier : openLocal(env)
  try {
    const { arn, region } = requireTopicArn(env.LINELEDGER_SNS_TOPIC_ARN)
    requireProjectProfile(env)
    process.env.AWS_EC2_METADATA_DISABLED = 'true' // never fall back to instance credentials
    return new FallbackNotifier(new SnsNotifier(new SNSClient({ region, profile: PROJECT_PROFILE }), arn), fallback)
  } catch (error) {
    if (fallback === noNotifier) throw error
    console.error(`SNS alerts not available (${error instanceof Error ? error.message : error}); using local alerts`)
    return fallback
  }
}
