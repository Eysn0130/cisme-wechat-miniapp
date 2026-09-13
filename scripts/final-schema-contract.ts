import type pg from "pg";

type Database=pg.Pool|pg.PoolClient;
type Named={table_name:string;name:string;definition:string};

/** Query the *result* of all forward migrations. A string in an old migration
 * does not prove that a later migration retained the protection. */
export async function assertFinalSchemaContract(db:Database){
  const requiredTables=[
    "commercial_membership","commercial_membership_event","commercial_referral_code","commercial_referral_relation",
    "commission_rate_rule","commission_order_snapshot","commission_ledger_entry","commission_payment_inbox",
    "commerce_payment_attempt","commerce_refund_request","commerce_fulfillment_attestation",
    "commission_settlement_request","commission_settlement_allocation","commission_transfer_fact",
    "commission_credit_conversion","commission_credit_source","commission_credit_entry",
    "commission_transfer_callback_inbox","commerce_trade_bill_batch","commerce_trade_bill_row",
    "commission_refund_intent","commission_refund_inbox","ugc_post","ugc_post_revision","ugc_media_asset",
    "ugc_post_media","ugc_safety_scan","ugc_safety_callback_inbox","ugc_comment_safety_scan",
    "ugc_go_live_approval","ugc_post_review_action","ugc_block_relation","ugc_author_follow","ugc_report","ugc_post_appeal"
  ];
  const tables=(await db.query<{name:string}>(`SELECT c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'`)).rows;
  const tableNames=new Set(tables.map(row=>row.name));
  for(const table of requiredTables)if(!tableNames.has(table))throw new Error(`FINAL_SCHEMA_TABLE_MISSING:${table}`);

  const constraints=(await db.query<Named>(`SELECT c.conrelid::regclass::text AS table_name,c.conname AS name,
    pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
    JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'`)).rows;
  const constraint=(table:string,name:string,part:string)=>{
    const found=constraints.find(row=>row.table_name===table&&row.name===name);
    if(!found||!found.definition.includes(part))throw new Error(`FINAL_SCHEMA_CONSTRAINT_MISSING:${table}.${name}:${part}`);
  };
  constraint("commerce_order","commerce_order_status_check","paid");
  constraint("commerce_order","commerce_order_paid_at_check","paid_at IS NOT NULL");
  constraint("commerce_order","commerce_order_transaction_source_kind_check","verified_commerce");
  constraint("ugc_post","ugc_post_published_pointer_check","published_revision IS NOT NULL");
  constraint("ugc_post","ugc_post_published_revision_fk","ugc_post_revision");
  constraint("ugc_media_asset","ugc_media_approved_derivatives","thumbnail_object_key IS NOT NULL");
  constraint("commission_rate_rule","commission_rate_request_pair_check","request_fingerprint");
  constraint("commission_rate_rule","commission_rate_action_basis_check","action");
  constraint("commission_payment_inbox","payment_retry_quarantine_check","quarantined_at");
  constraint("commission_refund_inbox","refund_retry_quarantine_check","quarantined_at");
  constraint("commission_ledger_entry","commission_accrual_positive","amount_cents > 0");
  constraint("commission_ledger_entry","commission_refund_negative","amount_cents < 0");
  constraint("commerce_payment_attempt","commerce_payment_attempt_state_check","prepay_ready");
  constraint("commerce_payment_attempt","commerce_payment_attempt_quote_id_fkey","commerce_checkout_quote");
  constraint("commerce_refund_request","commerce_refund_request_state_check","requested");
  constraint("commission_refund_intent","commission_refund_intent_request_id_fkey","commerce_refund_request");
  constraint("commission_refund_intent","commission_refund_submission_lease_check","submission_lease_until");
  constraint("commission_refund_intent","commission_refund_reconcile_lease_check","reconcile_lease_until");
  constraint("commerce_fulfillment_attestation","commerce_fulfillment_attestation_state_check","verified");
  constraint("commission_ledger_entry","commission_release_positive","amount_cents > 0");
  constraint("commission_settlement_request","commission_settlement_request_state_check","processing");
  constraint("commission_ledger_entry","commission_settlement_positive","amount_cents > 0");
  constraint("commission_ledger_entry","commission_credit_conversion_sign_check","credit_conversion_reversal");
  constraint("commission_credit_conversion","commission_credit_conversion_tax_policy_version_check","isolated-synthetic-zero-withholding-v1");
  constraint("commission_credit_conversion","commission_credit_conversion_check2","cancel_hash IS NOT NULL");
  constraint("commission_credit_entry","commission_credit_entry_check1","purchase_order_id IS NOT NULL");
  constraint("authority_grant","authority_grant_capability_check","commission.settlement.approve");
  constraint("authority_grant","authority_grant_capability_check","commerce.money.reconcile");
  constraint("commission_transfer_callback_inbox","commission_transfer_callback_inbox_state_check","pending");
  constraint("ugc_report","ugc_report_terminal_decision_check","decision_code IS NOT NULL");
  constraint("ugc_post_appeal","ugc_appeal_decision_complete","decision_code");
  constraint("commerce_trade_bill_batch","commerce_trade_bill_batch_bill_type_check","REFUND");
  constraint("commerce_trade_bill_row","commerce_trade_bill_row_status_check","exception");

  const indexes=(await db.query<{name:string;definition:string}>(`SELECT indexname AS name,indexdef AS definition
    FROM pg_indexes WHERE schemaname='public'`)).rows;
  for(const [name,part] of [
    ["commission_one_accrual_per_order","UNIQUE"],
    ["commission_one_reversal_per_refund_fact","UNIQUE"],
    ["commission_refund_one_applied_success","UNIQUE"],
    ["commission_refund_provider_success_once","UNIQUE"],
    ["commission_rate_request_unique","UNIQUE"],
    ["commission_payment_inbox_due","next_attempt_at"],
    ["commission_refund_inbox_due","next_attempt_at"],
    ["commerce_payment_attempt_state","updated_at"],
    ["commerce_refund_request_order","created_at"],
    ["commerce_refund_request_queue","created_at"],
    ["commerce_refund_decision_key","UNIQUE"],
    ["commission_refund_intent_submission_due","submission_next_attempt_at"],
    ["commerce_fulfillment_queue","created_at"],
    ["commerce_fulfillment_decision_key","UNIQUE"],
    ["commission_one_release_per_order","UNIQUE"],
    ["commission_settlement_queue","created_at"],
    ["commission_settlement_due","next_attempt_at"],
    ["commission_settlement_member","created_at"],
    ["commission_settlement_decision_key","UNIQUE"],
    ["commission_settlement_allocation_order","order_id"],
    ["commission_transfer_fact_request","observed_at"],
    ["commission_settlement_fact_order","UNIQUE"],
    ["commission_credit_conversion_member_id_idempotency_key_key","UNIQUE"],
    ["commission_credit_source_order","order_id"],
    ["commission_credit_entry_source","source_id"],
    ["commission_transfer_callback_due","next_attempt_at"],
    ["ugc_media_source_post","source_post_id"],
    ["ugc_report_queue","created_at"],
    ["ugc_post_appeal_queue","created_at"],
    ["commerce_trade_bill_batch_bill_date_bill_type_merchant_id_key","UNIQUE"],
    ["commerce_trade_bill_row_exception","batch_id"]
  ] as const){
    if(!indexes.find(row=>row.name===name&&row.definition.includes(part)))throw new Error(`FINAL_SCHEMA_INDEX_MISSING:${name}`);
  }

  const triggers=(await db.query<{table_name:string;name:string}>(`SELECT t.tgrelid::regclass::text AS table_name,t.tgname AS name
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname='public'`)).rows;
  const triggerNames=new Set(triggers.map(row=>`${row.table_name}.${row.name}`));
  for(const trigger of [
    "commercial_referral_relation.commercial_referral_relation_guard",
    "commercial_referral_code.commercial_referral_code_guard",
    "commission_rate_rule.commission_rate_rule_guard",
    "commission_payment_inbox.commission_payment_inbox_guard",
    "commission_refund_inbox.commission_refund_inbox_guard",
    "commerce_payment_attempt.commerce_payment_attempt_guard",
    "commerce_refund_request.commerce_refund_request_guard",
    "commission_refund_intent.commission_refund_submission_guard",
    "commerce_fulfillment_attestation.commerce_fulfillment_attestation_guard",
    "commission_ledger_entry.commission_release_source",
    "commission_settlement_request.commission_settlement_request_guard",
    "commission_settlement_allocation.commission_settlement_allocation_immutable",
    "commission_transfer_fact.commission_transfer_fact_immutable",
    "commission_ledger_entry.commission_settlement_source",
    "commission_credit_conversion.commission_credit_conversion_guard",
    "commission_credit_source.commission_credit_source_immutable",
    "commission_credit_entry.commission_credit_entry_immutable",
    "commission_transfer_callback_inbox.commission_transfer_callback_guard",
    "commission_ledger_entry.commission_accrual_source",
    "commission_ledger_entry.commission_refund_reversal_source",
    "ugc_post.ugc_post_update_guard",
    "ugc_safety_scan.ugc_safety_scan_guard",
    "emergency_switch.emergency_switch_ugc_approval",
    "ugc_report.ugc_report_terminal_guard",
    "ugc_post_appeal.ugc_post_appeal_terminal_guard",
    "commerce_trade_bill_batch.commerce_trade_bill_batch_immutable",
    "commerce_trade_bill_row.commerce_trade_bill_row_immutable"
  ])if(!triggerNames.has(trigger))throw new Error(`FINAL_SCHEMA_TRIGGER_MISSING:${trigger}`);
  return {tables:requiredTables.length,constraints:33,indexes:31,triggers:27};
}
