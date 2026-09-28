import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mw2Data } from './tools/vite-plugin-mw2-data.ts';

// MW2_ROOT / MW2_DECOMPILED come from tools/paths.ts, which loads .env.local
// and .env itself, so the dev server, the tests and the gen scripts agree
export default defineConfig({
  plugins: [react(), mw2Data()],
  server: { port: 5173 },
});
