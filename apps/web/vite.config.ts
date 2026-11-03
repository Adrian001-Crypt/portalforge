import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { port: Number(process.env.PF_WEB_PORT ?? 5180), proxy: { '/api': { target: `http://127.0.0.1:${process.env.PF_API_PORT ?? 4300}`, changeOrigin: false } } },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500 },
});
