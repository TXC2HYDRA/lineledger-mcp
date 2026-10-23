// AWS Lambda, run by the EventBridge rule in infra/shift-report.yaml: reads the DynamoDB table and
// publishes the shift digest to the SNS topic. Credentials come from the function's own IAM role.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { SNSClient } from '@aws-sdk/client-sns'
import { SnsNotifier } from '../server/notify.js'
import { buildShiftReport } from '../server/report.js'
import { DynamoDbStore } from '../server/store-dynamodb.js'

export async function handler(): Promise<{ sent: string }> {
  const table = process.env.LINELEDGER_DYNAMODB_TABLE
  const topic = process.env.LINELEDGER_SNS_TOPIC_ARN
  if (!table || !topic) throw new Error('LINELEDGER_DYNAMODB_TABLE and LINELEDGER_SNS_TOPIC_ARN must be set')
  const store = new DynamoDbStore({ client: new DynamoDBClient({}), table })
  try {
    const report = await buildShiftReport(store)
    await new SnsNotifier(new SNSClient({}), topic).publish(report)
    return { sent: report.subject }
  } finally {
    await store.close()
  }
}
