// Self-hosted version of the scheduled shift report (the Lambda does the same on AWS). Run it from cron:
//   0 6,14,22 * * *  cd /path/to/lineledger-mcp && npm run report
// Builds the digest from the configured store and sends it through the configured notifier
// (LINELEDGER_NOTIFY=local|sns). With no notifier it prints the report.
import { openNotifier } from '../server/notify.js'
import { buildShiftReport } from '../server/report.js'
import { openStore } from '../server/store.js'

const store = await openStore(process.env)
try {
  const report = await buildShiftReport(store)
  const notifier = openNotifier(process.env)
  if (notifier.kind === 'none') console.log(`${report.subject}\n\n${report.message}`)
  else {
    await notifier.publish(report)
    console.log(`sent via ${notifier.kind}: ${report.subject}`)
  }
} finally {
  await store.close()
}
