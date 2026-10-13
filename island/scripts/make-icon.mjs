// Draws the app icon (a dark rounded tile with an island hanging from its top
// edge and a status dot) as a 1024×1024 PNG. `npm run icons` turns it into
// every size Tauri needs under src-tauri/icons/.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const S = 1024;
const px = Buffer.alloc(S * S * 4);

const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let c = [0, 0, 0, 0];
    if (inRoundRect(x, y, 64, 64, 960, 960, 210)) {
      const t = y / S; // subtle vertical gradient
      c = [Math.round(28 - 14 * t), Math.round(30 - 14 * t), Math.round(46 - 20 * t), 255];
    }
    // The island: a pill hanging from the tile's top band.
    if (inRoundRect(x, y, 262, 250, 762, 410, 80)) c = [244, 244, 246, 255];
    // Status dot.
    if ((x - 512) ** 2 + (y - 660) ** 2 <= 96 ** 2) c = [142, 162, 255, 255];
    px.set(c, (y * S + x) * 4);
  }
}

// PNG: signature, IHDR, IDAT (filter byte 0 per row), IEND.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const out = process.argv[2] ?? "app-icon.png";
writeFileSync(out, png);
console.log(`wrote ${out}`);
