// Source inventory only: never a WXML interpreter, authorization audit or device result.
// Run from the repo root: node docs/evidence/commercial-release-audit-20260921/inventory.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const native = path.join(root, 'apps/miniprogram');
const app = JSON.parse(fs.readFileSync(path.join(native, 'app.json'), 'utf8'));
const routes = [...app.pages, ...app.subPackages.flatMap(p => p.pages.map(page => `${p.root}/${page}`))];
const unique = values => [...new Set(values)].sort();
const inventory = routes.map(route => {
  const files = ['ts', 'wxml', 'wxss'].map(extension => {
    const file = `apps/miniprogram/${route}.${extension}`;
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    return { file, source, sha256: createHash('sha256').update(source).digest('hex') };
  });
  const [logic, markup, style] = files.map(file => file.source);
  const locate = (source, pattern) => [...source.matchAll(pattern)].map(match => ({
    line: source.slice(0, match.index).split('\n').length, expression: match[0]
  }));
  return {
    route,
    sourceFiles: files.map(({ file, sha256 }) => ({ file, sha256 })),
    apiPathTokens: unique([...logic.matchAll(/\/v1\/[\w/?=${}.-]+/g)].map(m => m[0])),
    lifecycleHooks: unique([...logic.matchAll(/\b(onLoad|onShow|onHide|onUnload)\s*\(/g)].map(m => m[1])),
    eventHandlerTokens: unique([...markup.matchAll(/(?:bind|catch)(?::?\w+)=["']([^"']+)["']/g)].map(m => m[1])),
    buttonCount: [...markup.matchAll(/<button\b/g)].length,
    inputCount: [...markup.matchAll(/<(?:input|textarea)\b/g)].length,
    fontSizes: unique([...style.matchAll(/font-size\s*:\s*([^;}]+)/g)].map(m => m[1])),
    motionDeclarations: unique([...style.matchAll(/(?:animation|transition|backdrop-filter)\s*:\s*([^;}]+)/g)].map(m => m[1])),
    parallelBarriers: locate(logic, /Promise\.all\(/g),
    releaseCopyMarkers: locate(markup, /[^<>\n]*(?:尚未开放|尚未批准|仅.{0,8}测试|隔离测试|测试预览)[^<>\n]*/g),
    nativeVisualAcceptance: 'not_verified',
    businessClosure: 'requires_scenario_evidence'
  };
});
const output = { schemaVersion: 1,
  scope: '37 route TS/WXML/WXSS source inventory; regex tokens omit wrapper internals and template scope. Counts do not prove executed requests, styling, state coverage or business correctness.',
  routes: inventory };
fs.writeFileSync(new URL('./page-inventory.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ routes: inventory.length, sourceFiles: inventory.length * 3 }));
