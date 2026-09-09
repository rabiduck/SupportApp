export async function authenticateBootstrap(_request, env = {}) {
  const username = String(env.AUTH_BOOTSTRAP_USERNAME || '').trim();
  const email = String(env.AUTH_BOOTSTRAP_EMAIL || '').trim().toLowerCase();

  if (username || email) {
    return {
      authenticated: true,
      bootstrap: false,
      source: 'bootstrap',
      username: username || null,
      email: email || null,
    };
  }

  return {
    authenticated: true,
    bootstrap: true,
    source: 'bootstrap',
    username: 'uat-bootstrap',
    email: null,
    displayName: 'UAT Bootstrap',
  };
}
