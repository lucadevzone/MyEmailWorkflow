import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.MMW_PORT ?? '4310';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
});
