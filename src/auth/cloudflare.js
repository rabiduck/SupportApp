export async function authenticateCloudflare(request) {
  const email = String(request.headers.get('Cf-Access-Authenticated-User-Email') || '')
    .trim()
    .toLowerCase();

  if (!email) {
    return {
      authenticated: false,
      source: 'cloudflare-access',
      reason: 'Cloudflare Access authentication is required.',
    };
  }

  return {
    authenticated: true,
    source: 'cloudflare-access',
    email,
    username: null,
  };
}
