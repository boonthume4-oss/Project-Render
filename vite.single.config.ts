// Builds the whole app into ONE self-contained HTML file (JS, CSS and icons inlined):
//   npm run build:single  →  dist-single/index.html  (also copied to ./arch-prompt-studio.html)
// Open it directly, or via `npm start` at http://localhost:8787 to enable AI image analysis.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: 'dist-single',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
});
