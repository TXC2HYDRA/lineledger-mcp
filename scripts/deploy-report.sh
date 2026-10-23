#!/usr/bin/env bash
# Builds the Lambda and deploys infra/shift-report.yaml: SNS topic, Lambda, EventBridge schedule.
# Run by the owner, with a profile allowed to create CloudFormation, IAM, Lambda, Events, SNS and S3 resources.
# That is more than the app user's policy (docs/aws-iam-policy.json) allows, on purpose.
#
#   export AWS_CONFIG_FILE=$HOME/.aws-lineledger/config AWS_SHARED_CREDENTIALS_FILE=$HOME/.aws-lineledger/credentials
#   export AWS_PROFILE=lineledger
#   scripts/deploy-report.sh you@example.com            # deploy
#   scripts/deploy-report.sh --delete                   # remove the stack
#
# After the deploy, confirm the subscription in the email AWS sends.
set -euo pipefail

STACK=lineledger-shift-report
REGION="${LINELEDGER_AWS_REGION:-us-east-1}"
fail() { echo "deploy-report: $*" >&2; exit 1; }

[ "${AWS_PROFILE:-}" = "lineledger" ] || fail "AWS_PROFILE must be lineledger (got '${AWS_PROFILE:-}')"
for var in AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE; do
  case "${!var:-}" in "$HOME/.aws-lineledger/"*) ;; *) fail "$var must point inside $HOME/.aws-lineledger/" ;; esac
done
for var in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; do
  [ -z "${!var:-}" ] || fail "unset $var: keys come from the project credentials file only"
done

if [ "${1:-}" = "--delete" ]; then
  aws cloudformation delete-stack --region "$REGION" --stack-name "$STACK"
  aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$STACK"
  echo "deleted $STACK (the code bucket is kept: remove it with aws s3 rb --force)"
  exit 0
fi
EMAIL="${1:-}"
[ -n "$EMAIL" ] || fail "usage: scripts/deploy-report.sh <alert email> | --delete"

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "Deploying to account $ACCOUNT in $REGION (must be the new personal account, not the employer's)."
read -r -p "Continue? [y/N] " answer
[ "$answer" = "y" ] || fail "cancelled"

BUCKET="lineledger-code-$ACCOUNT-$REGION"
aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null || aws s3 mb "s3://$BUCKET" --region "$REGION"

BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
# The Node 22 Lambda runtime provides the AWS SDK v3, so it stays out of the bundle.
npx esbuild lambda/shift-report.ts --bundle --platform=node --target=node22 --format=cjs \
  --external:@aws-sdk/* --outfile="$BUILD/shift-report.js" --log-level=warning
(cd "$BUILD" && zip -q code.zip shift-report.js)
KEY="shift-report-$(sha256sum "$BUILD/code.zip" | cut -c1-16).zip"
aws s3 cp "$BUILD/code.zip" "s3://$BUCKET/$KEY" --region "$REGION"

aws cloudformation deploy --region "$REGION" --stack-name "$STACK" --template-file infra/shift-report.yaml \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  --parameter-overrides "AlertEmail=$EMAIL" "CodeBucket=$BUCKET" "CodeKey=$KEY" "TableName=${LINELEDGER_DYNAMODB_TABLE:-lineledger}"
aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query 'Stacks[0].Outputs' --output table
echo "Test now: aws lambda invoke --region $REGION --function-name lineledger-shift-report /dev/stdout"
