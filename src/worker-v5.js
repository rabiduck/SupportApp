import appWorker from './worker-v4.js';
import { authenticate } from './auth/index.js';

function withIdentityHeader(request, identity) {
  const headers = new Headers(request.headers);
  headers.delete('Cf-Access-Authenticated-User-Email');

  if (identity?.email) {
    headers.set('Cf-Access-Authenticated-User-Email', identity.email);
  }

  return new Request(request, { headers });
}

export default {
  async fetch(request, env) {
    const identity = await authenticate(request, env);

    if (!identity.authenticated) {
      const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in required · Support Portal</title><link rel="stylesheet" href="/assets/site.css"></head><body><header class="top-bar"><div class="brand">Support Portal</div><div class="user-area">Authentication</div></header><main class="page"><div class="page-header"><div><div class="page-title">Sign in required</div></div></div><div class="notice"><strong>${String(identity.reason || 'Authentication is required.').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}</strong></div></main></body></html>`;
      return new Response(body, { status: 401, headers: { 'content-type': 'text/html; charset=UTF-8' } });
    }

    if (identity.bootstrap) {
      return appWorker.fetch(withIdentityHeader(request, null), { ...env, AUTH_REQUIRED: 'false' });
    }

    return appWorker.fetch(withIdentityHeader(request, identity), { ...env, AUTH_REQUIRED: 'true' });
  },
};
