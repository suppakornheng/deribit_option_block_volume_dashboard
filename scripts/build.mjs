import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/src/js', { recursive: true });
await mkdir('dist/src/css', { recursive: true });
await cp('index.html', 'dist/index.html');
await cp('src/js/app.js', 'dist/src/js/app.js');
