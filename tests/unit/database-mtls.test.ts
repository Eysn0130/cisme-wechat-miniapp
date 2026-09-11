import {afterEach,describe,expect,it,vi} from 'vitest';
const poolConstructor=vi.hoisted(()=>vi.fn(function(this:any,config:any){this.options=config;}));
vi.mock('pg',()=>({default:{Pool:poolConstructor}}));
import {createPool} from '../../services/api/src/db';
afterEach(()=>{vi.unstubAllEnvs();poolConstructor.mockClear();});
describe('database mutual TLS configuration',()=>{
 it('requires all certificate material and never accepts partial TLS configuration',()=>{
  vi.stubEnv('DATABASE_TLS_CA_BASE64',Buffer.from('ca').toString('base64'));
  vi.stubEnv('DATABASE_TLS_CERT_BASE64','');vi.stubEnv('DATABASE_TLS_KEY_BASE64','');
  expect(()=>createPool('postgres://test@db.test/cisme')).toThrow('DATABASE_MTLS_CONFIGURATION_INCOMPLETE');
  expect(poolConstructor).not.toHaveBeenCalled();
 });
 it('enforces certificate verification even when an old URL has permissive SSL parameters',()=>{
  for(const [key,value] of [['CA','ca'],['CERT','cert'],['KEY','key']])vi.stubEnv('DATABASE_TLS_'+key+'_BASE64',Buffer.from(value!).toString('base64'));
  createPool('postgres://test@db.test/cisme?sslmode=no-verify');
  expect(poolConstructor).toHaveBeenCalledWith(expect.objectContaining({connectionString:'postgres://test@db.test/cisme',ssl:{ca:'ca',cert:'cert',key:'key',rejectUnauthorized:true},max:10,connectionTimeoutMillis:2000,statement_timeout:2500}));
 });
 it('honours a bounded per-instance connection budget and query deadlines',()=>{
  createPool('postgres://test@db.test/cisme',{poolMax:6,globalConnectionBudget:24,instanceCount:4,poolAcquireTimeoutMs:900,statementTimeoutMs:1400,lockTimeoutMs:400,idleTransactionTimeoutMs:3000,transactionDeadlineMs:3500,transactionMaxAttempts:3});
  expect(poolConstructor).toHaveBeenCalledWith(expect.objectContaining({max:6,connectionTimeoutMillis:900,statement_timeout:1400,options:'-c lock_timeout=400 -c idle_in_transaction_session_timeout=3000'}));
 });
});
