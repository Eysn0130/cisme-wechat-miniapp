import{shouldReduceMotion}from'./layout';
import{commerceContextRevision}from'./commerce-command-store';
type Surface='member'|'award'|'coupon';
type Host={setData:(data:WechatMiniprogram.IAnyObject)=>void};
type Point={x:number;y:number};
type Gesture={surface:Surface;token:string;revision:number;start:Point;point:Point;rect:{left:number;top:number;width:number;height:number}|null;lastPaint:number;moved:boolean};
const gestures=new WeakMap<object,Gesture>(),dragTaps=new WeakMap<object,boolean>();
export const foilData={foilSurface:'' as ''|Surface,foilX:50,foilY:50};
const selectors:Record<Surface,string>={member:'.member-card',award:'.reward-ticket',coupon:'.purchase-ticket'};
function point(event:WechatMiniprogram.TouchEvent):Point|null{const p=event.touches?.[0];return p&&Number.isFinite(p.clientX)&&Number.isFinite(p.clientY)?{x:p.clientX,y:p.clientY}:null;}
function owns(host:Host,g:Gesture){return gestures.get(host)===g&&getApp<IAppOption>().globalData.sessionToken===g.token&&commerceContextRevision()===g.revision;}
function paint(host:Host,g:Gesture){if(!owns(host,g)||!g.rect||g.rect.width<=0||g.rect.height<=0)return;const now=Date.now();if(g.lastPaint&&now-g.lastPaint<40)return;g.lastPaint=now;
 const clamp=(v:number)=>Math.round(Math.max(0,Math.min(100,v)));host.setData({foilSurface:g.surface,foilX:clamp((g.point.x-g.rect.left)/g.rect.width*100),foilY:clamp((g.point.y-g.rect.top)/g.rect.height*100)});}
export function clearFoil(host:Host){gestures.delete(host);dragTaps.delete(host);host.setData({...foilData});}
export function consumeFoilDrag(host:Host){const blocked=dragTaps.get(host)===true;dragTaps.delete(host);return blocked;}
export const foilEvents={
 beginFoil(this:Host,event:WechatMiniprogram.TouchEvent){dragTaps.delete(this);if(shouldReduceMotion())return;const surface=String(event.currentTarget.dataset.foilSurface) as Surface,p=point(event);if(!selectors[surface]||!p)return;
  const g:Gesture={surface,token:getApp<IAppOption>().globalData.sessionToken,revision:commerceContextRevision(),start:p,point:p,rect:null,lastPaint:0,moved:false};gestures.set(this,g);
  wx.createSelectorQuery().select(selectors[surface]).boundingClientRect(rect=>{if(!owns(this,g)||!rect||Array.isArray(rect))return;g.rect=rect;paint(this,g);}).exec();
 },
 moveFoil(this:Host,event:WechatMiniprogram.TouchEvent){const g=gestures.get(this),p=point(event);if(!g||!p)return;if(!owns(this,g)){clearFoil(this);return;}const dx=p.x-g.start.x,dy=p.y-g.start.y;g.moved ||=Math.hypot(dx,dy)>8;
  // Leave vertical scrolling to the native page; this handler never captures it.
  if(Math.abs(dy)>8&&Math.abs(dy)>Math.abs(dx)){if(g.moved)dragTaps.set(this,true);gestures.delete(this);this.setData({...foilData});return;}g.point=p;paint(this,g);
 },
 endFoil(this:Host){const g=gestures.get(this);if(g?.moved)dragTaps.set(this,true);gestures.delete(this);this.setData({...foilData});}
};
