import { pageRead, cancelPageReads } from "../../services/page-requests";
import { commerceContextRevision } from "../../services/commerce-command-store";
import { request, requireMemberAccess } from "../../services/api";
import { currentChromeStyle, shouldReduceMotion } from "../../services/layout";
import { deleteEditorialComment, setEditorialBlock } from "../../services/editorial-comments";

type Source="editorial"|"ugc";
type Section="comments"|"saves"|"reports"|"appeals"|"blocks";
type ActivityRow={id:string;postId?:string;postTitle?:string|null;body?:string|null;state?:string;
  title?:string|null;available?:boolean;targetType?:string;category?:string;decisionCode?:string|null;
  decisionReason?:string|null;description?:string|null;reason?:string;memberId?:string;displayName?:string;createdAt:string;
  source?:"editorial"|"shared";stateLabel?:string;categoryLabel?:string;decisionLabel?:string;createdLabel?:string};
type PageResult={items:ActivityRow[];nextCursor:string|null;matchingTotal:number;loadedCount?:number;hasMore?:boolean};
const sources:Array<{key:Source;label:string}>=[{key:"editorial",label:"精选"},{key:"ugc",label:"投稿"}];
const ugcTabs:Array<{key:Section;label:string}>=[
  {key:"comments",label:"评论"},{key:"saves",label:"收藏"},{key:"reports",label:"举报"},
  {key:"appeals",label:"申诉"},{key:"blocks",label:"屏蔽"}
];
const editorialTabs=ugcTabs.filter(tab=>tab.key!=="appeals");
const tabsFor=(source:Source)=>source==="editorial"?editorialTabs:ugcTabs;
const stateLabels:Record<string,string>={pending_review:"待审核",published:"已公开",rejected:"未通过",deleted:"已删除",
  hidden:"已隐藏",open:"已收到",received:"已收到",triaged:"处理中",resolved:"已处理"};
const categoryLabels:Record<string,string>={spam:"垃圾信息",harassment:"骚扰",unsafe_advice:"不安全建议",illegal:"违法内容",
  intellectual_property:"知识产权",privacy:"隐私",other:"其他",abuse:"不当言语",misinformation:"不实信息",rights:"侵权"};
const decisionLabels:Record<string,string>={hide_post:"内容已下架",remove_comment:"评论已移除",dismiss:"未发现违规",
  restore:"内容已恢复",uphold:"维持下架"};
const titleOf=(error:unknown,fallback:string)=>(error as {title?:string})?.title||fallback;
const returnUrl=(source:Source,section:Section)=>`/pages/community-activity/index?source=${source}&section=${section}`;
const timeLabel=(value:string)=>{
  const time=new Date(value);if(!Number.isFinite(time.getTime()))return "";
  const two=(part:number)=>String(part).padStart(2,"0");
  return `${time.getFullYear()}/${two(time.getMonth()+1)}/${two(time.getDate())} ${two(time.getHours())}:${two(time.getMinutes())}`;
};

Page({
  data:{chromeStyle:currentChromeStyle(),reduceMotion:shouldReduceMotion(),sources,source:"editorial" as Source,tabs:editorialTabs,section:"comments" as Section,activeTabIndex:0,items:[] as ActivityRow[],
    nextCursor:null as string|null,matchingTotal:0,loading:true,loadingMore:false,busy:false,error:"",notice:"",epoch:0},
  sessionToken:"",alive:true,visible:true,shown:false,
  contextRevision:commerceContextRevision(),mutationSerial:0,mutationPending:false,
  onLoad(query:Record<string,string|undefined>){
    this.alive=true;this.visible=true;this.sessionToken=getApp<IAppOption>().globalData.sessionToken;
    this.contextRevision=commerceContextRevision();
    const source:Source=query.source==="ugc"?"ugc":"editorial",tabs=tabsFor(source);
    const section=tabs.some(tab=>tab.key===query.section)?query.section as Section:"comments";
    this.setData({source,tabs,section,activeTabIndex:tabs.findIndex(tab=>tab.key===section)});
    if(requireMemberAccess(returnUrl(source,section)))void this.load(true);
  },
  onShow(){
    const resuming=!this.visible;this.visible=true;
    const token=getApp<IAppOption>().globalData.sessionToken,revision=commerceContextRevision();
    const contextChanged=token!==this.sessionToken||revision!==this.contextRevision;
    if(contextChanged){
      this.sessionToken=token;this.contextRevision=revision;this.mutationSerial+=1;this.mutationPending=false;
      this.data.epoch+=1;cancelPageReads(this);
      this.setData({items:[],nextCursor:null,matchingTotal:0,busy:false,notice:"",error:""});
    }
    if(!requireMemberAccess(returnUrl(this.data.source,this.data.section))){
      this.data.epoch+=1;this.mutationSerial+=1;this.mutationPending=false;cancelPageReads(this);
      this.setData({items:[],nextCursor:null,matchingTotal:0,loading:false,loadingMore:false,busy:false,error:"",notice:""});return;
    }
    this.setData({busy:this.mutationPending});
    if(this.shown||resuming||contextChanged)void this.load(true);
    this.shown=true;
  },
  onHide(){this.visible=false;this.data.epoch+=1;cancelPageReads(this);},
  onUnload(){this.onHide();this.alive=false;this.mutationSerial+=1;},
  isCurrent(epoch:number,token:string,revision:number){
    return this.alive&&this.visible&&epoch===this.data.epoch&&
      token===this.sessionToken&&revision===this.contextRevision&&
      token===getApp<IAppOption>().globalData.sessionToken&&revision===commerceContextRevision();
  },
  // A tab/read epoch must not own the lifetime of an already dispatched write.
  releaseMutation(serial:number,token:string,revision:number,epoch:number,source:Source,succeeded:boolean,shared=false){
    if(serial!==this.mutationSerial)return;
    this.mutationPending=false;
    if(this.alive&&this.visible&&token===this.sessionToken&&revision===this.contextRevision&&
      token===getApp<IAppOption>().globalData.sessionToken&&revision===commerceContextRevision()){
      this.setData({busy:false});
      // A resume/tab read may have observed the database before this write settled.
      // Supersede it, including uncertain failures, without replaying the command.
      if(shared||source===this.data.source&&(succeeded||epoch!==this.data.epoch))void this.load(true);
    }
  },
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  selectSource(event:WechatMiniprogram.TouchEvent){
    const source=String(event.currentTarget.dataset.source);
    if(!this.alive||!this.visible||!sources.some(item=>item.key===source)||source===this.data.source)return;
    const tabs=tabsFor(source as Source),section=tabs.some(tab=>tab.key===this.data.section)?this.data.section:"comments";
    this.setData({source:source as Source,tabs,section,activeTabIndex:tabs.findIndex(tab=>tab.key===section),items:[],nextCursor:null,matchingTotal:0,notice:""});
    void this.load(true);
  },
  selectSection(event:WechatMiniprogram.TouchEvent){
    const section=String(event.currentTarget.dataset.section);
    if(!this.alive||!this.visible||!this.data.tabs.some(tab=>tab.key===section)||section===this.data.section)return;
    this.setData({section:section as Section,activeTabIndex:this.data.tabs.findIndex(tab=>tab.key===section),items:[],nextCursor:null,matchingTotal:0,notice:""});
    void this.load(true);
  },
  onReachBottom(){void this.load(false);},
  retry(){void this.load(true);},
  loadMore(){void this.load(false);},
  async load(reset=true){
    if(!this.alive||!this.visible)return;
    if(!reset&&(!this.data.nextCursor||this.data.loadingMore||this.data.loading))return;
    const epoch=reset?++this.data.epoch:this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,
      section=this.data.section,source=this.data.source,cursor=reset?null:this.data.nextCursor,revision=commerceContextRevision();
    if(reset)cancelPageReads(this);
    if(reset)this.setData({items:[],nextCursor:null,matchingTotal:0,loading:true,loadingMore:false,error:""});
    else this.setData({loadingMore:true,error:""});
    try{
      const page=await pageRead<PageResult>(this,{path:`/v1/me/${source}/activity/${section}?limit=30${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`});
      if(!this.isCurrent(epoch,token,revision)||
        source!==this.data.source||section!==this.data.section||(!reset&&cursor!==this.data.nextCursor))return;
      if(source==="editorial"&&(!Array.isArray(page.items)||!Number.isSafeInteger(page.matchingTotal)||page.matchingTotal<0
        ||page.loadedCount!==page.items.length||typeof page.hasMore!=="boolean"||page.hasMore!==(page.nextCursor!==null)
        ||(page.nextCursor!==null&&typeof page.nextCursor!=="string")))throw new Error("EDITORIAL_ACTIVITY_RESPONSE_INVALID");
      const seen=new Set(reset?[]:this.data.items.map(item=>item.id));
      const rows=page.items.filter(item=>{if(seen.has(item.id))return false;seen.add(item.id);return true;}).map(item=>({...item,
        stateLabel:stateLabels[item.state??""]??item.state??"",
        categoryLabel:categoryLabels[item.category??""]??"",
        decisionLabel:decisionLabels[item.decisionCode??""]??"",createdLabel:timeLabel(item.createdAt)}));
      this.setData({items:reset?rows:[...this.data.items,...rows],nextCursor:page.nextCursor,
        matchingTotal:page.matchingTotal,loading:false,loadingMore:false,error:""});
    }catch(error){if(this.isCurrent(epoch,token,revision)&&source===this.data.source&&section===this.data.section){
      this.setData({loading:false,loadingMore:false,error:titleOf(error,"社区记录暂时无法加载，请重试。")});
    }}
  },
  openPost(event:WechatMiniprogram.TouchEvent){
    const id=String(event.currentTarget.dataset.id||""),source=this.data.source,row=this.data.items.find(item=>item.postId===id);
    if(!this.alive||!this.visible||!id||event.currentTarget.dataset.source!==source||!row||source==="editorial"&&row.available!==true)return;
    const url=source==="editorial"?`/pages/post/index?id=${encodeURIComponent(id)}&source=editorial`:`/pages/community-post/index?id=${encodeURIComponent(id)}`;
    wx.navigateTo({url,
      fail:()=>wx.showToast({title:"内容暂时无法打开",icon:"none"})});
  },
  openAppealedPost(event:WechatMiniprogram.TouchEvent){
    const id=String(event.currentTarget.dataset.id||"");if(!id||this.data.source!=="ugc")return;
    wx.navigateTo({url:`/pages/community-compose/index?id=${encodeURIComponent(id)}`,
      fail:()=>wx.showToast({title:"内容记录暂时无法打开",icon:"none"})});
  },
  async removeSaved(event:WechatMiniprogram.TouchEvent){
    const id=String(event.currentTarget.dataset.id||""),row=this.data.items.find(item=>item.postId===id);
    if(!this.alive||!this.visible||this.data.busy||!row||event.currentTarget.dataset.source&&event.currentTarget.dataset.source!==this.data.source)return;
    const epoch=this.data.epoch,source=this.data.source,token=getApp<IAppOption>().globalData.sessionToken,revision=commerceContextRevision();
    const answer=await wx.showModal({title:"移除收藏？",content:"这篇内容会从我的收藏中移除。",confirmText:"移除"}).catch(()=>({confirm:false}));
    if(!answer.confirm||this.data.busy||!this.isCurrent(epoch,token,revision)||
      !this.data.items.some(item=>item.postId===id))return;
    const serial=++this.mutationSerial;this.mutationPending=true;let succeeded=false;
    this.setData({busy:true,error:""});
    try{if(source==="editorial"){
        const result=await request<{id:string;saved:boolean}>({path:`/v1/me/editorial/saves/${encodeURIComponent(id)}`,method:"DELETE"});
        if(result?.id!==id||result.saved!==false)throw new Error("EDITORIAL_SAVE_REMOVAL_RESPONSE_INVALID");
      }else await request({path:`/v1/ugc/posts/${id}/reaction`,method:"PUT",data:{kind:"save",active:false}});
      succeeded=true;
      if(this.isCurrent(epoch,token,revision)){this.setData({notice:"已移除收藏。"});}
    }catch(error){if(this.isCurrent(epoch,token,revision))
      this.setData({error:titleOf(error,source==="editorial"?"收藏状态尚未确认，请刷新核对。":"收藏未移除，请重试。")});}
    finally{this.releaseMutation(serial,token,revision,epoch,source,succeeded);}
  },
  async unblock(event:WechatMiniprogram.TouchEvent){
    const id=String(event.currentTarget.dataset.id||""),row=this.data.items.find(item=>item.memberId===id);
    if(!this.alive||!this.visible||this.data.busy||!row||event.currentTarget.dataset.source&&event.currentTarget.dataset.source!==this.data.source)return;
    const epoch=this.data.epoch,source=this.data.source,token=getApp<IAppOption>().globalData.sessionToken,revision=commerceContextRevision();
    const answer=await wx.showModal({title:"解除屏蔽？",content:"解除后，可再次看到对方的公开内容。",confirmText:"解除"}).catch(()=>({confirm:false}));
    if(!answer.confirm||this.data.busy||!this.isCurrent(epoch,token,revision)||
      !this.data.items.some(item=>item.memberId===id))return;
    const serial=++this.mutationSerial;this.mutationPending=true;let succeeded=false;
    this.setData({busy:true,error:""});
    try{if(source==="editorial")await setEditorialBlock(id,false);
      else await request({path:`/v1/me/ugc/blocks/${id}`,method:"PUT",data:{active:false}});
      succeeded=true;
      if(this.isCurrent(epoch,token,revision)){this.setData({notice:"已解除屏蔽。"});}
    }catch(error){if(this.isCurrent(epoch,token,revision))
      this.setData({error:titleOf(error,"屏蔽状态未更新，请重试。")});}
    finally{this.releaseMutation(serial,token,revision,epoch,source,succeeded,true);}
  },
  async deleteComment(event:WechatMiniprogram.TouchEvent){
    const id=String(event.currentTarget.dataset.id||""),row=this.data.items.find(item=>item.id===id);
    if(!this.alive||!this.visible||this.data.busy||!row?.postId||row.state==="deleted"||event.currentTarget.dataset.source&&event.currentTarget.dataset.source!==this.data.source)return;
    const epoch=this.data.epoch,source=this.data.source,token=getApp<IAppOption>().globalData.sessionToken,revision=commerceContextRevision();
    const answer=await wx.showModal({title:"删除这条评论？",content:"删除后无法恢复，审核记录仍会保留。",confirmText:"删除"}).catch(()=>({confirm:false}));
    if(!answer.confirm||this.data.busy||!this.isCurrent(epoch,token,revision)||
      !this.data.items.some(item=>item.id===id))return;
    const serial=++this.mutationSerial;this.mutationPending=true;let succeeded=false;
    this.setData({busy:true,error:""});
    try{if(source==="editorial")await deleteEditorialComment(row.postId,id);
      else await request({path:`/v1/ugc/posts/${row.postId}/comments/${id}`,method:"DELETE"});
      succeeded=true;
      if(this.isCurrent(epoch,token,revision)){this.setData({notice:"评论已删除。"});}
    }catch(error){if(this.isCurrent(epoch,token,revision))
      this.setData({error:titleOf(error,"评论未删除，请重试。")});}
    finally{this.releaseMutation(serial,token,revision,epoch,source,succeeded);}
  },
  back(){wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/profile/index"})});}
});
