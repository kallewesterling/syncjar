/**
 * push-plan.mjs — decide what `push` would change, without doing any of it.
 *
 * Separating the decision from the act is what lets the scan run in parallel.
 * `push` prompts the operator before each write, and prompts have to be
 * sequential; comparing local content against upstream does not. Keeping the
 * comparison pure — no network, no prompts, no writes — means the whole scan
 * can be fanned out and the answers collected into one plan, and it means the
 * comparison rules below can be tested directly rather than only through a
 * live sync.
 */

/**
 * Skilljar and the local copy wrap and indent markup differently without
 * anyone editing anything, so comparing them literally reports changes nobody
 * made. Collapsing runs of whitespace removes that noise.
 *
 * Inside `<pre>`, whitespace is the content. A YAML block indented with tabs
 * and the same block indented with spaces are different documents, because
 * YAML forbids the tab, and a reader who copies the first one gets a parse
 * error. Collapsing there reports such a block as already in sync, so the fix
 * can never be pushed. Keep those spans exactly, and settle only line endings,
 * which change in transport rather than in an edit.
 */
export function normalizeHtml(html = '') {
  // Odd indices are the captured <pre> spans; even indices are everything else.
  return String(html)
    .split(/(<pre\b[\s\S]*?<\/pre>)/i)
    .map((part, i) =>
      i % 2 ? part.replace(/\r\n?/g, '\n') : part.replace(/\s+/g, ' '))
    .join('')
    .trim();
}

function textDiffers(a, b) {
  return (a || '').trim() !== (b || '').trim();
}

/**
 * Builds the list of writes that would bring one course's upstream copy in
 * line with the local one.
 *
 * Everything it needs has already been fetched by the caller; this function
 * makes no requests. Inputs:
 *
 *   courseDir              directory name, used to label and order actions
 *   courseDetails          the local details.json
 *   lessons                the local lessons-meta.json
 *   upstreamCourse         the course record from `GET /courses`
 *   upstreamLessonsById    Map lesson id -> lesson record
 *   upstreamItemsByLessonId Map lesson id -> Map item id -> content item
 *   localHtmlByItemId      Map content-item id -> the local file's contents
 *   lessonFilter           when set, only this lesson slug is considered, and
 *                          the course title is left alone
 *
 * Returns `{ actions, inSyncCount, warnings }`. Actions come out in the order
 * a person reading the tree would expect — course title, then each lesson's
 * title followed by its content items — so the prompts arrive in the same
 * order the old sequential implementation asked them in.
 */
export function planCourse({
  courseDir,
  courseDetails,
  lessons,
  upstreamCourse,
  upstreamLessonsById,
  upstreamItemsByLessonId,
  localHtmlByItemId,
  lessonFilter = null
}) {
  const actions = [];
  const warnings = [];
  let inSyncCount = 0;

  if (!lessonFilter && textDiffers(courseDetails.title, upstreamCourse.title)) {
    actions.push({
      kind: 'text',
      courseDir,
      label: `course title (${courseDetails.title})`,
      endpoint: `/courses/${courseDetails.id}`,
      field: 'title',
      localValue: courseDetails.title,
      upstreamValue: upstreamCourse.title
    });
  } else if (!lessonFilter) {
    inSyncCount += 1;
  }

  for (const lesson of lessons) {
    if (lessonFilter && lesson.slug !== lessonFilter) continue;

    const upstreamLesson = upstreamLessonsById.get(lesson.id);
    if (!upstreamLesson) {
      // The old implementation fetched each lesson by id and exited on the
      // 404. Reporting it and carrying on is better: one lesson deleted
      // upstream is not a reason to abandon the other 648, and the operator
      // needs to see it to know a pull is due.
      warnings.push(
        `lesson ${lesson.id} ("${lesson.title}") is in lessons-meta.json but not in ${courseDir} upstream — pull to reconcile`
      );
      continue;
    }

    if (textDiffers(lesson.title, upstreamLesson.title)) {
      actions.push({
        kind: 'text',
        courseDir,
        label: `lesson title (${lesson.title})`,
        endpoint: `/lessons/${lesson.id}`,
        field: 'title',
        localValue: lesson.title,
        upstreamValue: upstreamLesson.title
      });
    } else {
      inSyncCount += 1;
    }

    const upstreamItems = upstreamItemsByLessonId.get(lesson.id) ?? new Map();

    for (const item of lesson.content_items) {
      // The pull records HTML files it found on disk but could not match to an
      // upstream content item with `id: null`. There is nothing to PUT to, so
      // the old code built `/content-items/null`, took a 404, and killed the
      // whole run over a stray file.
      if (!item.id) {
        warnings.push(
          `${courseDir}/${item.file} has no upstream content-item id — cannot be pushed`
        );
        continue;
      }

      const upstreamItem = upstreamItems.get(item.id);
      if (!upstreamItem) {
        warnings.push(
          `content item ${item.id} (${courseDir}/${item.file}) is not in lesson ${lesson.id} upstream — pull to reconcile`
        );
        continue;
      }

      const localHtml = localHtmlByItemId.get(item.id);
      if (localHtml === undefined) {
        warnings.push(`${courseDir}/${item.file} is in lessons-meta.json but missing on disk`);
        continue;
      }

      if (normalizeHtml(localHtml) === normalizeHtml(upstreamItem.content_html || '')) {
        inSyncCount += 1;
        continue;
      }

      actions.push({
        kind: 'content',
        courseDir,
        label: `content-item ${item.id}`,
        endpoint: `/lessons/${lesson.id}/content-items/${item.id}`,
        lessonId: lesson.id,
        itemId: item.id,
        // The apply phase stamps `description_html` on this object when
        // --add-last-updated is set, and the same object is what gets written
        // back to lessons-meta.json, so it has to be the live one.
        lesson,
        localValue: localHtml,
        upstreamValue: upstreamItem.content_html || ''
      });
    }
  }

  return { actions, inSyncCount, warnings };
}
