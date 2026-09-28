#!/usr/bin/env node
/**
 * ops/prep-gift-cells.mjs
 *
 * Pre-splits operator gift wallet (OPERATOR_CKB_PRIVATE_KEY) into multiple small (~220 CKB)
 * cells. When multiple users concurrently open sponsored channels via openChannelWithExternalFunding,
 * user WASM nodes pick live gift cells independently. Having many pre-split ~220 CKB cells reduces
 * the probability of two sessions selecting the same input UTXO.
 *
 * Usage:
 *   node ops/prep-gift-cells.mjs [--count 10] [--amount 220] [--dry-run]
 *
 * Environment:
 *   OPERATOR_CKB_PRIVATE_KEY: 32-byte hex private key (required)
 *   CKB_RPC_URL: optional CKB RPC URL (default: public testnet)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Address,
  ClientPublicTestnet,
  SignerCkbPrivateKey,
  Transaction,
  fixedPointFrom,
} from '@ckb-ccc/core';

// Load .env file if present in workspace root or ops directory
function loadDotEnv() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    path.resolve(__dirname, '../.env'),
    path.resolve(__dirname, '.env'),
    path.resolve(process.cwd(), '.env'),
  ];
  for (const envPath of candidatePaths) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (process.env[key] === undefined) {
            process.env[key] = val;
          }
        }
      }
      break;
    }
  }
}

loadDotEnv();

function printHelp() {
  console.log(`
prep-gift-cells.mjs - Pre-split operator gift wallet into ~220 CKB cells

Options:
  --count <n>       Number of cells to create (default: 10)
  --amount <ckb>    Capacity per cell in CKB (default: 220)
  --rpc <url>       CKB RPC URL (default: public testnet)
  --dry-run         Assemble and inspect transaction without broadcasting
  --help            Show this help message

Environment:
  OPERATOR_CKB_PRIVATE_KEY  32-byte hex private key (required)
  CKB_RPC_URL               CKB RPC URL (optional)
`);
}

async function main() {
  const args = process.argv.slice(2);
  let count = 10;
  let amountCkb = 220;
  let dryRun = false;
  let rpcUrl = process.env.CKB_RPC_URL;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      return;
    }
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--count' && i + 1 < args.length) {
      count = parseInt(args[++i], 10);
    } else if (arg === '--amount' && i + 1 < args.length) {
      amountCkb = parseInt(args[++i], 10);
    } else if (arg === '--rpc' && i + 1 < args.length) {
      rpcUrl = args[++i];
    }
  }

  const privateKey = process.env.OPERATOR_CKB_PRIVATE_KEY?.trim();
  if (!privateKey) {
    console.error('Error: OPERATOR_CKB_PRIVATE_KEY environment variable is required.');
    console.error('Set it in your environment or in .env');
    process.exit(1);
  }

  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) {
    console.error('Error: OPERATOR_CKB_PRIVATE_KEY must be a 32-byte hex private key.');
    process.exit(1);
  }

  if (count <= 0 || isNaN(count)) {
    console.error('Error: --count must be a positive integer.');
    process.exit(1);
  }
  if (amountCkb < 61 || isNaN(amountCkb)) {
    console.error('Error: --amount must be at least 61 CKB (minimum cell capacity).');
    process.exit(1);
  }

  const client = rpcUrl ? new ClientPublicTestnet({ url: rpcUrl }) : new ClientPublicTestnet();
  const signer = new SignerCkbPrivateKey(client, privateKey);
  const addrObj = await signer.getRecommendedAddressObj();
  const address = await addrObj.toString();

  console.log(`[prep-gift-cells] Operator Address: ${address}`);
  console.log(`[prep-gift-cells] Target: ${count} cells x ${amountCkb} CKB = ${count * amountCkb} CKB total`);

  const capacityPerCell = fixedPointFrom(amountCkb);
  const outputs = [];
  for (let i = 0; i < count; i += 1) {
    outputs.push({
      lock: addrObj.script,
      capacity: capacityPerCell,
    });
  }

  const tx = Transaction.from({ outputs });
  console.log('[prep-gift-cells] Balancing inputs and calculating transaction fee…');
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer);

  console.log(`[prep-gift-cells] Transaction assembled:`);
  console.log(`  - Inputs:  ${tx.inputs.length} cell(s)`);
  console.log(`  - Outputs: ${tx.outputs.length} cell(s) (${count} target cells + change)`);
  console.log(`  - Fee:     ${tx.fee ? (Number(tx.fee) / 1e8).toFixed(6) : 'auto'} CKB`);

  if (dryRun) {
    console.log('[prep-gift-cells] --dry-run specified: skipping broadcast.');
    return;
  }

  console.log('[prep-gift-cells] Signing and broadcasting transaction…');
  const txHash = await signer.sendTransaction(tx);
  console.log(`[prep-gift-cells] Transaction broadcast: ${txHash}`);
  console.log('[prep-gift-cells] Waiting for on-chain confirmation…');
  await client.waitTransaction(txHash);
  console.log(`[prep-gift-cells] Confirmation confirmed! Successfully created ${count} cells of ~${amountCkb} CKB.`);
}

main().catch((err) => {
  console.error('[prep-gift-cells] Failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
