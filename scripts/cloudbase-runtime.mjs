import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const archiveName = 'node-v24.14.0-linux-x64';
const archiveSha256 = '41cd79bb7877c81605a9e68ec4c91547774f46a40c67a17e34d7179ef11729df';

export async function bundleCloudbaseRuntime(output) {
  const cache = fileURLToPath(new URL('../tmp/cloudbase-runtime/', import.meta.url));
  await mkdir(cache, { recursive: true });
  const archivePath = resolve(cache, `${archiveName}.tar.xz`);
  let archive;
  try { archive = await readFile(archivePath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(`https://nodejs.org/dist/v24.14.0/${archiveName}.tar.xz`, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error('NODE_RUNTIME_DOWNLOAD_FAILED');
    archive = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(archive).digest('hex') !== archiveSha256) throw new Error('NODE_RUNTIME_CHECKSUM_MISMATCH');
    await writeFile(archivePath, archive);
  }
  if (createHash('sha256').update(archive).digest('hex') !== archiveSha256) throw new Error('NODE_RUNTIME_CHECKSUM_MISMATCH');
  execFileSync('tar', ['-xJf', archivePath, '-C', cache, `${archiveName}/bin/node`, `${archiveName}/LICENSE`]);
  const binary = await readFile(resolve(cache, archiveName, 'bin/node'));
  const binarySha256 = createHash('sha256').update(binary).digest('hex');
  const compressedPath = resolve(cache, `${archiveName}-q11.br`);
  let compressed;
  try {
    compressed = await readFile(compressedPath);
    if (createHash('sha256').update(brotliDecompressSync(compressed)).digest('hex') !== binarySha256) throw new Error('COMPRESSED_RUNTIME_CHECKSUM_MISMATCH');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log('Compressing pinned Node.js runtime for the CloudBase upload limit.');
    compressed = brotliCompressSync(binary, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
    await writeFile(compressedPath, compressed);
  }
  await writeFile(resolve(output, 'node.br'), compressed);
  await copyFile(resolve(cache, archiveName, 'LICENSE'), resolve(output, 'NODE-LICENSE'));
  // Stream to limit cold-start memory; verify the executable before launching it.
  await writeFile(resolve(output, 'unpack.cjs'), `const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { createBrotliDecompress } = require('node:zlib');
const { createHash } = require('node:crypto');
(async () => {
  const path = '/tmp/cisme-node24';
  await pipeline(fs.createReadStream('/var/user/node.br'), createBrotliDecompress(), fs.createWriteStream(path, { mode: 0o755 }));
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== '${binarySha256}') throw new Error('RUNTIME_CHECKSUM_MISMATCH');
})().catch(() => { console.error('CISME_RUNTIME_UNPACK_FAILED'); process.exitCode = 1; });
`);
  return '/tmp/cisme-node24';
}
