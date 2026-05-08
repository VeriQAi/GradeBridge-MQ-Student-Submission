import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const REPO = 'GradeBridge-MQ-Student-Submission';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? `/${REPO}/` : '/',
}));
