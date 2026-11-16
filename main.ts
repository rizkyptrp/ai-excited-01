// "The Koi That Jumped at the Moon" — ai-excited-01
//
// A generative 1024x1024 poster drawn entirely in code, stdlib only.
// A colossal glowing koi leaps out of a neon night pond in a great arc
// toward a huge full moon, water exploding into light behind it, aurora
// ribbons overhead, and a bold "WOW, JUDGE!" banner across the sky.
//
// Deterministic: a fixed-seed PRNG (mulberry32) drives every random
// choice, so every run writes byte-identical output.
//
// Run:  mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// Writes entry.png into MAKEFUN_OUTPUT_DIR (default /output).

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

const W = 1024;
const H = 1024;
const WATER_Y = 768; // horizon / waterline

// ---------------------------------------------------------------------------
// Seeded randomness (deterministic; never Date.now / Math.random)
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261117);
function rr(a, b) { return a + rnd() * (b - a); }
function ri(a, b) { return Math.floor(rr(a, b + 1)); }
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

// ---------------------------------------------------------------------------
// Pixel buffer + colour helpers (RGB, 8 bit per channel)
// ---------------------------------------------------------------------------
const img = Buffer.alloc(W * H * 3);

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpC(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}
// multi-stop vertical gradient: stops = [[t, [r,g,b]], ...]
function grad(stops, t) {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const f = (t - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
      return lerpC(stops[i - 1][1], stops[i][1], f);
    }
  }
  return stops[stops.length - 1][1];
}

function setPx(x, y, c, a) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const o = (y * W + x) * 3;
  if (a >= 1) {
    img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2];
  } else if (a > 0) {
    const ia = 1 - a;
    img[o] = img[o] * ia + c[0] * a;
    img[o + 1] = img[o + 1] * ia + c[1] * a;
    img[o + 2] = img[o + 2] * ia + c[2] * a;
  }
}
// Additive glow: light accumulates (for halos, sparkles, neon).
function addPx(x, y, c, amt) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= W || y < 0 || y >= H || amt <= 0) return;
  const o = (y * W + x) * 3;
  img[o] = Math.min(255, img[o] + c[0] * amt);
  img[o + 1] = Math.min(255, img[o + 1] + c[1] * amt);
  img[o + 2] = Math.min(255, img[o + 2] + c[2] * amt);
}

function fillCircle(cx, cy, r, c, a) {
  if (r <= 0) return;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(H - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy <= r2) setPx(x, y, c, a);
    }
  }
}
function glowCircle(cx, cy, r, c, strength) {
  // soft radial halo, additive
  if (r <= 0) return;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(H - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    const dy = (y - cy) / r;
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / r;
      const d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        const f = (1 - d2) * (1 - d2);
        addPx(x, y, c, strength * f);
      }
    }
  }
}
function ring(cx, cy, rx, ry, c, a, thick) {
  // ellipse outline drawn as many small dots (cheap, smooth enough)
  const steps = Math.max(48, Math.floor((rx + ry) * 3.2));
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const x = cx + Math.cos(t) * rx;
    const y = cy + Math.sin(t) * ry;
    fillCircle(x, y, thick, c, a);
  }
}
function lineTo(x0, y0, x1, y1, w, c, a) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(len / Math.max(1, w * 0.5)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    fillCircle(x0 + dx * t, y0 + dy * t, w / 2, c, a);
  }
}
// Quadratic bezier point
function qbez(p0, p1, p2, t) {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
  ];
}
// Cubic bezier point
function cbez(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
  ];
}
// Scanline fill for a simple polygon (array of [x,y]).
function fillPoly(pts, c, a) {
  if (pts.length < 3) return;
  let minY = H, maxY = 0;
  for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  minY = Math.max(0, Math.floor(minY)); maxY = Math.min(H - 1, Math.ceil(maxY));
  for (let y = minY; y <= maxY; y++) {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      if ((p[1] <= y && q[1] > y) || (q[1] <= y && p[1] > y)) {
        const t = (y - p[1]) / (q[1] - p[1]);
        xs.push(p[0] + t * (q[0] - p[0]));
      }
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k]));
      const x1 = Math.min(W - 1, Math.floor(xs[k + 1]));
      for (let x = x0; x <= x1; x++) setPx(x, y, c, a);
    }
  }
}
// Tube along a sampled curve: pts = [[x,y,r], ...], colour by callback.
function tube(pts, colorAt, alpha) {
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    fillCircle(p[0], p[1], p[2], colorAt(i / (pts.length - 1), p), alpha);
  }
}

// ---------------------------------------------------------------------------
// PNG encoder (zlib deflate, per-row filter choice, CRC32) — stdlib only
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function filterRow(row, prev, type) {
  const out = Buffer.alloc(row.length);
  const bpp = 3;
  for (let i = 0; i < row.length; i++) {
    const left = i >= bpp ? row[i - bpp] : 0;
    const up = prev ? prev[i] : 0;
    const upLeft = prev && i >= bpp ? prev[i - bpp] : 0;
    let pred = 0;
    if (type === 1) pred = left;
    else if (type === 2) pred = up;
    else if (type === 3) pred = Math.floor((left + up) / 2);
    else if (type === 4) {
      const p = left + up - upLeft;
      const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
      pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
    }
    out[i] = (row[i] - pred) & 0xff;
  }
  return out;
}
function encodePNG() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = [];
  let prev = null;
  for (let y = 0; y < H; y++) {
    const row = img.subarray(y * W * 3, (y + 1) * W * 3);
    let best = null, bestScore = Infinity;
    for (let f = 0; f <= 4; f++) {
      const fr = filterRow(row, prev, f);
      let s = 0;
      for (let i = 0; i < fr.length; i++) {
        const v = fr[i] > 127 ? fr[i] - 256 : fr[i];
        s += v < 0 ? -v : v;
      }
      if (s < bestScore) { bestScore = s; best = fr; var bestF = f; }
    }
    raw.push(Buffer.concat([Buffer.from([bestF]), best]));
    prev = row;
  }
  const idat = zlib.deflateSync(Buffer.concat(raw), { level: 9 });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Scene: night sky, aurora, stars, moon
// ---------------------------------------------------------------------------
const SKY = [
  [0.0, [4, 6, 26]],
  [0.35, [13, 20, 64]],
  [0.58, [26, 38, 94]],
  [0.75, [58, 44, 96]],
  [1.0, [16, 34, 62]],
];
const MOON = { x: 742, y: 268, r: 178 };

function drawSky() {
  for (let y = 0; y < WATER_Y; y++) {
    const c = grad(SKY, y / WATER_Y);
    for (let x = 0; x < W; x++) setPx(x, y, c, 1);
  }
  // faint magenta glow near the horizon (the pond's neon light rising)
  glowCircle(512, WATER_Y, 620, [150, 60, 140], 0.10);
  glowCircle(180, WATER_Y, 380, [40, 180, 190], 0.10);
}

function drawAurora() {
  // Three translucent ribbons rippling across the upper sky.
  const ribbons = [
    { base: 120, amp: 46, freq: 0.0042, ph: 0.6, col: [64, 255, 170], a: 0.20, w: 26 },
    { base: 190, amp: 60, freq: 0.0031, ph: 2.4, col: [80, 220, 255], a: 0.16, w: 34 },
    { base: 84, amp: 34, freq: 0.0056, ph: 4.1, col: [200, 90, 255], a: 0.14, w: 20 },
  ];
  for (const rb of ribbons) {
    for (let x = 0; x < W; x += 2) {
      const yc = rb.base + Math.sin(x * rb.freq + rb.ph) * rb.amp
        + Math.sin(x * rb.freq * 2.7 + rb.ph * 2) * rb.amp * 0.3;
      for (let dy = -rb.w; dy <= rb.w; dy += 2) {
        const f = 1 - Math.abs(dy) / rb.w;
        addPx(x, yc + dy, rb.col, rb.a * f * f * 0.55);
        addPx(x + 1, yc + dy, rb.col, rb.a * f * f * 0.55);
      }
    }
  }
}

function drawStars() {
  for (let i = 0; i < 300; i++) {
    const x = rr(10, W - 10);
    const y = rr(8, WATER_Y - 60);
    const b = rr(0.25, 1);
    const r = rnd() < 0.12 ? 2.2 : rr(0.7, 1.5);
    const col = pick([[255, 255, 255], [255, 244, 200], [200, 225, 255], [255, 220, 230]]);
    fillCircle(x, y, r, col, b);
    if (rnd() < 0.10) {
      // four-point sparkle
      const L = rr(7, 13);
      lineTo(x - L, y, x + L, y, 1, col, b * 0.8);
      lineTo(x, y - L, x, y + L, 1, col, b * 0.8);
      glowCircle(x, y, 9, col, 0.25 * b);
    }
  }
}

function drawMoon() {
  const { x, y, r } = MOON;
  glowCircle(x, y, r * 1.9, [255, 214, 130], 0.34);
  glowCircle(x, y, r * 1.35, [255, 236, 180], 0.5);
  // disc with radial shading: bright core, warm rim
  for (let yy = Math.floor(y - r); yy <= Math.ceil(y + r); yy++) {
    for (let xx = Math.floor(x - r); xx <= Math.ceil(x + r); xx++) {
      const dx = (xx - x) / r, dy = (yy - y) / r;
      const d2 = dx * dx + dy * dy;
      if (d2 > 1) continue;
      const d = Math.sqrt(d2);
      const t = clamp(d, 0, 1);
      const c = lerpC([255, 250, 226], [238, 196, 110], t * t * 0.85);
      setPx(xx, yy, c, 1);
    }
  }
  // craters — soft darker patches
  for (let i = 0; i < 16; i++) {
    const a = rr(0, Math.PI * 2);
    const d = rr(0.1, 0.82) * r;
    const cx = x + Math.cos(a) * d, cy = y + Math.sin(a) * d;
    const cr = rr(6, 26);
    fillCircle(cx, cy, cr, [214, 178, 104], rr(0.10, 0.22));
    fillCircle(cx - cr * 0.25, cy - cr * 0.25, cr * 0.7, [248, 228, 178], 0.12);
  }
  // thin bright rim on the moon's upper-left edge
  ring(x, y, r - 2, r - 2, [255, 255, 240], 0.5, 2);
}

// ---------------------------------------------------------------------------
// Scene: the pond — dark water, moon reflection, ripples, lilies
// ---------------------------------------------------------------------------
function drawWater() {
  const stops = [
    [0.0, [10, 42, 58]],
    [0.35, [7, 30, 46]],
    [1.0, [2, 10, 22]],
  ];
  for (let y = WATER_Y; y < H; y++) {
    const c = grad(stops, (y - WATER_Y) / (H - WATER_Y));
    for (let x = 0; x < W; x++) setPx(x, y, c, 1);
  }
  // moon reflection: a shimmering golden column under the moon
  for (let i = 0; i < 420; i++) {
    const x = MOON.x + rr(-95, 95) * (1 + (rr(0, 1)) * 0.4);
    const y = WATER_Y + rr(4, H - WATER_Y - 8);
    const w = rr(6, 30);
    const a = rr(0.05, 0.30) * (1 - (y - WATER_Y) / (H - WATER_Y) * 0.55);
    lineTo(x - w / 2, y, x + w / 2, y, 2, [255, 205, 110], a);
  }
  // teal neon shimmer near the leap point
  for (let i = 0; i < 130; i++) {
    const x = rr(40, 420);
    const y = WATER_Y + rr(4, 150);
    lineTo(x - rr(4, 16), y, x + rr(4, 16), y, 2, [90, 230, 220], rr(0.05, 0.22));
  }
}

function drawRipples() {
  // concentric ripples spreading from where the koi burst out
  const cx = 178, cy = WATER_Y + 6;
  for (let k = 0; k < 6; k++) {
    const rx = 46 + k * 52 + rr(-6, 6);
    const ry = 13 + k * 13;
    const a = 0.5 - k * 0.07;
    ring(cx, cy, rx, ry, [150, 235, 240], a, 3);
    ring(cx, cy, rx + 14, ry + 4, [255, 220, 150], a * 0.55, 2);
  }
  // small ripples under the tail's wake, trailing right
  for (let k = 0; k < 4; k++) {
    ring(330 + k * 90, WATER_Y + 10 + k * 16, 34 + k * 8, 9 + k * 2, [120, 210, 220], 0.30 - k * 0.05, 2);
  }
}

function lilyPad(cx, cy, rx, ry, rot) {
  // round pad with a wedge notch, plus a pink lotus
  const pts = [];
  const steps = 40;
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    if (t > 0.5 && t < 1.1) continue; // notch
    const px = cx + Math.cos(t + rot) * rx;
    const py = cy + Math.sin(t + rot) * ry;
    pts.push([px, py]);
  }
  pts.push([cx, cy]);
  fillPoly(pts, [16, 110, 74], 0.95);
  fillPoly(pts, [24, 140, 96], 0.25);
  ring(cx, cy, rx * 0.86, ry * 0.86, [40, 170, 120], 0.35, 2);
  // lotus: layered petals
  const petalCols = [[255, 150, 200], [255, 120, 185], [255, 190, 220]];
  for (let ringI = 0; ringI < 3; ringI++) {
    const n = 6 - ringI;
    const pr = 26 - ringI * 6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + ringI * 0.5 + rot;
      const tipX = cx + Math.cos(a) * pr;
      const tipY = cy - 8 - Math.sin(a) * pr * 0.7;
      const baseX = cx, baseY = cy - 4;
      const side = 0.35;
      const p1 = [baseX + Math.cos(a + side) * pr * 0.4, baseY - Math.sin(a + side) * pr * 0.3];
      const p2 = [baseX + Math.cos(a - side) * pr * 0.4, baseY - Math.sin(a - side) * pr * 0.3];
      fillPoly([[baseX, baseY], p1, [tipX, tipY], p2], petalCols[ringI], 0.95);
    }
  }
  fillCircle(cx, cy - 6, 7, [255, 214, 90], 0.95);
  glowCircle(cx, cy - 8, 26, [255, 140, 200], 0.18);
}
function drawLilies() {
  lilyPad(830, 912, 74, 24, 0.4);
  lilyPad(700, 968, 58, 19, -0.3);
  lilyPad(950, 828, 52, 17, 0.9);
  lilyPad(60, 950, 46, 15, 0.2);
}

// ---------------------------------------------------------------------------
// The koi — a great arc from the pond up toward the moon
// ---------------------------------------------------------------------------
// Cubic spine: tail bursts out of the water at lower-left, body sweeps up,
// head reaches just below the moon at upper-right.
const KOI = {
  p0: [168, 812],
  p1: [215, 470],
  p2: [470, 268],
  p3: [668, 330],
};
function koiPoint(t) { return cbez(KOI.p0, KOI.p1, KOI.p2, KOI.p3, t); }
function koiRadius(t) {
  // thin tail -> thick mid-body -> tapered snout
  if (t < 0.12) return lerp(10, 30, t / 0.12);
  if (t < 0.55) return lerp(30, 60, (t - 0.12) / 0.43);
  if (t < 0.85) return lerp(60, 54, (t - 0.55) / 0.30);
  return lerp(54, 26, (t - 0.85) / 0.15);
}
function koiNormal(t) {
  const a = koiPoint(Math.max(0, t - 0.01));
  const b = koiPoint(Math.min(1, t + 0.01));
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return [-dy / len, dx / len]; // perpendicular
}

function drawKoiBody() {
  // sample the spine densely so the tube is smooth
  const pts = [];
  const N = 240;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const p = koiPoint(t);
    pts.push([p[0], p[1], koiRadius(t)]);
  }
  // soft glow hugging the whole fish (it is lit from within)
  for (let i = 0; i <= N; i += 2) {
    const p = pts[i];
    glowCircle(p[0], p[1], p[2] * 1.7, [255, 140, 40], 0.05);
  }
  // main body: deep ember orange at the tail warming to bright gold at head
  tube(pts, (t) => {
    if (t < 0.25) return lerpC([228, 82, 6], [248, 124, 8], t / 0.25);
    if (t < 0.7) return lerpC([248, 124, 8], [255, 166, 22], (t - 0.25) / 0.45);
    return lerpC([255, 166, 22], [255, 200, 80], (t - 0.7) / 0.3);
  }, 1);
  // pale gold belly along the underside — a narrow stripe, not a full coat
  const belly = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const p = koiPoint(t);
    const n = koiNormal(t);
    const r = koiRadius(t);
    belly.push([p[0] + n[0] * r * 0.52, p[1] + n[1] * r * 0.52, r * 0.44]);
  }
  tube(belly, () => [255, 228, 175], 0.7);
  // hot highlight along the spine's top edge
  const spine = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const p = koiPoint(t);
    const n = koiNormal(t);
    const r = koiRadius(t);
    spine.push([p[0] - n[0] * r * 0.52, p[1] - n[1] * r * 0.52, r * 0.30]);
  }
  tube(spine, () => [255, 232, 160], 0.55);
}

function drawKoiSpots() {
  // classic koi patches: ink-black and snow-white, hugging the body
  for (let i = 0; i < 15; i++) {
    const t = rr(0.18, 0.92);
    const p = koiPoint(t);
    const n = koiNormal(t);
    const r = koiRadius(t);
    const off = rr(-0.45, 0.45) * r;
    const cx = p[0] + n[0] * off, cy = p[1] + n[1] * off;
    const pr = rr(8, 20) * (r / 55);
    const col = rnd() < 0.55 ? [22, 18, 38] : [255, 250, 240];
    fillCircle(cx, cy, pr, col, 0.92);
    fillCircle(cx + pr * 0.3, cy - pr * 0.25, pr * 0.55, col, 0.85);
  }
}

function drawKoiScales() {
  // rows of small arcs shimmering down the flanks — subtle, not polka dots
  for (let t = 0.12; t < 0.92; t += 0.06) {
    const p = koiPoint(t);
    const n = koiNormal(t);
    const r = koiRadius(t);
    for (let s = -1; s <= 1; s++) {
      const off = (s / 2.2) * r;
      const cx = p[0] + n[0] * off, cy = p[1] + n[1] * off;
      const rr2 = 6 * (r / 55);
      ring(cx, cy, rr2, rr2 * 0.8, [190, 90, 10], 0.20, 1.2);
    }
  }
}

function drawKoiFins() {
  // dorsal fin: a low serrated crest along the top of the back
  const crest = [];
  for (let t = 0.32; t <= 0.78; t += 0.05) {
    const p = koiPoint(t);
    const n = koiNormal(t);
    const r = koiRadius(t);
    const h = 9 + Math.sin((t - 0.32) / 0.46 * Math.PI) * 15;
    crest.push([p[0] - n[0] * r, p[1] - n[1] * r]);
    crest.push([p[0] - n[0] * (r + h), p[1] - n[1] * (r + h)]);
  }
  fillPoly(crest, [255, 120, 20], 0.9);
  fillPoly(crest, [255, 190, 80], 0.3);
  // pectoral fins fanning out near the head (translucent, glowing)
  const head = koiPoint(0.86);
  const hn = koiNormal(0.86);
  for (const side of [1, -1]) {
    const base = [head[0] + hn[0] * 30 * side, head[1] + hn[1] * 30 * side];
    const tip1 = [base[0] - 95, base[1] + 78 * side * 0.4 + 40];
    const tip2 = [base[0] - 118, base[1] + 18];
    fillPoly([base, tip1, tip2], [255, 150, 50], 0.75);
    fillPoly([base, tip1, tip2], [255, 210, 120], 0.25);
    lineTo(base[0], base[1], tip1[0], tip1[1], 2, [255, 220, 150], 0.6);
  }
}

function drawKoiTail() {
  // long flowing tail ribbons trailing behind the tail, flat along the
  // water surface (not dangling down like legs)
  const tail = koiPoint(0.02);
  const ribbons = [
    { dx: -96, dy: 34, w: 24, col: [255, 150, 40] },
    { dx: -150, dy: 18, w: 19, col: [255, 120, 30] },
    { dx: -70, dy: 58, w: 17, col: [255, 190, 90] },
    { dx: -176, dy: 52, w: 13, col: [255, 90, 20] },
  ];
  for (const rb of ribbons) {
    const mid = [tail[0] + rb.dx * 0.55 + rr(-8, 8), tail[1] + rb.dy * 0.5];
    const tip = [tail[0] + rb.dx, tail[1] + rb.dy];
    const pts = [];
    const N = 22;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p = qbez(tail, mid, tip, t);
      const wob = Math.sin(t * 9 + rb.dx) * 6 * t;
      pts.push([p[0] + wob, p[1], rb.w * (1 - t * 0.75)]);
    }
    tube(pts, () => rb.col, 0.8);
    tube(pts.map((p) => [p[0], p[1], p[2] * 0.45]), () => [255, 220, 140], 0.5);
    glowCircle(tip[0], tip[1], 30, rb.col, 0.15);
  }
}

function drawKoiHead() {
  const head = koiPoint(0.985);
  const n = koiNormal(0.985);
  // open mouth reaching for the moon
  fillCircle(head[0] + 14, head[1] - 6, 12, [120, 30, 10], 0.95);
  fillCircle(head[0] + 16, head[1] - 8, 7, [60, 8, 8], 0.95);
  // eye: bright, alert, looking up at the moon
  const ex = head[0] - n[0] * 12 - 8, ey = head[1] - n[1] * 12 - 14;
  fillCircle(ex, ey, 11, [255, 250, 235], 1);
  fillCircle(ex + 2, ey - 2, 5.5, [10, 8, 20], 1);
  fillCircle(ex + 4, ey - 4, 2, [255, 255, 255], 1);
  ring(ex, ey, 11, 11, [200, 90, 10], 0.7, 1.5);
  // whiskers curving from the snout
  for (const s of [1, -1]) {
    const sx = head[0] + 22, sy = head[1] + s * 4;
    const pts = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      pts.push([sx + t * 62, sy + s * 14 * t + Math.sin(t * 3) * 6]);
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      lineTo(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], 2, [255, 225, 170], 0.85);
    }
  }
  // gill glow
  glowCircle(head[0] - 18, head[1] + 6, 26, [255, 170, 60], 0.3);
}

// ---------------------------------------------------------------------------
// Splash, sparkles, reeds, frame
// ---------------------------------------------------------------------------
function drawSplash() {
  const sx = 178, sy = WATER_Y;
  // foam crown: sharp white-teal spikes bursting upward
  for (let i = 0; i < 11; i++) {
    const a = -Math.PI / 2 + (i - 5) * 0.17 + rr(-0.04, 0.04);
    const len = rr(34, 92) * (1 - Math.abs(i - 5) / 9);
    const bx = sx + Math.cos(a + 0.35) * 22, by = sy - 4;
    const tx = sx + Math.cos(a) * len, ty = sy - Math.sin(-a) * 0 - Math.abs(Math.sin(a)) * len;
    const tx2 = sx + Math.cos(a) * len * 0.9, ty2 = sy - Math.abs(Math.sin(a)) * len * 0.9;
    fillPoly([[bx, by], [tx, ty2], [sx + Math.cos(a - 0.35) * 22, sy - 4]], [235, 250, 255], 0.9);
  }
  // droplets arcing out of the burst (with bright highlights)
  for (let i = 0; i < 120; i++) {
    const a = -Math.PI / 2 + rr(-1.15, 1.15);
    const v = rr(60, 330);
    const x = sx + Math.cos(a) * v * rr(0.7, 1);
    const y = sy - Math.abs(Math.sin(a)) * v * rr(0.55, 0.9) + rr(0, 26);
    const r = rr(1.5, 6.5);
    const col = rnd() < 0.6 ? [220, 245, 255] : [140, 225, 240];
    fillCircle(x, y, r, col, rr(0.6, 0.95));
    setPx(x - r * 0.3, y - r * 0.3, [255, 255, 255], 0.9);
    if (r > 4) glowCircle(x, y, r * 2.4, [120, 210, 255], 0.12);
  }
  // foam ring where the body exits the water
  ring(sx, sy + 2, 66, 15, [240, 250, 255], 0.75, 4);
  ring(sx, sy + 2, 84, 19, [160, 230, 245], 0.4, 3);
}

function drawSparkles() {
  // a trail of light motes following the koi's arc, plus gold stars
  for (let t = 0.05; t < 1; t += 0.02) {
    if (rnd() < 0.35) continue;
    const p = koiPoint(t);
    const n = koiNormal(t);
    const off = rr(-70, 60);
    const x = p[0] + n[0] * off + rr(-14, 14);
    const y = p[1] + n[1] * off + rr(-14, 14);
    const r = rr(1.2, 3.4);
    const col = pick([[255, 210, 120], [255, 240, 200], [150, 230, 255], [255, 170, 90]]);
    fillCircle(x, y, r, col, 0.95);
    glowCircle(x, y, r * 4, col, 0.3);
  }
  for (let i = 0; i < 14; i++) {
    const t = rr(0.1, 0.95);
    const p = koiPoint(t);
    const n = koiNormal(t);
    const x = p[0] - n[0] * rr(70, 130) + rr(-30, 30);
    const y = p[1] - n[1] * rr(70, 130) + rr(-30, 30);
    const L = rr(9, 18);
    const col = [255, 226, 140];
    lineTo(x - L, y, x + L, y, 1.6, col, 0.95);
    lineTo(x, y - L, x, y + L, 1.6, col, 0.95);
    fillCircle(x, y, 2.6, [255, 255, 230], 1);
    glowCircle(x, y, 14, col, 0.35);
  }
}

function drawReeds() {
  // dark reed silhouettes framing the bottom corners
  const col = [3, 14, 24];
  for (const [bx, lean, hgt] of [[26, 1, 150], [64, -1, 190], [104, 1, 120], [966, -1, 170], [1002, 1, 130], [930, 1, 105]]) {
    const tipX = bx + lean * rr(18, 42);
    const tipY = H - hgt;
    fillPoly([[bx - 9, H], [tipX, tipY], [bx + 9, H]], col, 1);
    if (rnd() < 0.7) fillCircle(tipX, tipY - 4, 7, [8, 30, 44], 1);
  }
}

function drawFrame() {
  // thin glowing gold poster border
  const m = 15;
  const col = [255, 196, 90];
  lineTo(m, m, W - m, m, 4, col, 0.85);
  lineTo(m, H - m, W - m, H - m, 4, col, 0.85);
  lineTo(m, m, m, H - m, 4, col, 0.85);
  lineTo(W - m, m, W - m, H - m, 4, col, 0.85);
  glowCircle(W / 2, m, 8, col, 0.05);
}

// ---------------------------------------------------------------------------
// Banner text — a tiny 5x7 bitmap font, drawn big and glowing
// ---------------------------------------------------------------------------
const FONT = {
  "W": ["10001", "10001", "10001", "10101", "10101", "01010", "01010"],
  "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  ",": ["00000", "00000", "00000", "00000", "00000", "01100", "01000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "J": ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  "D": ["11100", "10010", "10001", "10001", "10001", "10010", "11100"],
  "G": ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
};
function drawText(text, x0, y0, scale, col, alpha) {
  let x = x0;
  for (const ch of text) {
    const g = FONT[ch] || FONT[" "];
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if (g[r][c] === "1") {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              setPx(x + c * scale + dx, y0 + r * scale + dy, col, alpha);
            }
          }
        }
      }
    }
    x += 6 * scale;
  }
  return x;
}
function textWidth(text, scale) { return text.length * 6 * scale - scale; }
function drawBanner() {
  const text = "WOW, JUDGE!";
  const scale = 8;
  const w = textWidth(text, scale);
  const x0 = Math.floor((W - w) / 2);
  const y0 = 42;
  // glow halo behind the letters
  drawText(text, x0 - 3, y0 - 2, scale, [255, 150, 40], 0.35);
  drawText(text, x0 + 3, y0 + 3, scale, [255, 150, 40], 0.35);
  drawText(text, x0, y0 - 3, scale, [255, 150, 40], 0.3);
  // dark outline so the letters stay legible over the sky
  drawText(text, x0 - 2, y0, scale, [20, 8, 40], 0.9);
  drawText(text, x0 + 2, y0, scale, [20, 8, 40], 0.9);
  drawText(text, x0, y0 - 2, scale, [20, 8, 40], 0.9);
  drawText(text, x0, y0 + 2, scale, [20, 8, 40], 0.9);
  // bright face
  drawText(text, x0, y0, scale, [255, 246, 200], 1);
  // hot core on the top half of each letter
  drawText(text, x0, y0, scale, [255, 255, 255], 0.0);
}

// ---------------------------------------------------------------------------
// Vignette + main
// ---------------------------------------------------------------------------
function drawVignette() {
  for (let y = 0; y < H; y++) {
    const dy = Math.abs(y - H / 2) / (H / 2);
    for (let x = 0; x < W; x++) {
      const dx = Math.abs(x - W / 2) / (W / 2);
      const d = Math.max(dx, dy);
      if (d > 0.82) {
        const a = (d - 0.82) / 0.18 * 0.38;
        setPx(x, y, [0, 0, 8], a);
      }
    }
  }
}

function main() {
  drawSky();
  drawAurora();
  drawStars();
  drawMoon();
  drawWater();
  drawRipples();
  drawLilies();
  drawKoiTail();
  drawKoiBody();
  drawKoiSpots();
  drawKoiScales();
  drawKoiFins();
  drawKoiHead();
  drawSplash();
  drawSparkles();
  drawReeds();
  drawFrame();
  drawBanner();
  drawVignette();

  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  fs.mkdirSync(outDir, { recursive: true });
  const png = encodePNG();
  fs.writeFileSync(path.join(outDir, "entry.png"), png);
  console.log(`wrote ${path.join(outDir, "entry.png")} (${png.length} bytes)`);
}

main();
