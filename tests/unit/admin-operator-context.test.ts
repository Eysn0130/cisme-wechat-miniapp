import {it,expect,vi} from 'vitest';
import {inOperatorContext} from '../../apps/admin/src/operatorContext.js';
const context={api:'https://synthetic.invalid',token:'synthetic-session'};
it('uses only the captured operator and returns a result if context remains current',async()=>{
 const run=vi.fn(async captured=>{expect(captured).toEqual(context);return 'result';});
 expect(await inOperatorContext(()=>context,run)).toBe('result');
});
it.each(['token','api'])('rejects a late result when %s changes, including an empty value',async field=>{
 const current={...context};
 await expect(inOperatorContext(()=>current,async()=>{current[field as 'api'|'token']='';return new Blob(['synthetic personal export']);})).rejects.toThrow('已改变');
});
it.each([{api:'',token:'synthetic-session'},{api:'https://synthetic.invalid',token:''}])('does not reuse or send a cleared credential',async current=>{
 const run=vi.fn();await expect(inOperatorContext(()=>current,run)).rejects.toThrow('请先填写');expect(run).not.toHaveBeenCalled();
});
