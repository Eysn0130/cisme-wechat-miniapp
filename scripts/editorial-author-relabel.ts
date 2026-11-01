import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {loadConfig} from '@cisme/config';
import {createPool} from '../services/api/src/db.js';
import {AuthorityService} from '../services/api/src/authority.js';
import {relabelEditorialAuthors,type EditorialAuthorRelabelPlan} from '../services/api/src/editorialAuthorRelabel.js';

// Offline maintenance only: a reviewed, exact-SHA plan and explicit apply are
// required. No default action, identity creation, service restart or retry.
async function main(){
  const [action,file,sha,...extra]=process.argv.slice(2);
  if(action!=='apply'||!file||!sha||!/^[0-9a-f]{64}$/.test(sha)||extra.length)
    throw new Error('EDITORIAL_RELABEL_EXPLICIT_PLAN_REQUIRED');
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  let raw:Buffer;
  try{
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size<1||stat.size>1024*1024||(stat.mode&0o077)!==0)
      throw new Error('EDITORIAL_RELABEL_PRIVATE_PLAN_REQUIRED');
    raw=await handle.readFile();
    if(raw.length!==stat.size||createHash('sha256').update(raw).digest('hex')!==sha)
      throw new Error('EDITORIAL_RELABEL_PLAN_HASH_MISMATCH');
  }finally{await handle.close();}
  const plan=JSON.parse(raw.toString('utf8')) as EditorialAuthorRelabelPlan;
  if(process.env.EXPECTED_DATABASE_NAME!=='cisme_trial')throw new Error('EDITORIAL_RELABEL_TARGET_MISMATCH');
  const config=loadConfig(),pool=createPool(config.databaseUrl);
  try{
    const result=await relabelEditorialAuthors(pool,config,new AuthorityService(pool,config.env),plan);
    process.stdout.write(JSON.stringify({ok:true,planSha256:sha,...result})+'\n');
  }finally{await pool.end();}
}
void main().catch(error=>{
  const code=typeof error?.code==='string'?error.code:typeof error?.message==='string'&&/^EDITORIAL_[A-Z_]+$/.test(error.message)?error.message:'EDITORIAL_RELABEL_FAILED';
  process.stderr.write(JSON.stringify({ok:false,code})+'\n');process.exitCode=1;
});
