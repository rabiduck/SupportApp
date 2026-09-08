const shell = (title, content) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} · SupportApp</title>
  <link rel="stylesheet" href="/assets/site.css">
</head>
<body>
  <aside class="sidebar">
    <div class="brand">SupportApp</div>
    <nav>
      <a class="active" href="/">Dashboard</a>
      <a href="/rota">Rota</a>
      <a href="/users">Users</a>
      <a href="/teams">Teams</a>
      <a href="/employees">Employees</a>
      <a href="/shift-patterns">Shift Patterns</a>
      <a href="/administration">Administration</a>
    </nav>
  </aside>
  <main class="main">
    <header class="topbar"><span>Support Portal</span><span class="prototype">Cloudflare prototype</span></header>
    <section class="content">${content}</section>
  </main>
</body>
</html>`;

const dashboard = `
  <div class="page-heading">
    <div><h1>Dashboard</h1><p>Support administration and rota management.</p></div>
  </div>
  <div class="notice"><strong>Cloudflare-native baseline</strong><br>This deployment proves the new SupportApp runtime. D1, authentication and application modules will be added next.</div>
  <div class="cards">
    <article class="card"><h2>Employees</h2><p>Employee administration will be migrated from the FastAPI prototype.</p><span class="badge">Planned</span></article>
    <article class="card"><h2>Teams</h2><p>Departments and support teams, including employee membership.</p><span class="badge">Planned</span></article>
    <article class="card"><h2>Rota</h2><p>Reusable shift patterns and team/employee rota assignments.</p><span class="badge">Next phase</span></article>
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

    return new Response(shell("Not yet implemented", `<h1>Not yet implemented</h1><p>This module will be migrated into the Cloudflare-native SupportApp.</p><p><a class="button" href="/">Return to dashboard</a></p>`), {
      status: 404,
      headers: { "content-type": "text/html; charset=UTF-8" },
    });
  },
};
