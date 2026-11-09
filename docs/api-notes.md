---
title: Skilljar API notes
nav_order: 9
---

# Skilljar API notes
{: .no_toc }

What the Skilljar API was observed to do while building Syncjar, where it
differs from what its specification says or leaves unsaid. They're useful if
you write your own tooling against it. Each was established against
throwaway objects in late 2026. Skilljar may change any of it.

1. TOC
{:toc}

---

## General

- **A `200` doesn't mean the write happened.** Several endpoints accept fields
  they ignore. Read the record back after every write.
- **Strings are trimmed.** `" x"` is stored as `"x"`, so compare trimmed
  values when reading back.
- **Some fields can be set but never cleared.** A course's
  `short_description`, `manual_course_time` and
  `course_and_lesson_time_format`, and a published course's registration
  dates, refuse a blank or null value. Sending the PATCH form-encoded with an
  empty value returns `200` and changes nothing. Clearing them takes the
  dashboard.
- **`PATCH /courses/{id}` is a true partial update.** `PUT /courses/{id}`
  requires the title and description too, so avoid it for settings.

## Timestamps

- **A dashboard edit moves `modified_at`** on the course, in v1 and v2, and
  on the lesson in v2.
- **An edit through the API moves nothing:** no course or lesson timestamp,
  and v2's `filter[updated_since]` doesn't list the lesson. So timestamps
  can't detect another API client's writes.
- **The v2 audit log records dashboard actions only.** API writes don't
  appear in it. Its `channel` field is null on older events, so don't
  filter on it.

## Content

- **`GET /lessons` has an empty `content_html` for modular lessons.**
  Content costs one request per lesson whatever you do. In v2, the
  `GET /lessons/{id}` response includes every content item with its HTML,
  which the specification doesn't mention.
- **Content items can't be deleted** through the API. There's no `DELETE` on
  a lesson's content items, so attaching a quiz to a lesson can't be undone
  except in the dashboard.
- **Deleting a course in the dashboard leaves its lessons readable**, still
  listed under the course id, and its quizzes untouched.

## Quizzes

- **Editing a question needs `quiz` in the body**, even though the question
  already belongs to one. Without it, every PATCH is a `400`.
- **Answers can't be edited, and order can't be set.** PATCH or PUT with
  `answers` or `order` returns `200` and changes nothing. Questions are
  ordered by creation, so changing an answer means deleting and recreating the
  question, which puts it at the end.
- **Recreating a question costs its history.** Its responses leave the quiz
  analytics, and learners can no longer review their answers. Scores and
  completions are kept.
- **Attaching a quiz** with `POST /lessons/{id}/content-items` needs a
  non-blank `header`.

## IDs across v1 and v2

- **Content ids are shared.** Courses, lessons, content items and quizzes have
  the same id in both versions, and so did the quiz questions and answers
  checked.
- **Student ids are not.** A student's v2 id differs from their v1 user id.
  Look students up by email in v2.
- **A path's id and its published path's id are different**, although on some
  paths they happen to be equal, which hides the difference.

## Groups (v2)

- **Members can't be listed.** There's no GET on a group's student
  relationships, only POST and DELETE, which take student ids.
- **Adding an existing member returns their original membership**, with the
  same id and `created_at`. That's the only sign they were already in.
- **Removing a non-member also succeeds**, so a remove can't report who wasn't
  in the group.
- **`rule_email_domains` is replaced whole** by a PATCH. Read it again just
  before writing so you don't overwrite a concurrent change. An empty list is
  allowed.
- **`student-groups:write` covers more than membership**: creating, renaming
  and batch-deleting groups, and their course visibility.

## Enrollments (v2)

- **An enrollment points at a published course**, but `filter[course.id]`
  takes the *course* id; a published-course id returns nothing rather than an
  error.
- **Deactivating keeps everything**: `PATCH` with `active: false` keeps the id,
  dates and progress. Neither the API nor the dashboard can delete an
  enrollment.
- **Re-enrolling a deactivated student creates a new enrollment** when the
  course has unique progress per enrollment, with no progress, beside the old
  one. `PATCH` with `active: true` restores the old one instead.
- **A re-enroll with `expires_at` fails** with an `internal_error` row and
  writes nothing.
- **Repeating an add** for an active student is a `207` with an
  `already_enrolled` row.
- **`include=student` lists each student once per page**, however many of the
  page's enrollments are theirs, so join on id.

## Visibility

- **`visible_on_catalog` is not the inverse of `hidden`.** What it tracks is
  unclear, so Syncjar doesn't rely on it.
- **Overrides name published-course ids**, so they're per domain.
- **A deleted course can leave published-course rows behind**, unpublished and
  with group overrides still on them.
- **A path with no visible course on a domain has its registration closed
  there.**

## Analytics (v2)

- **`filter[domains]` takes domain names, not ids.** An id returns zeros, not
  an error.
- **Enrollment rows reconcile exactly** with the analytics summary on
  enrollments, completions and certificates.

## Authentication (v2)

- **The token response doesn't list scopes**, but the token's payload does,
  in a `scopes` array. A missing scope only shows up as a `403` on the request
  that needs it.
- **Tokens last 900 seconds.**
- **An inactive client gets a `401`**, `invalid_client`.
