# Blog Poom

Cloudflare Workers and D1 backend for the blog mutual-support platform.

## Initial setup

1. Install dependencies with `npm install`.
2. Create a D1 database and replace `database_id` in `wrangler.jsonc`.
3. Apply `migrations/0001_initial_schema.sql` locally, then to the target D1 database.
4. Start the Worker with `npm run dev` and verify `GET /api/health`.

## Authentication API

- `POST /api/auth/signup` creates a pending user.
- `POST /api/auth/login` creates a 30-day HttpOnly session cookie for approved or locked users.
- `POST /api/auth/logout` revokes the current session.
- `GET /api/auth/me` returns the authenticated user without any password data.
- `GET /api/admin/me` additionally requires the `admin` role.

The initial migration establishes the relational schema. Room workflows, scheduled closure, the existing frontend migration, and Google Sheets data import follow in separate changes.
