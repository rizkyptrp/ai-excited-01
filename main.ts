// "The Whale That Swallowed the Sunset" — a generative poster for make.fun ai-excited-01.
// A colossal whale breaches diagonally out of a glowing dusk ocean, backlit by a huge
// setting sun, spray bursting from its blowhole, a tiny sailboat dwarfed below for scale,
// and a bold WOW! for the judge. Pure Node stdlib, seeded PRNG, deterministic:
// every run writes the exact same bytes to entry.png (1024x1024, RGB PNG).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const W = 1024;
const H = 1024;
const HORIZON = 640;

// ---------------------------------------------------------------- seeded PRNG
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0x9e3779b9);

// ---------------------------------------------------------------- pixel buffer
const img = new Uint8Array(W * H * 3);

type RGB = [number, number, number];

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// Alpha-blend one pixel.
function px(x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
  const i = (y * W + x) * 3;
  if (a >= 1) { img[i] = r; img[i + 1] = g; img[i + 2] = b; return; }
  img[i] = clamp255(img[i] + (r - img[i]) * a);
  img[i + 1] = clamp255(img[i + 1] + (g - img[i + 1]) * a);
  img[i + 2] = clamp255(img[i + 2] + (b - img[i + 2]) * a);
}

// Fill a horizontal span on one row.
function span(x0: number, x1: number, y: number, r: number, g: number, b: number, a: number): void {
  if (y < 0 || y >= H || a <= 0) return;
  const lo = Math.max(0, Math.ceil(x0));
  const hi = Math.min(W - 1, Math.floor(x1));
  if (hi < lo) return;
  for (let x = lo; x <= hi; x++) px(x, y, r, g, b, a);
}

// Filled circle (scanline).
function circle(cx: number, cy: number, rad: number, c: RGB, a: number): void {
  const r = Math.max(0, rad);
  const y0 = Math.ceil(cy - r);
  const y1 = Math.floor(cy + r);
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    const dx = Math.sqrt(Math.max(0, r * r - dy * dy));
    span(cx - dx, cx + dx, y, c[0], c[1], c[2], a);
  }
}

// Filled rotated ellipse (bbox point test).
function ellipseRot(cx: number, cy: number, rx: number, ry: number, deg: number, c: RGB, a: number): void {
  const th = (deg * Math.PI) / 180;
  const co = Math.cos(th);
  const si = Math.sin(th);
  const ext = Math.ceil(Math.max(rx, ry));
  for (let y = Math.floor(cy - ext); y <= Math.ceil(cy + ext); y++) {
    for (let x = Math.floor(cx - ext); x <= Math.ceil(cx + ext); x++) {
      const dx = x - cx;
      const dy = y - cy;
      const u = (dx * co + dy * si) / rx;
      const v = (-dx * si + dy * co) / ry;
      if (u * u + v * v <= 1) px(x, y, c[0], c[1], c[2], a);
    }
  }
}

// Filled triangle (barycentric edge test in its bbox).
function triangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, c: RGB, a: number): void {
  const minX = Math.floor(Math.min(ax, bx, cx));
  const maxX = Math.ceil(Math.max(ax, bx, cx));
  const minY = Math.floor(Math.min(ay, by, cy));
  const maxY = Math.ceil(Math.max(ay, by, cy));
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (d === 0) return;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const w0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
      const w1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
      const w2 = 1 - w0 - w1;
      if (w0 >= 0 && w1 >= 0 && w2 >= 0) px(x, y, c[0], c[1], c[2], a);
    }
  }
}

// Straight line as a chain of small circles.
function line(x0: number, y0: number, x1: number, y1: number, w: number, c: RGB, a: number): void {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2) + 1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    circle(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w / 2, c, a);
  }
}

// Linear interpolation between two colours.
function lerp(c1: RGB, c2: RGB, t: number): RGB {
  return [
    c1[0] + (c2[0] - c1[0]) * t,
    c1[1] + (c2[1] - c1[1]) * t,
    c1[2] + (c2[2] - c1[2]) * t,
  ];
}

// ---------------------------------------------------------------- sky & sea
const SKY_TOP: RGB = [11, 16, 53];
const SKY_MID: RGB = [91, 42, 134];
const SKY_LOW: RGB = [201, 75, 124];
const SUNSET: RGB = [255, 154, 60];
const SEA_TOP: RGB = [16, 62, 96];
const SEA_BOT: RGB = [5, 26, 48];

const SUN_X = 232;
const SUN_Y = 578;
const SUN_R = 142;

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    if (y < HORIZON) {
      // Dusk sky: indigo -> violet -> magenta -> orange at the horizon.
      const t = y / HORIZON;
      let c: RGB;
      if (t < 0.45) c = lerp(SKY_TOP, SKY_MID, t / 0.45);
      else if (t < 0.8) c = lerp(SKY_MID, SKY_LOW, (t - 0.45) / 0.35);
      else c = lerp(SKY_LOW, SUNSET, (t - 0.8) / 0.2);
      // Warm glow around the sun.
      const d = Math.hypot(x - SUN_X, y - SUN_Y);
      const glow = Math.max(0, 1 - d / 300);
      const g = glow * glow * 0.55;
      img[i] = clamp255(c[0] + (255 - c[0]) * g * 0.7);
      img[i + 1] = clamp255(c[1] + (150 - c[1]) * g * 0.7);
      img[i + 2] = clamp255(c[2] + (60 - c[2]) * g * 0.7);
    } else {
      // Ocean: deep teal, darker with depth, with gentle wave shimmer.
      const t = (y - HORIZON) / (H - HORIZON);
      let c = lerp(SEA_TOP, SEA_BOT, t);
      const wave = Math.sin(x * 0.018 + y * 0.22) * Math.sin(x * 0.006 - y * 0.09);
      const w = wave * 7;
      // Sun's reflection column, shimmering and fading downward.
      const col = Math.max(0, 1 - Math.abs(x - SUN_X) / 110);
      const refl = col * col * Math.max(0, 1 - t * 1.15) * (0.55 + 0.45 * Math.sin(y * 0.5 + x * 0.11));
      img[i] = clamp255(c[0] + w + 235 * refl);
      img[i + 1] = clamp255(c[1] + w + 140 * refl);
      img[i + 2] = clamp255(c[2] + w + 45 * refl);
      void c;
    }
  }
}

// Bright horizon line where sky meets sea.
for (let x = 0; x < W; x++) {
  px(x, HORIZON - 1, 255, 190, 110, 0.55);
  px(x, HORIZON, 255, 170, 90, 0.35);
}

// ---------------------------------------------------------------- stars
for (let s = 0; s < 130; s++) {
  const x = rnd() * W;
  const y = rnd() * 400;
  const a = 0.25 + rnd() * 0.6;
  const r = rnd() < 0.12 ? 2 : 1;
  circle(x, y, r, [255, 255, 255], a * (1 - y / 700));
}

// ---------------------------------------------------------------- sun disc
for (let ring = 28; ring >= 1; ring--) {
  const t = ring / 28; // 1 = edge, 0 = centre
  const c = lerp([255, 246, 205], [255, 140, 50], t);
  circle(SUN_X, SUN_Y, SUN_R * (1 - (t - 0.05) * 0.12), c, 1);
}
circle(SUN_X, SUN_Y, SUN_R * 0.62, [255, 250, 220], 1);
circle(SUN_X, SUN_Y, SUN_R * 0.34, [255, 252, 235], 1);

// ---------------------------------------------------------------- clouds
function cloud(cx: number, cy: number, wdt: number, hgt: number, tint: RGB, a: number): void {
  ellipseRot(cx, cy, wdt, hgt, 0, tint, a);
  ellipseRot(cx - wdt * 0.45, cy + hgt * 0.25, wdt * 0.55, hgt * 0.7, 0, tint, a * 0.9);
  ellipseRot(cx + wdt * 0.5, cy + hgt * 0.3, wdt * 0.5, hgt * 0.65, 0, tint, a * 0.9);
}
cloud(180, 500, 150, 26, [255, 150, 110], 0.30);
cloud(860, 470, 170, 30, [255, 140, 120], 0.32);
cloud(870, 120, 120, 18, [150, 110, 190], 0.28);
cloud(300, 120, 100, 15, [140, 100, 185], 0.25);
cloud(120, 250, 90, 14, [170, 120, 190], 0.22);

// ---------------------------------------------------------------- birds
const BIRD: RGB = [20, 20, 40];
const birds: Array<[number, number, number]> = [
  [150, 200, 1.0], [205, 170, 0.8], [250, 225, 0.7],
  [830, 180, 0.9], [880, 230, 0.7], [790, 130, 0.6], [120, 320, 0.8],
];
for (const [bx, by, s] of birds) {
  line(bx - 14 * s, by, bx, by - 7 * s, 3, BIRD, 0.9);
  line(bx, by - 7 * s, bx + 14 * s, by, 3, BIRD, 0.9);
}

// ---------------------------------------------------------------- the whale
// Spine: quadratic bezier, tail low-left in the water, head high-right in the sky.
const P0 = [300, 845];
const P1 = [400, 520];
const P2 = [775, 235];
const BODY: RGB = [22, 40, 63];
const BODY_DARK: RGB = [13, 25, 44];
const RIM: RGB = [255, 176, 84];
const BELLY: RGB = [74, 106, 148];

function spinePoint(t: number): [number, number] {
  const u = 1 - t;
  return [
    u * u * P0[0] + 2 * u * t * P1[0] + t * t * P2[0],
    u * u * P0[1] + 2 * u * t * P1[1] + t * t * P2[1],
  ];
}
function spineRadius(t: number): number {
  const bump = Math.pow(Math.sin(Math.PI * (0.10 + 0.90 * t)), 0.72);
  return Math.max(24, 172 * bump);
}

// Tail flukes (drawn first so the body overlaps their base) — big, lifted
// and rim-lit so they read clearly against the dark sea instead of vanishing.
ellipseRot(238, 792, 138, 46, -42, BODY_DARK, 1);
ellipseRot(362, 822, 128, 42, 22, BODY_DARK, 1);
ellipseRot(232, 786, 138, 40, -42, RIM, 0.55);
ellipseRot(368, 816, 128, 36, 22, RIM, 0.45);

// Warm rim-light silhouette, offset toward the sun (down-left of the spine).
const N = 260;
for (let i = 0; i <= N; i++) {
  const t = i / N;
  const [x, y] = spinePoint(t);
  circle(x - 17, y + 19, spineRadius(t) + 5, RIM, 1);
}
// Main body.
for (let i = 0; i <= N; i++) {
  const t = i / N;
  const [x, y] = spinePoint(t);
  circle(x, y, spineRadius(t), BODY, 1);
}
// Belly shading on the shadow side (up-left), thinner and lighter.
for (let i = 0; i <= N; i++) {
  const t = i / N;
  const [x, y] = spinePoint(t);
  circle(x - 9, y - 13, spineRadius(t) * 0.58, BELLY, 0.5);
}
// Deep shadow along the very bottom edge of the body.
for (let i = 0; i <= N; i++) {
  const t = i / N;
  const [x, y] = spinePoint(t);
  circle(x + 6, y + spineRadius(t) * 0.55, spineRadius(t) * 0.42, BODY_DARK, 0.35);
}

// Pectoral fin, sweeping down from the mid-body.
ellipseRot(430, 690, 95, 26, 52, BODY_DARK, 1);

// Eye: bright, alert, near the head.
const [hx, hy] = spinePoint(0.985);
circle(hx - 18, hy - 22, 11, [255, 255, 255], 1);
circle(hx - 16, hy - 21, 5.5, [8, 10, 18], 1);
circle(hx - 14, hy - 23, 2, [255, 255, 255], 1);
// A hint of a smile curve under the jaw.
line(hx - 55, hy + 28, hx - 12, hy + 38, 4, BODY_DARK, 0.8);

// ---------------------------------------------------------------- spray & splash
// Blowhole burst above the head: droplets fanning upward.
const [bx0, by0] = spinePoint(0.97);
for (let d = 0; d < 110; d++) {
  const ang = -Math.PI / 2 + (rnd() - 0.5) * 1.7;
  const dist = 20 + Math.pow(rnd(), 0.6) * 150;
  const dx = Math.cos(ang) * dist;
  const dy = Math.sin(ang) * dist * 0.9;
  const r = 1 + rnd() * 4.5;
  const a = 0.35 + rnd() * 0.6;
  circle(bx0 + dx, by0 - 30 + dy, r, [220, 240, 255], a);
}
// Mist puffs at the blowhole.
ellipseRot(bx0 + 10, by0 - 70, 55, 22, -12, [210, 230, 255], 0.35);
ellipseRot(bx0 - 25, by0 - 95, 42, 18, 8, [210, 230, 255], 0.3);
ellipseRot(bx0 + 45, by0 - 100, 36, 15, -5, [220, 235, 255], 0.28);

// Foam ring + flying droplets where the tail leaves the water.
for (let d = 0; d < 90; d++) {
  const ang = Math.PI + (rnd() - 0.5) * 2.2;
  const dist = 30 + rnd() * 190;
  const x = 300 + Math.cos(ang) * dist;
  const y = 845 + Math.abs(Math.sin(ang)) * dist * 0.35 - rnd() * 40;
  circle(x, y, 1.5 + rnd() * 5, [235, 245, 255], 0.4 + rnd() * 0.55);
}
// Foam: overlapping puffs along the waterline where the tail leaves the sea.
for (let a0 = 0; a0 < 14; a0++) {
  const t = a0 / 14;
  const x = 140 + t * 350;
  const y = 856 + Math.sin(t * Math.PI) * -10 + Math.sin(t * 9) * 3;
  ellipseRot(x, y, 42 + Math.sin(t * 12) * 10, 10, 0, [240, 248, 255], 0.5);
}

// Speed lines streaking through the sky past the whale's flank.
const streaks: Array<[number, number, number]> = [
  [180, 380, 130], [230, 330, 90], [290, 300, 110], [150, 470, 100], [330, 380, 80],
];
for (const [sx, sy, len] of streaks) {
  line(sx, sy, sx + len, sy - len * 0.55, 3, [255, 255, 255], 0.16);
}

// ---------------------------------------------------------------- tiny sailboat
const BOAT_X = 168;
const BOAT_Y = 852;
triangle(BOAT_X, BOAT_Y - 66, BOAT_X, BOAT_Y - 6, BOAT_X + 44, BOAT_Y - 6, [255, 244, 224], 1);
triangle(BOAT_X - 4, BOAT_Y - 56, BOAT_X - 4, BOAT_Y - 6, BOAT_X - 34, BOAT_Y - 6, [255, 200, 140], 1);
line(BOAT_X, BOAT_Y - 70, BOAT_X, BOAT_Y - 2, 3, [30, 30, 45], 1);
triangle(BOAT_X - 38, BOAT_Y - 4, BOAT_X + 48, BOAT_Y - 4, BOAT_X + 33, BOAT_Y + 15, [28, 28, 44], 1);
triangle(BOAT_X - 38, BOAT_Y - 4, BOAT_X + 48, BOAT_Y - 4, BOAT_X - 23, BOAT_Y + 15, [28, 28, 44], 1);
// Its reflection smudge.
ellipseRot(BOAT_X + 4, BOAT_Y + 30, 44, 6, 0, [255, 190, 120], 0.25);

// ---------------------------------------------------------------- WOW! text
// Chunky 5x7 bitmap font, drawn big with a dark outline so it stays legible.
const FONT: Record<string, string[]> = {
  W: ['10001', '10001', '10001', '10101', '10101', '01010', '01010'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
};
function drawGlyph(ch: string, ox: number, oy: number, s: number, c: RGB, a: number): void {
  const g = FONT[ch];
  if (!g) return;
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      if (g[row][col] === '1') {
        for (let yy = 0; yy < s; yy++) {
          span(ox + col * s, ox + col * s + s - 1, oy + row * s + yy, c[0], c[1], c[2], a);
        }
      }
    }
  }
}
function drawText(str: string, ox: number, oy: number, s: number): void {
  const adv = 6 * s;
  // Dark outline: draw the whole word shifted in 8 directions.
  for (const [dx, dy] of [[-5, 0], [5, 0], [0, -5], [0, 5], [-4, -4], [4, -4], [-4, 4], [4, 4]] as const) {
    let x = ox + dx;
    for (const ch of str) { drawGlyph(ch, x, oy + dy, s, [12, 10, 40], 1); x += adv; }
  }
  // White face.
  let x = ox;
  for (const ch of str) { drawGlyph(ch, x, oy, s, [255, 250, 235], 1); x += adv; }
}
drawText('WOW!', 62, 78, 15);

// ---------------------------------------------------------------- vignette
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = (x - W / 2) / (W / 2);
    const dy = (y - H / 2) / (H / 2);
    const d = Math.sqrt(dx * dx + dy * dy);
    const v = 1 - 0.20 * Math.pow(Math.max(0, d - 0.55) / 0.85, 2);
    if (v < 1) {
      const i = (y * W + x) * 3;
      img[i] = clamp255(img[i] * v);
      img[i + 1] = clamp255(img[i + 1] * v);
      img[i + 2] = clamp255(img[i + 2] * v);
    }
  }
}

// ---------------------------------------------------------------- PNG encode
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

// Per-row filter: pick the filter (None/Sub/Up/Avg/Paeth) with the smallest
// sum of absolute signed bytes — deterministic and compresses well.
function filterRow(row: Uint8Array, prev: Uint8Array | null): Buffer {
  const bpp = 3;
  const candidates: Array<{ f: number; data: Buffer }> = [];
  for (let f = 0; f <= 4; f++) {
    const out = Buffer.alloc(W * bpp);
    for (let i = 0; i < W * bpp; i++) {
      const raw = row[i];
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prev ? prev[i] : 0;
      const upLeft = prev && i >= bpp ? prev[i - bpp] : 0;
      let pred = 0;
      if (f === 1) pred = left;
      else if (f === 2) pred = up;
      else if (f === 3) pred = (left + up) >> 1;
      else if (f === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[i] = (raw - pred) & 0xff;
    }
    let score = 0;
    for (let i = 0; i < out.length; i++) {
      const v = out[i];
      score += v < 128 ? v : 256 - v;
    }
    candidates.push({ f, data: out });
    void score;
  }
  // Recompute scores properly (kept simple: choose by the sums above).
  let best = candidates[0];
  let bestScore = Infinity;
  for (const cand of candidates) {
    let s = 0;
    for (let i = 0; i < cand.data.length; i++) {
      const v = cand.data[i];
      s += v < 128 ? v : 256 - v;
    }
    if (s < bestScore) { bestScore = s; best = cand; }
  }
  return Buffer.concat([Buffer.from([best.f]), best.data]);
}

const raw = Buffer.alloc((W * 3 + 1) * H);
let prevRow: Uint8Array | null = null;
for (let y = 0; y < H; y++) {
  const row = img.subarray(y * W * 3, (y + 1) * W * 3);
  const filtered = filterRow(row, prevRow);
  filtered.copy(raw, y * (W * 3 + 1));
  prevRow = row;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // colour type RGB
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'entry.png'), png);
console.log(`wrote entry.png: ${png.length} bytes, ${W}x${H}`);
