const courseSelector = document.getElementById('courseSelector');
const lessonSelector = document.getElementById('lessonSelector');
const lessonMain = document.getElementById('lesson-main-content');
const lessonTop = document.querySelector('.lesson-top');

let courseData = {};

function loadLesson(lessonPath, lessonTitle) {
  localStorage.setItem('selectedLessonPath', lessonPath);
  localStorage.setItem('selectedLessonTitle', lessonTitle);

  lessonTop.innerHTML = `<h2>${lessonTitle}</h2>`;

  fetch(lessonPath)
    .then(res => {
      if (!res.ok) throw new Error(`Failed to load ${lessonPath}: ${res.status}`);
      return res.text();
    })
    .then(html => {
      lessonMain.innerHTML = html;
    })
    .catch(err => {
      lessonMain.innerHTML = `<p style="color:red;">${err.message}</p>`;
    });
}

function populateCourseDropdown() {
  courseSelector.innerHTML = '';
  for (const courseName of Object.keys(courseData)) {
    const option = document.createElement('option');
    option.value = courseName;
    option.textContent = courseName;
    courseSelector.appendChild(option);
  }
}

function populateLessonDropdown(courseName) {
  const lessons = courseData[courseName]["Lessons"];
  lessonSelector.innerHTML = '';
  for (const [title, path] of Object.entries(lessons)) {
    const option = document.createElement('option');
    option.value = path;
    option.textContent = title;
    lessonSelector.appendChild(option);
  }
}

courseSelector.addEventListener('change', () => {
  const selectedCourse = courseSelector.value;
  localStorage.setItem('selectedCourse', selectedCourse);
  populateLessonDropdown(selectedCourse);

  const firstLesson = lessonSelector.options[0];
  if (firstLesson) {
    lessonSelector.value = firstLesson.value;
    loadLesson(`${firstLesson.value}`, firstLesson.textContent);
  }
});

lessonSelector.addEventListener('change', () => {
  const lessonPath = lessonSelector.value;
  const title = lessonSelector.options[lessonSelector.selectedIndex].textContent;
  loadLesson(`${lessonPath}`, title);
});

window.addEventListener('DOMContentLoaded', () => {
  fetch('data/courses.json')
    .then(res => res.json())
    .then(json => {
      courseData = json;
      populateCourseDropdown();

      const savedCourse = localStorage.getItem('selectedCourse');
      const savedLessonPath = localStorage.getItem('selectedLessonPath');
      const savedLessonTitle = localStorage.getItem('selectedLessonTitle');

      if (savedCourse && courseData[savedCourse]) {
        courseSelector.value = savedCourse;
        populateLessonDropdown(savedCourse);

        if (savedLessonPath && savedLessonTitle) {
          lessonSelector.value = savedLessonPath.replace(/^courses\//, '');
          loadLesson(`${savedLessonPath}`, savedLessonTitle);
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
          loadLesson(`${firstLesson.value}`, firstLesson.textContent);
        }
      }
    });
});
