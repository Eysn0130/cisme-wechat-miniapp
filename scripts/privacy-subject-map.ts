import {readFile,writeFile} from 'node:fs/promises';
type Table={table:string;columns:Array<{name:string;type:string;nullable:boolean}>;foreignKeys:Array<{column:string;table:string;referencedColumn:string}>};
const input=process.argv[2];if(!input)throw new Error('EXPLICIT_SYNTHETIC_SCHEMA_METADATA_REQUIRED');
const schema=JSON.parse(await readFile(input,'utf8')) as {kind:string;migrationSetSha256:string;tables:Table[]};
if(schema.kind!=='synthetic-migrated-schema-only-NOT-personal-data-export')throw new Error('SCHEMA_METADATA_ONLY');
const tables=new Map(schema.tables.map(t=>[t.table,t]));
const allow:Record<string,string[]>={member:['id','display_name','created_at'],member_profile:['wechat_handle','updated_at']};
const special:Record<string,string>={
 commerce_aftersale_case:'member_id/order_id identify buyer; claim_basis, return_destination, return_tracking, reason and exception_evidence_reference are private. exception_approved_by is a separate operator. The support_conversation_id links the existing customer service thread; it is not another claim. The case and refund, receipt, inspection and inventory facts remain distinct. Never raw-export reasons, evidence references or contacts across subjects.',
 commerce_aftersale_event:'case_id identifies buyer; actor_member_id is the customer or a separately authorized operator. Notes may contain third-party data. Immutable history is not a blanket retention approval.',
 commerce_aftersale_return_instruction:'case_id identifies buyer; issued_by is a separate operator. The recipient, phone, region and address may identify a third party. Each version is immutable and must be projected to the case owner only; do not export all versions as a general member profile or delete while return/dispute duties remain.',
 commerce_shipment:'order_id identifies buyer; created_by_member_id is operator, not the buyer. Receipt fact is independent of carrier state and refund/commission eligibility.',
 commerce_shipment_line:'Resolve buyer through shipment/order; product quantities are immutable fulfillment evidence.',
 commerce_shipment_event:'Resolve buyer through shipment/order; actor_principal_id identifies operator or owner separately. No raw event export; preserve retention and legal holds.',
 commerce_shipping_sync:'order_id resolves the buyer via commerce_order; created_by_member_id is a separate operator actor. encrypted_parcel contains tracking and masked contact, never raw-export ciphertext. Shipping synchronization does not prove receipt or authorize deletion; apply object-specific retention and legal holds.',
 audit_log:'principal_id joins provider:id of wechat_identity or member:member.id; object_type/object_id and JSON snapshots are polymorphic and may include other people. Never export raw snapshots.',
 idempotency_operation:'principal_id joins canonical identity or member:member.id; operation/business_key are typed object references. Never export raw response_body, key or request_hash.',
 outbox_event:'aggregate_type/aggregate_id resolves through the event catalog; payload may contain several subjects. Never infer ownership from UUID alone or export raw payload.',
 legal_hold_binding:'object_type/object_id requires typed subject/object resolver; hold overrides erasure eligibility. No broad member cascade.',
 legal_hold:'approved_by/released_by are operator actors; bound subjects are indirect via legal_hold_binding. Not a public/legal-hold export.',
 commerce_trade_bill_row:'out_trade_no joins commerce_order.order_number; out_refund_no joins commission_refund_intent.out_refund_no; related_id is typed by batch bill_type, not a general UUID ownership predicate.',
 ugc_report:'reporter and reported subject are distinct; target_type/target_id resolves post/comment/member; never disclose reporter identity to reported author.',
 moderation_case:'target_type/target_id plus source_report_id; reporter, target author and operator have different field rights.',
 ugc_safety_callback_inbox:'trace_id joins ugc_safety_scan.trace_id or other typed scan records; callback payload is private security evidence, not a member export.',
 support_message:'conversation member is owner of conversation access; sender_principal_id may identify another person; attachments, order_snapshot and case-linked return_instruction_snapshot require independent projection and retention. An old valid address version must remain traceable for in-transit disputes.',
 privacy_request_member_reply:'privacy_request_id identifies the request owner, and member_id must match it. Reply body is private to that member and authorized privacy operators; it is not a production export or erasure permission. Immutable evidence requires an object-specific retention and backup rule.',
 privacy_request_operator_reply:'privacy_request_id identifies the owner. The response body is private to that member and authorized privacy operators; actor_principal_id identifies a separate operator. Historical snapshots carry only the last response known before this migration. Immutable evidence requires an object-specific retention and backup rule.',
 ugc_author_follow:'follower and followed are different subjects; each relationship must not imply exporting the other member profile.',
 commercial_referral_relation:'referred and referrer are different subjects; only approved own projection, never both member profiles.',
 commission_order_snapshot:'buyer and referrer are distinct; financial retention and each subject projection are independent.'
};
function paths(name:string,seen=new Set<string>()):string[][]{
 if(name==='member')return [['member.id']];
 if(seen.has(name)||seen.size>=8)return [];
 const next=new Set([...seen,name]);
 return (tables.get(name)?.foreignKeys??[]).flatMap(f=>paths(f.table,next).map(tail=>[`${name}.${f.column} -> ${f.table}.${f.referencedColumn}`,...tail])).slice(0,64);
}
const result={schemaVersion:1,migrationSetSha256:schema.migrationSetSha256,scope:'schema/subject review map; no personal rows read',
 fullMemberExportImplemented:false,productionErasureEnabled:false,retentionApproved:false,releaseReady:false,
 rules:{export:'Only existing synthetic member_profile_only archive fields are allowed. All other columns excluded; no SELECT * exporter.',
  subject:'FK paths are candidate relationships, not authorization. Actor, beneficiary, reporter and owner must remain distinct; polymorphic notes require typed resolver.',
  retention:'Transaction and transaction-linked support have a declared 36-month baseline. Ordinary support needs a finite, enabled category policy and a separate automatic purge gate. Every object remains subject to legal holds; no general account erasure is authorized.',
  identity:'Canonical principal uses wechat_identity.provider + colon + wechat_identity.id, or explicit member:member.id. OpenID is not a public subject key.'},
 tables:schema.tables.map(t=>({table:t.table,subjectPaths:paths(t.table),
  actorColumns:t.columns.filter(c=>/principal|created_by|updated_by|approved_by|requested_by|decided_by|reviewed_by/.test(c.name)).map(c=>c.name),
  specialHandling:special[t.table]??(paths(t.table).length?'Follow each distinct subject role; shared rows require field-specific projection.':'No FK path to member; examine operator text fields/config/reference purpose before deciding non-personal.'),
  exportFields:allow[t.table]??[],excludedFields:t.columns.map(c=>c.name).filter(name=>!(allow[t.table]??[]).includes(name)),
  syntheticErasureFields:t.table==='member_profile'?['wechat_handle']:[],productionErasure:'DISABLED',
  retention:['support_conversation','support_message'].includes(t.table)
    ?'ORDINARY_SUPPORT_FINITE_POLICY_AND_AUTO_GATE; TRANSACTION_LINKED_EXCLUDED'
    :'POLICY_PENDING_NO_AUTOMATIC_DELETION',
  fullSubjectResolverStatus:special[t.table]?'TYPED_RESOLVER_REQUIRED':'RELATIONSHIPS_MAPPED_NOT_EXPORT_AUTHORIZATION'}))};
await writeFile('docs/privacy/subject-data-map.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({tables:result.tables.length,withSubjectPaths:result.tables.filter(t=>t.subjectPaths.length).length,fullMemberExportImplemented:false}));
