const fs = require('fs');
let code = fs.readFileSync('src/services/hebcal.ts', 'utf8');

// Fix getCacheKey
code = code.replace(
  /private getCacheKey\(location: string, date: string\): string \{\n    return `\$\{location\}_\$\{date\}`;/,
  `private getCacheKey(location: string, date: string): string {
    const d = date === "today" ? new Date().toISOString().split("T")[0] : date;
    return \`\${location}_\${d}\`;`
);

// Fix getZmanimData cacheKey
code = code.replace(
  /const cacheKey = \`zmanim_\$\{latitude\}_\$\{longitude\}_\$\{date \|\| "today"\}_\$\{tzid \|\| "Asia\/Jerusalem"\}\`;/,
  `const d = date || new Date().toISOString().split("T")[0];
    const cacheKey = \`zmanim_\${latitude}_\${longitude}_\${d}_\${tzid || "Asia/Jerusalem"}\`;`
);

fs.writeFileSync('src/services/hebcal.ts', code);
