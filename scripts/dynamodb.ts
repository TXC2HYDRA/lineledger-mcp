// DynamoDB helpers. Tables on AWS are created only with scripts/create-table.sh (AWS CLI, run by the owner).
//
//   npm run dynamodb:local-table   create the table on DynamoDB Local (LINELEDGER_DYNAMODB_ENDPOINT, loopback only)
//   npm run dynamodb:seed          seed the synthetic demo data once and print what the table holds.
//                                  Uses DynamoDB Local when LINELEDGER_DYNAMODB_ENDPOINT is set, otherwise
//                                  the real table through the project profile (AWS_PROFILE=lineledger).
import { createLocalTable, DEFAULT_TABLE, dynamoClientFromEnv, DynamoDbStore } from '../server/store-dynamodb.js'

const command = process.argv[2]
const table = process.env.LINELEDGER_DYNAMODB_TABLE || DEFAULT_TABLE

if (command === 'create-local') {
  const endpoint = process.env.LINELEDGER_DYNAMODB_ENDPOINT
  if (!endpoint) throw new Error('Set LINELEDGER_DYNAMODB_ENDPOINT, for example http://127.0.0.1:8000 (DynamoDB Local).')
  try {
    await createLocalTable(endpoint, table, process.env.LINELEDGER_AWS_REGION || undefined)
    console.log(`Created table "${table}" on ${endpoint} (provisioned 5/5, keys pk/sk).`)
  } catch (error) {
    if ((error as { name?: string }).name !== 'ResourceInUseException') throw error
    console.log(`Table "${table}" already exists on ${endpoint}.`)
  }
} else if (command === 'seed') {
  const { client, target } = dynamoClientFromEnv(process.env)
  const store = new DynamoDbStore({ client, table })
  try {
    const seeded = await store.ensureSeeded()
    const [notes, followUps, stock, shift] = await Promise.all([
      store.listNotes({ limit: 50 }),
      store.listFollowUps({ status: 'all' }),
      store.findStock('-'),
      store.latestShift({}),
    ])
    console.log(`${target}, table "${table}": ${seeded ? 'seeded now' : 'already seeded'}.`)
    console.log(`notes ${notes.length}, follow-ups ${followUps.length}, stock items ${stock.length}, latest shift ${shift?.shift_date} ${shift?.shift}`)
  } finally {
    await store.close()
  }
} else {
  console.error('usage: tsx scripts/dynamodb.ts create-local | seed')
  process.exitCode = 2
}
