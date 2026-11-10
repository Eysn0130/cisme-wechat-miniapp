import sharp from 'sharp';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const design=resolve(root,'docs/design/commerce-20261110');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const originals=JSON.parse(await readFile(resolve(design,'source-manifest.json'),'utf8')).files;
const generated=JSON.parse(await readFile(resolve(design,'generation-v4.json'),'utf8')).selectedAssets;
const clean=JSON.parse(await readFile(resolve(design,'source-manifest.json'),'utf8')).derivedAssets;
const jobs=[
  ...originals.map(a=>({source:resolve(design,a.copy),expected:a.sha256,file:`pages/product/assets/${a.product}-${a.copy.match(/-(\d+)\.PNG$/)[1]}.jpg`,quality:82})),
  ...generated.map(a=>({source:resolve(design,a.file),expected:a.sha256,file:`assets/commerce/product${a.product}-glass-v4b.jpg`,quality:88})),
  ...clean.map(a=>({source:resolve(design,a.file),expected:a.sha256,file:a.key.endsWith('hero')?`assets/commerce/product${a.key[1]}-hero-v2.jpg`:`pages/product/assets/product${a.key[1]}-clean-v2.jpg`,quality:84}))
];
const files=[];
for(const job of jobs){
  const input=await readFile(job.source);
  if(sha(input)!==job.expected)throw Error(`COMMERCE_SOURCE_HASH_CHANGED:${job.source}`);
  const image=await sharp(input).jpeg({quality:job.quality,mozjpeg:true}).toBuffer();
  if(image.length>200000)throw Error(`COMMERCE_IMAGE_BUDGET:${job.file}:${image.length}`);
  const path=resolve(root,'apps/miniprogram',job.file);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,image);
  const dimensions=await sharp(image).metadata();
  files.push({file:job.file,source:job.source,sourceSha256:job.expected,sha256:sha(image),bytes:image.length,width:dimensions.width,height:dimensions.height,quality:job.quality});
}
await writeFile(resolve(root,'docs/evidence/commerce-native-20261110/packaged-assets.json'),JSON.stringify({scope:'JPEG encoding only, full original dimensions and composition; PNG masters retained in design source. No new raster design or copy.',files},null,2)+'\n');
console.log(JSON.stringify({files:files.length,totalBytes:files.reduce((sum,a)=>sum+a.bytes,0)},null,2));
