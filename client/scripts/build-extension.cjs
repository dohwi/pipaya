#!/usr/bin/env node
// Package plain JS async-body source with a manifest into a portable JSON file.
// Usage: node scripts/build-extension.cjs manifest.json source.js output.json
const fs = require('node:fs');
const path = require('node:path');
const [manifestPath, sourcePath, outputPath] = process.argv.slice(2);
if (!manifestPath || !sourcePath || !outputPath || process.argv.length !== 5) {
  console.error('Usage: node scripts/build-extension.cjs manifest.json source.js output.json');
  process.exit(1);
}
try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const code = fs.readFileSync(sourcePath, 'utf8');
  // Syntax check only: never evaluate author code during packaging.
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  new AsyncFunction('sdk', code);
  const json = JSON.stringify({ manifest, code }, null, 2) + '\n';
  if (Buffer.byteLength(code, 'utf8') > 128 * 1024 || Buffer.byteLength(json, 'utf8') > 256 * 1024) throw new Error('Extension package exceeds size limits');
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, json);
  console.log(`Built ${outputPath} (${Buffer.byteLength(json, 'utf8')} bytes). The client validates manifest and permissions on import.`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
