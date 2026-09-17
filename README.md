# CKB On-ramp

CKB On-ramp is an early scaffold for a non-custodial first-deposit flow:

1. a user starts a new Fiber node in the browser;
2. the service prepares a route with inbound UDT liquidity for that node;
3. the browser node signs a Fiber invoice;
4. the backend asks a Fiber CCH operator to create the matching Lightning invoice;
5. the user pays that invoice from their own LND node;
6. the CCH order settles the wrapped-BTC UDT to the browser Fiber node.

The backend operates against testnet with real RPC endpoints (FNN CCH actor and CKB node via CCC). If `OPERATOR_CKB_PRIVATE_KEY` is not configured, inbound-liquidity provisioning fails closed (HTTP 501). End-to-end deposits depend on live testnet infrastructure and are not claimed to be fully working without active external CCH settlement and testnet funding.

## Why the bootstrap exists

A new Fiber node cannot receive merely by creating an invoice. It first needs a reachable peer and inbound UDT liquidity. This is the main difference from [fiber-swap-demo](https://github.com/humble-little-bear/fiber-swap-demo), which assumes Fiber connectivity and liquidity already exist.

## Run locally

Requirements: Node.js 22+ and npm 10+.

```bash
npm install
npm run dev
```

- Web: `http://localhost:5173`
- API: `http://localhost:3001`

The development server and production preview set the COOP/COEP headers required by Fiber WASM.

## Verify

```bash
npm run typecheck
npm run build
npm test
```

## Environment

Copy `.env.example` to `.env` to override defaults.

| Variable | Default | Purpose |
| --- | --- | --- |
| `FNN_RPC_URL` | `http://127.0.0.1:8227` | Operator Fiber node JSON-RPC |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed web origin |
| `CCH_BASE_FEE_SATS` | `100` | Quote base fee; must match FNN |
| `CCH_FEE_RATE_PPM` | `3000` | Quote proportional fee; must match FNN |
| `VITE_API_BASE_URL` | `http://localhost:3001/api` | Browser API base URL |
| `OPERATOR_CKB_PRIVATE_KEY` | _(none)_ | 32-byte hex private key for operator CKB capacity gifts |
| `CKB_RPC_URL` | `https://testnet.ckb.dev/rpc` | CKB node RPC URL |
| `OPERATOR_CHANNEL_FUNDING_AMOUNT` | `100000000` | cWBTC channel funding amount in raw units |

Never send an LND macaroon, TLS key, seed phrase, or Fiber key to this backend. The user pays the returned BOLT11 invoice from their own LND instance.
