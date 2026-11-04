# Known limits and deferred work

What this demo does not do yet, and why. Each item names where it shows and what would close it.

## Trust and settlement

| # | Limit | Where | What would close it |
|---|---|---|---|
| T1 | **The follower pays first and trusts the seller to admit it.** No escrow. | README › Trust assumptions; `POST /claim` | a contract escrow that releases the payment once the admission is on chain (README › Next steps). NOVA's contract-enforced settlement is designed but parked, because a withdrawal's memo does not reach the chain. |
| T2 | **The seller trusts its RPC node's answers** when it checks a payment. | `src/core/near-chain.ts` | checking against more than one node, or a light-client proof |
| T3 | **`POST /claim` is unauthenticated.** It listens on loopback only, and a claim only admits the account that paid. | `src/seller/seller-service.ts` | authenticated claims once the seller is served beyond localhost |

## Agent API and policies

| # | Limit | Where | What would close it |
|---|---|---|---|
| A1 | **The seller's policy allows destinations `any`.** A NOVA call's attached deposit is checked against the destinations list as a withdrawal on chain `near`, and the schema accepts only withdrawal and transfer entries; an `only` list refused the uploads (`policy_destination_denied`). The seller's actions are still limited to `swap` and calls to `nova-sdk.near`. | seller policy revision 6 | a narrower revision with a withdrawal entry for `nova-sdk.near`; the matching note in `nova-agent-connect`'s header to be corrected |
| A2 | **A recipient that does not exist is refused before the policy is checked**, so the hostile listing must name an existing account. | `HOSTILE_PROCEEDS` (default `wrap.near`) | nothing needed; documented |

## Payment verification

| # | Limit | Where | What would close it |
|---|---|---|---|
| P1 | **Each payment check makes about 100 RPC requests** (a binary search for the window, then each block and chunk in it), which free archival endpoints rate-limit. Requests are paced and retried. | `src/core/near-chain.ts` | verifying by transaction hash once the Agent API returns it, or a keyed RPC |

## Seller

| # | Limit | Where | What would close it |
|---|---|---|---|
| S1 | **Trade decisions are scripted** and priced with dry quotes; nothing is executed. | `src/seller/script-decider.ts`, `demo/live-script.json` | a model-driven decider inside the same policy (README › Next steps) |
| S2 | **A failed quote or upload stops trading** for good, and `/health` says so (by design: the journal must not skip an entry silently). | `seller-service.test.ts` S16, S17 | retry with an explicit gap marker |
| S3 | **A record uploaded to the group by another account blocks new listings** until it falls out of the range; the previous listing stays. Any member can upload to a NOVA group. | `seller-service.test.ts` S21; `follower-service.test.ts` K9 | a seller-only upload rule in the group, or listings that skip foreign records explicitly |
| S4 | **A revoke whose chain step landed but whose key rotation failed** is retried as a whole rather than resumed from the rotation. | `membership.test.ts` M20 | a resumable finalize step |
| S5 | **The first listing can fail to build right after the first entry** (`NOT_OBSERVED`: NOVA has not indexed the record yet); the next entry's rebuild succeeds. In the recorded run the first published listing covers 2 entries. | `docs/proof/2026-11-04/demo-live.txt` | retry the rebuild after a short delay |

## Follower

| # | Limit | Where | What would close it |
|---|---|---|---|
| F1 | **Copies are dry quotes**; the follower holds no position on chain. A sell is sized to the position its copies would have built. | `src/follower/follower-service.ts` | real swaps under the same per-trade limit |
| F2 | **Revocation stops future reads only.** Entries already decrypted stay with the follower. | README › Trust assumptions | inherent to selling read access |

## Demo tooling

| # | Limit | Where | What would close it |
|---|---|---|---|
| D1 | **The viewer stays on its closing card while a live run is in progress**: when following, it jumps to its last step, which is the closing card. The replay after the run is unaffected. | `viewer/index.html` | follow the last event, not the closing card, until the run ends |
| D2 | **`demo:live` is wired to the two agents of the recorded run** (constants at the top of `src/demo/live.ts`). Credential directories are configurable (`SELLER_DIR`, `FOLLOWER_DIR`). | `src/demo/live.ts` | reading the agents, group and proceeds account from the environment |
| D3 | **Preflight P11 needs an earlier run** to re-verify; it is skipped otherwise. | `PREFLIGHT_PAYMENT_DIR` | re-verifying a published payment from `docs/proof/` |
