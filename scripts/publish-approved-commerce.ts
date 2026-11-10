import {loadConfig,CANONICAL_WECHAT_MINIPROGRAM_APP_ID} from '@cisme/config';
import {createPool,transaction} from '../services/api/src/db.js';
import {AuthorityService} from '../services/api/src/authority.js';
import {CommerceCatalogService} from '../services/api/src/commerceCatalog.js';

// This is an explicit owner-approved operator action, never an HTTP route or an automatic seed.
const apply=process.argv.includes('--apply');
const config=loadConfig();
const database=decodeURIComponent(new URL(config.databaseUrl).pathname.slice(1));
if(config.env!=='staging'||database!=='cisme_trial'||process.env.EXPECTED_DATABASE_NAME!=='cisme_trial'||process.env.WECHAT_APP_ID!==CANONICAL_WECHAT_MINIPROGRAM_APP_ID)throw Error('APPROVED_COMMERCE_TARGET_MISMATCH');
const operator='8d2b65b6-c165-4186-b4d0-5fdda9c67456';
const principal='wechat_miniprogram:36eece5a-d79c-4fb4-8905-bc2c83688b7d';
const authorization='owner:commerce-native-20261110';
const caps=['commerce.product.manage','commerce.qualification.manage','commerce.inventory.manage','commerce.order.read','commerce.fulfillment.manage'] as const;
const products=[
  {code:'aigerong-moisture-shampoo-280',name:'净润小紫瓶 280mL',subtitle:'买 280 mL，享 620 mL',description:'发根要蓬，头皮要润。买 280 mL，享 620 mL。',imagePath:'/assets/commerce/product1-glass-v4b.jpg',sku:{code:'AIGERONG_MOISTURE_280',label:'净润小紫瓶 280mL',priceCents:19800}},
  {code:'aigerong-scalp-repair-essence-100',name:'头皮紧致修护精华液',subtitle:'买正装头皮精华，赠洗护双正装',description:'头皮紧实，发根立得住。买正装头皮精华，赠洗护双正装。',imagePath:'/assets/commerce/product2-glass-v4b.jpg',sku:{code:'AIGERONG_SCALP_ESSENCE_100',label:'头皮紧致修护精华液 100ml',priceCents:29800}}
];
const pool=createPool(config.databaseUrl,config.database);
try{
  const actor=await pool.query(`SELECT m.id FROM member m JOIN wechat_identity w ON w.member_id=m.id
    WHERE m.id=$1 AND m.status='active' AND w.provider='wechat_miniprogram' AND w.adapter='wechat'
    AND w.app_id=$2 AND 'wechat_miniprogram:'||w.id::text=$3`,[operator,CANONICAL_WECHAT_MINIPROGRAM_APP_ID,principal]);
  if(actor.rowCount!==1)throw Error('OWNER_CANONICAL_ADMIN_IDENTITY_MISMATCH');
  const administrators=(await pool.query<{id:string}>(`SELECT DISTINCT m.id FROM member m JOIN authority_grant g ON g.member_id=m.id
    JOIN wechat_identity w ON w.member_id=m.id WHERE m.status='active' AND w.provider='wechat_miniprogram' AND w.adapter='wechat'
    AND w.app_id=$1 AND g.environment='staging' AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp()) ORDER BY m.id`,[CANONICAL_WECHAT_MINIPROGRAM_APP_ID])).rows;
  if(!administrators.some(a=>a.id===operator))throw Error('OWNER_ADMIN_NOT_PREVIOUSLY_GRANTED');
  const before=(await pool.query(`SELECT p.id,p.code,p.version,p.publication_status,p.qualification_status,p.image_path,
    s.id AS sku_id,i.stock_on_hand,i.reserved_quantity,i.version AS inventory_version,r.amount_cents
    FROM catalog_product p JOIN catalog_sku s ON s.product_id=p.id JOIN catalog_price r ON r.sku_id=s.id
    JOIN catalog_inventory_level i ON i.sku_id=s.id WHERE p.code=ANY($1::text[]) ORDER BY p.code`,[products.map(p=>p.code)])).rows;
  if(!apply){console.log(JSON.stringify({applied:false,database,environment:config.env,operator,principal,administrators,capabilities:caps,before,approvedStockPerBundle:100,products},null,2));}
  else{
    const grants=await transaction(pool,async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[authorization]);
      const changes=[];
      for(const admin of administrators)for(const capability of caps){
        const existing=await client.query(`SELECT id FROM authority_grant WHERE member_id=$1 AND environment='staging' AND capability=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR UPDATE`,[admin.id,capability]);
        if(existing.rowCount){changes.push({memberId:admin.id,capability,created:false});continue;}
        const added=(await client.query<{id:string}>(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
          VALUES($1,$2,$3,$4,'staging',$5) RETURNING id`,[admin.id,capability,'codex:owner-authorized-20261110','用户明确要求：所有管理员管理商品、审核、库存，并查看销售、导出及单笔或批量上传XLSX发货',authorization])).rows[0]!;
        await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
          VALUES($1,'authority.commerce_admin.grant','authority_grant',$2,$3,NULL,$4,$3)`,[principal,added.id,authorization,{memberId:admin.id,capability,environment:'staging',actualOperator:'codex:owner-authorized-20261110'}]);
        changes.push({memberId:admin.id,capability,created:true,grantId:added.id});
      }
      return changes;
    });
    const service=new CommerceCatalogService(pool,new AuthorityService(pool,config.env),config.env,false);
    const results=[];
    for(const input of products){
      let product:any;
      const found=(await pool.query<{id:string;created_by:string}>('SELECT id,created_by FROM catalog_product WHERE code=$1',[input.code])).rows[0];
      if(found){if(found.created_by!==principal)throw Error('APPROVED_COMMERCE_PRODUCT_OWNERSHIP_CONFLICT');product=await service.managementDetail(operator,found.id);}
      else product=await service.create(operator,principal,`commerce-20261110-create-${input.code}`,input,authorization);
      if(product.qualificationStatus==='pending')product=await service.qualify(operator,principal,product.productId,`commerce-20261110-qualify-${input.code}`,{expectedVersion:product.version,status:'eligible',reason:'所有者提供产品原图并确认产品、价格和库存，授权上架；不代表支付、运费险或积分规则已启用',evidenceRef:'docs/evidence/commerce-native-20261110/owner-authorization.json'},authorization);
      const sku=product.variants[0];
      if(!sku||sku.priceCents!==input.sku.priceCents)throw Error('APPROVED_COMMERCE_PRICE_MISMATCH');
      if(sku.stockOnHand===0&&sku.reservedQuantity===0)await service.adjustInventory(operator,principal,sku.id,`commerce-20261110-stock-${input.code}`,{expectedVersion:sku.inventoryVersion,delta:100,reason:'所有者确认：两款可售库存上调至100；之后由管理员后台按版本调整'},authorization);
      if(product.publicationStatus==='draft')product=await service.publish(operator,principal,product.productId,`commerce-20261110-publish-${input.code}`,{expectedVersion:product.version,action:'publish',reason:'所有者确认商城设计、两款真实产品、价格与库存后上架'},authorization);
      results.push(await service.managementDetail(operator,product.productId));
    }
    console.log(JSON.stringify({applied:true,authorization,database,environment:config.env,grants,products:results,paymentOrOrderCreated:false},null,2));
  }
}finally{await pool.end();}
