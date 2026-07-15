import {defineConfig} from 'vite';
import {viteSingleFile} from 'vite-plugin-singlefile';

// base './' so the built app works from any static host or subpath
// (GitHub Pages, a home server, a USB stick).
//
// Two build modes:
//   npm run build              -> dist/       normal PWA build
//   npm run build:artifact     -> dist-one/   single self-contained HTML
//                                 (published to the claude.ai artifact link)
export default defineConfig(({mode}) => ({
  base: './',
  server: {port: 5173, strictPort: true},
  build: mode === 'artifact'
    ? {target: 'es2020', outDir: 'dist-one'}
    : {target: 'es2020'},
  plugins: mode === 'artifact' ? [viteSingleFile()] : [],
}));
