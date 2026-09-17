import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import express from 'express';
import apiRouter from '../routes/api.js';
import { prepareInboundLiquidity, validateBootstrapRequest } from './bootstrap.js';

const VALID_PUBKEY = '03dfe0e6cc02a21ca3a971bc2fa05474872dc2acb91cc5defeb1f0566888536957';
const VALID_PUBKEY_WITH_0X = '0x03dfe0e6cc02a21ca3a971bc2fa05474872dc2acb91cc5defeb1f0566888536957';
const VALID_TESTNET_ADDRESS = 'ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq05hurcuuzeudh8ldfcxp48jfj2efakgkqz78dss';
const MAINNET_ADDRESS = 'ckb1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq05hurcuuzeudh8ldfcxp48jfj2efakgkqz78dss';

describe('Bootstrap Service and Route (Scheme B Phase-1)', () => {
  describe('validateBootstrapRequest', () => {
    it('accepts valid compressed pubkey and ckt1 testnet address', () => {
      const result = validateBootstrapRequest({
        node_pubkey: VALID_PUBKEY,
        funding_address: VALID_TESTNET_ADDRESS,
      });
      assert.equal(result.node_pubkey, VALID_PUBKEY);
      assert.equal(result.funding_address, VALID_TESTNET_ADDRESS);
    });

    it('accepts pubkey with 0x prefix', () => {
      const result = validateBootstrapRequest({
        node_pubkey: VALID_PUBKEY_WITH_0X,
        funding_address: VALID_TESTNET_ADDRESS,
      });
      assert.equal(result.node_pubkey, VALID_PUBKEY_WITH_0X);
    });

    it('rejects missing or empty node_pubkey', () => {
      assert.throws(
        () => validateBootstrapRequest({ funding_address: VALID_TESTNET_ADDRESS }),
        /node_pubkey must be a compressed secp256k1 public key/,
      );
      assert.throws(
        () => validateBootstrapRequest({ node_pubkey: '', funding_address: VALID_TESTNET_ADDRESS }),
        /node_pubkey must be a compressed secp256k1 public key/,
      );
    });

    it('rejects malformed or uncompressed node_pubkey', () => {
      assert.throws(
        () => validateBootstrapRequest({ node_pubkey: '03deadbeef', funding_address: VALID_TESTNET_ADDRESS }),
        /node_pubkey must be a compressed secp256k1 public key/,
      );
      assert.throws(
        () => validateBootstrapRequest({
          node_pubkey: '04' + 'a'.repeat(128),
          funding_address: VALID_TESTNET_ADDRESS,
        }),
        /node_pubkey must be a compressed secp256k1 public key/,
      );
    });

    it('rejects missing or empty funding_address', () => {
      assert.throws(
        () => validateBootstrapRequest({ node_pubkey: VALID_PUBKEY }),
        /funding_address must be a valid CKB testnet address/,
      );
      assert.throws(
        () => validateBootstrapRequest({ node_pubkey: VALID_PUBKEY, funding_address: '' }),
        /funding_address must be a valid CKB testnet address/,
      );
    });

    it('rejects CKB mainnet address', () => {
      assert.throws(
        () => validateBootstrapRequest({ node_pubkey: VALID_PUBKEY, funding_address: MAINNET_ADDRESS }),
        /funding_address must be a valid CKB testnet address/,
      );
    });

    it('rejects arbitrary non-CKB strings as funding_address', () => {
      assert.throws(
        () => validateBootstrapRequest({ node_pubkey: VALID_PUBKEY, funding_address: '0x1234567890abcdef' }),
        /funding_address must be a valid CKB testnet address/,
      );
      assert.throws(
        () => validateBootstrapRequest({ node_pubkey: VALID_PUBKEY, funding_address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' }),
        /funding_address must be a valid CKB testnet address/,
      );
    });
  });

  describe('prepareInboundLiquidity in mock mode', () => {
    it('returns ready status with simulated Phase-1 gifted capacity message', async () => {
      const session = await prepareInboundLiquidity({
        node_pubkey: VALID_PUBKEY,
        funding_address: VALID_TESTNET_ADDRESS,
      });

      assert.equal(session.status, 'ready');
      assert.ok(session.session_id);
      assert.ok(session.channel_id?.startsWith('mock_'));
      assert.ok(session.peer_address?.includes(VALID_PUBKEY));
      assert.match(session.message, /simulated.*gifted capacity/i);
    });
  });

  describe('POST /api/bootstrap HTTP route', () => {
    it('returns HTTP 400 when funding_address is missing', async () => {
      const app = express();
      app.use(express.json());
      app.use('/api', apiRouter);

      const server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ node_pubkey: VALID_PUBKEY }),
        });

        assert.equal(res.status, 400);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /funding_address/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('returns HTTP 400 when node_pubkey is invalid', async () => {
      const app = express();
      app.use(express.json());
      app.use('/api', apiRouter);

      const server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            node_pubkey: 'invalid_pubkey',
            funding_address: VALID_TESTNET_ADDRESS,
          }),
        });

        assert.equal(res.status, 400);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /node_pubkey/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('returns HTTP 400 when funding_address is a mainnet address', async () => {
      const app = express();
      app.use(express.json());
      app.use('/api', apiRouter);

      const server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            node_pubkey: VALID_PUBKEY,
            funding_address: MAINNET_ADDRESS,
          }),
        });

        assert.equal(res.status, 400);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /funding_address.*testnet/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('returns HTTP 201 and ready BootstrapSession in mock mode', async () => {
      const app = express();
      app.use(express.json());
      app.use('/api', apiRouter);

      const server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            node_pubkey: VALID_PUBKEY,
            funding_address: VALID_TESTNET_ADDRESS,
          }),
        });

        assert.equal(res.status, 201);
        const body = (await res.json()) as {
          session_id: string;
          status: string;
          peer_address: string;
          channel_id: string;
          message: string;
        };
        assert.equal(body.status, 'ready');
        assert.ok(body.session_id);
        assert.ok(body.peer_address.includes(VALID_PUBKEY));
        assert.match(body.message, /simulated/i);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
