import {beforeAll,afterAll,it,expect} from 'vitest';
import {testPool,resetDatabase} from '@cisme/testkit';
import {operationalSignals} from '../../services/api/src/operationalSignals';
const pool=testPool();beforeAll(async()=>resetDatabase(pool));afterAll(async()=>pool.end());
it('projects actionable aggregate facts without payloads and never automatically retries or infers failure',async()=>{
 const empty=await operationalSignals(pool);expect(empty.signals).toEqual([]);expect(empty.oldestOutboxSeconds).toBeNull();
 await pool.query(`INSERT INTO outbox_event(event_type,aggregate_type,aggregate_id,aggregate_version,business_key,payload,occurred_at,dead_lettered_at,dead_letter_reason)
  VALUES('synthetic.probe','member',gen_random_uuid(),1,'ops-synthetic-private-key','{"private":"never-export-this"}',now()-interval '1 minute',now(),'SYNTHETIC_QUARANTINE')`);
 const observed=await operationalSignals(pool);
 expect(observed.counts.outbox_quarantined).toBe(1);
 expect(observed.signals).toContainEqual({kind:'outbox_quarantined',count:1,action:'investigate_original_facts',automaticRetry:false,terminalFailureInferred:false});
 expect(JSON.stringify(observed)).not.toContain('never-export-this');expect(JSON.stringify(observed)).not.toContain('ops-synthetic-private-key');
 expect((await pool.query("SELECT dead_lettered_at FROM outbox_event WHERE business_key='ops-synthetic-private-key'")).rows[0].dead_lettered_at).not.toBeNull();
});
