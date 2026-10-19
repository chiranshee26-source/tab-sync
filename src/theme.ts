/**
 * Applies the colour theme derived from the background picture (if any) by
 * writing CSS custom properties into a <style> element. Used by the boot
 * script before first paint, and by the app whenever the palette changes.
 */

import { parsePalette, themeCss } from './color';

const STYLE_ID = 'daybook-palette';

export function applyPalette(palette: string, doc: Document = document): void {
  let style = doc.getElementById(STYLE_ID);
  if (!style) {
    style = doc.createElement('style');
    style.id = STYLE_ID;
    doc.head.appendChild(style);
  }
  const css = themeCss(parsePalette(palette));
  if (style.textContent !== css) style.textContent = css;
  doc.documentElement.toggleAttribute('data-custom-palette', css !== '');
}
