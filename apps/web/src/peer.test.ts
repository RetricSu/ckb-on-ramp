import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BootstrapRequest, BootstrapSession, NodeInfo } from '@ckb-on-ramp/contracts';
import type { Script } from '@fiber-pay/sdk/browser';
import { isMockPeerAddress, pickPeerAddress, prepareReceiveRoute } from './peer.js';

describe('Peer address picker and route preparation', () => {
  describe('pickPeerAddress', () => {
    it('returns null for empty, null, or undefined addresses', () => {
      assert.equal(pickPeerAddress([]), null);
      assert.equal(pickPeerAddress(null), null);
      assert.equal(pickPeerAddress(undefined), null);
    });

    it('returns null when only raw TCP addresses are present (no ws/wss)', () => {
      const addresses = [
        '/ip4/127.0.0.1/tcp/18228',
        '/ip4/192.168.1.1/tcp/18228/p2p/Qm1234567890abcdef',
      ];
      assert.equal(pickPeerAddress(addresses), null);
    });

    it('picks /wss address when only /wss is present', () => {
      const addresses = ['/dns4/mock-provider.test/tcp/8443/wss'];
      assert.equal(pickPeerAddress(addresses), '/dns4/mock-provider.test/tcp/8443/wss');
    });

    it('picks /ws address when only /ws is present', () => {
      const addresses = ['/ip4/127.0.0.1/tcp/18328/ws'];
      assert.equal(pickPeerAddress(addresses), '/ip4/127.0.0.1/tcp/18328/ws');
    });

    it('prefers /wss over /ws regardless of array order', () => {
      const wsFirst = [
        '/ip4/127.0.0.1/tcp/18328/ws',
        '/dns4/operator.example.com/tcp/8443/wss',
      ];
      assert.equal(pickPeerAddress(wsFirst), '/dns4/operator.example.com/tcp/8443/wss');

      const wssFirst = [
        '/dns4/operator.example.com/tcp/8443/wss',
        '/ip4/127.0.0.1/tcp/18328/ws',
      ];
      assert.equal(pickPeerAddress(wssFirst), '/dns4/operator.example.com/tcp/8443/wss');
    });

    it('picks the first /wss when multiple /wss addresses exist', () => {
      const addresses = [
        '/dns4/first.example.com/tcp/8443/wss',
        '/dns4/second.example.com/tcp/8443/wss',
      ];
      assert.equal(pickPeerAddress(addresses), '/dns4/first.example.com/tcp/8443/wss');
    });

    it('picks the first /ws when multiple /ws addresses exist and no /wss', () => {
      const addresses = [
        '/ip4/127.0.0.1/tcp/18328/ws',
        '/ip4/10.0.0.1/tcp/18328/ws',
      ];
      assert.equal(pickPeerAddress(addresses), '/ip4/127.0.0.1/tcp/18328/ws');
    });

    it('handles addresses with p2p peer ID suffixes', () => {
      const addresses = [
        '/ip4/127.0.0.1/tcp/18328/ws/p2p/QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N',
      ];
      assert.equal(pickPeerAddress(addresses), addresses[0]);
    });

    it('does not falsely match domains ending in .ws without ws protocol component', () => {
      const addresses = [
        '/dns4/node.ws/tcp/18328',
      ];
      assert.equal(pickPeerAddress(addresses), null);
    });
  });

  describe('isMockPeerAddress', () => {
    it('identifies mock-provider.test and .test addresses as mock', () => {
      assert.equal(isMockPeerAddress('/dns4/mock-provider.test/tcp/8443/wss'), true);
      assert.equal(isMockPeerAddress('/dns4/fnn.test/tcp/8443/wss'), true);
    });

    it('identifies real testnet and local addresses as non-mock', () => {
      assert.equal(isMockPeerAddress('/dns4/operator.ckb.dev/tcp/8443/wss'), false);
      assert.equal(isMockPeerAddress('/ip4/127.0.0.1/tcp/18328/ws'), false);
    });

    it('returns false for null or undefined', () => {
      assert.equal(isMockPeerAddress(null), false);
      assert.equal(isMockPeerAddress(undefined), false);
    });
  });

  describe('prepareReceiveRoute', () => {
    const mockNodeInfo: NodeInfo = {
      node_id: '03dfe0e6cc02a21ca3a971bc2fa05474872dc2acb91cc5defeb1f0566888536957',
      addresses: ['/dns4/mock-provider.test/tcp/8443/wss'],
      channel_count: 0,
      peer_count: 0,
    };

    const mockFundingLockScript: Script = {
      code_hash: '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8',
      hash_type: 'type',
      args: '0x029a8d5bd239bc1d7f85d65dc319022fc5934a41871473d63306b4022ee58c1e09',
    };
    const expectedDerivedAddress = 'ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqgzn2x4h53ehswhlpwkthp3jq30ckf55sv8z3eavvcxkspzaevvrcysvmgle9';
    const explicitFundingAddress = 'ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq05hurcuuzeudh8ldfcxp48jfj2efakgkqz78dss';

    it('throws if node is not running or nodePubkey is missing', async () => {
      await assert.rejects(
        () => prepareReceiveRoute({
          nodePubkey: undefined,
          fundingAddress: explicitFundingAddress,
          connectPeer: async () => {},
          getNodeInfo: async () => mockNodeInfo,
          bootstrap: async () => ({ session_id: '1', status: 'ready', message: 'ok' }),
        }),
        /Start the browser Fiber node/,
      );

      await assert.rejects(
        () => prepareReceiveRoute({
          nodePubkey: '0328d1d5...',
          fundingAddress: explicitFundingAddress,
          connectPeer: null,
          getNodeInfo: async () => mockNodeInfo,
          bootstrap: async () => ({ session_id: '1', status: 'ready', message: 'ok' }),
        }),
        /Start the browser Fiber node/,
      );
    });

    it('throws if default funding lock script and funding address are both missing', async () => {
      await assert.rejects(
        () => prepareReceiveRoute({
          nodePubkey: '0328d1d5...',
          connectPeer: async () => {},
          getNodeInfo: async () => mockNodeInfo,
          bootstrap: async () => ({ session_id: '1', status: 'ready', message: 'ok' }),
        }),
        /funding lock script is unavailable/,
      );
    });

    it('derives funding_address from default_funding_lock_script and posts with node_pubkey', async () => {
      let receivedRequest: BootstrapRequest | null = null;

      const session: BootstrapSession = {
        session_id: 'test-session',
        status: 'ready',
        message: 'Mock inbound route is ready (simulated Phase-1 Scheme B gifted capacity).',
      };

      const result = await prepareReceiveRoute({
        nodePubkey: '029a8d5b...',
        defaultFundingLockScript: mockFundingLockScript,
        connectPeer: async () => {},
        getNodeInfo: async () => mockNodeInfo,
        bootstrap: async (req) => {
          receivedRequest = req;
          return session;
        },
        mode: 'mock',
      });

      assert.equal(result.status, 'ready');
      assert.deepEqual(receivedRequest, {
        node_pubkey: '029a8d5b...',
        funding_address: expectedDerivedAddress,
      });
    });

    describe('in RPC mode (CCH_MODE=rpc / testnet)', () => {
      it('fails closed when operator addresses is empty without calling connectPeer or bootstrap', async () => {
        let connectCalled = false;
        let bootstrapCalled = false;

        const rpcEmptyNodeInfo: NodeInfo = {
          node_id: '03dfe0e6cc02a21ca3a971bc2fa05474872dc2acb91cc5defeb1f0566888536957',
          addresses: [],
          channel_count: 0,
          peer_count: 0,
        };

        await assert.rejects(
          () => prepareReceiveRoute({
            nodePubkey: '029a8d5b...',
            fundingAddress: explicitFundingAddress,
            connectPeer: async () => { connectCalled = true; },
            getNodeInfo: async () => rpcEmptyNodeInfo,
            bootstrap: async () => { bootstrapCalled = true; return { session_id: '1', status: 'ready', message: 'ok' }; },
            mode: 'testnet',
          }),
          /Operator has no reachable WebSocket address \(WSS\/WS\) advertised\./,
        );

        assert.equal(connectCalled, false, 'connectPeer must not be called');
        assert.equal(bootstrapCalled, false, 'bootstrap must not be called');
      });

      it('attempts connectPeer with picked address and passes both node_pubkey and funding_address to bootstrap', async () => {
        const connectedAddrs: string[] = [];
        let bootstrapCalled = false;
        let receivedRequest: BootstrapRequest | null = null;

        const liveNodeInfo: NodeInfo = {
          node_id: '03dfe0e6cc02a21ca3a971bc2fa05474872dc2acb91cc5defeb1f0566888536957',
          addresses: ['/ip4/127.0.0.1/tcp/18328/ws'],
          channel_count: 1,
          peer_count: 2,
        };

        const session: BootstrapSession = {
          session_id: 'test-session',
          status: 'ready',
          message: 'Route ready',
        };

        const result = await prepareReceiveRoute({
          nodePubkey: '029a8d5b...',
          defaultFundingLockScript: mockFundingLockScript,
          connectPeer: async ({ address }) => { connectedAddrs.push(address); },
          getNodeInfo: async () => liveNodeInfo,
          bootstrap: async (req) => {
            bootstrapCalled = true;
            receivedRequest = req;
            return session;
          },
          mode: 'testnet',
        });

        assert.deepEqual(connectedAddrs, ['/ip4/127.0.0.1/tcp/18328/ws']);
        assert.equal(bootstrapCalled, true);
        assert.equal(result.status, 'ready');
        assert.deepEqual(receivedRequest, {
          node_pubkey: '029a8d5b...',
          funding_address: expectedDerivedAddress,
        });
      });

      it('fails closed and reports clear error if connectPeer fails', async () => {
        let bootstrapCalled = false;

        const liveNodeInfo: NodeInfo = {
          node_id: '03dfe0e6cc02a21ca3a971bc2fa05474872dc2acb91cc5defeb1f0566888536957',
          addresses: ['/ip4/127.0.0.1/tcp/18328/ws'],
          channel_count: 1,
          peer_count: 2,
        };

        await assert.rejects(
          () => prepareReceiveRoute({
            nodePubkey: '029a8d5b...',
            fundingAddress: explicitFundingAddress,
            connectPeer: async () => { throw new Error('Connection refused (ECONNREFUSED)'); },
            getNodeInfo: async () => liveNodeInfo,
            bootstrap: async () => { bootstrapCalled = true; return { session_id: '1', status: 'ready', message: 'ok' }; },
            mode: 'testnet',
          }),
          /Failed to connect to operator peer \(\/ip4\/127\.0\.0\.1\/tcp\/18328\/ws\): Connection refused \(ECONNREFUSED\)/,
        );

        assert.equal(bootstrapCalled, false, 'bootstrap must not be called when connectPeer fails');
      });

      it('propagates bootstrap failure (e.g. 501 unprovisioned) in RPC mode', async () => {
        const liveNodeInfo: NodeInfo = {
          node_id: '03dfe0e6cc02a21ca3a971bc2fa05474872dc2acb91cc5defeb1f0566888536957',
          addresses: ['/ip4/127.0.0.1/tcp/18328/ws'],
          channel_count: 1,
          peer_count: 2,
        };

        await assert.rejects(
          () => prepareReceiveRoute({
            nodePubkey: '029a8d5b...',
            fundingAddress: explicitFundingAddress,
            connectPeer: async () => {},
            getNodeInfo: async () => liveNodeInfo,
            bootstrap: async () => ({
              session_id: 'failed-session',
              status: 'failed',
              message: 'Scheme B inbound-liquidity provisioning (unpaid CKB capacity gift) is not wired: operator CKB send is not wired and channel funding is not implemented.',
            }),
            mode: 'testnet',
          }),
          /Scheme B inbound-liquidity provisioning.*not wired/,
        );
      });
    });

    describe('in Mock mode', () => {
      it('skips dialing real P2P on mock address and successfully completes bootstrap', async () => {
        let connectPeerCalled = false;
        let receivedRequest: BootstrapRequest | null = null;

        const mockSession: BootstrapSession = {
          session_id: 'mock-session-123',
          status: 'ready',
          peer_address: '/dns4/mock-provider.test/tcp/8228/p2p/029a8d5b',
          channel_id: 'mock_123',
          message: 'Mock inbound route is ready (simulated Phase-1 Scheme B gifted capacity).',
        };

        const result = await prepareReceiveRoute({
          nodePubkey: '029a8d5b...',
          fundingAddress: explicitFundingAddress,
          connectPeer: async () => { connectPeerCalled = true; },
          getNodeInfo: async () => mockNodeInfo,
          bootstrap: async (req) => {
            receivedRequest = req;
            return mockSession;
          },
          mode: 'mock',
        });

        assert.equal(connectPeerCalled, false, 'connectPeer must be skipped in mock mode to avoid DNS failure');
        assert.deepEqual(receivedRequest, {
          node_pubkey: '029a8d5b...',
          funding_address: explicitFundingAddress,
        });
        assert.equal(result.status, 'ready');
        assert.equal(result.session_id, 'mock-session-123');
      });

      it('skips dialing real P2P even if mode is undefined but address is mock-provider.test', async () => {
        let connectPeerCalled = false;

        const result = await prepareReceiveRoute({
          nodePubkey: '029a8d5b...',
          fundingAddress: explicitFundingAddress,
          connectPeer: async () => { connectPeerCalled = true; },
          getNodeInfo: async () => mockNodeInfo,
          bootstrap: async () => ({
            session_id: 'mock-session-456',
            status: 'ready',
            message: 'Mock inbound route is ready.',
          }),
          mode: undefined,
        });

        assert.equal(connectPeerCalled, false, 'connectPeer must be skipped when address is mock');
        assert.equal(result.status, 'ready');
      });
    });
  });
});
