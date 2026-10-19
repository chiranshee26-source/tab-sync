/**
 * Colour engine for "theme from your picture".
 *
 * 1. extractPalette(): k-means clustering of an image's pixels in OKLab, a
 *    perceptual colour space (distances match how different colours look),
 *    then picks a dominant "base" colour and a vivid "accent".
 * 2. deriveTheme(): turns those seeds into complete light and dark token sets
 *    in OKLCH, keeping each seed's hue but choosing lightness and chroma
 *    ourselves, then nudges lightness until every text/background pair meets
 *    WCAG contrast. Any photo therefore yields a readable theme.
 *
 * Pure functions (no DOM), so the boot script and the tests can use them.
 */

export type Rgb = [number, number, number];
type Lab = [number, number, number];
interface Lch {
  l: number;
  c: number;
  h: number;
}

// ---------- Conversions (sRGB ⇄ OKLab ⇄ OKLCH) ----------

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export function rgbToOklab([r8, g8, b8]: Rgb): Lab {
  const [r, g, b] = [r8, g8, b8].map((v) => toLinear(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinear([L, a, b]: Lab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

function lchToLab({ l, c, h }: Lch): Lab {
  const rad = (h * Math.PI) / 180;
  return [l, c * Math.cos(rad), c * Math.sin(rad)];
}

function labToLch([l, a, b]: Lab): Lch {
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return { l, c: Math.hypot(a, b), h: h < 0 ? h + 360 : h };
}

/** OKLCH → sRGB, reducing chroma until the colour fits the sRGB gamut. */
export function lchToRgb(lch: Lch): Rgb {
  let { c } = lch;
  let linear = oklabToLinear(lchToLab({ ...lch, c }));
  for (let i = 0; i < 24 && !inGamut(linear); i++) {
    c *= 0.85;
    linear = oklabToLinear(lchToLab({ ...lch, c }));
  }
  return linear.map((v) => Math.round(toGamma(Math.min(1, Math.max(0, v))) * 255)) as Rgb;
}

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const hexToLch = (hex: string) => labToLch(rgbToOklab(hexToRgb(hex)));
const lchToHex = (lch: Lch) => rgbToHex(lchToRgb(lch));

// ---------- Contrast (WCAG 2) ----------

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => toLinear(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Moves `fg` lightness away from `bg` until the pair reaches `min` contrast. */
function ensureContrast(fg: Lch, bg: string, min: number): string {
  const direction = relativeLuminance(bg) > 0.18 ? -1 : 1;
  let candidate = { ...fg };
  for (let i = 0; i < 40; i++) {
    const hex = lchToHex(candidate);
    if (contrastRatio(hex, bg) >= min) return hex;
    candidate = { ...candidate, l: Math.min(1, Math.max(0, candidate.l + direction * 0.02)) };
  }
  return direction < 0 ? '#000000' : '#ffffff';
}

// ---------- Palette extraction ----------

/** Deterministic PRNG so the same picture always gives the same palette in every tab. */
function seededRandom(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const distance2 = (a: Lab, b: Lab) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

export interface Swatch {
  hex: string;
  /** Share of the picture's pixels, 0–1. */
  population: number;
}

/**
 * Clusters RGBA pixels (as from canvas getImageData) into up to `k` swatches,
 * most common first. Transparent pixels are ignored.
 */
export function clusterPixels(rgba: Uint8ClampedArray | number[], k = 6, iterations = 12): Swatch[] {
  const points: Lab[] = [];
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    points.push(rgbToOklab([rgba[i], rgba[i + 1], rgba[i + 2]]));
  }
  if (points.length === 0) return [];

  // k-means++ initialisation: spread the starting centres apart.
  const random = seededRandom(points.length);
  const centres: Lab[] = [points[Math.floor(random() * points.length)]];
  while (centres.length < Math.min(k, points.length)) {
    const weights = points.map((p) => Math.min(...centres.map((c) => distance2(p, c))));
    const total = weights.reduce((a, b) => a + b, 0);
    if (total === 0) break;
    let pick = random() * total;
    let index = 0;
    while (index < weights.length - 1 && (pick -= weights[index]) > 0) index++;
    centres.push(points[index]);
  }

  const assignment = new Array<number>(points.length).fill(0);
  for (let iter = 0; iter < iterations; iter++) {
    for (let p = 0; p < points.length; p++) {
      let best = 0;
      for (let c = 1; c < centres.length; c++) {
        if (distance2(points[p], centres[c]) < distance2(points[p], centres[best])) best = c;
      }
      assignment[p] = best;
    }
    const sums = centres.map(() => [0, 0, 0, 0]);
    points.forEach((p, i) => {
      const s = sums[assignment[i]];
      s[0] += p[0];
      s[1] += p[1];
      s[2] += p[2];
      s[3]++;
    });
    sums.forEach((s, c) => {
      if (s[3] > 0) centres[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
    });
  }

  const counts = centres.map(() => 0);
  assignment.forEach((c) => counts[c]++);
  return centres
    .map((centre, c) => ({ hex: rgbToHex(lchToRgb(labToLch(centre))), population: counts[c] / points.length }))
    .filter((swatch) => swatch.population > 0)
    .sort((a, b) => b.population - a.population);
}

/**
 * Orders swatches as theme seeds: [base, accent, …rest]. The base is the
 * dominant colour; the accent is the most vivid colour that covers a
 * meaningful part of the picture (chroma weighted by √population).
 */
export function chooseSeeds(swatches: Swatch[]): string[] {
  if (swatches.length === 0) return [];
  const [base, ...rest] = swatches;
  const score = (s: Swatch) => {
    const { l, c } = hexToLch(s.hex);
    const usableLightness = l > 0.25 && l < 0.9 ? 1 : 0.3;
    return c * Math.sqrt(s.population) * usableLightness;
  };
  const accent = [...rest].sort((a, b) => score(b) - score(a))[0] ?? base;
  return [base.hex, accent.hex, ...rest.filter((s) => s !== accent).map((s) => s.hex)];
}

// ---------- Theme derivation ----------

export const TOKEN_NAMES = [
  'bg',
  'surface',
  'surface-2',
  'surface-3',
  'border',
  'text',
  'muted',
  'accent',
  'accent-hover',
  'accent-text',
  'accent-soft',
  'hero-ink',
  'hero-shade',
  'success',
  'success-soft',
  'warning',
  'warning-soft',
  'danger',
  'danger-soft',
] as const;
export type ThemeTokens = Record<(typeof TOKEN_NAMES)[number], string>;

/** Status colours keep their meaning (green / amber / red) at these hues. */
const STATUS_HUES = { success: 140, warning: 75, danger: 28 } as const;

/** Builds light and dark themes from [base, accent, …] seed colours. */
export function deriveTheme(seeds: string[]): { light: ThemeTokens; dark: ThemeTokens } {
  const base = hexToLch(seeds[0]);
  const accent = hexToLch(seeds[1] ?? seeds[0]);
  // A near-grey accent would make the UI look disabled: borrow some chroma.
  const accentChroma = Math.max(Math.min(accent.c, 0.17), 0.08);
  const tint = Math.min(base.c, 0.035);
  const surface = (l: number, c = tint) => lchToHex({ l, c, h: base.h });

  const build = (mode: 'light' | 'dark'): ThemeTokens => {
    const light = mode === 'light';
    const bg = surface(light ? 0.955 : 0.17, light ? tint : tint * 0.8);
    const card = surface(light ? 0.985 : 0.215);
    const accentHex = ensureContrast({ l: light ? 0.52 : 0.76, c: accentChroma, h: accent.h }, card, 4.5);
    const accentLch = hexToLch(accentHex);
    const accentText = contrastRatio('#ffffff', accentHex) >= contrastRatio('#141210', accentHex) ? '#ffffff' : '#141210';
    return {
      bg,
      surface: card,
      'surface-2': surface(light ? 0.935 : 0.255),
      'surface-3': surface(light ? 0.895 : 0.3),
      border: surface(light ? 0.87 : 0.32, tint * 1.2),
      text: ensureContrast({ l: light ? 0.24 : 0.94, c: Math.min(base.c, 0.03), h: base.h }, bg, 10),
      muted: ensureContrast({ l: light ? 0.5 : 0.74, c: Math.min(base.c, 0.04), h: base.h }, card, 4.5),
      accent: accentHex,
      'accent-hover': lchToHex({ ...accentLch, l: accentLch.l + (light ? -0.06 : 0.06) }),
      'accent-text': accentText,
      'accent-soft': lchToHex({ l: light ? 0.92 : 0.3, c: Math.min(accentChroma, 0.06), h: accent.h }),
      'hero-ink': '#fffaf3',
      'hero-shade': lchToHex({ l: 0.16, c: Math.min(base.c, 0.05), h: base.h }),
      ...statusTokens(light, card),
    };
  };
  return { light: build('light'), dark: build('dark') };
}

function statusTokens(light: boolean, card: string) {
  const tokens: Record<string, string> = {};
  for (const [name, h] of Object.entries(STATUS_HUES)) {
    tokens[name] = ensureContrast({ l: light ? 0.5 : 0.78, c: 0.12, h }, card, 4.5);
    tokens[`${name}-soft`] = lchToHex({ l: light ? 0.93 : 0.28, c: 0.045, h });
  }
  return tokens as Pick<ThemeTokens, 'success' | 'success-soft' | 'warning' | 'warning-soft' | 'danger' | 'danger-soft'>;
}

/** CSS that overrides the default theme tokens with ones derived from `seeds`. */
export function themeCss(seeds: string[]): string {
  if (seeds.length === 0) return '';
  const { light, dark } = deriveTheme(seeds);
  const block = (tokens: ThemeTokens) => TOKEN_NAMES.map((name) => `--${name}:${tokens[name]};`).join('');
  return `:root{${block(light)}}:root[data-theme='dark']{${block(dark)}}`;
}

export function parsePalette(palette: string): string[] {
  return palette ? palette.split(',') : [];
}
