# JUDGES.md: a map for reviewers (human and automated)

**What this is.** Two AI agents on NEAR mainnet. A seller agent keeps an encrypted trade journal in a NOVA
group and publishes a listing (price, access period, a public P&L curve and a fingerprint of the entries).
A follower agent pays 0.10 USDC for 15 minutes of access through the NEAR Intents Agent API; the seller
checks the payment on chain and admits it; the follower verifies what it bought and copies trades within
its owner's limits; at the end of the period the seller revokes it and rotates the key.

**What is real and what is simulated.** The NOVA files, the on-chain records, the payment, the admission
and the revocation are real mainnet transactions. The trades are simulated: decisions are scripted
(`demo/live-script.json`) and priced with dry quotes, so no trade is executed. Technical demo, not
investment advice.

Everything below can be checked without credentials, except the last row of the first table.

## 1. Checks to run (do X → see Y)

Node 24 (`.nvmrc`). From the repository root:

| # | Do | See |
|---|---|---|
| 1 | `npm ci && npm test` | every harness ends `N/N passed`; the command exits 0 |
| 2 | `for f in test/mutate-*.mjs; do node "$f" \|\| break; done` | each ends `N/N mutants caught`: each check named below fails a test when removed |
| 3 | `npm run demo:mock` | `✓ all 6 beats` (in-memory NOVA, Agent API and chain; the payment is the real recorded 57r1 payment, replayed) |
| 4 | `VIEWER_STATE=docs/proof/2026-11-04 npm run viewer`, open http://127.0.0.1:8790/?autoplay&pace=4000 | the recorded mainnet run replayed in 29 steps, labelled LIVE · NEAR mainnet |
| 5 | open the links in [README › Live run](README.md#live-run) | the payment transaction on nearblocks; the seller account's calls to `nova-sdk.near` |
| 6 | `npm run demo:live -- --preflight` (needs two agents, see [docs/live-setup.md](docs/live-setup.md)) | `preflight: 12/12 passed`, nothing signed or spent |

## 2. Claims → code → tests → live evidence

Test ids are the labels printed by each harness (`✓ V3 …`). The live evidence is in
[docs/proof/2026-11-04/](docs/proof/2026-11-04/) (`demo-live.txt` is the full terminal output).

| Claim | Code | Tests | Live evidence (2026-11-04) |
|---|---|---|---|
| **C1** No server or storage provider sees a journal entry in plaintext or its key. | `src/vendor/nova-agent-connect.ts` (the agent signs in to NOVA and signs its own writes through Agent Connect; no key reaches NOVA), `src/core/journal.ts`, NOVA (encryption, TEE key release) | `src/vendor/test-nova-agent-connect.ts`; `journal.test.ts` J1–J12; `seller-service.test.ts` S27 (events hold no trade content); `follower-service.test.ts` E1; `viewer-server.test.ts` V2 (never serves the payment, ledger or pending store) | the follower reads entries only while a member; entry 7 is refused after revocation (`Shade retrieve failed: 403`) |
| **C2** An agent spends only what its owner signed. | the owners' Agent Connect policies; `src/follower/follower-service.ts` (`approve`, `preview`, `copyTick`) | `follower-service.test.ts` A3, P1, P3, K2, K11; `hostile-seller.test.ts` F1; `mock-world.test.ts` A3, A5, A7 | preflight P4, P7, P9; beat 2: listing #99 refused (`policy_destination_denied`), nothing sent; beat 5: 0.18 USDC copy refused (`policy_transaction_limit_exceeded`) |
| **C3** Payment is what grants access. The seller admits only after its own on-chain check (final, successful, payer → proceeds account, exact asset and amount, single use), and access goes to the payer. | `src/core/verify-payment.ts`, `src/core/near-chain.ts`, `src/core/membership.ts`, `src/seller/seller-service.ts` (`POST /claim`) | `verify-payment.test.ts` F1, V1–V7, L1, U1, D6; `near-chain.test.ts` N1–N29 (N24: the real 57r1 payment end to end; N26–N29: retries); `membership.test.ts` M1–M13; `seller-service.test.ts` S5, S6, S8–S11; `member-ops.test.ts` O4, O11 | payment tx [`63vndaKu…`](https://nearblocks.io/txns/63vndaKumpgAMaNFeXg6QycethFYZb8a4sNwyvae15r7) → `payment_verified` 14:57:12 UTC → `member_admitted` 14:57:31 UTC |
| **C4** The follower verifies what it bought: the fingerprint, each entry's SHA-256, and the P&L recomputed against the public curve. | `src/core/verify-feed.ts`, `src/core/live-feed.ts`, `src/core/pnl.ts`, `src/core/listing.ts`, `src/core/journal.ts` | `verify-feed.test.ts` V1–V14; `live-feed.test.ts` F1–F13; `pnl.test.ts` P1–P26; `listing.test.ts` L1–L12; `journal.test.ts` K1–K11 (fingerprint); `follower-service.test.ts` K0, V1, V2, B3, B4, K9 | `feed_verified` (3 entries, root, realised P&L); entries 4–6 each verified before copying |
| **C5** Access ends cleanly: revoked at period end, key rotated, next read refused. | `src/core/membership.ts`, `src/adapters/member-ops.ts`, `src/seller/seller-service.ts` (`maintenanceTick`) | `membership.test.ts` M14–M23; `member-ops.test.ts` O5, O6; `seller-service.test.ts` S12; `follower-service.test.ts` K7, K8 | `member_revoked` 15:10:03 UTC (`rotation: confirmed`), `access_ended`, entry 7 unreadable to the follower |
| **C6** Every agent write is signed and paid by the agent's own NEAR account; NOVA signs nothing for it. | `src/vendor/nova-agent-connect.ts`, `src/adapters/member-ops.ts` | `src/vendor/test-nova-agent-connect.ts`; `member-ops.test.ts` O9 (the seller may sign exactly upload, add and revoke), O10 (deposit cap per call) | the seller's account on [nearblocks](https://nearblocks.io/address/5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288): its uploads, the admission and the revocation, all signed by it |

Robustness (not claims of their own, but what keeps C2–C5 true across crashes and retries):

| Property | Tests |
|---|---|
| A payment is sent at most once, even across a crash mid-send | `follower-service.test.ts` Y1–Y10; `follower-state.test.ts` F1–F5, W1–W4, I1 |
| A claim is retried only on a chain failure, never re-paid | `follower-service.test.ts` C1–C7; `seller-service.test.ts` S6, S9 |
| A NOVA write left pending by a crash is settled before any other write | `pending-file.test.ts` F1–F6, A1–A4, I1–I2; `member-ops.test.ts` O6; `seller-service.test.ts` S15 |
| The ledger, listings and state survive restarts and refuse damage | `ledger-file.test.ts`; `state-dir.test.ts`; `seller-service.test.ts` S24–S26, S28 |
| The viewer is read-only and local | `viewer-server.test.ts` V1–V5, R1–R5, L1 |

## 3. NEAR HACKATHON tracks

| Track | What in this project fits it |
|---|---|
| `agents` Agent Economy | an agent earns by selling access to its own data and another agent pays for it (an M2M micropayment through NEAR Intents), with no marketplace in between: C3, C5 |
| `privacy` Privacy & Private AI | the journal is encrypted per entry, the key is released by NOVA's TEE only to on-chain members, the reasoning never reaches the chain, and the buyer verifies without the seller revealing more: C1, C4 |
| `security` AI Security & Defense | both agents act only inside policies their owners signed: a payment to an unlisted account and a copy above the owner's cap are refused by the Agent API before anything moves: C2, C6 |

## 4. Where things are

| Path | What |
|---|---|
| `src/core/` | pure logic: journal encoding, listing, P&L, feed and payment verification, membership, the NEAR RPC reader |
| `src/adapters/` | files on disk (ledger, state, pending writes) and NOVA (reader, member operations) |
| `src/seller/`, `src/follower/` | the two agents' services and their standalone runners |
| `src/demo/live.ts` | `npm run demo:live`: the preflight and the six beats on mainnet |
| `src/demo/hostile-seller.ts` | listing #99, the hostile listing of beat 2 |
| `src/mock/` | `npm run demo:mock`: the same story in memory |
| `src/viewer/`, `viewer/index.html` | `npm run viewer`: the read-only local replay |
| `src/vendor/nova-agent-connect.ts` | NOVA sign-in and signing through Agent Connect (own library, vendored) |
| `test/` | one harness and one mutation script per module |
| `docs/proof/2026-11-04/` | the recorded mainnet run |
| `docs/live-setup.md`, `docs/deferrals.md` | running it live; known limits and deferred work |

## 5. Not claimed

- That the seller is profitable, or that its journal is complete: only that what was listed is what was
  delivered, committed on chain when written.
- That the payment is escrowed: the follower pays first and trusts the seller to admit it (README › Next steps).
- That a model decides the trades: decisions are scripted in this demo.
- That a revoked follower forgets what it already read.

## 6. Hackathon rules

| Rule | Where |
|---|---|
| Q-001/Q-003/Q-004 code written in the window | first commit 2026-11-02; README › What existed before this hackathon |
| Q-005 libraries and own earlier work (baseline) | README › What existed before this hackathon |
| Q-007 mainnet with tiny amounts and dry quotes | one 0.10 USDC payment; every trade a dry quote |
| Q-012 reproducible locally, with a video | sections 1 and 2 above; the demo video: [x.com/jcarbonnell/status/2118274901693837481](https://x.com/jcarbonnell/status/2118274901693837481) |
| Q-014 license | MIT, `LICENSE` |
| No secrets in the repository | credentials live in each agent's own directory outside the repo (`.env.example`, `.gitignore`) |
