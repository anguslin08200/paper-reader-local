// Generate assets/paper-reader.ico (PNG-in-ICO, 256/48/32/16) for the desktop shortcut and app window.
import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';

function drawIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const radius = size * 0.22;
  ctx.fillStyle = '#202a44';
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, radius);
  ctx.fill();
  // Highlighter stroke behind the letter echoes the reading/annotation focus.
  ctx.fillStyle = 'rgba(255, 228, 56, 0.9)';
  ctx.fillRect(size * 0.18, size * 0.58, size * 0.64, size * 0.16);
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(size * 0.62)}px Segoe UI, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('P', size / 2, size * 0.5);
  return canvas.toBuffer('image/png');
}

const sizes = [256, 48, 32, 16];
const images = sizes.map(drawIcon);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
const entries = [];
let offset = 6 + 16 * images.length;
images.forEach((png, index) => {
  const entry = Buffer.alloc(16);
  const size = sizes[index];
  entry.writeUInt8(size >= 256 ? 0 : size, 0); entry.writeUInt8(size >= 256 ? 0 : size, 1);
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(offset, 12);
  offset += png.length;
  entries.push(entry);
});
writeFileSync(new URL('../assets/paper-reader.ico', import.meta.url), Buffer.concat([header, ...entries, ...images]));
writeFileSync(new URL('../src/web/public/icon.png', import.meta.url), images[0]);
console.log('icon written');
