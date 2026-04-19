/**
 * Report generator for test results
 */

const fs = require('fs');
const path = require('path');

function generateReport(allResults, reportPath) {
  const now = new Date().toISOString();
  const total = allResults.length;
  const passed = allResults.filter(r => r.pass).length;
  const failed = total - passed;

  let md = `# Task Test Report\n\n`;
  md += `**Generated:** ${now}  \n`;
  md += `**Total:** ${total} | **Passed:** ${passed} | **Failed:** ${failed}\n\n`;
  md += `---\n\n`;

  // Group by task
  const byTask = {};
  for (const r of allResults) {
    if (!byTask[r.task]) byTask[r.task] = [];
    byTask[r.task].push(r);
  }

  for (const [task, results] of Object.entries(byTask)) {
    const taskPassed = results.filter(r => r.pass).length;
    const status = taskPassed === results.length ? '✅' : '❌';
    md += `## ${status} ${task} (${taskPassed}/${results.length})\n\n`;
    for (const r of results) {
      const icon = r.pass ? '✅' : '❌';
      md += `- ${icon} ${r.name}\n`;
      if (!r.pass && r.error) {
        md += `  > \`${r.error}\`\n`;
      }
    }
    md += `\n`;
  }

  fs.writeFileSync(reportPath, md, 'utf8');
  return { total, passed, failed };
}

module.exports = { generateReport };
