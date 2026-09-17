import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import apiRouter from '../routes/api.js';
import { CchRpcError, MockCchGateway, RpcCchGateway } from './cch.js';

describe('NodeInfo Service and Route', () => {
  describe('MockCchGateway.getNodeInfo', () => {
    it('returns stable fake node_id, wss multiaddr, and counts', async () => {
      const gateway = new MockCchGateway();
      const info = await gateway.getNodeInfo();

      assert.equal(typeof info.node_id, 'string');
      assert.match(info.node_id, /^[0-9a-fA-F]{66}$/);
      assert.ok(Array.isArray(info.addresses));
      assert.ok(info.addresses.length > 0);
      assert.ok(info.addresses.some((addr) => addr.includes('/wss')));
      assert.equal(typeof info.channel_count, 'number');
      assert.ok(info.channel_count >= 0);
      assert.equal(typeof info.peer_count, 'number');
      assert.ok(info.peer_count >= 0);
    });
  });

  describe('RpcCchGateway.getNodeInfo', () => {
    it('maps FNN node_info fields to NodeInfo DTO', async () => {
      let requestedMethod = '';
      const fnnServer = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          const payload = JSON.parse(body) as { method: string; id: string };
          requestedMethod = payload.method;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            result: {
              version: '0.9.0-rc7',
              commit_hash: 'abc1234',
              pubkey: '03dfe0e6cc02a21ca3a971bc2fa05474872dc2acb91cc5defeb1f0566888536957',
              addresses: ['/ip4/127.0.0.1/tcp/18328/ws'],
              channel_count: '0x3',
              peers_count: '0xa',
            },
          }));
        });
      });

      await new Promise<void>((resolve) => fnnServer.listen(0, resolve));
      const address = fnnServer.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      try {
        const gateway = new RpcCchGateway(`http://127.0.0.1:${port}`);
        const info = await gateway.getNodeInfo();

        assert.equal(requestedMethod, 'node_info');
        assert.equal(info.node_id, '03dfe0e6cc02a21ca3a971bc2fa05474872dc2acb91cc5defeb1f0566888536957');
        assert.deepEqual(info.addresses, ['/ip4/127.0.0.1/tcp/18328/ws']);
        assert.equal(info.channel_count, 3);
        assert.equal(info.peer_count, 10);
      } finally {
        await new Promise<void>((resolve) => fnnServer.close(() => resolve()));
      }
    });

    it('preserves empty addresses array without inventing public WSS', async () => {
      const fnnServer = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          const payload = JSON.parse(body) as { id: string };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            result: {
              pubkey: '03dfe0e6cc02a21ca3a971bc2fa05474872dc2acb91cc5defeb1f0566888536957',
              addresses: [],
              channel_count: 0,
              peers_count: 0,
            },
          }));
        });
      });

      await new Promise<void>((resolve) => fnnServer.listen(0, resolve));
      const address = fnnServer.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      try {
        const gateway = new RpcCchGateway(`http://127.0.0.1:${port}`);
        const info = await gateway.getNodeInfo();
        assert.deepEqual(info.addresses, []);
      } finally {
        await new Promise<void>((resolve) => fnnServer.close(() => resolve()));
      }
    });

    it('throws CchRpcError when FNN returns an RPC error', async () => {
      const fnnServer = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          const payload = JSON.parse(body) as { id: string };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            error: { code: -32601, message: 'Method not found' },
          }));
        });
      });

      await new Promise<void>((resolve) => fnnServer.listen(0, resolve));
      const address = fnnServer.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      try {
        const gateway = new RpcCchGateway(`http://127.0.0.1:${port}`);
        await assert.rejects(async () => gateway.getNodeInfo(), (err: unknown) => {
          assert.ok(err instanceof CchRpcError);
          assert.equal(err.code, -32601);
          return true;
        });
      } finally {
        await new Promise<void>((resolve) => fnnServer.close(() => resolve()));
      }
    });

    it('fails closed with error when FNN is unreachable (no mock fallback)', async () => {
      // Connect to a closed port
      const gateway = new RpcCchGateway('http://127.0.0.1:59999');
      await assert.rejects(async () => gateway.getNodeInfo(), /fetch failed|ECONNREFUSED/);
    });
  });

  describe('GET /api/node-info HTTP route', () => {
    it('returns HTTP 200 and NodeInfo DTO in mock mode', async () => {
      const app = express();
      app.use(express.json());
      app.use('/api', apiRouter);

      const server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/node-info`);
        assert.equal(res.status, 200);

        const body = (await res.json()) as {
          node_id: string;
          addresses: string[];
          channel_count: number;
          peer_count: number;
        };

        assert.equal(typeof body.node_id, 'string');
        assert.ok(body.node_id.length > 0);
        assert.ok(Array.isArray(body.addresses));
        assert.ok(body.addresses.some((addr) => addr.includes('/wss')));
        assert.equal(typeof body.channel_count, 'number');
        assert.equal(typeof body.peer_count, 'number');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('CCH_MODE=rpc fail-closed bootstrap verification', () => {
    it('POST /api/bootstrap returns HTTP 501 when CCH_MODE=rpc', () => {
      const output = execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '-e',
          `
          import express from "express";
          import { createServer } from "node:http";
          import apiRouter from "./src/routes/api.js";
          const app = express();
          app.use(express.json());
          app.use("/api", apiRouter);
          const server = createServer(app);
          server.listen(0, async () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            const res = await fetch(\`http://127.0.0.1:\${port}/api/bootstrap\`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                node_pubkey: "03dfe0e6cc02a21ca3a971bc2fa05474872dc2acb91cc5defeb1f0566888536957",
                funding_address: "ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq05hurcuuzeudh8ldfcxp48jfj2efakgkqz78dss",
              }),
            });
            console.log(JSON.stringify({ status: res.status, body: await res.json() }));
            server.close();
          });
          `,
        ],
        {
          cwd: fileURLToPath(new URL('../..', import.meta.url)),
          env: { ...process.env, CCH_MODE: 'rpc' },
          encoding: 'utf8',
        },
      );

      const parsed = JSON.parse(output.trim()) as {
        status: number;
        body: { status: string; message: string };
      };

      assert.equal(parsed.status, 501);
      assert.equal(parsed.body.status, 'failed');
      assert.match(parsed.body.message, /Scheme B/i);
      assert.match(parsed.body.message, /not wired/i);
    });
  });
});
