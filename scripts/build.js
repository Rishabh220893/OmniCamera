import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/src', { recursive: true });
await cp('index.html', 'dist/index.html');
await cp('src/main.js', 'dist/src/main.js');
await cp('src/sceneAnalyzer.js', 'dist/src/sceneAnalyzer.js');
await cp('src/styles.css', 'dist/src/styles.css');
console.log('Built static OmniCamera app into dist/');
