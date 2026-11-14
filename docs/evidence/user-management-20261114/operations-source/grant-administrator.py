from pathlib import Path
from urllib.parse import urlsplit
import os,shlex,subprocess,json
os.umask(0o077)
assert os.geteuid()==0
cfg={}
for line in Path('/opt/cisme-trial/runtime.env').read_text().splitlines():
 if line and not line.startswith('#') and '=' in line:
  k,v=line.split('=',1);p=shlex.split(v);cfg[k]=p[0] if len(p)==1 else v
u=urlsplit(cfg['DATABASE_URL']);assert cfg['APP_ENV']=='staging' and u.hostname=='127.0.0.1' and u.username=='cisme_trial' and u.path=='/cisme_trial' and cfg['WECHAT_APP_ID']=='wx4eac2d4fb11d299b'
script=r"""
const {createRequire}=require('node:module'),fs=require('node:fs'),assert=require('node:assert/strict');
const {Pool}=createRequire('/opt/cisme-trial/releases/tencent-release-'+JSON.parse(fs.readFileSync('/opt/cisme-trial/operations/user-management-20261114/binding.json')).sourceHead.slice(0,12)+'/package.json')('pg');
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1});
const plan=JSON.parse(fs.readFileSync('/opt/cisme-trial/operations/user-management-20261114/binding.json'));const state='/opt/cisme-trial/user-management-upgrades/apply-'+plan.sourceHead.slice(0,12),actor='owner-authorized:20261114:user-management',source='owner-authorized:user-management-trial';
const member='8d2b65b6-c165-4186-b4d0-5fdda9c67456',appid='wx4eac2d4fb11d299b',caps=['member.profile.read','member.care.read','member.contact.read','member.export','privacy.request.manage','member.support_view'].sort();
const fingerprint=async(c,table,where,args)=>(await c.query('SELECT encode(digest(to_jsonb(t)::text,\'sha256\'),\'hex\') AS hash FROM '+table+' t WHERE '+where+' ORDER BY id',args)).rows;
(async()=>{const c=await pool.connect();try{
 assert(!fs.existsSync(state+'/admin-grant-private.json'),'GRANT_RECEIPT_ALREADY_EXISTS');
 await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await c.query("SET LOCAL lock_timeout='5s'");
 const identity=(await c.query(`SELECT m.id,m.status,(SELECT count(*)::int FROM wechat_identity w WHERE w.member_id=m.id AND w.provider='wechat_miniprogram' AND w.adapter='wechat' AND w.app_id=$2) AS n FROM member m JOIN member_card_number card ON card.member_id=m.id WHERE m.id=$1 AND card.number=1 FOR UPDATE OF m`,[member,appid])).rows;
 assert.equal(identity.length,1);assert.equal(identity[0].status,'active');assert.equal(identity[0].n,1);
 const grants=(await c.query('SELECT * FROM authority_grant WHERE member_id=$1 ORDER BY id',[member])).rows;
 const active=grants.filter(g=>g.revoked_at===null&&(g.expires_at===null||new Date(g.expires_at)>new Date()));assert.equal(active.length,15);assert(active.every(g=>!caps.includes(g.capability)));
 const before={memberFingerprint:await fingerprint(c,'member','id=$1',[member]),originalGrants:grants,verifiedCanonicalWechatIdentityCount:1,cardNumber:1};
 fs.writeFileSync(state+'/admin-grant-baseline-private.json',JSON.stringify(before)+'\n',{flag:'wx',mode:0o600});
 const added=[];for(const cap of caps){const row=(await c.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source,expires_at) VALUES($1,$2,$3,$4,'staging',$5,NULL) RETURNING id,capability`,[member,cap,actor,'用户授权完整交付管理员用户管理；为已核验最高管理员 No.00001 补齐用户资料、护理、联系方式、汇总导出、既有隐私受理与客服资料查看权限；不更改普通会员权限或资产',source])).rows[0];added.push(row);}
 const originalAfter=(await c.query('SELECT * FROM authority_grant WHERE id=ANY($1::uuid[]) ORDER BY id',[grants.map(g=>g.id)])).rows;assert.deepEqual(originalAfter,grants);assert.deepEqual(await fingerprint(c,'member','id=$1',[member]),before.memberFingerprint);
 const audited=(await c.query("SELECT count(*)::int n FROM audit_log WHERE action='authority.grant' AND object_id=ANY($1::uuid[]) AND principal_id=$2",[added.map(g=>g.id),actor])).rows[0].n;assert.equal(audited,6);
 const officers=(await c.query('SELECT count(*)::int n FROM sharing_officer WHERE member_id=$1',[member])).rows[0].n;assert.equal(officers,0);
 await c.query('COMMIT');const receipt={memberId:member,source,added,priorActiveCount:15,currentActiveCount:21,auditRows:audited,memberProfilePreserved:true,noOfficerQualificationGranted:true,environment:'staging'};fs.writeFileSync(state+'/admin-grant-private.json',JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({administrator:'No.00001',canonicalIdentityVerified:true,grantedCapabilities:caps,originalGrantsPreserved:true,memberProfilePreserved:true,noOfficerQualificationGranted:true,auditRows:audited,environment:'isolated-trial',actualMoneyOperations:0}));
 }catch(error){await c.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({code:/^[A-Z_]{5,90}$/.test(error.message||'')?error.message:'ADMIN_GRANT_REFUSED'}));process.exitCode=1;}finally{c.release();await pool.end();}})();
"""
result=subprocess.run(['/opt/node-v24.14.0-linux-x64/bin/node','-e',script],env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','DATABASE_URL':cfg['DATABASE_URL']},capture_output=True,text=True,timeout=30)
print(result.stdout,end='')
if result.returncode:print(result.stderr,end='');raise SystemExit(result.returncode)
