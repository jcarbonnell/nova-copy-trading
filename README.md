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

## Why not just share a viewing key?

- A viewing key exposes all on-chain activity, with no way to stop. Here access ends with a revocation
  that rotates the group key.
- The journal carries the trader's reasoning, which never appears on chain.
- Each entry is committed on chain (timestamp + SHA-256) as the trade happens, so the listing's
  fingerprint can be checked after purchase and entries cannot be backdated.

## Claims

Each claim maps to something you can run or open. Status is `planned` until its proof lands.

| # | Claim | How to check | Status |
|---|---|---|---|
| C1 | No server and no storage provider sees a journal entry in plaintext or its key. Entries are encrypted in the agent's own process before upload; NOVA stores ciphertext; the decryption key is released by NOVA's TEE only to on-chain group members. | `npm test` (encryption and hash checks); on-chain record links in [Live run](#live-run) | planned |
| C2 | An agent spends only what its owner signed. The follower can pay only the listing in its owner's policy, and a copy above its per-trade limit is refused. | `npm run demo:mock` (refusal beats); live refusal records | planned |
| C3 | Payment is what grants access. The seller's agent admits a follower only after checking the payment on chain (final, successful, from the payer to the seller's proceeds account, exact asset and amount, never used before), and access always goes to the paying account. | `npm test` (payment-verification harness); live payment and admission links | planned |
| C4 | The follower verifies what it bought: the listing's fingerprint (a root over the entries' on-chain hashes), each decrypted entry's SHA-256, and the P&L recomputed from the journal against the public curve. | `npm test` (feed-verification harness); `npm run demo:mock` | planned |
| C5 | Access ends cleanly. At period end the seller revokes the follower, NOVA rotates the group key, and the follower's next read is refused. | live revocation link and refused read | planned |
| C6 | Every agent write is signed and paid by the agent's own NEAR account. NOVA signs nothing for it and holds no agent key. | live transaction links (signer = the agent's account) | planned |

## Try it (no keys needed)

Requires Node 24 (`.nvmrc`).

```bash
npm ci
npm test            # offline harnesses: Agent API, NOVA and NEAR RPC mocked behind fetch
npm run demo:mock   # the whole story with recorded model outputs; open the printed local URL
```

You should see a public P&L curve next to a locked trade feed; a hostile listing refused; a payment
verified and the feed unlocking with each check marked; an oversized copy refused while smaller ones
follow; and a revocation after which the follower is refused.

## Live mode

`npm run demo:live` reads `.env` (see `.env.example`). It needs your own Agent Connect partner key and
two agents whose owners have signed the policies described in [docs/live-setup.md](docs/live-setup.md).
It spends real, tiny amounts on NEAR mainnet (NEAR Intents has no testnet).

## Live run

Mainnet transactions from the recorded run: *to be filled in after the live run.*

## How NEAR is used

| NEAR component | Role |
|---|---|
| NEAR Intents Agent API (Agent Connect) | Each agent's account, owner-signed policy, USDC payment (withdrawal), swaps, signed NOVA writes (`native/near/call`), NOVA sign-in (NEP-413) |
| NEAR Intents | Settlement of the payment and of the trades |
| NOVA contract `nova-sdk.near` | Group membership, one on-chain record (timestamp + SHA-256) per journal entry, revocation |
| NEAR AI Cloud | The models that propose trades and decide whether to copy |

## Trust assumptions and limits

- **The follower trusts the seller to admit it after payment.** There is no on-chain escrow: NOVA's
  contract-enforced settlement is designed but parked, because a withdrawal's memo does not reach the
  chain. The seller's agent admits automatically after its on-chain check; no human and no NOVA
  operator decides.
- **The model provider sees what each agent reasons about.** The guarantee in C1 covers servers and
  storage, not the inference provider each agent uses.
- **"Verifiable" means consistent and committed in time, not profitable or complete.** The follower can
  check that the P&L matches the journal and that each entry was recorded when claimed. It cannot see
  journals the seller chose not to list.
- **Revocation stops future access only.** Entries the follower already decrypted stay with it.

## What existed before this hackathon, and what was built in it

The hackathon window opened on 2026-10-19 (NEAR HACKATHON rule Q-001).

| Piece | Origin | Date | In window |
|---|---|---|---|
| NOVA contract, MCP server, Shade TEE agent, `nova-sdk-js` | [jcarbonnell/nova](https://github.com/jcarbonnell/nova) | 2025–2026; self-custodial wallet mode (SDK 1.4.0, contract v0.3.7–v0.3.9) 2026-10-21 to 10-29 | partly |
| `src/vendor/nova-agent-connect.ts`, its harness and mutation script | `nova/nova-agent-connect` @ `ecd5fd4` | 2026-10-29 to 10-30 | yes |
| Payment observation (event shape, memo, refusals) | `nova/paid-handoff` | 2026-10-19 to 10-29 | yes |
| Everything else in this repository | this repository | from 2026-11-02 | yes |

Owner-side policy and funding scripts stay in `nova/paid-handoff` (they use the owner's wallet key and
are not part of this demo). NOVA's dashboard Cleanroom is private and is not used here.

## License

MIT, see [LICENSE](LICENSE).