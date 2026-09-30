// Собирает один файл worker.js (его можно целиком вставить в редактор Cloudflare)
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('./src/bot.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./src/app.html', import.meta.url), 'utf8');
const marker = "const APP_HTML = '__APP_HTML__';";
if (!src.includes(marker)) throw new Error('marker not found');
const out = '// ⚠️ Файл собран из src/ командой `npm run build` — правь исходники, а не его.\n' +
  src.replace(marker, () => `const APP_HTML = ${JSON.stringify(html)};`);
writeFileSync(new URL('./worker.js', import.meta.url), out);
console.log(`worker.js: ${(out.length / 1024).toFixed(0)} KB`);
