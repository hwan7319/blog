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

## First administrator

Set a one-time secret before deployment:

```bash
npx wrangler secret put BOOTSTRAP_ADMIN_SECRET
```

After the intended administrator has registered, call `POST /api/auth/bootstrap-admin` with their nickname in the JSON body and the same secret in the `X-Bootstrap-Admin-Secret` header. This endpoint works only while no administrator role exists. Remove the secret after the first administrator is created.

An authenticated administrator can then use:

- `GET /api/admin/users?status=pending`
- `PATCH /api/admin/users/:userId/account-status` with `approved`, `rejected`, or `locked`

## Room API

- `GET /api/rooms?type=keyword` lists rooms in the current Korean service day, which starts at 04:00 KST.
- `POST /api/rooms` creates a keyword or link room for an approved member without unresolved penalties.
- `GET /api/rooms/:roomId` returns a room preview.
- `POST /api/rooms/:roomId/participants` joins an open room. The server enforces room start time, capacity, and one participation per member.
- `DELETE /api/rooms/:roomId` is available only to the creator before anybody has joined.

The initial migration establishes the relational schema. Room workflows, scheduled closure, the existing frontend migration, and Google Sheets data import follow in separate changes.
