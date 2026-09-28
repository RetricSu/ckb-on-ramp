# Local protocol e2e stack

This runbook exercises the Lightning → CCH → Fiber protocol entirely on a local development network, without testnet faucets or the browser app.

It is intentionally separate from the website workflow:

| | Protocol stack in this folder | Website (`npm run dev`) |
| --- | --- | --- |
| CKB | offckb devnet | CKB testnet |
| User Fiber node | offckb FNN node 2 (CLI) | Browser WASM with `network: 'testnet'` |
| Operator Fiber | offckb FNN node 1 | Testnet fiber-pay operator |
| Wrapped BTC | Local xUDT issued by the script | Testnet cWBTC |
| Invoice currency | `Fibd` | `Fibt` |

Do not use this stack as a reason to change `apps/web/src/FiberProvider.tsx`, point Vite at offckb, or substitute the website's cWBTC script. A web node on testnet cannot use the devnet xUDT or a `Fibd` invoice.

## What it runs

```text
user LND  --pays BOLT11 hold invoice-->  CCH LND
                                              |
                                         same payment_hash
                                              v
user FNN  <--local xUDT over Fiber--  operator FNN + standalone CCH
```

`stack:up` starts and prepares:

- bitcoind regtest plus `lnd-user` and `lnd-cch` in Docker;
- one offckb CKB devnet and two offckb FNN nodes;
- a local xUDT, issued to the devnet accounts;
- Lightning and Fiber channels with the required direction of liquidity;
- standalone CCH from the FNN binary downloaded through `fiber-pay`.

## Prerequisites

- Node.js 22+ and npm 10+ (the root `npm run stack:*` wrappers).
- Docker Desktop installed and running.
- `offckb` 0.5.0-canary or later with Fiber support.
- `fiber-pay` 0.3.0.
- `python3`, `jq`, and `openssl` on `PATH`.

Install repository dependencies with `npm install` if this is a fresh worktree.

No testnet `OPERATOR_CKB_PRIVATE_KEY` is required here. The script uses pre-funded offckb devnet accounts, generates its local secrets under gitignored `ops/data/`, and sets `SKIP_CAPACITY_GIFT=1`. Treat `ops/data/` as secret local state anyway: it contains keys and LND credentials, so do not publish or commit it.

## Start, inspect, verify, and stop

Run these commands from the repository root:

```bash
npm run stack:up
npm run stack:status
npm run stack:e2e
npm run stack:down
```

- `stack:up` starts every service, issues/reuses the local xUDT, opens the channels, and waits until they are usable. The first run may take longer while offckb and fiber-pay download/start FNN components.
- `stack:status` shows Docker services, LND sync/channel state, offckb Fiber status, and the standalone CCH process. It is safe to run repeatedly.
- `stack:e2e` creates a `Fibd` invoice on the user FNN for the local xUDT, calls CCH `receive_btc`, pays the returned BOLT11 hold invoice from `lnd-user`, waits for CCH success, and confirms that the user Fiber invoice settled. `E2E PASS` means that protocol chain completed; it does **not** verify browser WASM, passkeys, testnet cWBTC, or the website UI.
- `stack:down` stops CCH, offckb/FNN, bitcoind, and both LND containers. It keeps `ops/data/`, so the next start can reuse the chain and wallet state.

Equivalent direct command: `bash ops/stack.sh <up|status|e2e|down|logs>`.

To inspect recent CCH and Docker logs:

```bash
bash ops/stack.sh logs
```

## Generated environment files

`stack:up` writes gitignored `ops/runtime.env` with local endpoints, including:

```dotenv
FNN_RPC_URL=http://127.0.0.1:21714
CCH_RPC_URL=http://127.0.0.1:8227
CKB_RPC_URL=http://127.0.0.1:8114
SKIP_CAPACITY_GIFT=1
```

If the repository has no `.env`, the script also copies `ops/runtime.env` to `.env`; it never overwrites an existing `.env`.

These values describe the protocol harness. `FNN_RPC_URL` is its local operator FNN and `CCH_RPC_URL` is its standalone CCH. They are not valid website-path settings because the browser remains on testnet with testnet cWBTC. Before later running the website, replace an ops-generated `.env` with the testnet operator configuration described in the root [README](../README.md).

The testnet-only `OPERATOR_CKB_PRIVATE_KEY` in `.env.example` is deliberately unused by this local stack. Never add a real private key to `.env.example` or git; `.env`, `ops/runtime.env`, and `ops/data/` are gitignored.

## Ports

| Service | Port |
| --- | --- |
| bitcoind RPC | 18443 |
| CCH LND gRPC | 10009 |
| user LND gRPC | 11009 |
| offckb CKB | 8114 |
| operator FNN | 21714 |
| user FNN | 21715 |
| standalone CCH | 8227 |

## Manual Lightning inspection

Pay a returned BOLT11 from the user LND:

```bash
docker compose -f ops/docker-compose.yml --project-directory ops \
  exec lnd-user lncli --network=regtest payinvoice --force <bolt11>
```

Inspect the CCH-side LND:

```bash
docker compose -f ops/docker-compose.yml --project-directory ops \
  exec lnd-cch lncli --network=regtest getinfo
```

## Troubleshooting

- **`missing required command: docker` or `Docker daemon is not running`:** install/start Docker Desktop, verify `docker info`, and rerun `stack:up`.
- **A port is already in use:** stop the conflicting local process or the older stack, then retry. Use `stack:status` and `bash ops/stack.sh logs` to identify what is already running.
- **offckb Fiber refuses to start because genesis has no Fiber contracts:** the existing offckb devnet predates Fiber support. Reset that local chain as shown below.
- **`stack:e2e` says the stack or CCH is missing:** run `stack:up` first and check `stack:status`; the e2e command does not start dependencies itself.
- **You see `Fibt`, cWBTC, passkey, COOP, or COEP errors:** those belong to the separate browser/testnet path. This CLI run should use `Fibd` and the xUDT recorded in `ops/data/udt.json`.

## Reset local state

Normally, keep the state and use `npm run stack:down`. For a clean protocol stack reset:

```bash
npm run stack:down
rm -rf ops/data
npm run stack:up
```

`ops/data` is generated and gitignored, but deleting it removes local keys, LND wallets, logs, and cached stack state.

If only the offckb chain is incompatible with Fiber genesis contracts:

```bash
offckb node stop --force
offckb clean
npm run stack:up
```

`offckb clean` deletes the offckb local chain; it does not touch this repository.

## Receive availability checks

Before opening or signing a new channel, the API verifies the operator gift-lock CKB and the FNN funding-lock CKB/cWBTC live cells. A missing inventory reader, an unavailable FNN funding lock, insufficient CKB, insufficient cWBTC, or the absence of an exact-sized cWBTC input cell makes `/api/health` and `/api/node-info` report `can_receive: false`; bootstrap/sign-funding then reject before creating a partially funded channel.

The current FNN/CCH RPC surface does not expose a reliable CCH LND inbound-liquidity balance, so LND-side inbound capacity is **not checked** here. This is an explicit remaining risk rather than a readiness signal inferred from node health.
