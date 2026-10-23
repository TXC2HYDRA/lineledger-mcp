#!/usr/bin/env bash
# Creates the one LineLedger table on AWS and checks it: provisioned 5 RCU / 5 WCU (inside the always-free
# allowance), Standard class, no index, no stream, no point-in-time recovery. Run by the owner only.
#
#   export AWS_CONFIG_FILE=$HOME/.aws-lineledger/config
#   export AWS_SHARED_CREDENTIALS_FILE=$HOME/.aws-lineledger/credentials
#   export AWS_PROFILE=lineledger
#   scripts/create-table.sh            # create, then verify
#   scripts/create-table.sh --verify   # verify only
#
# Never run this with the machine's default ~/.aws profile. Do not create the table in the console:
# console-created tables turn on auto scaling.
set -euo pipefail

TABLE="${LINELEDGER_DYNAMODB_TABLE:-lineledger}"
REGION="${LINELEDGER_AWS_REGION:-us-east-1}"

fail() { echo "create-table: $*" >&2; exit 1; }

[ "${AWS_PROFILE:-}" = "lineledger" ] || fail "AWS_PROFILE must be lineledger (got '${AWS_PROFILE:-}')"
for var in AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE; do
  case "${!var:-}" in
    "$HOME/.aws-lineledger/"*) ;;
    *) fail "$var must point inside $HOME/.aws-lineledger/ (got '${!var:-}')" ;;
  esac
done
for var in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; do
  [ -z "${!var:-}" ] || fail "unset $var: keys come from the project credentials file only"
done
command -v aws >/dev/null || fail "the AWS CLI (aws) is not installed"

echo "Account for profile lineledger (must be the new personal account, not the employer's):"
aws sts get-caller-identity --query Account --output text

if [ "${1:-}" != "--verify" ]; then
  read -r -p "Create table '$TABLE' in $REGION on that account? [y/N] " answer
  [ "$answer" = "y" ] || fail "cancelled"
  aws dynamodb create-table \
    --region "$REGION" \
    --table-name "$TABLE" \
    --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
    --billing-mode PROVISIONED \
    --provisioned-throughput ReadCapacityUnits=5,WriteCapacityUnits=5 \
    --table-class STANDARD \
    --query 'TableDescription.TableStatus' --output text
  aws dynamodb wait table-exists --region "$REGION" --table-name "$TABLE"
fi

echo "Table check (expect: PROVISIONED 5 5, no indexes, no stream, STANDARD):"
aws dynamodb describe-table --region "$REGION" --table-name "$TABLE" --query \
  'Table.{status: TableStatus, billing: BillingModeSummary.BillingMode || `PROVISIONED`, rcu: ProvisionedThroughput.ReadCapacityUnits, wcu: ProvisionedThroughput.WriteCapacityUnits, gsi: length(GlobalSecondaryIndexes || `[]`), lsi: length(LocalSecondaryIndexes || `[]`), stream: StreamSpecification.StreamEnabled || `false`, class: TableClassSummary.TableClass || `STANDARD`, replicas: length(Replicas || `[]`)}' \
  --output table
echo "Point-in-time recovery (expect DISABLED):"
aws dynamodb describe-continuous-backups --region "$REGION" --table-name "$TABLE" \
  --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus' --output text
echo "Next: npm run dynamodb:seed, then LINELEDGER_STORE=dynamodb npm run dev:server"
