const IMPORT_MAP_HASH = "'sha256-7hTsMfyMtV8w+gENnoJHMb7H8Qa6F86OQXoj35VLCQo='";

function contentSecurityPolicy(allowViteInlineScripts: boolean): string {
  const scriptSources = [
    "'self'",
    "'wasm-unsafe-eval'",
    allowViteInlineScripts ? "'unsafe-inline'" : IMPORT_MAP_HASH,
  ];

  return [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self' ws: wss:",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "manifest-src 'self'",
    "object-src 'none'",
    `script-src ${scriptSources.join(' ')}`,
    "script-src-attr 'none'",
    `style-src 'self'${allowViteInlineScripts ? " 'unsafe-inline'" : ''}`,
    "worker-src 'self' blob:",
  ].join('; ');
}

interface SecurityHeaders extends Record<string, string> {
  'Content-Security-Policy': string;
  'Cross-Origin-Embedder-Policy': string;
  'Cross-Origin-Opener-Policy': string;
}

function securityHeaders(allowViteInlineScripts: boolean): SecurityHeaders {
  return {
    'Content-Security-Policy': contentSecurityPolicy(allowViteInlineScripts),
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}

export const developmentSecurityHeaders = securityHeaders(true);
export const productionSecurityHeaders = securityHeaders(false);
