# Running the live demo (`npm run demo:live`)

The live demo runs the whole story on NEAR mainnet with two real agents. NEAR Intents has no testnet, so it
spends real, tiny amounts. You do not need to run it to review the project: the recorded run is in
[docs/proof/2026-11-04/](proof/2026-11-04/) and replays without credentials
(`VIEWER_STATE=docs/proof/2026-11-04 npm run viewer`).

## What it costs

| Who | What | Per run |
|---|---|---|
| Follower | the payment, from its NEAR Intents balance (`intents.near`) | 0.10 USDC |
| Seller | gas and NOVA deposits for 7 uploads, 1 admission, 1 revocation | well under 0.5 NEAR |

Dry quotes (the trades, the copies, the payment preview) are free.

## What you need

1. **Two Agent Connect agents** (NEAR Intents Agent API), each with its own NEAR account, Agent API key and
   grant token. The seller and the follower must be different agents.
2. **An owner-signed policy for each**, matching what the preflight checks:

   | Agent | Policy |
   |---|---|
   | Seller | actions: `swap` only; destinations: `any` (a NOVA call's deposit is checked as a withdrawal, see [deferrals](deferrals.md)); native NEAR: no transfers, calls to `nova-sdk.near` only; at most 12 actions per hour |
   | Follower | destinations: only the seller's proceeds account, as a withdrawal with memo `copytrade`; per-transaction limit 0.15 USDC; native NEAR: no transfers |

   The policies are signed by each agent's human owner with the owner's own wallet. The owner-side scripts
   used for the recorded run live in [jcarbonnell/nova](https://github.com/jcarbonnell/nova)
   (`paid-handoff/`), not in this repository, because they use the owner's key.
3. **A NOVA group owned by the seller agent** (created by the agent under its own account).
4. **Funds**: the seller holds some NEAR (0.5 is plenty); the follower holds at least 0.10 USDC on
   `intents.near` per run, deposited to its Agent API balance (a plain USDC transfer to its account does not
   reach that balance).

## Credentials: one directory per agent, outside the repository

```
<SELLER_DIR>/.env            NEAR_INTENTS_AGENT_API_KEY=...  and  NEAR_INTENTS_AGENT_API_URL=...
<SELLER_DIR>/.grant-token    the seller's grant token
<SELLER_DIR>/aa-state.json   {"agent_id": "..."}
<FOLLOWER_DIR>/...           the same three files for the follower
```

Defaults: `SELLER_DIR=~/near/nova/paid-handoff`, `FOLLOWER_DIR=~/near/nova/paid-handoff/follower-1`. Every
variable is listed in [`.env.example`](../.env.example). `demo:live` reads these files and never prints them; it
refuses if both directories hold the same agent.

## Using your own agents

`demo:live` is wired to the two agents of the recorded run. Change the constants at the top of
`src/demo/live.ts` to yours: `GROUP_ID`, `SELLER_ACCOUNT`, `FOLLOWER_ACCOUNT`, `SELLER_AGENT` and `PROCEEDS`.
The preflight then fails with a named check if an account, a policy or a balance does not match.

## Run it

```bash
export AGENT_API_BASE_URL=...          # only if the seller's .env has no NEAR_INTENTS_AGENT_API_URL
npm run demo:live -- --preflight       # read-only: expect "preflight: 12/12 passed"
VIEWER_STATE=state npm run viewer      # terminal 1 (optional)
npm run demo:live                      # terminal 2: about 4 min of preflight, then about 25 min
```

The run asks you to type `pay` before the payment and stops at the first failed beat, printing why. It
expects a fresh `state/`: move an earlier run aside first, for example
`mv state/seller state/run1-seller; mv state/follower state/run1-follower; mv state/follower-hostile state/run1-follower-hostile`.

While it runs, the viewer stays on its closing card (see [deferrals](deferrals.md)); open
http://127.0.0.1:8790/?autoplay&pace=4000 once it prints `DONE` to replay it.

## What to expect

| Beat | Output |
|---|---|
| 1 | three `entry_written`, then `listing_published` |
| 2 | `payment_refused_by_policy` for listing #99 (`policy_destination_denied`) |
| 3 | `payment_sent`, `payment_settled`, then (after the seller's check, 1–4 min) `payment_verified`, `member_admitted`, `admitted` |
| 4 | `feed_verified` |
| 5 | three more entries; `copy_done` (0.05), `copy_refused` (0.18, `policy_transaction_limit_exceeded`), the sell |
| 6 | at the end of the period `member_revoked`, `access_ended`; entry 7 refused to the follower |

## When something goes wrong

- **P11 skipped**: it re-verifies an earlier real payment and needs one (`PREFLIGHT_PAYMENT_DIR`). Without
  one it is skipped; the run still verifies its own payment.
- **Slow or rate-limited RPC**: archival requests are paced (1200 ms) and timeouts, 429 and 502/503/504 are
  retried with backoff. Raise `NEAR_ARCHIVAL_MIN_INTERVAL_MS` or use another archival endpoint
  (`NEAR_ARCHIVAL_RPC_URL`).
- **`listing_build_failed … NOT_OBSERVED` right after the first entry**: NOVA had not indexed the new record
  yet; the next entry's rebuild succeeds. Nothing is lost.
- **A recipient that does not exist** is refused by the Agent API before the policy is checked, so
  `HOSTILE_PROCEEDS` must be an existing account outside the follower's policy.
