import {readFile, writeFile} from 'node:fs/promises';
import {assembleLegalPublication, type LegalReleaseFacts} from './legal-publication.js';

const [factsPath, outputPath] = process.argv.slice(2);
if (!factsPath || !outputPath) throw new Error('Usage: tsx scripts/prepare-legal-documents.ts VERIFIED_FACTS_JSON OUTPUT_JSON');
const base = new URL('../docs/legal/production-candidate-20260923/', import.meta.url);
const [terms, privacy, facts] = await Promise.all([
  readFile(new URL('用户协议.md', base), 'utf8'),
  readFile(new URL('隐私政策.md', base), 'utf8'),
  readFile(factsPath, 'utf8').then(value => JSON.parse(value) as LegalReleaseFacts)
]);
const documents = assembleLegalPublication(terms, privacy, facts);
await writeFile(outputPath, JSON.stringify(documents, null, 2) + '\n', {flag: 'wx'});
console.log(`Prepared ${documents.length} unpublished documents; review them before any database publication.`);
