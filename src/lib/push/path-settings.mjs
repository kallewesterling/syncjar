/**
 * path-settings.mjs — the fields `push:paths` writes from a path's
 * details.json, through `PATCH /paths/{id}`.
 *
 * All six round-tripped on a throwaway staging path on 2026-10-28, each
 * changing only itself (and the published-path record's embedded copy of the
 * path). Unlike a course's, a path's `short_description` can be blanked
 * again. Whether a blank title or item name is accepted was not tested, so
 * those are refused here.
 */
import { text, html } from '#lib/push/settings.mjs';

export const PATH_SETTINGS = {
  title: text({ required: true }),
  short_description: text(),
  long_description_html: html,
  header_html: html,
  course_name_singular: text({ required: true }),
  course_name_plural: text({ required: true })
};

/**
 * Builds planSettings() targets from local path directories.
 *
 *   locals        [{ dir, details }] — details is the parsed details.json
 *   upstreamById  Map path id -> record from `GET /paths`
 */
export function pathTargets(locals, upstreamById) {
  return locals.map(({ dir, details }) => ({
    id: details.id,
    label: `${upstreamById.get(details.id)?.title ?? details.title} (${dir})`,
    where: `${dir}/details.json`,
    endpoint: `/paths/${details.id}`,
    local: details,
    upstream: upstreamById.get(details.id)
  }));
}
