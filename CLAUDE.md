# syncjar — working notes

Local-first tooling for Chainguard's Skilljar instance (Chainguard Courses).

## CRITICAL: never let a raw axios error reach the console

`scripts/skilljar-client.mjs` authenticates with HTTP Basic using `SKILLJAR_API_KEY`.
An **unhandled axios rejection prints the entire request object**, including the
`Authorization: Basic …` header, which contains the API key in trivially
recoverable form.

A key that reaches a terminal, a log, or a CI transcript has to be treated as
compromised and rotated. Assume it will happen unless the call is wrapped.

So:

- **Every** call through `createSkilljarClient()` must be wrapped in `try/catch`.
- Catch blocks print `err.response?.status` and a short body only. **Never** the
  error object, `err.config`, `err.request`, or any headers.
- This applies to throwaway `node -e` one-liners just as much as to committed
  scripts. Ad-hoc commands are the easiest place to forget.

Minimum safe shape for an ad-hoc command:

```bash
node -e "import('./scripts/skilljar-client.mjs').then(async m=>{
  const c=m.createSkilljarClient();
  try{const r=await c.get('/ping');console.log(r.status,r.data);}
  catch(e){console.error('HTTP',e?.response?.status,e?.response?.data??e.message);}
})"
```

See `failCleanly()` in `scripts/revoke-access.mjs` for the pattern used in scripts.

## API paths: no `/v1` prefix

`skilljar-client.mjs` sets `baseURL` to `https://api.skilljar.com/v1`. Paths passed
to the client must therefore be **relative to that**:

- ✅ `client.get('/groups/{id}/users')`
- ❌ `client.get('/v1/groups/{id}/users')` → resolves to `/v1/v1/…` → 404

Full endpoint reference: <https://api.skilljar.com/docs/> (JavaScript-rendered, so
`curl`/fetch returns an empty shell; open it in a browser).

## Destructive operations

- `POST /users/{id}/anonymize` is **irreversible PII erasure**. Do not call it.
- Deactivation is domain-scoped and reversible:
  `PATCH /domains/{domain}/users/{user_id}` with `{"active": false}`.
  There is no account-level deactivate in v1 — `PATCH /users/{id}` only accepts
  `email`, `first_name`, `last_name`.
- Group removal: `DELETE /groups/{group_id}/users/{user_id}`.
- Any script that writes to student records should: dry-run by default, preflight
  with live GETs before iterating, require typed confirmation, and write a
  per-run audit CSV recording prior state.

## Data hygiene

- `public/data/` is gitignored. Write student exports **there**, never to the repo
  root, which is not ignored.
- Student exports contain real names and email addresses. Delete them when the
  task is done; they regenerate from the API in one command.

## Known bug in the shipped user export

`sync-users.mjs` skips users whose per-user cache file already exists and does
*not* add them to `processed`. Since `processed` is what gets written to
`user-progress.json` — the file `export-users-to-csv.mjs` reads — the resulting
CSV contains only the users touched in that run. **On any re-run it is silently
partial.** Do not use `npm run export:users` for audits. Use
`scripts/export-students.mjs`, which hits `/users` once and completely.
