import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  return {
    plugins: [react()],
    // IMPORTANT: If deploying to https://<USERNAME>.github.io/<REPO>/, uncomment the line below and replace <REPO> with your repository name.
    // base: '/daily-staff-roster/', 
  };
});