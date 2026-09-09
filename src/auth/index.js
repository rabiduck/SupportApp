import { authenticateBootstrap } from './bootstrap.js';
import { authenticateCloudflare } from './cloudflare.js';

const PROVIDERS = {
  bootstrap: authenticateBootstrap,
  'cloudflare-access': authenticateCloudflare,
};

export async function authenticate(request, env = {}) {
  const providerName = String(env.AUTH_PROVIDER || 'bootstrap').trim().toLowerCase();
  const provider = PROVIDERS[providerName];

  if (!provider) {
    return {
      authenticated: false,
      source: providerName,
      reason: `Unsupported authentication provider: ${providerName}`,
    };
  }

  return provider(request, env);
}
