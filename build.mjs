// Builds syncbuzz.html: one self-contained file with PeerJS, the app code and
// the styles inlined. The Content-Security-Policy only allows those exact
// inline blocks (by hash) and connections to the PeerJS signaling server, so
// the page can't load or run anything else.
//
// Usage: node build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const template = read('./src/template.html');
const css = `\n${read('./src/style.css').trim()}\n`;
const peerjs = read('./vendor/peerjs-1.5.5.min.js')
  .replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '')
  .trim();
const app = read('./src/app.js').trim();
const script = `\n/* PeerJS 1.5.5, MIT License, https://github.com/peers/peerjs */\n${peerjs}\n;\n${app}\n`;

for (const [name, text] of [['script', script], ['style', css]]) {
  if (/<\/(script|style)|<!--/i.test(text)) throw new Error(`${name} contains a sequence that would break inline embedding`);
}

const sha = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
const csp = [
  "default-src 'none'",
  `script-src ${sha(script)}`,
  `style-src ${sha(css)}`,
  'connect-src wss://0.peerjs.com https://0.peerjs.com',
  'img-src data:',
  "base-uri 'none'",
  "form-action 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');

const out = template
  .replace('%CSP%', () => csp)
  .replace('%STYLE%', () => css)
  .replace('%SCRIPT%', () => script);

writeFileSync(new URL('./syncbuzz.html', import.meta.url), out);
// Same page as index.html, so the GitHub Pages link is just the site address.
writeFileSync(new URL('./index.html', import.meta.url), out);
console.log(`syncbuzz.html and index.html written (${(out.length / 1024).toFixed(1)} KB)`);
