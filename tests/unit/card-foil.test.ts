import{afterEach,beforeEach,describe,it,expect,vi}from'vitest';
const m=vi.hoisted(()=>({reduce:false,revision:1}));
vi.mock('../../apps/miniprogram/services/layout',()=>({shouldReduceMotion:()=>m.reduce}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>m.revision}));
import{foilData,foilEvents,clearFoil,consumeFoilDrag}from'../../apps/miniprogram/services/card-foil';
let app:any,host:any,box:any,queries:any[];
const event=(x:number,y:number)=>({currentTarget:{dataset:{foilSurface:'member'}},touches:[{clientX:x,clientY:y}]}) as any;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(10000);m.reduce=false;m.revision=1;queries=[];app={globalData:{sessionToken:'A'}};host={...foilEvents,data:{...foilData},setData:vi.fn(function(this:any,patch:any){Object.assign(this.data,patch);})};vi.stubGlobal('getApp',()=>app);vi.stubGlobal('wx',{createSelectorQuery:()=>{const q={select:()=>q,boundingClientRect:(callback:any)=>{box=callback;queries.push(q);return q;},exec:()=>{}};return q;}});});
afterEach(()=>{clearFoil(host);vi.useRealTimers();vi.unstubAllGlobals();});
describe('bounded native foil gestures',()=>{
 it('updates a bounded local light position at most once per 40ms without timers',()=>{host.beginFoil(event(100,50));box({left:0,top:0,width:200,height:100});expect(host.data).toMatchObject({foilSurface:'member',foilX:50,foilY:50});vi.advanceTimersByTime(45);host.moveFoil(event(150,52));expect(host.data.foilX).toBe(75);const count=host.setData.mock.calls.length;host.moveFoil(event(170,52));expect(host.setData).toHaveBeenCalledTimes(count);expect(vi.getTimerCount()).toBe(0);});
 it('releases vertical scrolling and suppresses its stale tap while allowing a new intentional touch',()=>{host.beginFoil(event(20,20));box({left:0,top:0,width:200,height:100});host.moveFoil(event(21,70));expect(host.data.foilSurface).toBe('');expect(consumeFoilDrag(host)).toBe(true);host.beginFoil(event(30,30));host.endFoil();expect(consumeFoilDrag(host)).toBe(false);});
 it('does not apply a rectangle after hiding, changing member or changing environment',()=>{for(const change of ['hide','member','environment']){host.beginFoil(event(10,10));const callback=box;if(change==='hide')clearFoil(host);if(change==='member')app.globalData.sessionToken='B';if(change==='environment')m.revision++;const count=host.setData.mock.calls.length;callback({left:0,top:0,width:100,height:100});expect(host.setData).toHaveBeenCalledTimes(count);}});
 it('retains a static material path on reduced-performance devices',()=>{m.reduce=true;host.beginFoil(event(10,10));expect(queries).toHaveLength(0);expect(host.data).toEqual(foilData);});
});
it('stops the authored sweep on hide and does not replay it on routine tab return',async()=>{
 let component:any;vi.stubGlobal('Component',(def:any)=>{component={...def,properties:{...Object.fromEntries(Object.entries(def.properties).map(([k,v]:[string,any])=>[k,v.value])),intro:true},data:structuredClone(def.data),setData(patch:any){Object.assign(this.data,patch);}};});await import('../../apps/miniprogram/components/card-foil/index');component.lifetimes.attached.call(component);expect(component.data.introActive).toBe(true);component.methods.finishSweep.call(component);expect(component.data.introActive).toBe(false);expect(component.data.flashActive).toBe(false);component.pageLifetimes.hide.call(component);component.pageLifetimes.show.call(component);expect(component.data.introActive).toBe(false);component.observers['x,y'].call(component,500,-200);expect(component.data.shiftX).toBe(35);expect(component.data.shiftY).toBe(-12);component.pageLifetimes.hide.call(component);component.observers.flash.call(component,true);expect(component.data.flashActive).toBe(false);
});

async function materialFixture() {
 vi.resetModules();
 let definition:any, intersection:any;
 vi.stubGlobal('Component',(value:any)=>{definition=value;});
 await import('../../apps/miniprogram/components/card-foil/index');
 const observer:any={relativeToViewport:vi.fn(function(){return observer;}),observe:vi.fn((_selector:any,callback:any)=>{intersection=callback;}),disconnect:vi.fn()};
 const component:any={properties:Object.fromEntries(Object.entries(definition.properties).map(([key,value]:[string,any])=>[key,value.value])),data:structuredClone(definition.data),setData:vi.fn(function(patch:any){Object.assign(component.data,patch);}),createIntersectionObserver:vi.fn(()=>observer)};
 return{definition,component,observer,intersect:(ratio:number)=>intersection({intersectionRatio:ratio})};
}

it('runs the material only in the visible viewport and releases its observer without late writes',async()=>{
 const{definition:d,component:c,observer,intersect}=await materialFixture();
 d.lifetimes.attached.call(c);expect(c.data.ambientOn).toBe(false);
 intersect(1);expect(c.data.ambientOn).toBe(false);
 d.methods.textureLoaded.call(c,{currentTarget:{dataset:{texture:'silk'}}});expect(c.data.ambientOn).toBe(false);
 d.methods.textureLoaded.call(c,{currentTarget:{dataset:{texture:'engraving'}}});expect(c.data.ambientOn).toBe(true);expect(vi.getTimerCount()).toBe(0);
 intersect(0);expect(c.data.ambientOn).toBe(false);intersect(1);
 d.pageLifetimes.hide.call(c);intersect(1);expect(c.data.ambientOn).toBe(false);
 d.pageLifetimes.show.call(c);expect(c.data.ambientOn).toBe(true);
 c.properties.reduced=true;d.observers['reduced,quiet'].call(c);expect(c.data.ambientOn).toBe(false);
 c.properties.reduced=false;c.properties.quiet=true;d.observers['reduced,quiet'].call(c);expect(c.data.ambientOn).toBe(false);
 c.properties.quiet=false;d.observers['reduced,quiet'].call(c);expect(c.data.ambientOn).toBe(true);
 d.lifetimes.detached.call(c);expect(observer.disconnect).toHaveBeenCalledOnce();const writes=c.setData.mock.calls.length;intersect(0);expect(c.setData).toHaveBeenCalledTimes(writes);
});

it('does not attach a viewport observer on a reduced-performance device',async()=>{
 m.reduce=true;const{definition:d,component:c}=await materialFixture();d.lifetimes.attached.call(c);
 expect(c.createIntersectionObserver).not.toHaveBeenCalled();expect(c.data.lowMotion).toBe(true);expect(c.data.ambientOn).toBe(false);
});

it('falls back to static material when viewport observation cannot attach',async()=>{
 const{definition:d,component:c,observer}=await materialFixture();let late:any;observer.observe.mockImplementation((_selector:any,callback:any)=>{late=callback;throw Error('OBSERVATION_UNAVAILABLE');});
 expect(()=>d.lifetimes.attached.call(c)).not.toThrow();expect(observer.disconnect).toHaveBeenCalledOnce();expect(c.data.ambientOn).toBe(false);const writes=c.setData.mock.calls.length;late({intersectionRatio:1});expect(c.setData).toHaveBeenCalledTimes(writes);
});
