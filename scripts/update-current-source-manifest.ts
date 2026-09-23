import {readFile,writeFile} from 'node:fs/promises';
import {inspectMiniProgramPackage} from './miniprogram-package-lib';
const result=await inspectMiniProgramPackage();
if(!result.ok)throw new Error(JSON.stringify(result.errors));
const path='docs/evidence/visual/current-source-acceptance.json';
const original=await readFile(path,'utf8');
const manifest=JSON.parse(original);
if(manifest.packageSourceSha256!==result.actual.sourceSha256){
 await writeFile(`docs/evidence/visual/source-acceptance-${manifest.packageSourceSha256.slice(0,12)}.json`,original);
 manifest.packageSourceSha256=result.actual.sourceSha256;
 manifest.finalResult='blocked';manifest.evidenceIndex={};manifest.devtools=null;
 manifest.routeCoverage=result.routes.map(route=>({route,matrixComplete:false,result:'blocked',evidenceFiles:[]}));
 await writeFile(path,JSON.stringify(manifest,null,2)+'\n');
}
console.log(JSON.stringify(result.actual));
