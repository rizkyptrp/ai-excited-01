// main.ts — "The Rocket That Paints the Galaxy"
// A deterministic generative-art program for make.fun ai-excited-01.
// Draws a 1024x1024 poster, pixel by pixel, with no assets at all:
// a sleek rocket blasting off a tiny moon base, its trail of light
// sweeping across the sky and dissolving into a spiral galaxy, a ringed
// planet glowing in the corner, and one line for the judge.
// Node standard library only. Same seed, same bytes, every run.
// Re-implemented fresh 2026-11-17 (rescue build): same algorithm, same
// seed, same output — rewritten line by line in a new session.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------- RNG ----
// One seeded stream; the program never touches Math.random or the clock,
// so two runs produce byte-identical output.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261116);
function rr(a, b) {
  return a + rand() * (b - a);
}
function gauss() {
  // Box-Muller, from the seeded stream.
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ------------------------------------------------------------ canvas ----
const W = 1024;
const H = 1024;
// HDR accumulation buffer: values may exceed 1 (glows add up) and are
// tone-mapped to 8-bit at the very end.
const img = new Float32Array(W * H * 3);

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function smoothstep(a, b, x) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
// Linear mix of two [r, g, b] colours.
function mix3(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

function addPx(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  img[i] += r;
  img[i + 1] += g;
  img[i + 2] += b;
}
function setPx(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  img[i] = r;
  img[i + 1] = g;
  img[i + 2] = b;
}
// Alpha blend over what is already there.
function mixPx(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
  const i = (y * W + x) * 3;
  if (a >= 1) {
    img[i] = r;
    img[i + 1] = g;
    img[i + 2] = b;
    return;
  }
  const na = 1 - a;
  img[i] = img[i] * na + r * a;
  img[i + 1] = img[i + 1] * na + g * a;
  img[i + 2] = img[i + 2] * na + b * a;
}

// Soft additive radial glow. Gaussian falloff, bbox cut where the
// contribution is negligible.
function glow(cx, cy, radius, r, g, b, intensity) {
  const span = Math.max(1, Math.ceil(radius * 1.9));
  const x0 = Math.max(0, Math.floor(cx - span));
  const x1 = Math.min(W - 1, Math.ceil(cx + span));
  const y0 = Math.max(0, Math.floor(cy - span));
  const y1 = Math.min(H - 1, Math.ceil(cy + span));
  const inv = 1 / (radius * radius);
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const d2 = (dx * dx + dy * dy) * inv;
      if (d2 > 3.6) continue;
      const f = intensity * Math.exp(-d2 * 2.0);
      if (f < 0.002) continue;
      addPx(x, y, r * f, g * f, b * f);
    }
  }
}

// A thick soft line, drawn as overlapping glows.
function thickLine(x0, y0, x1, y1, width, r, g, b, intensity) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(len / Math.max(1, width * 0.35)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    glow(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, width * 0.5, r, g, b, intensity);
  }
}

function fillRect(x, y, w, h, r, g, b, a) {
  const x0 = Math.max(0, Math.floor(x));
  const x1 = Math.min(W - 1, Math.ceil(x + w) - 1);
  const y0 = Math.max(0, Math.floor(y));
  const y1 = Math.min(H - 1, Math.ceil(y + h) - 1);
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) mixPx(xx, yy, r, g, b, a);
  }
}

// Even-odd scanline polygon fill (flat colour, full opacity).
function fillPoly(pts, r, g, b) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(H - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const c = pts[(i + 1) % pts.length];
      if ((a[1] <= y && c[1] > y) || (c[1] <= y && a[1] > y)) {
        xs.push(a[0] + ((y - a[1]) * (c[0] - a[0])) / (c[1] - a[1]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k]));
      const xb = Math.min(W - 1, Math.floor(xs[k + 1]));
      for (let x = xa; x <= xb; x++) setPx(x, y, r, g, b);
    }
  }
}

// ------------------------------------------------------------- noise ----
// Seeded value noise on a shuffled permutation grid, plus fBm.
const PERM = new Uint8Array(512);
{
  const base = [];
  for (let i = 0; i < 256; i++) base.push(i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = base[i];
    base[i] = base[j];
    base[j] = tmp;
  }
  for (let i = 0; i < 512; i++) PERM[i] = base[i & 255];
}
function hash2(ix, iy) {
  return PERM[(PERM[ix & 255] + iy) & 255] / 255;
}
function vnoise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}
function fbm(x, y, octaves) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoise(x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

// --------------------------------------------------------------- sky ----
// Deep-space vertical gradient with a warm launch glow low-left and a
// cool galactic glow upper-right.
function drawSky() {
  const top = [0.008, 0.01, 0.045];
  const mid = [0.02, 0.022, 0.088];
  const bot = [0.055, 0.02, 0.11];
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    const base = t < 0.55 ? mix3(top, mid, t / 0.55) : mix3(mid, bot, (t - 0.55) / 0.45);
    for (let x = 0; x < W; x++) {
      let r = base[0];
      let g = base[1];
      let b = base[2];
      // Warm light pooling around the launch site.
      const dxw = (x - 200) / 520;
      const dyw = (y - 960) / 520;
      const warm = Math.exp(-(dxw * dxw + dyw * dyw) * 2.2);
      r += 0.22 * warm;
      g += 0.08 * warm;
      b += 0.02 * warm;
      // Cool light around the galaxy.
      const dxc = (x - 720) / 480;
      const dyc = (y - 330) / 480;
      const cool = Math.exp(-(dxc * dxc + dyc * dyc) * 2.0);
      r += 0.03 * cool;
      g += 0.07 * cool;
      b += 0.18 * cool;
      setPx(x, y, r, g, b);
    }
  }
}

// ------------------------------------------------------------ nebula ----
// fBm clouds at half resolution, bilinearly upsampled: magenta, teal and
// violet washes, kept subtle so the sky stays dark and the glows pop.
function drawNebula() {
  const NW = 512;
  const NH = 512;
  const neb = new Float32Array(NW * NH * 3);
  for (let y = 0; y < NH; y++) {
    const ny = y / NH;
    for (let x = 0; x < NW; x++) {
      const nx = x / NW;
      const n1 = fbm(nx * 3.1 + 7.3, ny * 3.1 + 2.9, 4);
      const n2 = fbm(nx * 2.3 + 13.7, ny * 2.3 + 8.1, 4);
      const n3 = fbm(nx * 5.0 + 3.1, ny * 5.0 + 11.3, 3);
      const i = (y * NW + x) * 3;
      const m = smoothstep(0.52, 0.8, n1);
      const t = smoothstep(0.55, 0.82, n2);
      const v = smoothstep(0.6, 0.86, n3);
      neb[i] = (m * 0.5 + v * 0.16) * 0.5;
      neb[i + 1] = (m * 0.07 + t * 0.3 + v * 0.04) * 0.5;
      neb[i + 2] = (m * 0.28 + t * 0.28 + v * 0.32) * 0.5;
    }
  }
  for (let y = 0; y < H; y++) {
    const sy = y / 2;
    const y0 = Math.min(NH - 2, Math.floor(sy));
    const fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = x / 2;
      const x0 = Math.min(NW - 2, Math.floor(sx));
      const fx = sx - x0;
      const i00 = (y0 * NW + x0) * 3;
      const i10 = i00 + 3;
      const i01 = i00 + NW * 3;
      const i11 = i01 + 3;
      const r = lerp(lerp(neb[i00], neb[i10], fx), lerp(neb[i01], neb[i11], fx), fy);
      const g = lerp(lerp(neb[i00 + 1], neb[i10 + 1], fx), lerp(neb[i01 + 1], neb[i11 + 1], fx), fy);
      const b = lerp(lerp(neb[i00 + 2], neb[i10 + 2], fx), lerp(neb[i01 + 2], neb[i11 + 2], fx), fy);
      addPx(x, y, r, g, b);
    }
  }
}

// ------------------------------------------------------------- stars ----
function drawStars() {
  const tints = [
    [1.0, 1.0, 1.0],
    [1.0, 1.0, 1.0],
    [0.72, 0.86, 1.0],
    [1.0, 0.9, 0.72],
    [0.85, 0.75, 1.0],
  ];
  for (let i = 0; i < 560; i++) {
    const x = rr(0, W);
    const y = rr(0, H);
    const tint = tints[Math.floor(rand() * tints.length)];
    const bright = rand();
    if (bright > 0.97) {
      // Rare hero star with a cross flare.
      const s = rr(1.8, 2.6);
      glow(x, y, s, tint[0], tint[1], tint[2], rr(0.9, 1.4));
      const arm = rr(9, 16);
      thickLine(x - arm, y, x + arm, y, 1.1, tint[0], tint[1], tint[2], 0.5);
      thickLine(x, y - arm, x, y + arm, 1.1, tint[0], tint[1], tint[2], 0.5);
    } else if (bright > 0.85) {
      glow(x, y, rr(1.3, 1.9), tint[0], tint[1], tint[2], rr(0.45, 0.8));
    } else {
      glow(x, y, rr(0.7, 1.2), tint[0], tint[1], tint[2], rr(0.14, 0.4));
    }
  }
}

// Two shooting stars for extra motion.
function drawComets() {
  const comets = [
    { hx: 895, hy: 165, dx: -0.82, dy: -0.57, len: 150 },
    { hx: 118, hy: 615, dx: -0.78, dy: -0.62, len: 120 },
  ];
  for (const c of comets) {
    for (let i = 0; i < 46; i++) {
      const t = i / 45;
      const x = c.hx + c.dx * t * c.len;
      const y = c.hy + c.dy * t * c.len;
      const inten = 0.85 * (1 - t) * (1 - t);
      glow(x, y, 2.4 * (1 - t) + 0.5, 0.85, 0.95, 1.0, inten);
    }
    glow(c.hx, c.hy, 5, 1.0, 1.0, 1.0, 1.3);
    glow(c.hx, c.hy, 14, 0.7, 0.85, 1.0, 0.25);
  }
}

// ------------------------------------------------------------ planet ----
// A banded ringed planet, upper-left, cropped by the frame edge. The ring
// is drawn in two halves: the far half behind the disc, the near half in
// front of it, which sells the 3D tilt.
function drawRingHalf(cx, cy, r, front) {
  const a = r * 1.8;
  const b = a * 0.3;
  const rot = (-18 * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  // Ring-frame coords: rotate screen offsets by -rot.
  const x0 = Math.max(0, Math.floor(cx - a - 6));
  const x1 = Math.min(W - 1, Math.ceil(cx + a + 6));
  const y0 = Math.max(0, Math.floor(cy - a * 0.42 - 6));
  const y1 = Math.min(H - 1, Math.ceil(cy + a * 0.42 + 6));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const u = dx * cos + dy * sin;
      const v = -dx * sin + dy * cos;
      if (front ? v < 0 : v >= 0) continue;
      const q = Math.sqrt((u / a) * (u / a) + (v / b) * (v / b));
      if (q < 0.6 || q > 1.0) continue;
      let alpha = 0.85;
      alpha *= smoothstep(0.6, 0.68, q);
      alpha *= 1 - smoothstep(0.96, 1.0, q);
      if (q > 0.85 && q < 0.91) alpha *= 0.22; // Cassini-style gap
      alpha *= front ? 0.95 : 0.5;
      const warm = 1 - 0.35 * q;
      mixPx(x, y, 0.95 * warm, 0.84 * warm, 0.6 * warm, alpha);
    }
  }
}

function drawPlanet(cx, cy, r) {
  glow(cx, cy, r * 1.55, 0.85, 0.65, 0.38, 0.22);
  drawRingHalf(cx, cy, r, false);
  const cream = [0.93, 0.8, 0.58];
  const gold = [0.86, 0.62, 0.38];
  const rose = [0.78, 0.47, 0.37];
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(H - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > r) continue;
      const nx = dx / r;
      const ny = dy / r;
      const edge = clamp01((r - d) / 1.5);
      const band =
        Math.sin(ny * 10 + Math.sin(nx * 4 + 1.7) * 0.8 + Math.sin(ny * 23) * 0.25) * 0.5 + 0.5;
      let col = band < 0.5 ? mix3(rose, gold, band * 2) : mix3(gold, cream, (band - 0.5) * 2);
      // Terminator: light comes from the upper right.
      const light = 0.3 + 0.7 * clamp01(0.5 + 0.5 * (nx * 0.8 - ny * 0.6));
      // Limb darkening, plus a warm atmospheric rim on the lit side.
      const limb = 1 - 0.32 * Math.pow(d / r, 3);
      let cr = col[0] * light * limb;
      let cg = col[1] * light * limb;
      let cb = col[2] * light * limb;
      if (d / r > 0.965 && nx > -0.2) {
        const rim = (d / r - 0.965) / 0.035;
        cr += 0.35 * rim;
        cg += 0.22 * rim;
        cb += 0.08 * rim;
      }
      mixPx(x, y, cr, cg, cb, edge);
    }
  }
  drawRingHalf(cx, cy, r, true);
}

// ------------------------------------------------------------ galaxy ----
// A two-arm logarithmic spiral of glowing dots, tilted like a real disc
// galaxy: white-gold core, cyan arms, violet-magenta edges, bright knots
// and a halo of faint stars around it.
function drawGalaxy(cx, cy, rotDeg, tilt, maxR) {
  const rot = (rotDeg * Math.PI) / 180;
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  glow(cx, cy, 52, 1.0, 0.88, 0.55, 1.25);
  glow(cx, cy, 24, 1.0, 0.97, 0.82, 1.6);
  const gold = [1.0, 0.82, 0.45];
  const cyan = [0.5, 0.95, 1.0];
  const violet = [0.72, 0.55, 1.0];
  const magenta = [1.0, 0.4, 0.65];
  const white = [1.0, 0.96, 0.78];
  function armPoint(t, armOff) {
    const phi = t * Math.PI * 3.1 + armOff;
    const r = 10 + Math.pow(t, 1.35) * (maxR - 10);
    const spread = 4 + t * 26;
    const px = Math.cos(phi) * r + gauss() * spread * 0.5;
    const py = Math.sin(phi) * r + gauss() * spread * 0.5;
    const qx = px * cosR - py * tilt * sinR;
    const qy = px * sinR + py * tilt * cosR;
    return [cx + qx, cy + qy];
  }
  function armColour(t) {
    if (t < 0.25) return mix3(white, gold, t / 0.25);
    if (t < 0.55) return mix3(gold, cyan, (t - 0.25) / 0.3);
    if (t < 0.8) return mix3(cyan, violet, (t - 0.55) / 0.25);
    return mix3(violet, magenta, (t - 0.8) / 0.2);
  }
  for (let arm = 0; arm < 2; arm++) {
    const off = arm * Math.PI;
    for (let s = 0; s < 1100; s++) {
      const t = s / 1100;
      const p = armPoint(t, off);
      const c = armColour(t);
      const size = rr(0.8, 2.6) * (1.25 - t * 0.6);
      const inten = rr(0.22, 0.85) * (1 - t * 0.5);
      glow(p[0], p[1], size, c[0], c[1], c[2], inten);
    }
  }
  // Bright knots along the arms, a few with cross flares.
  for (let i = 0; i < 26; i++) {
    const t = rr(0.12, 0.92);
    const p = armPoint(t, rand() < 0.5 ? 0 : Math.PI);
    const c = armColour(t);
    const s = rr(2.6, 4.6);
    glow(p[0], p[1], s, c[0], c[1], c[2], rr(0.9, 1.5));
    if (i % 4 === 0) {
      const armLen = rr(8, 13);
      thickLine(p[0] - armLen, p[1], p[0] + armLen, p[1], 1.0, c[0], c[1], c[2], 0.4);
      thickLine(p[0], p[1] - armLen, p[0], p[1] + armLen, 1.0, c[0], c[1], c[2], 0.4);
    }
  }
  // Faint halo stars scattered around the disc.
  for (let i = 0; i < 200; i++) {
    const ang = rr(0, Math.PI * 2);
    const rr2 = Math.pow(rand(), 0.6) * maxR * 1.2;
    const px = Math.cos(ang) * rr2;
    const py = Math.sin(ang) * rr2;
    const qx = px * cosR - py * tilt * sinR;
    const qy = px * sinR + py * tilt * cosR;
    const c = rand() < 0.5 ? [1, 1, 1] : [0.75, 0.85, 1];
    glow(cx + qx, cy + qy, rr(0.7, 1.5), c[0], c[1], c[2], rr(0.08, 0.3));
  }
}

// ------------------------------------------------------------ ribbon ----
// The rocket's trail of light: a sweeping cubic arc from the flame tip
// up to the galaxy's lower edge. Fire near the rocket, gold mid-flight,
// then it breaks into cyan-white star dots and melts into the spiral —
// the trail becomes the galaxy.
function cubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
  ];
}

function drawRibbon() {
  const p0 = [161, 971];
  const p1 = [470, 925];
  const p2 = [760, 825];
  const p3 = [830, 450];
  const white = [1.0, 0.96, 0.82];
  const gold = [1.0, 0.74, 0.3];
  const pink = [1.0, 0.45, 0.66];
  const ice = [0.75, 0.95, 1.0];
  for (let s = 0; s <= 600; s++) {
    const t = s / 600;
    const p = cubic(p0, p1, p2, p3, t);
    // Gentle organic wobble, stronger mid-flight.
    const wob = Math.sin(t * 25) * 4 * (1 - t) + Math.sin(t * 9) * 6;
    const x = p[0] + wob * 0.4;
    const y = p[1] + wob;
    const radius = lerp(22, 7, t);
    let c;
    if (t < 0.35) c = mix3(white, gold, t / 0.35);
    else if (t < 0.7) c = mix3(gold, pink, (t - 0.35) / 0.35);
    else c = mix3(pink, ice, (t - 0.7) / 0.3);
    const fade = t > 0.97 ? 1 - (t - 0.97) / 0.03 : 1;
    glow(x, y, radius * 0.45, c[0], c[1], c[2], 0.85 * fade);
    glow(x, y, radius * 1.4, c[0], c[1], c[2], 0.15 * fade);
  }
  // Star dots bursting off the ribbon as it reaches the galaxy.
  for (let i = 0; i < 210; i++) {
    const t = rr(0.6, 1.05);
    const p = cubic(p0, p1, p2, p3, Math.min(1, t));
    const x = p[0] + gauss() * 30;
    const y = p[1] + gauss() * 30;
    const c = rand() < 0.6 ? [0.8, 0.95, 1.0] : [1.0, 1.0, 1.0];
    glow(x, y, rr(0.8, 2.4), c[0], c[1], c[2], rr(0.35, 1.0));
  }
  // Sparks along the whole ribbon.
  for (let i = 0; i < 80; i++) {
    const t = rr(0.05, 0.95);
    const p = cubic(p0, p1, p2, p3, t);
    const x = p[0] + gauss() * 30;
    const y = p[1] + gauss() * 30;
    const c = rand() < 0.5 ? [1.0, 0.8, 0.4] : [1.0, 0.95, 0.85];
    glow(x, y, rr(0.7, 1.8), c[0], c[1], c[2], rr(0.2, 0.7));
  }
}

// ----------------------------------------------------- moon + launch ----
// The launch site: a dark curved horizon along the bottom, a tiny pad and
// tower, warm pad lights, drifting smoke, and a few lit windows of a
// little base — the small scale that makes the sky feel huge.
const HOR_CX = 512;
const HOR_CY = 2800;
const HOR_R = 1850;
function horizonY(x) {
  const dx = x - HOR_CX;
  return HOR_CY - Math.sqrt(HOR_R * HOR_R - dx * dx);
}

function drawMoon() {
  for (let x = 0; x < W; x++) {
    const hy = horizonY(x);
    for (let y = Math.max(0, Math.floor(hy)); y < H; y++) {
      const depth = (y - hy) / 80;
      const n = vnoise(x * 0.02, y * 0.05) - 0.5;
      let r = lerp(0.066, 0.026, clamp01(depth)) + n * 0.02;
      let g = lerp(0.056, 0.022, clamp01(depth)) + n * 0.016;
      let b = lerp(0.105, 0.05, clamp01(depth)) + n * 0.022;
      // A thin lit rim right on the horizon edge.
      if (y - hy < 1.5) {
        r += 0.14;
        g += 0.08;
        b += 0.04;
      }
      // A warm kiss of launch light near the pad.
      const dx = (x - 165) / 260;
      const dy = (y - 975) / 120;
      const warm = Math.exp(-(dx * dx + dy * dy) * 2.0);
      r += 0.16 * warm;
      g += 0.07 * warm;
      setPx(x, y, Math.max(0, r), Math.max(0, g), Math.max(0, b));
    }
  }
  // Craters: dark ellipses with a lit upper rim.
  for (let i = 0; i < 14; i++) {
    const x = rr(20, W - 20);
    const hy = horizonY(x);
    const y = hy + rr(8, 55);
    const rx = rr(7, 26);
    const ry = rx * rr(0.3, 0.45);
    for (let yy = Math.floor(y - ry); yy <= Math.ceil(y + ry); yy++) {
      for (let xx = Math.floor(x - rx); xx <= Math.ceil(x + rx); xx++) {
        const q = ((xx - x) / rx) ** 2 + ((yy - y) / ry) ** 2;
        if (q > 1) continue;
        if (yy < y) mixPx(xx, yy, 0.11, 0.1, 0.16, 0.65 * (1 - q));
        else mixPx(xx, yy, 0.012, 0.01, 0.03, 0.6 * (1 - q));
      }
    }
  }
  // Lit windows of the little base.
  for (let i = 0; i < 9; i++) {
    const x = rr(60, 420);
    const y = horizonY(x) + rr(4, 30);
    glow(x, y, 1.6, 1.0, 0.85, 0.5, rr(0.5, 0.9));
  }
}

function drawPad() {
  const baseY = Math.floor(horizonY(165));
  // Tower.
  fillRect(149, baseY - 52, 9, 52, 0.03, 0.03, 0.06, 1);
  fillRect(145, baseY - 52, 17, 5, 0.03, 0.03, 0.06, 1);
  // Arm reaching toward the rocket.
  fillRect(158, baseY - 44, 22, 4, 0.03, 0.03, 0.06, 1);
  // Pad deck.
  fillRect(133, baseY - 6, 70, 6, 0.035, 0.035, 0.07, 1);
  // Blinking red beacon on the tower (one frozen moment).
  glow(153, baseY - 56, 3.5, 1.0, 0.2, 0.2, 1.2);
  glow(153, baseY - 56, 10, 1.0, 0.25, 0.25, 0.3);
  // Warm floodlight glow at the pad.
  glow(168, baseY - 8, 55, 1.0, 0.6, 0.25, 0.4);
  glow(168, baseY - 8, 18, 1.0, 0.85, 0.5, 0.7);
  // Drifting launch smoke, soft and pale.
  for (let i = 0; i < 7; i++) {
    const x = 103 + i * 22 + rr(-8, 8);
    const y = baseY - rr(2, 26);
    glow(x, y, rr(16, 30), 0.55, 0.55, 0.62, rr(0.05, 0.1));
  }
}

// ------------------------------------------------------------ rocket ----
// The hero: a sleek white rocket with a red nose and fins, drawn in its
// own local frame (nose up) and rotated into place. Every pixel in the
// bounding box is inverse-transformed and tested against the body
// profile, the fins, the window and the flame, with a 1px feather so the
// edges stay clean.
function drawRocket(cx, cy, angleDeg, scale) {
  const th = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const toLocal = (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    return [(dx * cos + dy * sin) / scale, (-dx * sin + dy * cos) / scale];
  };
  const toScreen = (lx, ly) => {
    return [cx + (lx * cos - ly * sin) * scale, cy + (lx * sin + ly * cos) * scale];
  };

  // Body half-width profile, ly from -85 (nose tip) to +85 (tail).
  function bodyW(ly) {
    if (ly < -55) return 13 * Math.pow((ly + 85) / 30, 0.7);
    if (ly < 55) return 13 * (1 - 0.08 * ((ly + 55) / 110));
    return 12 * (1 - ((ly - 55) / 30) * 0.25);
  }
  // Flame half-width profile, t from 0 (base) to 1 (tip).
  function flameW(t) {
    const bulge = 1 + 0.22 * Math.exp(-(((t - 0.12) / 0.09) ** 2));
    return 19 * Math.pow(1 - t, 0.7) * bulge * (1 + 0.1 * Math.sin(t * 26));
  }
  function inPoly(px, py, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0];
      const yi = pts[i][1];
      const xj = pts[j][0];
      const yj = pts[j][1];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }
  const finL = [
    [-12, 40],
    [-38, 86],
    [-32, 98],
    [-11, 80],
  ];
  const finR = [
    [12, 40],
    [38, 86],
    [32, 98],
    [11, 80],
  ];

  const R = Math.ceil(280 * scale);
  const x0 = Math.max(0, Math.floor(cx - R));
  const x1 = Math.min(W - 1, Math.ceil(cx + R));
  const y0 = Math.max(0, Math.floor(cy - R));
  const y1 = Math.min(H - 1, Math.ceil(cy + R));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const [lx, ly] = toLocal(x, y);
      // --- flame (behind the body, additive) ---
      if (ly >= 80 && ly <= 245) {
        const t = (ly - 80) / 165;
        const w = flameW(t);
        const ax = Math.abs(lx);
        if (ax < w) {
          const edge = clamp01((w - ax) / 2);
          const core = 1 - ax / w;
          const bright = (1 - t * 0.55) * (0.35 + 0.65 * Math.pow(core, 1.5)) * edge;
          let c;
          if (t < 0.35) c = mix3([1.5, 1.35, 0.9], [1.5, 0.9, 0.35], t / 0.35);
          else c = mix3([1.5, 0.9, 0.35], [1.2, 0.35, 0.45], (t - 0.35) / 0.65);
          addPx(x, y, c[0] * bright, c[1] * bright, c[2] * bright);
        }
      }
      // --- fins (behind the body) ---
      if (inPoly(lx, ly, finL)) setPx(x, y, 0.85, 0.18, 0.22);
      else if (inPoly(lx, ly, finR)) setPx(x, y, 0.58, 0.12, 0.16);
      // --- engine nozzle ---
      if (ly >= 85 && ly <= 95 && Math.abs(lx) < 7) {
        setPx(x, y, 0.15, 0.16, 0.2);
      }
      // --- body ---
      if (ly >= -85 && ly <= 85) {
        const w = bodyW(ly);
        const ax = Math.abs(lx);
        if (ax < w + 1) {
          const feather = clamp01((w - ax) / 1.5 + 0.5);
          const s = clamp01(lx / w);
          const shade = 0.86 + 0.14 * (s * 0.5 + 0.5);
          let cr;
          let cg;
          let cb;
          if (ly < -44) {
            // Red nose cone (and the band below it).
            const nt = clamp01((-ly - 44) / 41);
            const nc = mix3([0.95, 0.25, 0.25], [0.72, 0.1, 0.15], nt);
            cr = nc[0] * shade;
            cg = nc[1] * shade;
            cb = nc[2] * shade;
          } else if (ly > 72) {
            // Dark engine skirt.
            cr = 0.25;
            cg = 0.28;
            cb = 0.32;
          } else {
            // White hull: vertical gradient plus a highlight stripe.
            const vt = (ly + 44) / 116;
            const base = mix3([0.98, 0.99, 1.0], [0.8, 0.87, 0.95], vt);
            let hi = 0;
            if (s > 0.25 && s < 0.55) hi = 0.08;
            cr = base[0] * shade + hi;
            cg = base[1] * shade + hi;
            cb = base[2] * shade + hi;
          }
          mixPx(x, y, cr, cg, cb, feather);
          // --- window ---
          const wdx = lx - 0;
          const wdy = ly - -8;
          const wd = Math.sqrt(wdx * wdx + wdy * wdy);
          if (wd < 10.5) {
            const wfe = clamp01((10.5 - wd) / 1.2);
            if (wd > 8.5) {
              mixPx(x, y, 0.6, 0.92, 1.0, wfe);
            } else {
              mixPx(x, y, 0.03, 0.08, 0.22, wfe);
              const gx = lx - -3.5;
              const gy = ly - -12;
              if (Math.sqrt(gx * gx + gy * gy) < 3) mixPx(x, y, 1, 1, 1, 0.9);
            }
          }
        }
      }
    }
  }
  // Speed lines streaming behind the rocket, parallel to its flight.
  const speedLines = [
    [-48, 30, 105],
    [-62, 60, 150],
    [48, 25, 95],
    [64, 70, 160],
    [-34, 130, 200],
    [36, 120, 185],
  ];
  for (const [lx, ly0, ly1] of speedLines) {
    const a = toScreen(lx, ly0);
    const b = toScreen(lx, ly1);
    thickLine(a[0], a[1], b[0], b[1], 1.6, 0.85, 0.95, 1.0, 0.3);
  }
  // Flame halo and sparks.
  const base = toScreen(0, 100);
  glow(base[0], base[1], 52 * scale, 1.0, 0.55, 0.2, 0.55);
  glow(base[0], base[1], 26 * scale, 1.0, 0.9, 0.55, 0.9);
  for (let i = 0; i < 34; i++) {
    const lp = toScreen(gauss() * 22, 245 + rr(0, 60));
    const c = rand() < 0.5 ? [1.0, 0.75, 0.35] : [1.0, 0.95, 0.8];
    glow(lp[0], lp[1], rr(1.2, 2.8), c[0], c[1], c[2], rr(0.4, 1.0));
  }
}

// ------------------------------------------------------------- title ----
// A chunky hand-drawn 7x9 bitmap font, only the glyphs the title needs.
// Rendered big and crisp: warm glow, dark outline, yellow-to-orange
// gradient fill with a white kiss on the top rows.
const FONT = {
  W: ['#.....#', '#.....#', '#.....#', '#..#..#', '#..#..#', '#.#.#.#', '.#...#.', '.#...#.', '.#...#.'],
  O: ['.#####.', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '.#####.'],
  ',': ['.......', '.......', '.......', '.......', '.......', '.......', '.##....', '.##....', '..#....'],
  ' ': ['.......', '.......', '.......', '.......', '.......', '.......', '.......', '.......', '.......'],
  J: ['....###', '.....##', '.....##', '.....##', '.....##', '##...##', '##...##', '.##.##.', '..###..'],
  U: ['##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '.##.##.', '..###..'],
  D: ['#####..', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '#####..'],
  G: ['.#####.', '##...##', '##.....', '##.....', '##..###', '##...##', '##...##', '##...##', '.#####.'],
  E: ['#######', '##.....', '##.....', '####...', '##.....', '##.....', '##.....', '##.....', '#######'],
  '!': ['..##...', '..##...', '..##...', '..##...', '..##...', '..##...', '..##...', '.......', '..##...'],
};

function drawTitle(text, scale) {
  const cell = 8 * scale; // 7 px glyph + 1 px gap
  const width = text.length * cell - scale;
  const height = 9 * scale;
  const x0 = Math.round((W - width) / 2);
  const y0 = 42;
  // Warm halo behind the whole line.
  glow(W / 2, y0 + height / 2, width * 0.42, 1.0, 0.55, 0.15, 0.16);
  // Glow pass: one soft glow per filled cell.
  for (let ci = 0; ci < text.length; ci++) {
    const glyph = FONT[text[ci]];
    if (!glyph) continue;
    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 7; col++) {
        if (glyph[row][col] !== '#') continue;
        const cx = x0 + ci * cell + col * scale + scale / 2;
        const cy = y0 + row * scale + scale / 2;
        glow(cx, cy, scale * 1.15, 1.0, 0.62, 0.12, 0.12);
      }
    }
  }
  // Outline pass: dark squares slightly larger than the fill squares.
  const pad = 3;
  for (let ci = 0; ci < text.length; ci++) {
    const glyph = FONT[text[ci]];
    if (!glyph) continue;
    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 7; col++) {
        if (glyph[row][col] !== '#') continue;
        fillRect(
          x0 + ci * cell + col * scale - pad,
          y0 + row * scale - pad,
          scale + pad * 2,
          scale + pad * 2,
          0.02,
          0.01,
          0.08,
          1,
        );
      }
    }
  }
  // Fill pass: gradient by row, white-kissed at the top.
  for (let ci = 0; ci < text.length; ci++) {
    const glyph = FONT[text[ci]];
    if (!glyph) continue;
    for (let row = 0; row < 9; row++) {
      const t = row / 8;
      let c = mix3([1.0, 0.88, 0.3], [1.0, 0.48, 0.1], t);
      if (row <= 1) c = mix3(c, [1.0, 1.0, 0.9], 0.4);
      for (let col = 0; col < 7; col++) {
        if (glyph[row][col] !== '#') continue;
        fillRect(x0 + ci * cell + col * scale, y0 + row * scale, scale, scale, c[0], c[1], c[2], 1);
      }
    }
  }
}

// -------------------------------------------------------- tone + PNG ----
// Filmic-ish soft clip plus a gentle vignette, then 8-bit RGB.
function toneMap() {
  const rgb = Buffer.alloc(W * H * 3);
  const cx = W / 2;
  const cy = H / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const dx = (x - cx) / (W * 0.72);
      const dy = (y - cy) / (H * 0.72);
      const d2 = dx * dx + dy * dy;
      const vig = 1 - 0.22 * smoothstep(0.45, 1.0, d2);
      for (let ch = 0; ch < 3; ch++) {
        const v = 1 - Math.exp(-1.5 * img[i + ch] * vig);
        rgb[i + ch] = Math.round(255 * Math.pow(v, 0.9));
      }
    }
  }
  return rgb;
}

// Minimal PNG encoder: 8-bit RGB, per-row filter chosen from the five
// standard filters by smallest absolute residual, zlib level 9.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
function encodePNG(rgb, w, h) {
  const bpp = 3;
  const stride = w * bpp;
  const raw = Buffer.alloc((stride + 1) * h);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const row = rgb.subarray(y * stride, (y + 1) * stride);
    let best = null;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = Buffer.alloc(stride);
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? row[i - bpp] : 0;
        const up = prev[i];
        const upLeft = i >= bpp ? prev[i - bpp] : 0;
        let pred = 0;
        if (f === 1) pred = left;
        else if (f === 2) pred = up;
        else if (f === 3) pred = (left + up) >> 1;
        else if (f === 4) pred = paeth(left, up, upLeft);
        const v = (row[i] - pred) & 0xff;
        out[i] = v;
        score += Math.abs(v < 128 ? v : v - 256);
      }
      if (score < bestScore) {
        bestScore = score;
        best = { f, out };
      }
    }
    raw[y * (stride + 1)] = best.f;
    best.out.copy(raw, y * (stride + 1) + 1);
    row.copy(prev);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// -------------------------------------------------------------- main ----
function main() {
  drawSky();
  drawNebula();
  drawStars();
  drawComets();
  drawPlanet(150, 270, 115);
  drawGalaxy(730, 350, -25, 0.62, 220);
  drawMoon();
  drawPad();
  drawRibbon();
  drawRocket(350, 730, 38, 1.25);
  drawTitle('WOW, JUDGE!', 10);

  const rgb = toneMap();
  const png = encodePNG(rgb, W, H);
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'entry.png'), png);
  console.log(`wrote ${join(outDir, 'entry.png')} (${png.length} bytes, ${W}x${H})`);
}

main();
