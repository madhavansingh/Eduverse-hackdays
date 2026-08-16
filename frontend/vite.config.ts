import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5189,
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Raise chunk size warning threshold (default 500kb is too aggressive for a full-featured SPA)
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: {
          // Core React runtime - cached aggressively
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          // Animation library - large but stable
          'framer-motion': ['framer-motion'],
          // Charts / data-vis - only needed on analytics/exam pages
          'recharts': ['recharts'],
          // Math rendering - only needed on problem solver & practice exam
          'katex': ['katex'],
          // i18n - all languages bundled together
          'i18n': ['i18next', 'react-i18next'],
          // UI icons - lucide-react is sizeable
          'icons': ['lucide-react'],
          // Socket.io client
          'socket-io': ['socket.io-client'],
          // PDF generation - only triggered on export
          'pdf': ['jspdf', 'jspdf-autotable'],
          // Utility libraries
          'utils': ['clsx', 'class-variance-authority', 'tailwind-merge', 'date-fns'],
        },
      },
    },
  },
});
