import { build } from 'esbuild';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Compiles src/boot.ts and inlines it as a classic, render-blocking <script>
 * at the top of <head>. It applies the saved theme before first paint, which
 * an external or module script (deferred by spec) cannot guarantee.
 */
function inlineBootScript(): Plugin {
  return {
    name: 'inline-boot-script',
    async transformIndexHtml() {
      const result = await build({
        entryPoints: ['src/boot.ts'],
        bundle: true,
        write: false,
        minify: true,
        format: 'iife',
        target: 'es2019',
      });
      return [{ tag: 'script', children: result.outputFiles[0].text, injectTo: 'head' }];
    },
  };
}

export default defineConfig({
  // Relative asset URLs so the build works from any sub-path (e.g. GitHub Pages).
  base: './',
  plugins: [inlineBootScript()],
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
