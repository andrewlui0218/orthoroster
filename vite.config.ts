import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    define: {
      'process.env.API_KEY': JSON.stringify(env.API_KEY)
    },
    // IMPORTANT: If deploying to https://<USERNAME>.github.io/<REPO>/, uncomment the line below and replace <REPO> with your repository name.
    // base: '/daily-staff-roster/', 
  };
});