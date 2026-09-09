export async function authenticateBootstrap() {
  return {
    authenticated: true,
    bootstrap: true,
    source: 'bootstrap',
    username: 'uat-bootstrap',
    email: null,
    displayName: 'UAT Bootstrap',
  };
}
