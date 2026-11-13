import{beforeEach,afterEach,describe,it,expect,vi}from'vitest';
import{readFile}from'node:fs/promises';
import{sectionTabs,sectionTabValue}from'../../apps/miniprogram/services/section-tabs';
vi.mock('../../apps/miniprogram/services/layout',()=>({shouldReduceMotion:()=>true}));
const items=[{id:'one',label:'精选'},{id:'two',label:'关注'},{id:'hidden',label:'管理',hidden:true},{id:'locked',label:'未开放',disabled:true}];
let component:any;
beforeEach(async()=>{vi.resetModules();vi.stubGlobal('Component',(definition:any)=>{component={...definition,...definition.methods,properties:{items,value:'one',itemKey:'id',disabled:false,reselect:false},data:structuredClone(definition.data),triggerEvent:vi.fn(),setData(patch:any){Object.assign(this.data,patch);}};});await import('../../apps/miniprogram/components/section-tabs/index');component.refreshTabs();});
afterEach(()=>vi.unstubAllGlobals());
describe('controlled native section tabs',()=>{
 it('filters hidden, malformed and duplicated entries without mutating page permission models',()=>{
  const raw=[...items,{id:'two',label:'重复'},null,{id:'invalid'}],before=JSON.stringify(raw),tabs=sectionTabs(raw,'two');expect(tabs.map(t=>t.id)).toEqual(['one','two','locked']);expect(tabs.filter(t=>t.selected).map(t=>t.id)).toEqual(['two']);expect(JSON.stringify(raw)).toBe(before);
 });
 it('supports the existing keyed community activity models',()=>{expect(sectionTabs([{key:'comments',label:'评论'}],'comments','key')[0]).toMatchObject({id:'comments',selected:true});});
 it('emits a choice without changing selected state before the page accepts it',()=>{component.select({currentTarget:{dataset:{index:1}}});expect(component.triggerEvent).toHaveBeenCalledWith('change',{value:'two'});expect(component.data.tabs.find((t:{selected:boolean})=>t.selected).id).toBe('one');component.properties.value='two';component.refreshTabs();expect(component.data.scrollTarget).toBe('section-tab-1');});
 it('does not emit hidden, invalid, disabled or unnecessary repeated selections',()=>{for(const index of [0,2,30,-1,'bad'])component.select({currentTarget:{dataset:{index}}});expect(component.triggerEvent).not.toHaveBeenCalled();component.properties.disabled=true;component.select({currentTarget:{dataset:{index:1}}});expect(component.triggerEvent).not.toHaveBeenCalled();});
 it('allows product anchor reselection and honors reduced-motion presentation',()=>{component.properties.reselect=true;component.select({currentTarget:{dataset:{index:0}}});expect(component.triggerEvent).toHaveBeenCalledWith('change',{value:'one'});component.lifetimes.attached.call(component);expect(component.data.reducedMotion).toBe(true);});
 it('accepts component changes and legacy controller events without turning missing input into a valid value',()=>{expect(sectionTabValue({detail:{value:'two'}},'mode')).toBe('two');expect(sectionTabValue({currentTarget:{dataset:{mode:'featured'}}},'mode')).toBe('featured');expect(sectionTabValue({})).toBe('');expect(sectionTabValue(null)).toBe('');});
 it('registers the same component for every audited top-tab page',async()=>{for(const route of ['community','rewards','management-rewards','points','management-member','management-members','management-finance','community-activity','community-review','product']){const json=JSON.parse(await readFile(`apps/miniprogram/pages/${route}/index.json`,'utf8'));expect(json.usingComponents['section-tabs'],route).toBe('/components/section-tabs/index');expect(await readFile(`apps/miniprogram/pages/${route}/index.wxml`,'utf8')).toContain('<section-tabs');}});
});
