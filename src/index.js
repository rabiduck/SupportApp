const shell = (title, content) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} · Support Portal</title>
  <link rel="stylesheet" href="/assets/site.css">
</head>
<body>
<div class="app-shell">
  <aside class="sidebar">
    <div class="brand">Support Portal</div>
    <nav>
      <a href="/">Dashboard</a>
      <a href="#" class="disabled">Rota</a>
      <a href="#" class="disabled">Users</a>
      <a href="#" class="disabled">Teams</a>
      <a href="#" class="disabled">Employees</a>
      <a href="#" class="disabled">Shift Patterns</a>
      <a href="#" class="disabled">Administration</a>
    </nav>
  </aside>
  <main class="content">
    <header class="topbar">
      <div></div>
      <div>Cloudflare prototype</div>
    </header>
    ${content}
  </main>
</div>
</body>
</html>`;

const dashboard = `
  <div class="page-header">
    <div>
      <h1>Dashboard</h1>
      <div class="muted">Support administration and rota management.</div>
    </div>
  </div>
  <div class="alert">
    <strong>Cloudflare-native baseline</strong><br>
    This deployment proves the new SupportApp runtime. D1, authentication and application modules will be added next.
  </div>
  <div class="card-grid">
    <article class="card">
      <h2>Employees</h2>
      <p class="muted">Employee administration will be migrated from the FastAPI prototype.</p>
      <span class="status inactive">Planned</span>
    </article>
    <article class="card">
      <h2>Teams</h2>
      <p class="muted">Departments and support teams, including employee membership.</p>
      <span class="status inactive">Planned</span>
    </article>
    <article class="card">
      <h2>Rota</h2>
      <p class="muted">Reusable shift patterns and team/employee rota assignments.</p>
      <span class="status active">Next phase</span>
    </article>
  </div>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/assets/site.css") {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/") {
      return new Response(shell("Dashboard", dashboard), {
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    }

    return new Response(shell("Not yet implemented", `
      <div class="page-header"><div><h1>Not yet implemented</h1><div class="muted">This module will be migrated into the Cloudflare-native SupportApp.</div></div></div>
      <div class="action-bar"><a class="button" href="/">Return to dashboard</a></div>
    `), {
      status: 404,
      headers: { "content-type": "text/html; charset=UTF-8" },
    });
  },
};
