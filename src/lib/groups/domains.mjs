/**
 * domains.mjs — a group's auto-add email domains, through the v2 API. The
 * pure half: reading the domains asked for and planning the new list.
 * `domains-run.mjs` does the I/O.
 *
 * A group's `rule_email_domains` puts every student who signs up with an
 * address at one of those domains into the group. It applies at signup only:
 * students who already have an account are not added (`group:add` does that).
 *
 * v2 writes the list with `PATCH /groups/`, whose `rule_email_domains`
 * **replaces the entire array**. There is no add or remove of one domain, so
 * an add is a read, a merge and a write of the whole list, and a write from a
 * stale read would silently drop a domain someone else added in between.
 */

// Free-mail providers. A rule for one of these would put every new student
// who signs up with, say, a Gmail address into the group, and the group may
// grant access to courses.
export const PUBLIC_EMAIL_DOMAINS = new Set([
  '163.com', 'aol.com', 'gmail.com', 'gmx.com', 'gmx.de', 'googlemail.com',
  'hotmail.com', 'icloud.com', 'live.com', 'mail.com', 'me.com', 'msn.com',
  'outlook.com', 'proton.me', 'protonmail.com', 'qq.com', 'yahoo.com',
  'yandex.com', 'zoho.com'
]);

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Lowercases and trims each domain, and drops a leading `@`, so `@Example.com`
 * is `example.com`. Skilljar stores domains lowercased.
 *
 * @returns {{ domains: string[], invalid: string[] }}
 */
export function normaliseDomains(values) {
  const seen = new Set();
  const invalid = [];
  for (const raw of values) {
    const domain = String(raw ?? '').trim().toLowerCase().replace(/^@/, '');
    if (!domain) continue;
    if (!DOMAIN.test(domain)) { invalid.push(raw); continue; }
    seen.add(domain);
  }
  return { domains: [...seen], invalid };
}

/**
 * The list to write, and what each requested domain amounts to. Existing
 * domains keep their order; new ones go on the end.
 */
export function planDomains(current, { add = [], remove = [] }) {
  const before = current.map((d) => d.toLowerCase());
  const has = new Set(before);
  const dropping = new Set(remove.filter((d) => has.has(d)));
  const adding = add.filter((d) => !has.has(d));
  return {
    before,
    after: [...before.filter((d) => !dropping.has(d)), ...adding],
    adding,
    alreadyPresent: add.filter((d) => has.has(d)),
    removing: [...dropping],
    notPresent: remove.filter((d) => !has.has(d))
  };
}

export function sameDomains(a, b) {
  const norm = (list) => [...new Set((list ?? []).map((d) => d.toLowerCase()))].sort().join('\n');
  return norm(a) === norm(b);
}

/** The JSON:API body for a `PATCH /groups/` that writes only the domains. */
export function domainsBody(groupId, domains) {
  return { data: [{ type: 'groups', id: groupId, attributes: { rule_email_domains: domains } }] };
}
