import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'three': ['three/webgpu', 'three/tsl'],
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
});
