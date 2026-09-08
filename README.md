# SupportApp

Support administration and rota management application.

## Current architecture

SupportApp is being rebuilt as a Cloudflare-native application using Cloudflare Workers. The application is deliberately structured with future self-hosting/on-premises portability in mind.

The original FastAPI/SQLAlchemy prototype has been preserved on the `fastapi-prototype` branch.

## Cloudflare development

```bash
npm install
npx wrangler dev
```

Deploy with:

```bash
npx wrangler deploy
```

## Roadmap

The existing prototype established the functional model for authentication/RBAC, Users, Departments, Teams, Employees and rota patterns. These modules will now be migrated incrementally to the Worker application, with D1 providing relational storage.

### Current milestone

CF-001 establishes the deployable Worker application shell and corporate SupportApp theme. D1 and application data are intentionally not required for the first deployment.
