---
title: Groups and access
parent: Students
nav_order: 1
---

# Groups and access
{: .no_toc }

1. TOC
{:toc}

---

## Adding and removing members: `group:add`, `group:remove`

```bash
# Dry run: reads only, and shows who would be added
syncjar group:add --group-name "Partner: Acme" --in acme.csv

# Do it: asks you to type "add <n>" first
syncjar group:add --group-name "Partner: Acme" --in acme.csv --confirm

# A few addresses, by group id
syncjar group:remove --group <id> --email a@acme.com --email b@acme.com --confirm
```

`--group-name` is the group's exact name, ignoring case; `--group` takes its
v2 id. Both use the v2 API and need a client with `student-groups:read`,
`student-groups:write` and `students:read`.

That client can't touch content, enrollments or accounts, so it's the one to
hand to someone who manages membership but shouldn't hold the v1 key. It is
broader than membership, though; see the
[warning on Configuration]({{ site.baseurl }}{% link configuration.md %}#which-commands-need-which).

**What the API can't tell you.** The v2 API can't list a group's members, so:

- an add reports who was already a member only after it runs, from
  Skilljar's response;
- a remove reports everyone sent as removed, whether or not they were in the
  group.

## Auto-add email domains: `group:domains`

A group's email domains put every new student who signs up with an address at
one of them into the group.

```bash
syncjar group:domains --group-name Partners                              # list
syncjar group:domains --group-name Partners --add acme.com               # dry run
syncjar group:domains --group-name Partners --add acme.com --confirm     # do it
syncjar group:domains --group-name Partners --remove old.example --confirm
```

It needs `student-groups:read` and `student-groups:write`.

{: .note }
The rules apply at signup only. Students who already have an account aren't
added, so pair a new domain with `group:add` for them.

The v2 API can only replace a group's whole domain list, not add or remove
one domain. So a confirmed run:

1. reads the list again just before writing, and stops if it changed since
   the plan was shown;
2. writes the merged list;
3. reads it back.

Afterwards it prints the previous list, so a mistake can be undone by hand.
Removing the last domain is allowed, and leaves the list empty. Free-mail
domains such as `gmail.com` are refused unless you pass
`--allow-public-domain`.

## Auditing a group against a roster: `group:audit`

```bash
syncjar group:audit --group <group_id> --roster people.csv
```

Answers "who is in this group but not on the roster?". The roster is a CSV
with an `email` column, one row per person who should keep access. The
result is a CSV in `public/data/` that `group:revoke` takes as it is.

It recomputes from the roster on every run, so it also catches people who
have left since the last audit. Anyone who joined after the roster was built
looks like a departure, so a roster older than 14 days (`--max-age-days`)
gets a warning. It is read-only and uses the v1 API key.

## Revoking access: `group:revoke`

```bash
# See what would happen
syncjar group:revoke --in public/data/group-audit-<group_id>.csv --group <group_id>

# Do it
syncjar group:revoke --in public/data/group-audit-<group_id>.csv --group <group_id> --confirm

# Revoke access to a training domain instead, or as well
syncjar group:revoke --in reviewed.csv --domain courses.example.com --confirm
```

It acts on a reviewed list with `skilljar_id` and `email` columns, such as
`group:audit` writes. Two actions are available, and both are reversible:

| Option | Does | Undo |
|---|---|---|
| `--group <id>` | Removes each user from the group, which withdraws the content the group unlocks | Add them back |
| `--domain <host>` | Deactivates each user on that training domain, as the dashboard's "Revoke access" does | `--reactivate` |

Neither deletes anything. Skilljar's v1 API has no account-level deactivate,
and Syncjar never calls its account anonymisation endpoint, which erases
personal data irreversibly.

To try a run on one person first, use `--limit 1` or `--only-email <address>`.
It uses the v1 API key.

## Checking membership: `check:membership`

```bash
syncjar check:membership --group <group_id> --domain courses.example.com --email someone@example.com
syncjar check:membership --group <group_id> --in reviewed.csv
```

For each person, reports whether they're currently in the group and whether
their domain access is active. It is read-only and uses the v1 API key.

It's useful after a removal from a group that has auto-add email domains: if
the person is back in the group a while later, the domain rule is re-adding
them, and has to change before a bulk removal is worth doing.
