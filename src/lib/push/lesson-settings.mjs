/**
 * lesson-settings.mjs — the lesson fields `push:lesson-settings` writes from
 * lessons-meta.json, through `PATCH /lessons/{id}`.
 *
 * Each round-tripped on a throwaway lesson on 2026-10-28, changing only
 * itself, with no `course_id` needed in the body. Two effects outside the
 * lesson record: every lesson write bumps the parent course's `modified_at`,
 * and `optional` changes the course's required-lesson count, which paths
 * show in their item summaries.
 *
 * Lesson titles stay with `push`, which already writes them. `order` was
 * also writable, but reordering is a different job from flipping a setting
 * and is left out, as are `time_seconds`, `search_keywords` and
 * `display_fullscreen`, which no lesson uses.
 */
import { boolean, html } from '#lib/push/settings.mjs';

export const LESSON_SETTINGS = {
  optional: boolean,
  description_html: html,
  tooltip_html: html
};

/**
 * Builds planSettings() targets from one course's lessons-meta.json.
 *
 *   courseDir     the course directory name
 *   lessons       the parsed lessons-meta.json
 *   upstreamById  Map lesson id -> record from `GET /lessons?course_id=`
 */
export function lessonTargets({ courseDir, lessons, upstreamById }) {
  return lessons.map(lesson => ({
    id: lesson.id,
    label: `${courseDir} › ${lesson.title}`,
    where: `${courseDir}/lessons-meta.json (lesson ${lesson.id})`,
    endpoint: `/lessons/${lesson.id}`,
    local: lesson,
    upstream: upstreamById.get(lesson.id)
  }));
}
