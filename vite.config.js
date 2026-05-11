import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, createReadStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const staticFiles = [
  'script-model.js',
  'roadmap-model.js',
  'profile-store.js',
  'legacy.html',
  'importer.html',
  'importer.js',
  'scores.json'
];

function copyStageCueStaticFiles(){
  return {
    name: 'copy-stagecue-static-files',
    closeBundle(){
      const root = process.cwd();
      const out = join(process.cwd(), 'dist');
      for(const file of staticFiles){
        const target = join(out, file);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(root, file), target);
      }
    }
  };
}

function servePrivateScriptsInDev(){
  return {
    name: 'serve-private-scripts-in-dev',
    configureServer(server){
      server.middlewares.use((request, response, next) => {
        const pathname = decodeURIComponent((request.url || '').split('?')[0]);
        if(!pathname.endsWith('.json')) return next();
        const safeName = pathname.replace(/^\/+/, '');
        if(safeName.includes('..') || safeName.includes('/')) return next();
        const file = join(process.cwd(), 'private', 'scripts', safeName);
        if(!existsSync(file)) return next();
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        createReadStream(file).pipe(response);
      });
    }
  };
}

export default defineConfig({
  root: '.',
  plugins: [react(), servePrivateScriptsInDev(), copyStageCueStaticFiles()],
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    host: '127.0.0.1',
    port: 5173
  },
  preview: {
    host: '127.0.0.1',
    port: 4173
  }
});
