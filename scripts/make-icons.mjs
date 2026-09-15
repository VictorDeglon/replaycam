import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(root, 'public');
const iconsDir = path.join(publicDir, 'icons');

function render(srcSvg, outPng, size) {
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), srcSvg, '-o', outPng]);
  console.log(`wrote ${path.relative(root, outPng)} (${size}x${size})`);
}

if (!existsSync('/opt/homebrew/bin/rsvg-convert') && !existsSync('/usr/local/bin/rsvg-convert')) {
  try {
    execFileSync('which', ['rsvg-convert']);
  } catch {
    console.error('rsvg-convert not found. Install it with: brew install librsvg');
    process.exit(1);
  }
}

const icon = path.join(publicDir, 'icon.svg');
const maskable = path.join(publicDir, 'icon-maskable.svg');

render(icon, path.join(iconsDir, 'icon-192.png'), 192);
render(icon, path.join(iconsDir, 'icon-512.png'), 512);
render(maskable, path.join(iconsDir, 'icon-512-maskable.png'), 512);
render(icon, path.join(publicDir, 'apple-touch-icon.png'), 180);
render(icon, path.join(publicDir, 'favicon-32.png'), 32);
render(icon, path.join(publicDir, 'favicon-16.png'), 16);

console.log('Icons generated.');
