import { it, expect } from 'vitest';
import { resetDatabase, testPool } from '@cisme/testkit';
import { communityFollowingScenario } from './community-following-scenario';
it('connects authenticated author following to newly published posts without bypassing publication or privacy gates',async()=>{
 const pool=testPool();try{await resetDatabase(pool);expect((await communityFollowingScenario(pool)).passed).toBe(true);}finally{await pool.end();}
},120000);
