import { describe, expect, it } from 'vitest';
import {
  chooseSeeds,
  clusterPixels,
  contrastRatio,
  deriveTheme,
  hexToRgb,
  lchToRgb,
  rgbToHex,
  rgbToOklab,
  themeCss,
  TOKEN_NAMES,
} from '../../src/color';

/** RGBA buffer with the given colours in the given proportions (100 px total). */
function pixels(parts: [string, number][]): number[] {
  const out: number[] = [];
  for (const [hex, count] of parts) {
    const [r, g, b] = hexToRgb(hex);
    for (let i = 0; i < count; i++) out.push(r, g, b, 255);
  }
  return out;
}

describe('colour conversions', () => {
  it('round-trips sRGB through OKLab/OKLCH', () => {
    for (const hex of ['#b14f27', '#2e4366', '#ffffff', '#000000', '#7c7a37']) {
      const [l, a, b] = rgbToOklab(hexToRgb(hex));
      const lch = { l, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
      expect(rgbToHex(lchToRgb(lch))).toBe(hex);
    }
  });

  it('computes WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
  });
});

describe('palette extraction', () => {
  it('finds the dominant colours, most common first, ignoring transparency', () => {
    const data = pixels([
      ['#1e3a5f', 60],
      ['#e8a87c', 25],
      ['#2f6e5d', 15],
    ]);
    data.push(255, 0, 0, 0); // a transparent red pixel must not count
    const swatches = clusterPixels(data, 3);
    expect(swatches.map((s) => s.hex)).toEqual(['#1e3a5f', '#e8a87c', '#2f6e5d']);
    expect(swatches[0].population).toBeCloseTo(0.6, 2);
  });

  it('is deterministic, so every tab derives the same palette', () => {
    const data = pixels([
      ['#445566', 40],
      ['#c0a080', 35],
      ['#8a3b2a', 25],
    ]);
    expect(clusterPixels(data)).toEqual(clusterPixels(data));
  });

  it('chooses the dominant colour as base and a vivid one as accent', () => {
    const seeds = chooseSeeds([
      { hex: '#3a3a3a', population: 0.6 }, // big but grey
      { hex: '#d9541e', population: 0.25 }, // vivid orange
      { hex: '#8c8c80', population: 0.15 },
    ]);
    expect(seeds.slice(0, 2)).toEqual(['#3a3a3a', '#d9541e']);
  });
});

describe('theme derivation', () => {
  const pictures = [
    ['#1e3a5f', '#e8a87c'], // blue hour
    ['#f5f5f0', '#f0f0e8'], // almost white, no colour at all
    ['#050505', '#101010'], // almost black
    ['#ff00ff', '#00ff00'], // garish
    ['#7c7a37', '#b14f27'], // autumn
  ];

  it.each(pictures)('keeps every text pair readable (%s, %s)', (base, accent) => {
    const { light, dark } = deriveTheme([base, accent]);
    for (const theme of [light, dark]) {
      expect(contrastRatio(theme.text, theme.bg)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(theme.text, theme.surface)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(theme.muted, theme.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme.accent, theme.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme['accent-text'], theme.accent)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(theme.danger, theme.surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the picture hue in the accent', () => {
    const { light } = deriveTheme(['#20304a', '#2a6fdb']);
    const [, a, b] = rgbToOklab(hexToRgb(light.accent));
    const hue = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
    const [, a0, b0] = rgbToOklab(hexToRgb('#2a6fdb'));
    const original = ((Math.atan2(b0, a0) * 180) / Math.PI + 360) % 360;
    expect(Math.abs(hue - original)).toBeLessThan(6);
  });

  it('emits light and dark CSS with every token', () => {
    const css = themeCss(['#2e4366', '#49618c']);
    for (const name of TOKEN_NAMES) expect(css.split(`--${name}:`).length - 1).toBe(2);
    expect(themeCss([])).toBe('');
  });
});
