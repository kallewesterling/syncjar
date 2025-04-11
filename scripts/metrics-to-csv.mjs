import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'json2csv';
import { format } from 'date-fns';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const inputPath = path.join(__dirname, '..', 'public', 'data', 'user-progress.json');
const outputPath = path.join(__dirname, '..', 'public', 'data', 'metrics-report.csv');

const users = await fs.readJson(inputPath);

const courseSet = new Set();
const monthlyMetrics = new Map();

const getMonthKey = date =>
  format(new Date(date), 'MMMM yyyy'); // e.g. "August 2024"

for (const user of users) {
  const courses = user.courses || [];

  for (const course of courses) {
    const title = course.course.title;
    courseSet.add(title);

    const enrolled = course.enrolled_at || user.signed_up_at || user.created;
    const completion = course.course_progress.completed_at;

    const enrolledMonth = getMonthKey(enrolled);
    const completedMonth = completion ? getMonthKey(completion) : null;

    // Init month if needed
    if (!monthlyMetrics.has(enrolledMonth)) {
      monthlyMetrics.set(enrolledMonth, {});
    }

    const monthMetrics = monthlyMetrics.get(enrolledMonth);
    if (!monthMetrics[title]) {
      monthMetrics[title] = { registrations: 0, completions: 0 };
    }

    monthMetrics[title].registrations += 1;

    // Count completion if it's in the same month
    if (completedMonth === enrolledMonth) {
      monthMetrics[title].completions += 1;
    }
  }
}

// Sort courses and months
const allCourses = Array.from(courseSet).sort();
const allMonths = Array.from(monthlyMetrics.keys()).sort(
  (a, b) => new Date(a) - new Date(b)
);

// Build rows for CSV
const rows = allMonths.map(month => {
  const row = { Month: month };
  const monthData = monthlyMetrics.get(month) || {};

  for (const course of allCourses) {
    const data = monthData[course] || { registrations: 0, completions: 0 };
    row[`${course} - registrations`] = data.registrations;
    row[`${course} - completions`] = data.completions;
  }

  return row;
});

// Fields order
const fields = ['Month'];
for (const course of allCourses) {
  fields.push(`${course} - registrations`, `${course} - completions`);
}

const csv = parse(rows, { fields });
await fs.writeFile(outputPath, csv);

console.log(`✅ Metrics CSV exported to ${outputPath}`);
