/**
 * syncjar check:visibility  (npm run check:visibility)
 *
 * Read-only. Reports which student groups can see which published courses
 * and paths, per domain, through the v2 API: every restricted record (hidden,
 * strict enforcement on, or carrying group rules) with what that means in
 * plain words, then what each group unlocks, then likely mistakes. See
 * src/lib/visibility/visibility.mjs for the model and what it leaves out.
 *
 * Needs SKILLJAR_CLIENT_ID and SKILLJAR_CLIENT_SECRET for an API client with
 * domains:read, student-groups:read, published-courses:read and paths:read.
 *
 *   syncjar check:visibility
 *   syncjar check:visibility --domain courses.example.com --group Partners
 *   syncjar check:visibility --json
 *   syncjar check:visibility --out            # public/data/visibility.csv
 *
 * Makes GET requests exclusively. Exits 0 whatever it finds; 1 only on a
 * failed read or a bad option.
 */
import 'dotenv/config';
import fs from 'fs-extra';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { toCsv } from '#lib/csv.mjs';
import { workRoot } from '#lib/paths.mjs';
import { failCleanly } from '#lib/skilljar/client.mjs';
import { createSkilljarV2Client, V2_CREDENTIALS_HINT } from '#lib/skilljar/client-v2.mjs';
import { checkDomains } from '#lib/analytics/course-analytics.mjs';
import { fail, heading, muted, ok, skip, warn } from '#lib/ui.mjs';
import { fetchVisibilityInputs } from '#lib/visibility/fetch.mjs';
import {
  CSV_FIELDS, EVERYONE, buildCatalog, describe, effectiveOf, filterDomains, findings, groupEffects,
  groupNamer, isRestricted, resolveGroup, viewFor, visibilityRows
} from '#lib/visibility/visibility.mjs';

const DEFAULT_OUT = path.join(workRoot, 'public', 'data', 'visibility.csv');

const argv = yargs(hideBin(process.argv))
  .scriptName('syncjar check:visibility')
  .option('group', { type: 'string', describe: 'Only this group, by name or id' })
  .option('domain', { type: 'array', string: true, default: [], describe: 'Only this domain name; repeatable' })
  .option('json', { type: 'boolean', default: false, describe: 'Print the catalog and findings as JSON instead' })
  .option('out', { type: 'string', describe: `Also write a flat CSV (default path ${path.relative(process.cwd(), DEFAULT_OUT) || DEFAULT_OUT})` })
  .strict()
  .help()
  .parse();

let client;
try {
  client = createSkilljarV2Client();
} catch (err) {
  console.error(fail(err.message));
  process.exit(1);
}

let inputs;
try {
  inputs = await fetchVisibilityInputs(client);
} catch (err) {
  failCleanly(err, err.visibilityStage || 'Could not read visibility', { credentialsHint: V2_CREDENTIALS_HINT });
}

let catalog = buildCatalog(inputs);
const nameOf = groupNamer(catalog.groups);

if (argv.domain.length) {
  const { valid, unknown } = checkDomains(argv.domain, catalog.domains.map((d) => d.name));
  if (unknown.length) {
    console.error(fail(`Not a Skilljar domain: ${unknown.join(', ')}. Known: ${catalog.domains.map((d) => d.name).join(', ')}`));
    process.exit(1);
  }
  catalog = filterDomains(catalog, valid);
}

let groups = catalog.groups;
if (argv.group !== undefined) {
  const { group, ambiguous } = resolveGroup(catalog.groups, argv.group);
  if (!group) {
    console.error(fail(`${ambiguous ? 'More than one group is called' : 'No group called'} "${argv.group}". Groups: ${catalog.groups.map((g) => g.name).join(', ')}`));
    process.exit(1);
  }
  groups = [group];
}
const groupIds = groups.map((g) => g.id);
const audiences = argv.group !== undefined ? [EVERYONE, ...groupIds] : [EVERYONE, ...catalog.groups.map((g) => g.id)];
const audienceName = (a) => (a === EVERYONE ? EVERYONE : nameOf(a));

const shown = (r) => (r.live ? isRestricted(r) : r.allow.length + r.block.length > 0);
const allFindings = findings(catalog).filter((f) => argv.group === undefined || !f.groupIds.length || f.groupIds.some((id) => groupIds.includes(id)));

if (argv.json) {
  const withViews = (r) => ({
    ...r,
    summary: describe(r, nameOf),
    audiences: Object.fromEntries(audiences.map((a) => {
      const view = viewFor(r, a);
      return [audienceName(a), { ...view, effective: effectiveOf(r, view) }];
    }))
  });
  console.log(JSON.stringify({
    domains: catalog.domains,
    groups,
    courses: catalog.courses.map(withViews),
    paths: catalog.paths.map(withViews),
    danglingOverrides: catalog.danglingOverrides,
    findings: allFindings
  }, null, 2));
} else {
  report();
}

if (argv.out !== undefined) {
  const out = argv.out || DEFAULT_OUT;
  await fs.ensureDir(path.dirname(out));
  await fs.writeFile(out, toCsv(visibilityRows(catalog, audiences), { fields: CSV_FIELDS }));
  console.error(ok(`Visibility rows written to ${out}`));
}

function flags(r) {
  const f = [];
  if (!r.live) f.push('not live');
  if (r.hidden) f.push('hidden');
  if (r.strict) f.push('strict');
  if (r.overrideType !== 'GROUP') f.push(r.overrideType);
  return f.length ? muted(` [${f.join(', ')}]`) : '';
}

function audienceLine(r) {
  const by = { listed: [], 'link-only': [], blocked: [] };
  for (const a of audiences) {
    const e = effectiveOf(r, viewFor(r, a));
    if (by[e]) by[e].push(audienceName(a));
  }
  return Object.entries(by).filter(([, names]) => names.length).map(([e, names]) => `${e}: ${names.join(', ')}`).join('  ·  ');
}

function report() {
  for (const domain of catalog.domains) {
    const courses = catalog.courses.filter((c) => c.domain === domain.name);
    const paths = catalog.paths.filter((p) => p.domain === domain.name);
    const rc = courses.filter(shown).sort((x, y) => x.title.localeCompare(y.title));
    const rp = paths.filter(shown).sort((x, y) => x.title.localeCompare(y.title));
    console.log(heading(`\n${domain.name}`) + muted(` — ${rc.length} of ${courses.length} published course(s) and ${rp.length} of ${paths.length} path(s) restricted`));
    for (const [label, records] of [['Courses', rc], ['Paths', rp]]) {
      if (!records.length) {
        console.log(skip(`${label}: none restricted; all visible to everyone`));
        continue;
      }
      console.log(`  ${label}`);
      for (const r of records) {
        console.log(`    ${r.title === r.slug ? r.slug : `${r.title}${muted(` (${r.slug})`)}`}${flags(r)}`);
        console.log(`      ${describe(r, nameOf)}`);
        if (r.live) console.log(muted(`      ${audienceLine(r)}`));
      }
    }
  }

  console.log(heading('\nGroups'));
  for (const g of groups) {
    const { unlocks, keptFrom } = groupEffects(catalog, g.id);
    console.log(`  ${heading(g.name)}`);
    if (!unlocks.length && !keptFrom.length) console.log(skip('    unlocks nothing and is kept from nothing: sees what everyone sees'));
    for (const domain of catalog.domains) {
      const u = unlocks.filter((x) => x.record.domain === domain.name);
      const k = keptFrom.filter((x) => x.record.domain === domain.name);
      if (!u.length && !k.length) continue;
      console.log(muted(`    ${domain.name}`));
      for (const { record, view } of u) console.log(`      + ${record.kind} ${record.title} ${muted(`(${effectiveOf(record, view)} for this group; ${effectiveOf(record, viewFor(record, EVERYONE))} for everyone else)`)}`);
      for (const { record, view } of k) console.log(`      - ${record.kind} ${record.title} ${muted(`(${effectiveOf(record, view)} for this group; ${effectiveOf(record, viewFor(record, EVERYONE))} for everyone else)`)}`);
    }
  }

  const problems = allFindings.filter((f) => f.severity === 'problem');
  const notes = allFindings.filter((f) => f.severity === 'note');
  console.log(heading('\nFindings'));
  if (!allFindings.length) console.log(ok('Nothing looks wrong.'));
  for (const f of problems) console.log(warn(f.message));
  for (const f of notes) console.log(skip(f.message));

  console.log(muted('\n"(everyone)" is anyone in none of a record\'s groups, anonymous visitors included. "listed" shows in the catalog;'));
  console.log(muted('"link-only" is unlisted but opens by direct link; "blocked" is neither. Groups are judged one at a time:'));
  console.log(muted('a student in several groups presumably sees the union, which this report does not check.'));
  console.log();
  console.log(problems.length ? warn(`${problems.length} likely problem(s), ${notes.length} note(s).`) : ok(`No likely problems${notes.length ? `; ${notes.length} note(s)` : ''}.`));
}
