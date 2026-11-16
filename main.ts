// Phoenix Rising — a generative poster, drawn entirely in code.
// Theme: a phoenix bursts through a ring of living fire toward a blazing
// moon, embers and sparks streaming behind it. Flat-poster style with
// warm golds and reds against a deep indigo night, one strong diagonal
// of motion, one clear focal point: the bird inside the ring.
// Node stdlib only. Deterministic: fixed seed, no clock, no Math.random.

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

const W = 1024;
const H = 1024;

// ---------------------------------------------------------------- seeded RNG
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0x9e3779b9);

// ------------------------------------------------------------------ colour
type RGB = [number, number, number];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function mix(c1: RGB, c2: RGB, t: number): RGB {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}
function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// ------------------------------------------------------------------ canvas
class Canvas {
  buf: Uint8Array;
  constructor() {
    this.buf = new Uint8Array(W * H * 3);
  }
  set(x: number, y: number, c: RGB, a = 1): void {
    const xi = x | 0, yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
    const i = (yi * W + xi) * 3;
    if (a >= 1) {
      this.buf[i] = c[0]; this.buf[i + 1] = c[1]; this.buf[i + 2] = c[2];
    } else {
      this.buf[i] = clamp255(lerp(this.buf[i], c[0], a));
      this.buf[i + 1] = clamp255(lerp(this.buf[i + 1], c[1], a));
      this.buf[i + 2] = clamp255(lerp(this.buf[i + 2], c[2], a));
    }
  }
  // additive light: colour added, scaled, clamped
  add(x: number, y: number, c: RGB, a: number): void {
    const xi = x | 0, yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= W || yi >= H || a <= 0) return;
    const i = (yi * W + xi) * 3;
    this.buf[i] = clamp255(this.buf[i] + c[0] * a);
    this.buf[i + 1] = clamp255(this.buf[i + 1] + c[1] * a);
    this.buf[i + 2] = clamp255(this.buf[i + 2] + c[2] * a);
  }
  get(x: number, y: number): RGB {
    const i = ((y | 0) * W + (x | 0)) * 3;
    return [this.buf[i], this.buf[i + 1], this.buf[i + 2]];
  }
}

// ------------------------------------------------------------ shape helpers
// Scanline polygon fill (flat colour, alpha).
function poly(cv: Canvas, pts: number[][], c: RGB, a = 1): void {
  if (pts.length < 3) return;
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  minY = Math.max(0, Math.floor(minY)); maxY = Math.min(H - 1, Math.ceil(maxY));
  for (let y = minY; y <= maxY; y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p1 = pts[i], p2 = pts[(i + 1) % pts.length];
      if ((p1[1] <= y && p2[1] > y) || (p2[1] <= y && p1[1] > y)) {
        const t = (y - p1[1]) / (p2[1] - p1[1]);
        xs.push(p1[0] + t * (p2[0] - p1[0]));
      }
    }
    xs.sort((u, v) => u - v);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k])), x1 = Math.min(W - 1, Math.floor(xs[k + 1]));
      for (let x = x0; x <= x1; x++) cv.set(x, y, c, a);
    }
  }
}

// Additive polygon (for glows / flames).
function polyAdd(cv: Canvas, pts: number[][], c: RGB, a: number): void {
  if (pts.length < 3) return;
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  minY = Math.max(0, Math.floor(minY)); maxY = Math.min(H - 1, Math.ceil(maxY));
  for (let y = minY; y <= maxY; y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p1 = pts[i], p2 = pts[(i + 1) % pts.length];
      if ((p1[1] <= y && p2[1] > y) || (p2[1] <= y && p1[1] > y)) {
        const t = (y - p1[1]) / (p2[1] - p1[1]);
        xs.push(p1[0] + t * (p2[0] - p1[0]));
      }
    }
    xs.sort((u, v) => u - v);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k])), x1 = Math.min(W - 1, Math.floor(xs[k + 1]));
      for (let x = x0; x <= x1; x++) cv.add(x, y, c, a);
    }
  }
}

// Filled disc with soft edge (alpha falls off over `soft` px).
function disc(cv: Canvas, cx: number, cy: number, r: number, c: RGB, a = 1, soft = 0): void {
  const x0 = Math.max(0, Math.floor(cx - r - soft)), x1 = Math.min(W - 1, Math.ceil(cx + r + soft));
  const y0 = Math.max(0, Math.floor(cy - r - soft)), y1 = Math.min(H - 1, Math.ceil(cy + r + soft));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r + soft) {
        const aa = soft > 0 ? a * (1 - Math.max(0, d - r) / soft) : a;
        if (aa > 0) cv.set(x, y, c, aa);
      }
    }
  }
}

// Additive radial glow: colour brightest at centre, fading to 0 at radius.
function glow(cv: Canvas, cx: number, cy: number, r: number, c: RGB, peak: number): void {
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy) / r;
      if (d < 1) {
        const f = (1 - d) * (1 - d);
        cv.add(x, y, c, peak * f);
      }
    }
  }
}

// Rotated ellipse fill.
function ellipse(cv: Canvas, cx: number, cy: number, rx: number, ry: number, rot: number, c: RGB, a = 1): void {
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const R = Math.max(rx, ry);
  const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(W - 1, Math.ceil(cx + R));
  const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(H - 1, Math.ceil(cy + R));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      const u = (dx * cos + dy * sin) / rx;
      const v = (-dx * sin + dy * cos) / ry;
      if (u * u + v * v <= 1) cv.set(x, y, c, a);
    }
  }
}

// Thick line (capsule) — used for speed lines and ribbon cores.
function thickLine(cv: Canvas, x1: number, y1: number, x2: number, y2: number, w: number, c: RGB, a = 1): void {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const pad = w + 2;
  const x0 = Math.max(0, Math.floor(Math.min(x1, x2) - pad)), x1b = Math.min(W - 1, Math.ceil(Math.max(x1, x2) + pad));
  const y0 = Math.max(0, Math.floor(Math.min(y1, y2) - pad)), y1b = Math.min(H - 1, Math.ceil(Math.max(y1, y2) + pad));
  for (let y = y0; y <= y1b; y++) {
    for (let x = x0; x <= x1b; x++) {
      let t = len2 === 0 ? 0 : ((x - x1) * dx + (y - y1) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = x1 + t * dx, py = y1 + t * dy;
      const d = Math.hypot(x - px, y - py);
      if (d <= w / 2) cv.set(x, y, c, a * (1 - (d / (w / 2)) * 0.35));
    }
  }
}

// Quadratic bezier point.
function qbez(p0: number[], p1: number[], p2: number[], t: number): number[] {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
          u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]];
}

// A tapering ribbon along a quadratic bezier: two-sided strip polygon.
function ribbon(cv: Canvas, p0: number[], p1: number[], p2: number[], w0: number, w1: number, c: RGB, a = 1, steps = 24): void {
  const left: number[][] = [], right: number[][] = [];
  let prev: number[] | null = null;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = qbez(p0, p1, p2, t);
    const q = qbez(p0, p1, p2, Math.min(1, t + 0.01));
    let nx = -(q[1] - p[1]), ny = q[0] - p[0];
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl; ny /= nl;
    const w = lerp(w0, w1, t) / 2;
    left.push([p[0] + nx * w, p[1] + ny * w]);
    right.push([p[0] - nx * w, p[1] - ny * w]);
    prev = p;
  }
  void prev;
  poly(cv, [...left, ...right.reverse()], c, a);
}

// ------------------------------------------------------------- flame tongue
// A curved flame tongue: a tapered spike leaning along `lean` degrees,
// built from a quadratic spine with a wavy width profile.
function flameTongue(cv: Canvas, bx: number, by: number, len: number, wdt: number, lean: number, c: RGB, a: number): void {
  const rad = (lean * Math.PI) / 180;
  const dx = Math.sin(rad), dy = -Math.cos(rad);
  const px = -dy, py = dx; // perpendicular
  const tip: number[] = [bx + dx * len, by + dy * len];
  const ctrl: number[] = [bx + dx * len * 0.55 + px * wdt * 0.9, by + dy * len * 0.55 + py * wdt * 0.9];
  const left: number[][] = [], right: number[][] = [];
  const steps = 14;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = qbez([bx, by], ctrl, tip, t);
    // width: fat near base, tapering to a point, with a slight bulge
    const prof = Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.62) * (1 - t * 0.55);
    const w = (wdt / 2) * Math.max(0.02, prof);
    left.push([p[0] + px * w, p[1] + py * w]);
    right.push([p[0] - px * w, p[1] - py * w]);
  }
  poly(cv, [...left, ...right.reverse()], c, a);
}

// ------------------------------------------------------------------ palette
const INDIGO: RGB = [16, 12, 44];
const DEEP: RGB = [8, 6, 26];
const VIOLET: RGB = [58, 28, 96];
const MAGENTA: RGB = [150, 40, 110];
const GOLD: RGB = [255, 196, 66];
const AMBER: RGB = [255, 140, 40];
const EMBER: RGB = [255, 84, 32];
const CRIMSON: RGB = [214, 32, 48];
const CREAM: RGB = [255, 244, 214];
const MOON: RGB = [255, 232, 170];
const TEAL: RGB = [64, 224, 208];

// ------------------------------------------------------------------- scene
function drawScene(): Canvas {
  const cv = new Canvas();

  // ---- background: vertical gradient deep indigo -> violet -> ember horizon
  const stops: [number, RGB][] = [
    [0.0, DEEP],
    [0.35, INDIGO],
    [0.62, VIOLET],
    [0.85, [96, 34, 92]],
    [1.0, [150, 52, 70]],
  ];
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    let i = 0;
    while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    const c = mix(c0, c1, (t - t0) / (t1 - t0));
    for (let x = 0; x < W; x++) cv.set(x, y, c);
  }

  // ---- nebula blobs (soft additive colour clouds)
  const nebulae: [number, number, number, RGB, number][] = [
    [180, 210, 260, [70, 40, 150], 0.5],
    [860, 160, 220, [40, 90, 170], 0.45],
    [820, 820, 300, [170, 50, 90], 0.4],
    [140, 800, 240, [90, 30, 120], 0.4],
    [512, 120, 300, [60, 30, 130], 0.35],
  ];
  for (const [x, y, r, c, p] of nebulae) glow(cv, x, y, r, c, p);

  // ---- stars: bright points + a few 4-point sparkles
  for (let i = 0; i < 260; i++) {
    const x = rnd() * W, y = rnd() * H * 0.85;
    const b = 0.35 + rnd() * 0.65;
    const s = rnd();
    const c: RGB = s < 0.7 ? [255, 255, 255] : s < 0.85 ? MOON : [170, 210, 255];
    const r = rnd() < 0.12 ? 2 : 1;
    disc(cv, x, y, r, c, b);
    if (rnd() < 0.1) {
      const L = 5 + rnd() * 9;
      thickLine(cv, x - L, y, x + L, y, 1, c, b * 0.8);
      thickLine(cv, x, y - L, x, y + L, 1, c, b * 0.8);
    }
  }

  // ---- the great moon: huge glowing disc upper-right, behind the ring
  const MX = 692, MY = 296, MR = 152;
  glow(cv, MX, MY, MR * 2.6, [255, 190, 90], 0.55);
  glow(cv, MX, MY, MR * 1.6, MOON, 0.8);
  disc(cv, MX, MY, MR, MOON, 1, 3);
  disc(cv, MX, MY, MR - 8, [255, 240, 196], 1);
  // moon maria: soft darker patches
  disc(cv, MX - 52, MY - 30, 34, [238, 205, 140], 0.55, 8);
  disc(cv, MX + 44, MY + 42, 26, [238, 205, 140], 0.5, 8);
  disc(cv, MX + 18, MY - 66, 20, [240, 210, 150], 0.45, 6);
  disc(cv, MX - 88, MY + 58, 18, [240, 212, 152], 0.4, 6);
  // crisp rim light on the moon's lower-left edge
  for (let k = 0; k < 60; k++) {
    const a = Math.PI * (0.55 + 0.45 * (k / 60));
    const x = MX + Math.cos(a) * (MR - 2), y = MY + Math.sin(a) * (MR - 2);
    disc(cv, x, y, 3, [255, 250, 225], 0.9);
  }

  // ---- fire ring: a blazing circle the phoenix bursts through
  const RX = 512, RY = 500, RR = 296;
  // outer glow halo of the ring
  glow(cv, RX, RY, RR + 90, [255, 120, 30], 0.5);
  // flame tongues licking outward all around the ring (drawn first so
  // their bases tuck under the solid band)
  for (let k = 0; k < 40; k++) {
    const ang = (k / 40) * Math.PI * 2 + rnd() * 0.08;
    const bx = RX + Math.cos(ang) * (RR - 6);
    const by = RY + Math.sin(ang) * (RR - 6);
    const len = 44 + rnd() * 64;
    const wdt = 22 + rnd() * 18;
    const leanDeg = (ang * 180) / Math.PI + 90 + (rnd() - 0.5) * 36;
    const hot = rnd();
    const c = hot < 0.45 ? GOLD : hot < 0.8 ? AMBER : EMBER;
    flameTongue(cv, bx, by, len, wdt, leanDeg, c, 0.95);
  }
  // inner tongues licking inward (short, hot, sparse)
  for (let k = 0; k < 14; k++) {
    const ang = (k / 14) * Math.PI * 2 + 0.12 + rnd() * 0.08;
    const bx = RX + Math.cos(ang) * (RR - 4);
    const by = RY + Math.sin(ang) * (RR - 4);
    const len = 16 + rnd() * 20;
    const wdt = 12 + rnd() * 8;
    const leanDeg = (ang * 180) / Math.PI - 90 + (rnd() - 0.5) * 30;
    flameTongue(cv, bx, by, len, wdt, leanDeg, rnd() < 0.6 ? GOLD : AMBER, 0.9);
  }
  // ring band: solid annulus, hottest (pale gold) at its centre line
  {
    const x0 = Math.max(0, Math.floor(RX - RR - 24)), x1 = Math.min(W - 1, Math.ceil(RX + RR + 24));
    const y0 = Math.max(0, Math.floor(RY - RR - 24)), y1 = Math.min(H - 1, Math.ceil(RY + RR + 24));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - RX, y - RY);
        const off = Math.abs(d - RR);
        if (off < 22) {
          const t = 1 - off / 22;
          const c = mix(EMBER, GOLD, Math.pow(t, 0.6));
          cv.set(x, y, c, 0.55 + 0.45 * t);
        }
      }
    }
  }
  // bright core line of the ring
  for (let k = 0; k < 1400; k++) {
    const ang = (k / 1400) * Math.PI * 2;
    cv.set(RX + Math.cos(ang) * RR, RY + Math.sin(ang) * RR, CREAM, 0.95);
    cv.set(RX + Math.cos(ang) * (RR + 1), RY + Math.sin(ang) * (RR + 1), GOLD, 0.7);
    cv.set(RX + Math.cos(ang) * (RR - 1), RY + Math.sin(ang) * (RR - 1), GOLD, 0.7);
  }

  // ---- speed lines: diagonal streaks driving toward the bird
  const streaks: [number, number, number, number, number, RGB][] = [];
  for (let i = 0; i < 34; i++) {
    const side = rnd();
    let x1: number, y1: number;
    if (side < 0.5) { x1 = rnd() * 420; y1 = 560 + rnd() * 420; }
    else { x1 = 620 + rnd() * 400; y1 = 620 + rnd() * 380; }
    const len = 60 + rnd() * 160;
    const ang = -0.62 + (rnd() - 0.5) * 0.22;
    const x2 = x1 + Math.cos(ang) * len, y2 = y1 + Math.sin(ang) * len;
    streaks.push([x1, y1, x2, y2, 1 + rnd() * 2.2, rnd() < 0.75 ? GOLD : CREAM]);
  }
  for (const [x1, y1, x2, y2, w, c] of streaks) thickLine(cv, x1, y1, x2, y2, w, c, 0.5);

  // ---- tail ribbons: long streaming plumes trailing down-left
  const tailBase: [number, number] = [470, 560];
  const ribbonCols: RGB[] = [CRIMSON, EMBER, AMBER, GOLD, [255, 90, 120]];
  const ribbonTargets: [number, number][] = [
    [150, 930], [240, 960], [330, 985], [420, 990], [120, 820],
  ];
  const ribbonCtrls: [number, number][] = [
    [300, 780], [330, 830], [380, 860], [430, 880], [250, 700],
  ];
  for (let i = 0; i < 5; i++) {
    const [tx, ty] = ribbonTargets[i];
    const [cxp, cyp] = ribbonCtrls[i];
    const w0 = 34 - i * 3, w1 = 5;
    // glow underlay
    ribbon(cv, tailBase, [cxp, cyp], [tx, ty], w0 + 14, w1 + 8, ribbonCols[i], 0.35);
    ribbon(cv, tailBase, [cxp, cyp], [tx, ty], w0, w1, ribbonCols[i], 0.95);
    // bright core stripe
    ribbon(cv, tailBase, [cxp, cyp], [tx, ty], w0 * 0.4, 2, CREAM, 0.5);
  }

  // ---- phoenix body: diagonal, rising from lower-left to upper-right
  // body axis from (430, 620) to (640, 360); angle ~ -35 deg
  const bodyAng = -0.61;
  // under-glow of the bird
  glow(cv, 540, 490, 200, [255, 110, 40], 0.35);
  // belly (deep crimson, lower)
  ellipse(cv, 520, 520, 118, 74, bodyAng, CRIMSON, 1);
  // back / upper body (bright amber-gold)
  ellipse(cv, 548, 486, 104, 62, bodyAng, AMBER, 1);
  ellipse(cv, 566, 462, 78, 46, bodyAng, GOLD, 1);
  // chest highlight
  ellipse(cv, 596, 428, 46, 30, bodyAng, CREAM, 0.85);

  // ---- wings: layered feather fans
  // UPPER wing — swept up and back, big fan of feathers
  const wingRoot: [number, number] = [520, 470];
  const featherCols: RGB[] = [GOLD, AMBER, EMBER, CRIMSON, [255, 60, 90]];
  // fan of long primary feathers, sweeping up and to the left as one wing
  for (let i = 0; i < 6; i++) {
    const t = i / 5; // 0..1 across the fan
    const ang = -2.75 + t * 1.35; // radians, fan spread (up-left to up)
    const len = 320 - Math.abs(t - 0.4) * 120;
    const tip: [number, number] = [
      wingRoot[0] + Math.cos(ang) * len,
      wingRoot[1] + Math.sin(ang) * len,
    ];
    const ctrl: [number, number] = [
      wingRoot[0] + Math.cos(ang + 0.35) * len * 0.55,
      wingRoot[1] + Math.sin(ang + 0.35) * len * 0.55,
    ];
    const wdt = 58 - Math.abs(t - 0.5) * 16;
    // feather as a tapered ribbon with a hot core
    ribbon(cv, wingRoot, ctrl, tip, wdt + 10, 6, featherCols[i % featherCols.length], 0.4);
    ribbon(cv, wingRoot, ctrl, tip, wdt, 4, featherCols[i % featherCols.length], 0.97);
    ribbon(cv, wingRoot, ctrl, tip, wdt * 0.35, 2, CREAM, 0.45);
    // teal eye-spot near the tip of the outer feathers
    if (i === 4) {
      const ex = wingRoot[0] + Math.cos(ang) * len * 0.8;
      const ey = wingRoot[1] + Math.sin(ang) * len * 0.8;
      disc(cv, ex, ey, 6, TEAL, 0.9, 2);
      disc(cv, ex, ey, 3, CREAM, 0.95);
    }
  }
  // wing shoulder coverts: overlapping rounded scales in warm tones
  const covertCols: RGB[] = [GOLD, AMBER, EMBER];
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < 4 - r; i++) {
      const x = wingRoot[0] - 24 + i * 32 + r * 14;
      const y = wingRoot[1] - 40 + r * 28;
      const c = covertCols[(r + i) % covertCols.length];
      ellipse(cv, x, y, 24, 11, -0.5 + r * 0.18, c, 0.95);
      ellipse(cv, x, y - 3, 16, 7, -0.5 + r * 0.18, mix(c, CREAM, 0.25), 0.6);
    }
  }

  // LOWER wing — swept down, smaller fan, catching the firelight
  const lowRoot: [number, number] = [500, 540];
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    const ang = 0.55 + t * 0.9;
    const len = 210 - Math.abs(t - 0.5) * 70;
    const tip: [number, number] = [lowRoot[0] + Math.cos(ang) * len, lowRoot[1] + Math.sin(ang) * len];
    const ctrl: [number, number] = [lowRoot[0] + Math.cos(ang - 0.3) * len * 0.55, lowRoot[1] + Math.sin(ang - 0.3) * len * 0.55];
    ribbon(cv, lowRoot, ctrl, tip, 40, 4, featherCols[(i + 2) % featherCols.length], 0.95);
    ribbon(cv, lowRoot, ctrl, tip, 14, 2, CREAM, 0.4);
  }

  // ---- neck + head, reaching up toward the moon
  ribbon(cv, [590, 430], [640, 380], [668, 330], 44, 26, AMBER, 1);
  ribbon(cv, [600, 420], [646, 372], [668, 330], 26, 14, GOLD, 1);
  // head
  ellipse(cv, 676, 316, 38, 29, -0.5, GOLD, 1);
  ellipse(cv, 684, 308, 22, 16, -0.5, CREAM, 0.8);
  // beak: sharp golden beak pointing up-right
  poly(cv, [[694, 292], [724, 276], [700, 312]], [255, 214, 90], 1);
  poly(cv, [[694, 292], [716, 282], [698, 302]], EMBER, 0.9);
  // eye: fierce, bright
  disc(cv, 686, 306, 7, [20, 8, 20], 1);
  disc(cv, 688, 304, 3, CREAM, 1);
  // crest: three flame plumes streaming back from the head
  flameTongue(cv, 660, 292, 74, 22, -58, GOLD, 0.95);
  flameTongue(cv, 652, 300, 92, 24, -72, AMBER, 0.95);
  flameTongue(cv, 646, 310, 64, 18, -86, EMBER, 0.95);
  // throat glow
  glow(cv, 668, 330, 60, GOLD, 0.5);

  // ---- front flames: a few bright tongues overlapping the bird's lower edge
  flameTongue(cv, 430, 640, 90, 30, 12, AMBER, 0.9);
  flameTongue(cv, 480, 660, 70, 24, -8, GOLD, 0.9);
  flameTongue(cv, 620, 660, 80, 26, 168, EMBER, 0.85);

  // ---- embers: glowing sparks bursting outward from the ring
  for (let i = 0; i < 150; i++) {
    const ang = rnd() * Math.PI * 2;
    const rad = RR + 20 + rnd() * 260;
    const x = RX + Math.cos(ang) * rad;
    const y = RY + Math.sin(ang) * rad;
    if (x < 4 || y < 4 || x > W - 4 || y > H - 4) continue;
    const s = rnd();
    const c: RGB = s < 0.5 ? GOLD : s < 0.8 ? AMBER : EMBER;
    const r = 1 + rnd() * 3.2;
    glow(cv, x, y, r * 4, c, 0.7);
    disc(cv, x, y, r, s < 0.25 ? CREAM : c, 0.95);
    // short streak behind a few of them
    if (rnd() < 0.3) {
      thickLine(cv, x, y, x - Math.cos(ang) * (10 + rnd() * 22), y - Math.sin(ang) * (10 + rnd() * 22), 1.4, c, 0.55);
    }
  }

  // ---- inner sparkle dust inside the ring
  for (let i = 0; i < 90; i++) {
    const ang = rnd() * Math.PI * 2;
    const rad = rnd() * (RR - 60);
    const x = RX + Math.cos(ang) * rad;
    const y = RY + Math.sin(ang) * rad;
    disc(cv, x, y, 1 + rnd() * 1.6, rnd() < 0.5 ? CREAM : GOLD, 0.35 + rnd() * 0.5);
  }

  // ---- vignette: darken the corners so the centre blazes
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - W / 2) / (W / 2), dy = (y - H / 2) / (H / 2);
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 0.72) {
        const f = Math.min(0.42, (d - 0.72) * 0.9);
        const i = (y * W + x) * 3;
        cv.buf[i] = clamp255(cv.buf[i] * (1 - f));
        cv.buf[i + 1] = clamp255(cv.buf[i + 1] * (1 - f));
        cv.buf[i + 2] = clamp255(cv.buf[i + 2] * (1 - f));
      }
    }
  }

  return cv;
}

// ---------------------------------------------------------------- PNG encode
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(cv: Canvas): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // raw scanlines: filter byte 0 + RGB rows
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0;
    raw.set(cv.buf.subarray(y * W * 3, (y + 1) * W * 3), y * (1 + W * 3) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------- main
function main(): void {
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  fs.mkdirSync(outDir, { recursive: true });
  const cv = drawScene();
  const png = encodePNG(cv);
  const outPath = path.join(outDir, "entry.png");
  fs.writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${png.length} bytes)`);
}

main();
