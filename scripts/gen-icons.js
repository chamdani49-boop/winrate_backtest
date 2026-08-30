// Generator ikon PWA (PNG murni via zlib, tanpa dependency eksternal).
// Membuat icons/icon-192.png & icons/icon-512.png — tema gelap + candlestick hijau naik.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const crcTable = (() => {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(S, rgba) {
  const raw = Buffer.alloc((S * 4 + 1) * S);
  for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function makeIcon(S) {
  const buf = Buffer.alloc(S * S * 4);
  const bg = [8, 11, 17];        // #080b11 (app bg)
  const panel = [19, 25, 35];    // #131923 (card)
  const green = [0, 229, 160];   // accent
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const i = (y * S + x) * 4; buf[i] = bg[0]; buf[i + 1] = bg[1]; buf[i + 2] = bg[2]; buf[i + 3] = 255; }
  const set = (x, y, c) => { x = x | 0; y = y | 0; if (x < 0 || y < 0 || x >= S || y >= S) return; const i = (y * S + x) * 4; buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255; };
  const rect = (x0, y0, x1, y1, c) => { for (let y = Math.round(y0); y < Math.round(y1); y++) for (let x = Math.round(x0); x < Math.round(x1); x++) set(x, y, c); };
  // rounded panel background (soft) — safe zone tengah
  const m = 0.12 * S, r = 0.14 * S;
  const rrect = (x0, y0, x1, y1, rad, c) => {
    for (let y = Math.round(y0); y < Math.round(y1); y++) for (let x = Math.round(x0); x < Math.round(x1); x++) {
      let cx = x, cy = y, inside = true;
      if (x < x0 + rad && y < y0 + rad) inside = ((x - (x0 + rad)) ** 2 + (y - (y0 + rad)) ** 2) <= rad * rad;
      else if (x > x1 - rad && y < y0 + rad) inside = ((x - (x1 - rad)) ** 2 + (y - (y0 + rad)) ** 2) <= rad * rad;
      else if (x < x0 + rad && y > y1 - rad) inside = ((x - (x0 + rad)) ** 2 + (y - (y1 - rad)) ** 2) <= rad * rad;
      else if (x > x1 - rad && y > y1 - rad) inside = ((x - (x1 - rad)) ** 2 + (y - (y1 - rad)) ** 2) <= rad * rad;
      if (inside) set(x, y, c);
    }
  };
  rrect(m, m, S - m, S - m, r, panel);
  // candlestick naik (4 candle hijau)
  const candles = [[0.30, 0.70, 0.58], [0.44, 0.64, 0.46], [0.58, 0.54, 0.36], [0.72, 0.46, 0.26]];
  const bw = 0.075 * S, ww = 0.016 * S, wick = 0.05 * S;
  candles.forEach(([cx, bot, top]) => {
    const x = cx * S, by = bot * S, ty = top * S;
    rect(x - ww / 2, ty - wick, x + ww / 2, by + wick, green); // wick
    rect(x - bw / 2, ty, x + bw / 2, by, green);               // body
  });
  return buf;
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
[192, 512].forEach(S => {
  const png = encodePNG(S, makeIcon(S));
  fs.writeFileSync(path.join(outDir, `icon-${S}.png`), png);
  console.log(`icon-${S}.png:`, png.length, 'bytes');
});
console.log('done');
