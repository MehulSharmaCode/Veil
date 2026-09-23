// esbuild script: one bundle per extension context, static files copied verbatim into dist/.
// Deliberately no Vite/CRXJS: predictable output, and later WASM/model files are copied as-is.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync('static', outdir, { recursive: true });

const options = {
  entryPoints: {
    'service-worker': 'src/background/service-worker.ts',
    content: 'src/content/content.ts',
    sidepanel: 'src/sidepanel/main.ts',
  },
  outdir,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  sourcemap: 'linked',
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching… (static/ is copied once at start; restart after editing it)');
} else {
  await esbuild.build(options);
}
