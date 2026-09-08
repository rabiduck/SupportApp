const shell = (title, content, active = "Dashboard") => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} · Support Portal</title>
  <link rel="stylesheet" href="/assets/site.css">
</head>
<body>
<header class="top-bar">
  <div class="brand">Support Portal</div>
  <div class="user-area">Cloudflare prototype</div>
</header>
<div class="app-shell">
  <nav class="side-nav">
    <a class="${active === "Dashboard" ? "active" : ""}" href="/">Dashboard</a>
    <a class="disabled" href="#">Rota</a>
    <a class="disabled" href="#">Users</a>
    <a class="disabled" href="#">Teams</a>
    <a class="disabled" href="#">Employees</a>
    <a class="disabled" href="#">Shift Patterns</a>
    <a class="disabled" href="#">Administration</a>
  </nav>
  <main class="page">
    ${content}
  </main>
</div>
<footer class="footer">SupportApp · Cloudflare-native prototype</footer>
</body>
</html>`;

const dashboard = `
  <div class="page-header">
    <div>
      <div class="page-title">Support Dashboard</div>
      <div class="page-description">Support administration and rota management.</div>
    </div>
  </div>
  <div class="notice">
    <strong>Cloudflare-native baseline</strong><br>
    This deployment proves the new SupportApp runtime. D1, authentication and application modules will be added next.
  </div>
  <div class="card-grid">
    <article class="card">
      <h2>Employees</h2>
      <p class="muted">Employee administration will be migrated from the FastAPI prototype.</p>
      <span class="status-badge status-inactive">Planned</span>
    </article>
    <article class="card">
      <h2>Teams</h2>
      <p class="muted">Departments and support teams, including employee membership.</p>
      <span class="status-badge status-inactive">Planned</span>
    </article>
    <article class="card">
      <h2>Rota</h2>
      <p class="muted">Reusable shift patterns and team/employee rota assignments.</p>
      <span class="status-badge status-active">Next phase</span>
    </article>
  </div>`;

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(shell("Dashboard", dashboard), {
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    }

    return new Response(shell("Not yet implemented", `
      <div class="page-header">
        <div>
          <div class="page-title">Not yet implemented</div>
          <div class="page-description">This module will be migrated into the Cloudflare-native SupportApp.</div>
        </div>
      </div>
      <div class="action-bar"><a class="button" href="/">Return to dashboard</a></div>
    `, ""), {
      status: 404,
      headers: { "content-type": "text/html; charset=UTF-8" },
    });
  },
};
