import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'umd');
const dest = path.join(root, 'public', 'ffmpeg');

if (!existsSync(src)) {
  console.error(`@ffmpeg/core not found at ${src} — did "npm install" finish?`);
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
for (const file of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  cpSync(path.join(src, file), path.join(dest, file));
  console.log(`copied ${file} -> public/ffmpeg/`);
}
