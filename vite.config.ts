import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { mw2Data } from './tools/vite-plugin-mw2-data.ts';

export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), 'MW2_') };
  return {
    plugins: [react(), mw2Data(env)],
    server: { port: 5173 },
  };
});
