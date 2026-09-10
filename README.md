# PAYDER backend (NestJS)

Core API for the PAYDER fintech app: auth, wallet/ledger, payments (Paystack/
Flutterwave), bills/VTU (VTpass), exam e-pins, support, and admin. See
`PAYDER-ARCHITECTURE.md` (in the project docs) for the full design rationale —
this README is just how to run it.

## Local setup

```bash
cp .env.example .env        # fill in sandbox provider keys as you get them
docker compose up -d        # postgres + redis
npm install
npm run prisma:generate     # generates the Prisma client (needed before anything else builds/runs)
npm run prisma:migrate      # creates tables from prisma/schema.prisma
npm run start:dev
```

`prisma:generate` needs to reach `binaries.prisma.sh` to download its query-engine
binary. That host was blocked by the network policy of the sandbox this scaffold was
originally built in, so the client was never generated there and a full typecheck/build
wasn't possible in that environment — this is a network-access issue, not a code problem.
It should work fine on a normal internet connection; if it doesn't, check whatever
firewall/proxy sits in front of this machine.

API is served under `/api/v1`, e.g. `POST http://localhost:3000/api/v1/auth/register`.

## Module map

| Module | Responsibility |
|---|---|
| `auth` | signup/login, JWT issuance |
| `users` | profile reads |
| `wallet` | double-entry ledger + wallet balance/debit/credit — the core of the system, see `wallet/ledger.service.ts` |
| `payments` | Paystack/Flutterwave adapters, virtual account provisioning, webhook handling |
| `bills` | VTU purchases (airtime/data/tv/electricity) via VTpass |
| `exams` | WAEC/JAMB e-pin purchase (reuses the VTpass adapter) |
| `support` | ticketing for customers + a queue for customer-care/admin — now also handles the `post_utme_assist` structured-intake flow, §5.5 |
| `admin` | KYC review, transaction monitoring, provider management |
| `manual-payments` | interim admin-mediated Remita/eTranzact invoice payment (§5.4b): customer submits + wallet is held, admin pays externally and marks it, PDF receipt generated and emailed |
| `common/email` | stubbed email delivery (logs instead of sending — same pattern as the OTP stub, see below) used by `manual-payments` today |

## What's real vs. stubbed

Real: request/response shapes, RBAC enforcement, the double-entry ledger logic
(including reversal — `WalletService.reversePendingDebit`), webhook signature
verification (now checked against the true raw request bytes — see
`main.ts`'s `express.json({ verify })` hook and `PaymentsController`),
provider-adapter interfaces, the manual invoice-payment flow end to end
(hold funds → admin queue → PDF receipt or reversal), and the post_utme_assist
support-ticket flow.

Stubbed (marked `TODO` in code, intentionally — see architecture doc for why):
OTP delivery, refresh-token-reuse detection, automatic reversal jobs for failed
VTU purchases (the reversal logic itself is real now, see above — just not yet
wired to an automatic requery job), BullMQ queue wiring for async provider
calls, and real email delivery (`common/email/email.service.ts` logs instead
of calling SendGrid/Postmark — see architecture doc §5.6).

## Security note

Do not commit a real `.env`. Provider secret keys belong in a secrets manager
in any real deployment — see architecture doc §8.
