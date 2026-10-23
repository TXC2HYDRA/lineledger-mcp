# AWS integration plan: Bedrock, DynamoDB, Lambda

## Implementation status (2026-10-22, evening)

- Phase 1 code (Bedrock provider for the agent) and Phase 2 code (store interface, DynamoDB store) are
  written and tested with no AWS account: 13 agent guard tests with mocked credentials; every server test
  now runs on both stores, plus store-level tests that compare SQLite and DynamoDB row by row. The DynamoDB
  runs used a local emulator (dynalite) during development; CI runs them against DynamoDB Local 3.3.1.
- Not done: Phase 0 (owner), every live AWS step, Phase 3 (Lambda, cut as planned), Phase 4 evidence.
- Changes from the plan below: (1) notes use `sk=N#<created_at>#<id>` so a reverse Query returns newest
  first; (2) the IAM policy in `docs/aws-iam-policy.json` uses `bedrock:InvokeModel` and
  `bedrock:InvokeModelWithResponseStream` (Strands calls ConverseStream; there is no separate Converse
  action), and drops `BatchWriteItem`, which the code does not use; (3) the agent caps each request at 4
  model calls; (4) DynamoDB Local is only needed for `npm run test:dynamodb`, not for `npm test`.

Original status: PLAN ONLY. Written 2026-10-22 14:30 IST. No AWS account exists for this project, no AWS call has
been made, and no credential is stored anywhere in the repository. Nothing in this plan is executed until the
owner passes the gates in section 2.

Goal: add AWS services to LineLedger for the AWS Builder mini challenge without spending money and without
breaking the project for anyone who has no AWS account. The Ollama agent and the SQLite store stay as the
defaults. Every AWS path is opt-in through an environment variable.

Deadline (unconfirmed, see section 10): 2026-10-23 12:00 PM PDT = 2026-10-24 00:30 IST. The owner's own
target for "ready" is 2026-10-23 18:00 IST.

## 1. Research summary

Research used read-only web search and fetch. Official AWS pages are cited where possible. Every devpost.com
URL returned HTTP 403, so nothing below about the hackathon rules is read from the official rules page.

| Fact | Source kind | Notes |
|---|---|---|
| New accounts get $100 credit at signup on either plan, plus up to $100 more for five "Explore AWS" activities (EC2, Bedrock playground prompt, Budgets, Lambda web app, RDS) | official AWS | The EC2, RDS, Lambda and Bedrock activities spend credits themselves |
| Free plan: no charges; account closes after 6 months or when credits run out, whichever is first; content kept 90 days, then deleted | official AWS | This is the cost safety net. It also means the account can disappear while judging is open |
| Free plan upgrades to Paid automatically if the account joins AWS Organizations, Control Tower, APN and similar; upgrading is irreversible | official AWS | Do not click Upgrade, ever |
| Always-free: Lambda 1M requests and 400,000 GB-s per month; DynamoDB 25 GB storage, 25 provisioned WCU, 25 provisioned RCU per Region | official AWS | DynamoDB request allowance is for provisioned mode only |
| Bedrock is usable on the Free plan; Bedrock AgentCore is Paid-plan only | official AWS | Whether Bedrock use draws on the $100 credit is shown only by the playground activity text |
| Claude models on Bedrock are billed through AWS Marketplace and need a payment method plus a use-case form; the Free plan excludes "certain Marketplace offers" | official AWS | Avoid Claude. Use Amazon Nova |
| Amazon Nova Micro `amazon.nova-micro-v1:0`: $0.035 / $0.14 per 1M input / output tokens. Nova Lite `amazon.nova-lite-v1:0`: $0.06 / $0.24. Both support Converse and tool use | official price list, us-east-1 | 200 agent turns of 3,000 input and 300 output tokens is about $0.03 to $0.05 |
| Account sign-up: the FAQ says a payment method is not required for most new customers; the sign-up guide says sign-up cannot finish without one | official AWS, conflicting | Only the live flow settles this |
| Existing or former AWS customers are not eligible for the Free plan and credits | official AWS | Nothing found about employer accounts. Treat eligibility as unverified |
| AWS Budgets alerts are not a hard cap and lag by hours | official AWS | The Free plan itself is the cap, not Budgets |
| Strands `BedrockModel` takes `model_id`, `region_name`, `boto_session`; `Agent()` with no model defaults to Bedrock with Claude Sonnet 4.6 | official Strands docs | Always pass `model_id`. A bare `Agent()` would try Claude |
| Lambda Function URLs add no charge; API Gateway HTTP API free tier is 12-month new-customer only | official AWS | Use a Function URL, never API Gateway |
| AWS Builder mini challenge: "integrate AWS services" (examples Bedrock, AgentCore, Strands SDK, SageMaker); wording on the Devpost page is reportedly "documented integrations" | AWS announcement plus third-party copy | Submission evidence format unknown |
| The $150 hackathon credit request form closed 2026-10-21 12:00 PM PT | third-party copy of the Devpost page | Assume no hackathon credits |

## 2. Gates: decisions only the owner can make

No AWS step runs until each gate has an explicit written yes from the owner in the chat.

- G1. Amend hard rule 1. It currently forbids AWS calls, cloud deployments and credentials. The owner must state
  what is now allowed: a Free-plan AWS account, Bedrock calls from the laptop, a DynamoDB table, a Lambda
  function with a public Function URL. Everything else stays forbidden.
- G2. Payment method. If sign-up demands a card, the zero-money rule is then held only by the Free plan's
  no-charge design. The owner decides whether to proceed, and prefers a virtual or low-limit card.
- G3. Account separation. This machine has `~/.aws/config` and `~/.aws/credentials`, which are almost certainly
  the employer's. The project account must be a separate, personal account (new email, new phone if asked), and
  must never share a profile with the employer's account. Section 4 has the technical guard.
- G4. Order and cut lines in section 7 are accepted. Lambda is the first thing to cut.
- G5. The owner reads the official rules at https://amazonappdev2026.devpost.com/rules in a browser and
  confirms: the deadline time, what the AWS Builder challenge asks as evidence, whether one project may enter
  both mini challenges, the AI-code, synthetic-data and third-party-service clauses, and the free-availability
  clause (the project must stay available to judges; a Free-plan account may close first).

## 3. Target architecture

```
browser --> web (Vite) --> MCP server --+--> store: SQLite (default)  |  DynamoDB (LINELEDGER_STORE=dynamodb)
                                         |
agent (Strands) ---MCP client-------------+
   model: Ollama (default)  |  Bedrock Nova (LINELEDGER_MODEL_PROVIDER=bedrock)

optional: MCP server packaged as a Lambda function behind a Function URL (LINELEDGER_STORE=dynamodb required)
```

Switches (all default to the current behaviour, so CI, tests and judges need no AWS account):

| Variable | Values | Default |
|---|---|---|
| `LINELEDGER_STORE` | `sqlite`, `dynamodb` | `sqlite` |
| `LINELEDGER_MODEL_PROVIDER` | `ollama`, `bedrock` | `ollama` |
| `LINELEDGER_BEDROCK_MODEL` | must start with `amazon.nova` or `us.amazon.nova` | `us.amazon.nova-lite-v1:0` |
| `LINELEDGER_AWS_REGION` | one Region | `us-east-1` |

## 4. Credential safety (applies to every phase)

- The agent today deletes every `AWS_*` variable before importing Strands. That stays true in `ollama` mode.
  In `bedrock` mode only these may pass through: `AWS_PROFILE`, `AWS_REGION`, `AWS_CONFIG_FILE`,
  `AWS_SHARED_CREDENTIALS_FILE`. Key variables stay scrubbed.
- Use a project-only credentials location, never the default one:
  `AWS_CONFIG_FILE=$HOME/.aws-lineledger/config`, `AWS_SHARED_CREDENTIALS_FILE=$HOME/.aws-lineledger/credentials`,
  `AWS_PROFILE=lineledger`. The code refuses to start a Bedrock or DynamoDB path unless `AWS_PROFILE` is
  `lineledger` and both file variables point inside `~/.aws-lineledger/`. This prevents the employer's default
  profile from being picked up silently.
- Before the first AWS call the owner runs `aws sts get-caller-identity` with those variables and confirms the
  account number is the new personal account. The account number is never committed.
- Root user: MFA on, no root access keys. One IAM user for the project, no console access, a policy that allows
  only the actions in section 6. Do not enable IAM Identity Center or Organizations: they can flip the account
  to Paid.
- The credentials file lives outside the repo. `.gitignore` already covers `.env`, `.env.*`, `.aws/` and
  `*.pem`; add `.aws-lineledger/`. Run `git add -n .` and a secret scan before every push. Delete or rotate the
  keys after judging.
- Claude never reads, prints or handles the keys or the account number. The owner creates the account and the
  keys, and runs any command that needs them.

## 5. Phases

### Phase 0: preflight (owner, about 1 hour, blocks Phases 1 to 3)

1. Clear G1 to G5.
2. Sign up with the standard flow, choose the Free plan explicitly, avoid the "Sign up for AWS (new)" flow if it
   offers to opt in to Organizations.
3. Turn on MFA for the root user. Create the IAM user and the project profile (section 4).
4. Open Billing and Cost Management, Account plan. Screenshot: plan = Free, credit balance, days remaining. If it
   says Paid or shows no credits, stop and report. Re-check after every IAM or console change.
5. Create one Budget of $0.01 with no budget action, and switch on Free Tier usage alerts. These are
   information only, not a cap.
6. Work in `us-east-1` only.

Exit: screenshot of the Free plan with credits, `get-caller-identity` account check done.

### Phase 1: Bedrock for the agent (about 4 hours, Claude writes the code, owner runs the AWS side)

Code changes:
- `agent/guard.py`: provider-aware environment scrub (section 4) and `require_nova(model_id)`.
- `agent/service.py`: `build_agent()` picks `OllamaModel` or `BedrockModel(model_id=..., region_name=...,
  boto_session=boto3.Session(profile_name="lineledger"), temperature=0, max_tokens=512)`. The startup assertion
  becomes "model is OllamaModel or BedrockModel with an allowed Nova id". Also set a maximum number of tool-loop
  iterations and log token usage per turn.
- `agent/test_guards.py`: new tests (no AWS needed): rejects `anthropic.*` ids, rejects a missing profile,
  strips key variables, still passes in `ollama` mode.

Run: one prompt in the Bedrock playground with Nova Lite (this also earns the $20 activity credit), then the
same 10 graded spike prompts through `agent/service.py` with Nova Lite. Compare with the recorded Qwen3-4B
results in `docs/spike-results.md`. If Nova Lite is poor, try Nova Micro (cheaper) or Nova 2.0 Lite (about
$0.36 per 200 turns).

Exit: graded table for Nova Lite committed; Billing shows credits being applied (check within 24 hours);
Account plan still Free.
Cut line: if the first Bedrock call is denied or sign-up fails by 2026-10-22 22:00 IST, stop AWS work and
return to the Ollama-only submission.

### Phase 2: DynamoDB store (about 10 hours, behind a flag)

Design:
- One table `lineledger`, string keys `pk` and `sk`, `BillingMode=PROVISIONED`, 5 RCU and 5 WCU, Standard
  class, no GSI, no streams, no PITR, no backups, no replicas. Create it from the CLI, never the console
  (console tables enable auto scaling).
- Items: lines `pk=LINE sk=<line_id>`; shift output `pk=OUT sk=<date>#<shift>#<line_id>` (a reverse Query gives
  the latest shift on record); notes `pk=NOTE sk=N#<zero-padded id>`; follow-ups `pk=FUP sk=F#<zero-padded id>`;
  stock `pk=STOCK sk=<sku>`; counters `pk=CTR sk=note|followup`.
- Numeric ids ("close follow-up 3") come from an atomic counter (`UpdateItem` with
  `SET n = if_not_exists(n, :0) + :1`, `ReturnValues=UPDATED_NEW`). Retries can skip a number but never repeat
  one.
- Closing a follow-up uses a conditional write; `ConditionalCheckFailedException` maps to the existing
  "not found" and "already closed" messages.
- Use `@aws-sdk/lib-dynamodb` with `removeUndefinedValues: true`.

Code changes:
- New `server/store.ts` interface (async) with `server/store-sqlite.ts` (current behaviour) and
  `server/store-dynamodb.ts`. `server/tools.ts` awaits the store. This is the expensive part: every handler and
  all tests become async.
- `tests/server.test.ts` runs against both stores. The DynamoDB run uses DynamoDB Local (Java 21 is installed;
  Docker is installed), so no AWS account is needed. Local runs cannot prove the 25-unit limit: after creating
  the real table, run `describe-table`, `list-tables` in every Region, and `describe-continuous-backups`.
- `scripts/create-table.sh` (provisioned 5/5, explicit billing mode) and `scripts/seed-dynamodb.ts`.

Downloads that need the owner's approval at the time: npm packages `@aws-sdk/client-dynamodb` and
`@aws-sdk/lib-dynamodb`, and either the `amazon/dynamodb-local` Docker image or the DynamoDB Local JAR.

Exit: the 19 tests pass on both stores; the web demo runs end to end against the real table; Billing shows no
cash charge.
Cut line: if the shared tests are not green by 2026-10-23 10:00 IST, keep the adapter unmerged and drop
DynamoDB from the submission claims.

### Phase 3: Lambda for the MCP server (about 6 hours, optional)

Only start if Phases 1 and 2 are green by 2026-10-23 12:00 IST. The research critic rates this no-go for the
deadline: it stacks several untested links and adds nothing for the mini challenge beyond Bedrock.

Design:
- A classic Lambda Event Function (Node.js 22, arm64), not Lambda Web Functions and not API Gateway.
- Run the existing Express app unchanged through the AWS Lambda Web Adapter layer, default BUFFERED mode.
- Set the MCP transport to `enableJsonResponse: true` (stateless, plain JSON replies, no streaming).
- Function URL with auth `NONE`, protected by a shared secret header checked in an Express middleware before
  the MCP handler. The secret is set as a Lambda environment variable by the owner, never in the repo. Reserved
  concurrency of 2 to 5 if the new account allows it; otherwise keep the function deployed only while testing
  and demoing.
- Host validation must allow the `*.lambda-url.us-east-1.on.aws` host, which is only known after creation.
- No VPC, no Provisioned Concurrency, no SAM or CloudFormation (they create an S3 bucket). Deploy as a zip with
  the AWS CLI. Log group retention 7 days.
- Storage is DynamoDB (Phase 2); SQLite cannot work on Lambda.
- The Strands agent keeps running on the laptop. Check that the Python MCP client can send a custom
  `Authorization` header before relying on this.

Test before deploying: run the Web Adapter container locally with Docker and send `initialize`, `tools/list`
and a tool call; confirm `protocolVersion` 2025-11-25 and the Host header handling.
Exit: the three calls succeed against the live Function URL with and without the secret (the second must be
rejected); a teardown rehearsal works.
Cut line: anything unfinished at 2026-10-23 12:00 IST is dropped.

### Phase 4: evidence, docs and teardown

- README section "AWS integrations": what is used, with a diagram, the environment switches, and a redacted
  sample Bedrock Converse log. State clearly what was run and what was not.
- Update the Devpost text, the video script, the product feedback and the friction log with measured results.
- Teardown runbook (after judging, or immediately if anything looks wrong): delete the Function URL, function
  and log group; delete the DynamoDB table; delete the IAM user and role; confirm no Marketplace subscription;
  sweep all Regions with Resource Explorer or Tag Editor; check Billing for zero; delete the local keys. Do not
  click Upgrade to keep the demo alive.

## 6. Least-privilege IAM policy (sketch, no account numbers)

- `bedrock:InvokeModel` and `bedrock:Converse` on the Nova Lite and Nova Micro model ARNs and, for a geo
  profile, on the profile ARN and the underlying model ARNs in every destination Region.
- `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `Query`, `BatchWriteItem` on the one table ARN only.
- For Phase 3 only: `lambda:*` on the one function, `iam:PassRole` on its role, `logs:*` on its log group.
- Explicitly nothing for `aws-marketplace:*`, Organizations, or Identity Center.

## 7. Schedule (IST) and cut lines

| When | Work | Cut line |
|---|---|---|
| Oct 22 15:00 to 17:00 | G1 to G5; owner reads the rules; Claude writes Phase 1 code with mocks (needs no account) | |
| Oct 22 17:00 to 19:00 | Phase 0 sign-up and screenshots (owner) | No Free plan by 19:00: stop AWS work |
| Oct 22 19:00 to 22:00 | Phase 1 live: playground, graded spike on Nova Lite | No working Bedrock call by 22:00: stop AWS work |
| Oct 22 to 23 morning | Phase 2 against DynamoDB Local, then the real table | Tests not green by Oct 23 10:00: drop DynamoDB |
| Oct 23 12:00 to 16:00 | Phase 3 only if green; otherwise polish and evidence | Unfinished at 12:00: drop Lambda |
| Oct 23 16:00 | Code freeze; clean-clone verification; secret scan | |
| Oct 23 16:00 to 18:00 | Video and Devpost text (owner) | |

## 8. Cost guardrails

- Plan is Free and the credit balance is visible. Check both daily. If the plan changes to Paid, stop.
- Only Nova models. A startup assertion rejects any other model id in every construction path.
- Agent limits: `max_tokens`, a maximum number of tool-loop iterations, no automatic retry loops, per-turn token
  logging. Tool loops resend context, so token use is higher than one call per turn.
- DynamoDB: provisioned 5/5, nothing else switched on. Lambda: no Provisioned Concurrency, no API Gateway.
- Do only the Bedrock, Budgets and Lambda "Explore AWS" activities, and only if the $20 each is worth the time.
  Skip EC2 and RDS.

## 9. What Claude will and will not do

Will: write and test all code with mocks and DynamoDB Local; write scripts and the runbook; grade the Bedrock
spike; update docs; keep the Ollama and SQLite defaults working; commit and push small commits to
`hydra-build/app`.

Will not: create the AWS account, enter payment details, handle or read keys or account numbers, run a command
against the real account without the owner's explicit yes for that step, click Upgrade, subscribe to anything on
AWS Marketplace, or use the employer's profile. Any download (npm packages, DynamoDB Local, Docker images, the
Lambda Web Adapter layer) is requested with name, source and size first.

## 10. Unverified items

- Eligibility of the owner's new personal account for the Free plan and credits.
- Whether sign-up requires a payment method.
- Whether Nova invocation draws on the $100 credit (check Billing within 24 hours of the first call).
- Whether Lambda Function URLs, IAM user creation and CloudWatch Logs are on the Free plan's eligible list.
- The hackathon deadline time and zone, the AWS Builder evidence format, the AI-code, synthetic-data and
  third-party-service rules, and whether one project may enter both mini challenges. All Devpost pages
  returned 403 to the research tool.
- Whether a closed Free-plan account counts as "unavailable" during judging.
- Nova Lite and Nova Micro argument quality compared with Qwen3-4B (untested; the justification for Phase 1).
- Whether the Python MCP client sends a custom header (Phase 3).
- Whether the MCP SDK 1.32.1 stateless transport with `enableJsonResponse` behaves correctly behind the Web
  Adapter (community reports only).
- Default Bedrock quotas for a new account (throttling could hit an agent loop).
