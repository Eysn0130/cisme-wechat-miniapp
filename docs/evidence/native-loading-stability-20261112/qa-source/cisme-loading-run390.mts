import{setup,capture,restore}from'./cisme-loading-native.mts';import{execFile}from'node:child_process';import{promisify}from'node:util';import{writeFile}from'node:fs/promises';
const exec=promisify(execFile);console.log(await setup());
for(const [script,args]of[['cisme-loading-geometry.mts',['final-390']],['cisme-loading-interrupt.mts',['390']]]as const){const r=await exec('npx',['tsx','/private/tmp/'+script,...args],{cwd:'/Users/mini/CISME',timeout:90000,maxBuffer:2e6});console.log(r.stdout);}
await capture('final-admin-390');const result=await restore();await writeFile('/private/tmp/cisme-loading-restoration.log',JSON.stringify(result,null,2)+'\n');console.log(result);
