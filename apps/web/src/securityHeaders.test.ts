import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { developmentSecurityHeaders, productionSecurityHeaders } from './securityHeaders';

describe('web security headers', () => {
  it('keeps COOP and COEP identical in development and production preview', () => {
    for (const name of ['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy']) {
      assert.equal(developmentSecurityHeaders[name], productionSecurityHeaders[name]);
    }
  });

  it('allows only the browser resources required by Fiber in production', () => {
    const csp = productionSecurityHeaders['Content-Security-Policy'];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self' ws: wss:/);
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval' 'sha256-[^']+'/);
    assert.match(csp, /worker-src 'self' blob:/);
    assert.doesNotMatch(csp, /'unsafe-inline'/);
    assert.doesNotMatch(csp, /https:/);
  });

  it('allows exactly the inline import map shipped in index.html', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const importMap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(importMap);
    const hash = createHash('sha256').update(importMap).digest('base64');
    assert.ok(productionSecurityHeaders['Content-Security-Policy'].includes(`'sha256-${hash}'`));
  });

  it('limits the development exception to Vite inline scripts', () => {
    const csp = developmentSecurityHeaders['Content-Security-Policy'];
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'/);
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /https:/);
  });
});
