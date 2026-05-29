const courseSelector = document.getElementById('courseSelector');
const lessonSelector = document.getElementById('lessonSelector');
const lessonFrame   = document.getElementById('lesson-frame');
const lessonTop     = document.querySelector('.lesson-top');

let courseData = {};
let previewConfig = {};
let currentBlobUrl = null;

async function fetchConfig() {
  try {
    const res = await fetch('/preview-config.json');
    previewConfig = await res.json();
  } catch {
    // No config — render unstyled
  }
}

function getBaseCss() {
  const baseURL = (previewConfig.baseURL || '').replace(/\/$/, '');
  if (!baseURL) return [];
  return [
    'https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300;0,400;0,600;0,700;0,800;1,300;1,400;1,600;1,700;1,800',
    `${baseURL}/static/css/sj_course_platform_v2.c3dbdd7c85c9.css`,
    `${baseURL}/static/js/vendor/prism/prism.47d40f251583.css`,
    'https://public.sj-cdn.net/sse/blank_slate.css',
  ];
}

function buildLessonDocument(html) {
  const allCss = [...getBaseCss(), ...(previewConfig.theme?.css || [])];
  const cssLinks = allCss
    .map(href => `  <link rel="stylesheet" href="${href}">`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
${cssLinks}
  <style>body { padding: 2rem 3rem; }</style>
</head>
<body>
${html}
</body>
</html>`;
}

async function loadLesson(lessonTitle, courseName) {
  localStorage.setItem('selectedCourse', courseName);
  localStorage.setItem('selectedLesson', lessonTitle);

  lessonTop.innerHTML = `<h2>${lessonTitle}</h2>`;

  const paths = courseData[courseName]['Lessons'][lessonTitle] || [];

  if (paths.length === 0) {
    if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
    lessonFrame.srcdoc = buildLessonDocument(
      `<p style="color:#888;font-style:italic;">No text content available for this lesson.</p>`
    );
    return;
  }

  try {
    const htmlParts = await Promise.all(paths.map(async (p) => {
      const res = await fetch(p);
      if (!res.ok) throw new Error(`Failed to load ${p}: ${res.status}`);
      return res.text();
    }));

    if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    const blob = new Blob([buildLessonDocument(htmlParts.join('\n'))], { type: 'text/html' });
    currentBlobUrl = URL.createObjectURL(blob);
    lessonFrame.src = currentBlobUrl;
  } catch (err) {
    lessonFrame.srcdoc = `<p style="color:red;font-family:sans-serif;padding:1rem">${err.message}</p>`;
  }
}

function populateCourseDropdown() {
  courseSelector.innerHTML = '';
  for (const courseName of Object.keys(courseData).sort()) {
    const option = document.createElement('option');
    option.value = courseName;
    option.textContent = courseName;
    courseSelector.appendChild(option);
  }
}

function populateLessonDropdown(courseName) {
  const lessons = courseData[courseName]['Lessons'];
  lessonSelector.innerHTML = '';
  for (const title of Object.keys(lessons)) {
    const option = document.createElement('option');
    option.value = title;
    option.textContent = title;
    lessonSelector.appendChild(option);
  }
}

courseSelector.addEventListener('change', () => {
  const selectedCourse = courseSelector.value;
  populateLessonDropdown(selectedCourse);

  const firstLesson = lessonSelector.options[0];
  if (firstLesson) {
    lessonSelector.value = firstLesson.value;
    loadLesson(firstLesson.value, selectedCourse);
  }
});

lessonSelector.addEventListener('change', () => {
  loadLesson(lessonSelector.value, courseSelector.value);
});

window.addEventListener('DOMContentLoaded', async () => {
  await fetchConfig();

  const res = await fetch('/api/courses');
  courseData = await res.json();
  populateCourseDropdown();

  const savedCourse = localStorage.getItem('selectedCourse');
  const savedLesson = localStorage.getItem('selectedLesson');

  if (savedCourse && courseData[savedCourse]) {
    courseSelector.value = savedCourse;
    populateLessonDropdown(savedCourse);

    if (savedLesson && courseData[savedCourse]['Lessons'][savedLesson]) {
      lessonSelector.value = savedLesson;
      loadLesson(savedLesson, savedCourse);
      return;
    }
  }

  // Fallback to first course + lesson
  const firstCourse = courseSelector.options[0]?.value;
  if (firstCourse) {
    courseSelector.value = firstCourse;
    populateLessonDropdown(firstCourse);
    const firstLesson = lessonSelector.options[0];
    if (firstLesson) {
      lessonSelector.value = firstLesson.value;
      loadLesson(firstLesson.value, firstCourse);
    }
  }
});
