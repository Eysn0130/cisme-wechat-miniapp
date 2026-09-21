import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {loadConfig} from '@cisme/config';
import {TEST_DATABASE_URL,testPool,resetDatabase} from '@cisme/testkit';
import {PhoneBinding} from '../../services/api/src/phoneBinding';
import {DeliveryAddressService} from '../../services/api/src/deliveryAddress';
const pool=testPool();
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'synthetic-member-revoke',UPLOAD_TOKEN_SECRET:'synthetic-upload',
 WECHAT_APP_ID:'wx0000000000000001',WECHAT_APP_SECRET:'synthetic-secret',WECHAT_PHONE_BINDING_ENABLED:'true',CONTACT_ENCRYPTION_KEY:'ab'.repeat(32),CONTACT_HASH_KEY:'cd'.repeat(32)});
const address={recipientName:'Synthetic',phone:'13800000001',province:'Synthetic',city:'Synthetic',district:'Synthetic',detail:'Synthetic only',label:'home',isDefault:true};
const addresses=new DeliveryAddressService(pool,config);
let member:string,saved:{id:string;version:number};
beforeAll(async()=>{await resetDatabase(pool);member=(await pool.query("INSERT INTO member(display_name) VALUES('synthetic revoked') RETURNING id")).rows[0].id;
 saved=await addresses.create(member,'synthetic-address-before-block',address);
 await pool.query("INSERT INTO member_contact(member_id,phone_encrypted,phone_hmac,phone_masked,key_version) VALUES($1,'synthetic-cipher',$2,'***0001','synthetic')",[member,'a'.repeat(64)]);
 await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[member]);});
afterAll(async()=>pool.end());
it('refuses every address mutation after the member is blocked without changing saved facts',async()=>{
 const before=(await pool.query('SELECT id,version,encrypted_payload,deleted_at,is_default FROM member_delivery_address WHERE member_id=$1',[member])).rows;
 for(const command of [()=>addresses.create(member,'synthetic-blocked-create',{...address,detail:'Changed'}),
  ()=>addresses.update(member,saved.id,{...address,detail:'Changed',expectedVersion:saved.version}),
  ()=>addresses.setDefault(member,saved.id,{expectedVersion:saved.version}),
  ()=>addresses.remove(member,saved.id,{expectedVersion:saved.version})])await expect(command()).rejects.toMatchObject({code:'AUTH_REVOKED'});
 expect((await pool.query('SELECT id,version,encrypted_payload,deleted_at,is_default FROM member_delivery_address WHERE member_id=$1',[member])).rows).toEqual(before);
});
it('refuses phone authorization and unbind after revocation before provider or database side effects',async()=>{
 const transport=vi.fn<typeof fetch>(),phone=new PhoneBinding(pool,config,transport);
 await expect(phone.bind(member,'synthetic-never-send')).rejects.toMatchObject({code:'AUTH_REVOKED'});
 await expect(phone.unbind(member)).rejects.toMatchObject({code:'AUTH_REVOKED'});
 expect(transport).not.toHaveBeenCalled();expect((await pool.query('SELECT phone_masked FROM member_contact WHERE member_id=$1',[member])).rows[0].phone_masked).toBe('***0001');
});
it('orders an already-authorized phone commit before concurrent member suspension',async()=>{
 const owner=(await pool.query("INSERT INTO member(display_name) VALUES('synthetic in-flight') RETURNING id")).rows[0].id;
 let entered!:()=>void,release!:()=>void;
 const dispatched=new Promise<void>(resolve=>{entered=resolve}),finish=new Promise<void>(resolve=>{release=resolve});
 const transport=vi.fn<typeof fetch>().mockImplementation(async(input)=>{
  if(String(input).includes('stable_token'))return new Response(JSON.stringify({access_token:'synthetic',expires_in:7200}));
  entered();await finish;return new Response(JSON.stringify({errcode:0,phone_info:{purePhoneNumber:'13900000002',countryCode:'86',watermark:{appid:config.wechat.appId}}}));
 });
 const phone=new PhoneBinding(pool,config,transport),binding=phone.bind(owner,'synthetic-concurrent-code');
 const revoker=await pool.connect();
 try{
  await dispatched;await revoker.query("SET lock_timeout='100ms'");
  await expect(revoker.query("UPDATE member SET status='blocked' WHERE id=$1",[owner])).rejects.toMatchObject({code:'55P03'});
  release();expect(await binding).toMatchObject({bound:true});
  await revoker.query("UPDATE member SET status='blocked' WHERE id=$1",[owner]);
  await expect(phone.unbind(owner)).rejects.toMatchObject({code:'AUTH_REVOKED'});
  expect((await pool.query('SELECT phone_masked FROM member_contact WHERE member_id=$1',[owner])).rows[0].phone_masked).toBe('***0002');
 }finally{release();await binding.catch(()=>{});await revoker.query('RESET lock_timeout');revoker.release();}
});
