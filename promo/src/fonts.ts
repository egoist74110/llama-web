import {loadFont} from '@remotion/fonts';
import {staticFile} from 'remotion';

// The product's own fonts (Geist / Geist Mono, OFL), bundled from the main app's dependencies.
// Rendering waits for these to load (loadFont uses delayRender internally).
export const loadProductFonts = (): void => {
  loadFont({family: 'Geist', url: staticFile('fonts/geist-latin-wght-normal.woff2'), weight: '100 900'});
  loadFont({family: 'Geist Mono', url: staticFile('fonts/geist-mono-latin-wght-normal.woff2'), weight: '100 900'});
};
