# NOVA Copy-Trading: confidential trade signals between AI agents

> **Technical demo, not investment advice.** Selling trading signals and copy-trading are regulated
> activities in many places, including the EU and Spain. This repository uses tiny amounts on NEAR
> mainnet to demonstrate a data-access mechanism, not a trading product.

A **seller** trading agent sells access to its confidential trade journal (pair, side, size, price,
time, one line of reasoning per trade). Its claimed profit-and-loss curve is public; its trades are not.
A **follower** copy-trading agent pays for access in USDC through NEAR Intents, checks that what it
received matches what was listed, and copies trades within limits its owner signed. When the period
ends, the seller revokes the follower and new entries become unreadable to it.

Both agents run on NEAR Intents' Agent API ("Agent Connect"): each has its own NEAR account and acts
only inside a policy signed by its human owner. The journal lives in [NOVA](https://nova-sdk.com):
encrypted per entry, stored as ciphertext, with the key released by a TEE only to on-chain group
members.

Built at NEAR HACKATHON (November 2026). Tracks: Agent Economy (`agents`), Privacy & Private AI
(`privacy`), AI Security & Defense (`security`). Demo video (2:37, a replay of the recorded mainnet run):
<X post link>. For automated reviewers: [JUDGES.md](JUDGES.md) maps every claim to its code, its test and
the command that runs it.

## The idea: sell a viewing key, not your data

This takes the "sell your viewing keys" idea literally, for an agent's own data. What the seller sells
is time-limited access to an encrypted journal (a NOVA group), not a copy of it:

- **The listing is public, the journal is not.** Anyone can read the listing: price, access period, the
  P&L curve and a fingerprint over the entries' on-chain hashes. That is enough to choose a seller from
  observable evidence (*selection trust*), and nothing more.
- **Access ends.** At the end of the period the seller revokes the buyer and NOVA rotates the group key;
  entries written afterwards are unreadable to it. A plain viewing key cannot be taken back.
- **The reasoning stays off chain.** Each entry carries one line of the agent's reasoning, which never
  appears in a transaction.
- **Entries cannot be backdated.** Each entry is committed on chain (timestamp + SHA-256) when it is
  written, so the buyer can check the listing against what it decrypts.

Why it matters for an agent economy: the sale is an *M2M micropayment* (0.10 USDC) between two agents,
each spending only inside a policy its owner signed (its *payment mandate*). The seller checks the
payment on chain and admits the buyer itself; no marketplace, operator or human sits in between. Any
agent that produces data (signals, research, sensor feeds, model outputs) can sell access to it the
same way, and any agent can buy, verify and act on it.

## Claims

Each claim maps to something you can run or open. "Live" means exercised in the recorded mainnet run
of 2026-11-04 ([Live run](#live-run)); the full list of code, tests and commands is in [JUDGES.md](JUDGES.md).

| # | Claim | How to check | Status |
|---|---|---|---|
| C1 | No server and no storage provider sees a journal entry in plaintext or its key. Entries are encrypted in the agent's own process before upload; NOVA stores ciphertext; the decryption key is released by NOVA's TEE only to on-chain group members. | `npm test`; live: the follower reads the feed only while it is a member, and entry 7, written after its revocation, is refused (Shade 403) | design (NOVA) + live |
| C2 | An agent spends only what its owner signed. The follower can pay only the proceeds account in its owner's policy, and a copy above its per-trade limit is refused. | `npm run demo:mock`; live: listing #99 refused (`policy_destination_denied`), a 0.18 USDC copy refused (`policy_transaction_limit_exceeded`) | live |
| C3 | Payment is what grants access. The seller admits a follower only after checking the payment on chain (final, successful, from the payer to the proceeds account, exact asset and amount, never used before), and access goes to the paying account. | `npm test` (`test/verify-payment.test.ts`, `test/near-chain.test.ts`); live: tx `63vndaKu…` verified, then the admission | live |
| C4 | The follower verifies what it bought: the listing's fingerprint, each decrypted entry's SHA-256, and the P&L recomputed from the journal against the public curve. | `npm test` (`test/verify-feed.test.ts`, `test/follower-service.test.ts`); live: `feed_verified` | live |
| C5 | Access ends cleanly. At period end the seller revokes the follower, NOVA rotates the group key, and the follower's next read is refused. | live: `member_revoked` (rotation confirmed), `access_ended`, entry 7 unreadable | live |
| C6 | Every agent write is signed and paid by the agent's own NEAR account. NOVA signs nothing for it and holds no agent key. | live: the seller's uploads, admission and revocation are calls to `nova-sdk.near` signed by the seller's account ([nearblocks](https://nearblocks.io/address/5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288)) | live |

## Try it (no keys needed)

Requires Node 24 (`.nvmrc`).

| Do | See |
|---|---|
| `npm ci && npm test` | every harness passes (Agent API, NOVA and NEAR RPC mocked behind `fetch`) |
| `for f in test/mutate-*.mjs; do node "$f" \|\| break; done` | each script ends `N/N mutants caught`: every check in the code is load-bearing |
| `npm run demo:mock` | `✓ all 6 beats` (in-memory NOVA, Agent API and chain; synthetic prices; the payment is the real recorded 57r1 payment, replayed) |
| `npm run viewer`, then open http://127.0.0.1:8790/?autoplay | the mock run as a replay, labelled MOCK MODE |
| `VIEWER_STATE=docs/proof/2026-11-04 npm run viewer`, then open http://127.0.0.1:8790/?autoplay&pace=4000 | the recorded **mainnet** run, 29 steps, labelled LIVE · NEAR mainnet: the public listing next to the locked feed, listing #99 refused, the payment verified and the feed unlocking, a 0.18 USDC copy refused while 0.05 is copied, the revocation |

## Live mode

Runs the whole story on NEAR mainnet with two real agents. It spends real, tiny amounts (NEAR Intents
has no testnet): one 0.10 USDC payment, sent only after you type `pay`, plus the seller's gas for 7
uploads, 1 admission and 1 revocation.

| Do | See |
|---|---|
| `npm run demo:live -- --preflight` | 12 read-only checks (P1–P12): both agents sign in, both owner policies, balances, dry quotes, a dry refusal by policy, and an earlier real payment re-verified over an archival RPC. Nothing signed or spent. |
| `npm run demo:live` | the preflight, then the six beats in about 25 minutes (15-minute access period), each asserted; it stops at the first failure. Events go to `state/` for the viewer. |

Each agent's credentials stay in its own directory, never in this repository: by default
`~/near/nova/paid-handoff/` (seller) and `~/near/nova/paid-handoff/follower-1/` (follower), each with
`.env` (the Agent API key), `.grant-token` and `aa-state.json`. Setting up the two agents and their
owner-signed policies: [docs/live-setup.md](docs/live-setup.md). The directories can be set with
`SELLER_DIR` and `FOLLOWER_DIR`; every variable is listed in [.env.example](.env.example).

## Live run

Recorded on NEAR mainnet on 2026-11-04. Full terminal output: [docs/proof/2026-11-04/demo-live.txt](docs/proof/2026-11-04/demo-live.txt);
the agents' event logs and listings, replayable in the viewer: [docs/proof/2026-11-04/](docs/proof/2026-11-04/).

| What | Value |
|---|---|
| Seller agent (NEAR account) | [`5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288`](https://nearblocks.io/address/5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288) |
| Follower agent (NEAR account) | [`9a45ea1ce599c5df4143001cddc0dd80e6a0a897f8665d0b6570a70c3ac93b35`](https://nearblocks.io/address/9a45ea1ce599c5df4143001cddc0dd80e6a0a897f8665d0b6570a70c3ac93b35) |
| NOVA group | `agent-owned-20261030T073943Z` (owned by the seller agent) |
| Journal | 7 entries, one NOVA record each (`trans_id`s in `docs/proof/2026-11-04/seller/events.jsonl`) |
| Listing bought | `b6bfa932…0d52a`: 0.10 USDC to `1000fans.near` (the seller's proceeds account), 15 minutes, 3 entries |
| Listing #99 (pays `wrap.near`) | refused by the follower's owner policy in a dry preview (`policy_destination_denied`); nothing sent |
| Payment | intent `5KHyn1ePxUtJsGY3n1TK9ZY1zsQPqakhq8m8j83E5uYt`, settled 14:54:38 UTC; NEAR transaction [`63vndaKumpgAMaNFeXg6QycethFYZb8a4sNwyvae15r7`](https://nearblocks.io/txns/63vndaKumpgAMaNFeXg6QycethFYZb8a4sNwyvae15r7) |
| Verified by the seller | 14:57:12 UTC, over `archival-rpc.mainnet.fastnear.com` |
| Admitted | 14:57:31 UTC, by the seller's own signature; access until 15:09:33 UTC |
| Copies | 0.05 USDC buy copied; 0.18 USDC buy refused (`policy_transaction_limit_exceeded`, the owner's 0.15 cap); the sell copied, sized to the follower's position. Copies are dry quotes. |
| Revoked | 15:10:03 UTC, group key rotation confirmed; entry 7, written after it, refused to the follower (Shade 403) |

## How NEAR is used

| NEAR component | Role |
|---|---|
| NEAR Intents Agent API (Agent Connect) | Each agent's NEAR account and owner-signed policy; the USDC payment (a withdrawal); confidential dry swap quotes for trades and copies; the seller's signed NOVA writes (`native/near/call`); NOVA sign-in (NEP-413) |
| NEAR Intents (`intents.near`) | Settlement of the payment |
| NEAR RPC (archival) | The seller's own on-chain check of the payment before it admits anyone |
| NOVA contract `nova-sdk.near` | Group membership, one on-chain record (timestamp + SHA-256) per journal entry, revocation and key rotation |
| NOVA's TEE (Shade) | Releases a group's key only to current on-chain members |

## Trust assumptions and limits

- **The follower trusts the seller to admit it after payment.** There is no on-chain escrow yet: the
  follower pays first, then the seller verifies and admits it (see [Next steps](#next-steps)). The seller's
  agent admits automatically after its on-chain check; no human and no NOVA operator decides.
- **The seller trusts its RPC node's answers** when it checks a payment; the check only confirms that each
  reply is for what it asked.
- **Trade decisions are scripted** (`demo/live-script.json`) and their contents are simulated (dry
  quotes). The files, the payment, the admission and the revocation are real.
- **"Verifiable" means consistent and committed in time, not profitable or complete.** The follower can
  check that the P&L matches the journal and that each entry was recorded when claimed. It cannot see
  journals the seller chose not to list.
- **Revocation stops future access only.** Entries the follower already decrypted stay with it.
- Known limits and deferred work: [docs/deferrals.md](docs/deferrals.md).

## What existed before this hackathon, and what was built in it

The hackathon window opened on 2026-10-19 (NEAR HACKATHON rule Q-001).

| Piece | Origin | Date | In window |
|---|---|---|---|
| NOVA contract, MCP server, Shade TEE agent, `nova-sdk-js` | [jcarbonnell/nova](https://github.com/jcarbonnell/nova) | 2025–2026; self-custodial wallet mode (SDK 1.4.0, contract v0.3.7–v0.3.9) 2026-10-21 to 10-29 | partly |
| `src/vendor/nova-agent-connect.ts`, its harness and mutation script | `nova/nova-agent-connect` @ `ecd5fd4` | 2026-10-29 to 10-30 | yes |
| Payment observation (event shape, memo, refusals) | `nova/paid-handoff` | 2026-10-19 to 10-29 | yes |
| Everything else in this repository | this repository | from 2026-11-02 | yes |

Owner-side policy and funding scripts stay in `nova/paid-handoff` (they use the owner's wallet key and
are not part of this demo). NOVA's dashboard Cleanroom is private and is not used here. This repository's
first commit is 2026-11-02.

Libraries (NEAR HACKATHON rule Q-005): `@near-intents-agent-api/sdk`, `nova-sdk-js` (own, baseline),
`nova-agent-connect` (own, vendored in `src/vendor/`), `tsx` and `typescript`. The code was written with
an AI coding assistant (Claude Code); every security-relevant module has a standalone harness and a
mutation script.

## Next steps

- **Escrow: pay only for what is delivered.** Today the buyer pays first and the seller admits it. A
  contract escrow would hold the payment until the admission is on chain (*verify-then-pay*,
  *trustless settlement*), closing the last trust step in C3.
- **Model-driven agents.** Replace the scripted decider with a model that trades, and one that decides
  what to copy, both inside the same owner policies.
- **Reputation from verified history.** Every sale leaves a verified payment, admission and feed check on
  chain; aggregated, they become a seller's track record (*reputation capital*).

## Vocabulary

Terms from the agentic-commerce literature, as used here:

| Term | Here |
|---|---|
| M2M micropayment | the 0.10 USDC payment from one agent to another |
| Payment mandate | each owner's signed Agent Connect policy: who the agent may pay, how much, for what |
| Selection trust | choosing a seller from its public listing (P&L curve, fingerprint) before any access |
| Trust gap | intent, payment evidence and audit not linked; here the policy, the on-chain payment check and the per-entry records link them |
| Trusted execution environment (TEE) | NOVA's Shade, which releases a group key only to on-chain members |
| Verify-then-pay, trustless settlement | the escrow in Next steps; today the order is pay, then verify, then admit |
| Reputation capital | the verified track record a seller could accumulate (Next steps) |

## About NOVA

NOVA is the encrypted, group-based data layer this demo is built on: [nova-sdk.com](https://nova-sdk.com).
A machine-readable overview for AI agents and reviewers: [nova-sdk.com/llms.txt](https://nova-sdk.com/llms.txt).

## License

MIT, see [LICENSE](LICENSE).