const fs = require('fs');
let code = fs.readFileSync('src/services/hebcal.ts', 'utf8');

// Replace getHebcalData axios call
code = code.replace(
  /const response = await axios\.get<HebcalResponse>\(\n\s*config\.hebcal\.apiBaseUrl,\n\s*\{\n\s*params,\n\s*timeout: 5000, \/\/ 5 second timeout to prevent hanging\n\s*\}\n\s*\);/g,
  `const response = await axios.get<HebcalResponse>(
        config.hebcal.apiBaseUrl,
        {
          params,
          timeout: 10000,
          headers: {
            "User-Agent": "WhatsApp-Reminders-Bot/1.0 (https://github.com/)"
          }
        }
      );`
);

// Replace getZmanimData axios call
code = code.replace(
  /const response = await axios\.get<ZmanimResponse>\(\n\s*"https:\/\/www\.hebcal\.com\/zmanim",\n\s*\{\n\s*params,\n\s*timeout: 5000, \/\/ 5 second timeout to prevent hanging\n\s*\}\n\s*\);/g,
  `const response = await axios.get<ZmanimResponse>(
        "https://www.hebcal.com/zmanim",
        {
          params,
          timeout: 10000,
          headers: {
            "User-Agent": "WhatsApp-Reminders-Bot/1.0 (https://github.com/)"
          }
        }
      );`
);

fs.writeFileSync('src/services/hebcal.ts', code);
