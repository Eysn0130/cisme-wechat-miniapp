import { describe, expect, it } from 'vitest';
import { linkedOrderTerminalAt } from '../../services/api/src/supportRetention.js';

const finalized=new Date('2023-06-03T12:00:00Z');
const paid={id:'fixture',status:'paid',cancelled_at:null,expired_at:null,
  receipt_confirmed_at:null,verified_delivered_at:null,total_cents:'10000',
  succeeded_refund_cents:'10000',refund_finalized_at:finalized};

describe('linked support order end fact',()=>{
  it('uses a fully succeeded refund when a paid order was never delivered',()=>{
    expect(linkedOrderTerminalAt(paid)).toEqual(finalized);
  });
  it('does not end an order on a partial, unknown, or unfinalized refund',()=>{
    expect(linkedOrderTerminalAt({...paid,succeeded_refund_cents:'9999'})).toBeNull();
    expect(linkedOrderTerminalAt({...paid,succeeded_refund_cents:'0'})).toBeNull();
    expect(linkedOrderTerminalAt({...paid,refund_finalized_at:null})).toBeNull();
  });
  it('starts the retention clock after a later verified refund on a delivered order',()=>{
    expect(linkedOrderTerminalAt({...paid,receipt_confirmed_at:new Date('2023-06-01T12:00:00Z'),
      succeeded_refund_cents:'1000'})).toEqual(finalized);
  });
});
