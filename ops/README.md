# Local e2e stack

Bring up Bitcoin Lightning, CKB Fiber, and the CCH bridge on one machine so you can walk the on-ramp protocol without testnet faucets.

## What the product does

```
user LND  --pays BOLT11 hold invoice-->  CCH LND
                                              |
                                         same payment_hash
                                              v
browser/CLI Fiber node  <--UDT (cWBTC)---  operator Fiber (FNN + CCH)
```

1. User Fiber node starts (browser WASM on testnet, or a local FNN here).
2. Operator funds an inbound UDT channel to that node (Scheme B: ~200 CKB capacity + cWBTC).
3. User signs a Fiber invoice (`sha256`, wrapped-BTC UDT).
4. Backend calls CCH `receive_btc`; CCH creates an LND hold invoice with the same payment hash.
5. User pays that BOLT11 from **their own** LND (this repo never takes a macaroon).
6. CCH pays the Fiber invoice; the user node reveals the preimage; CCH settles the hold invoice.

LND pays a Lightning invoice, not the `fibt`/`fibd` string.

## Two ways to run it

| | Local CLI (this folder) | Web app |
|---|---|---|
| CKB | offckb devnet | CKB testnet |
| Fiber | offckb FNN node 1 (operator) + node 2 (user) | Browser WASM (`network: 'testnet'`) + fiber-pay operator |
| BTC | bitcoind regtest + 2 LND containers | same local LND, or a real testnet LND |
| Invoice currency | `Fibd` | `Fibt` |
| Wrapped BTC | offckb xUDT issued for e2e | testnet cWBTC |

The Vite app is still locked to testnet WASM + the testnet cWBTC script. Use `stack.sh e2e` for a full local protocol run. Pointing the website at this stack needs a later FiberProvider/UDT change.

## Prerequisites

- Docker Desktop running
- `offckb` (`0.5.0-canary` or later with Fiber support)
- `fiber-pay` `0.3.0` (used to download `fnn v0.9.0` for standalone CCH)
- `python3`, `jq`, `openssl`
- Node 22+ if you also run `npm run dev`

Do not reuse `~/.fiber-pay` or the `/tmp/ckb-on-ramp-poc` nodes. This stack keeps data under `ops/data/`.

## Commands

```bash
npm run stack:up        # bitcoind+LND, offckb CKB/Fiber, CCH, channels
npm run stack:status
npm run stack:e2e       # Fiber invoice → user LND pays → UDT arrives
npm run stack:down      # stop processes; keeps ops/data
```

Equivalent: `bash ops/stack.sh up`.

`stack:up` writes `ops/runtime.env`. If the repo has no `.env` yet, it copies that file so `npm run dev` talks to the local operator Fiber (`FNN_RPC_URL`) and standalone CCH (`CCH_RPC_URL`).

## Ports

| Service | Port |
|---|---|
| bitcoind RPC | 18443 |
| CCH LND gRPC | 10009 |
| user LND gRPC | 11009 |
| offckb CKB | 8114 |
| operator Fiber | 21714 |
| user Fiber | 21715 |
| standalone CCH | 8227 |
| API (app) | 3001 |
| web (app) | 5173 |

## Paying a hold invoice yourself

After `stack:up` / `stack:e2e` you can also pay with:

```bash
docker compose -f ops/docker-compose.yml --project-directory ops \
  exec lnd-user lncli --network=regtest payinvoice --force <bolt11>
```

CCH LND:

```bash
docker compose -f ops/docker-compose.yml --project-directory ops \
  exec lnd-cch lncli --network=regtest getinfo
```

## Reset

```bash
npm run stack:down
rm -rf ops/data
```

If `offckb fiber start` refuses because the existing local chain has no Fiber contracts in genesis:

```bash
offckb node stop --force
offckb clean
npm run stack:up
```

`offckb clean` deletes the local CKB chain. It does not touch this git repo.
