// Opt-in alerts (LINELEDGER_NOTIFY=sns): one Amazon SNS topic. Off by default.
// A failed publish is logged and never fails the tool call that caused it.
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns'
import { PROJECT_PROFILE, requireProjectProfile, requireRegion } from './store-dynamodb.js'

export interface AlertEvent {
  subject: string
  message: string
}

export interface Notifier {
  readonly kind: 'none' | 'sns'
  publish(event: AlertEvent): Promise<void>
}

export const noNotifier: Notifier = { kind: 'none', publish: async () => {} }

const TOPIC_ARN = /^arn:aws:sns:([a-z]{2}(?:-gov)?-[a-z]+-\d):\d{12}:[A-Za-z0-9_-]{1,256}$/

export function requireTopicArn(arn: string | undefined): { arn: string; region: string } {
  const match = arn ? TOPIC_ARN.exec(arn) : null
  if (!arn || !match) throw new Error(`LINELEDGER_SNS_TOPIC_ARN is not an SNS topic ARN: ${arn ?? 'unset'}`)
  return { arn, region: requireRegion(match[1]!) }
}

/** SNS subjects: one line, at most 100 characters. */
export const cleanSubject = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 100)

export class SnsNotifier implements Notifier {
  readonly kind = 'sns' as const
  constructor(private readonly client: Pick<SNSClient, 'send'>, private readonly topicArn: string) {}

  async publish({ subject, message }: AlertEvent): Promise<void> {
    try {
      await this.client.send(new PublishCommand({ TopicArn: this.topicArn, Subject: cleanSubject(subject), Message: message }))
    } catch (error) {
      console.error(`SNS publish failed: ${error instanceof Error ? error.name : 'error'}`)
    }
  }
}

export function openNotifier(env: NodeJS.ProcessEnv = process.env): Notifier {
  const mode = (env.LINELEDGER_NOTIFY ?? 'none').trim().toLowerCase() || 'none'
  if (mode === 'none') return noNotifier
  if (mode !== 'sns') throw new Error(`LINELEDGER_NOTIFY must be none or sns, got "${env.LINELEDGER_NOTIFY}"`)
  const { arn, region } = requireTopicArn(env.LINELEDGER_SNS_TOPIC_ARN)
  requireProjectProfile(env)
  process.env.AWS_EC2_METADATA_DISABLED = 'true' // never fall back to instance credentials
  return new SnsNotifier(new SNSClient({ region, profile: PROJECT_PROFILE }), arn)
}
