import { pageRead, cancelPageReads } from "../../services/page-requests";
import { commerceContextRevision } from "../../services/commerce-command-store";
import { request, requireMemberAccess } from "../../services/api";
import { currentChromeStyle, shouldReduceMotion } from "../../services/layout";

type Section="comments"|"saves"|"reports"|"appeals"|"blocks";
type ActivityRow={id:string;postId?:string;postTitle?:string|null;body?:string|null;state?:string;
  title?:string|null;available?:boolean;targetType?:string;category?:string;decisionCode?:string|null;
  decisionReason?:string|null;description?:string|null;reason?:string;memberId?:string;displayName?:string;createdAt:string;
  stateLabel?:string;categoryLabel?:string;decisionLabel?:string;createdLabel?:string};
type PageResult={items:ActivityRow[];nextCursor:string|null;matchingTotal:number};
const tabs:Array<{key:Section;label:string}>=[
  {key:"comments",label:"评论"},{key:"saves",label:"收藏"},{key:"reports",label:"举报"},
  {key:"appeals",label:"申诉"},{key:"blocks",label:"屏蔽"}
];
const stateLabels:Record<string,string>={pending_review:"待审核",published:"已公开",rejected:"未通过",deleted:"已删除",
  received:"已收到",triaged:"处理中",resolved:"已处理"};
const categoryLabels:Record<string,string>={spam:"垃圾信息",harassment:"骚扰",unsafe_advice:"不安全建议",illegal:"违法内容",
  intellectual_property:"知识产权",privacy:"隐私",other:"其他"};
const decisionLabels:Record<string,string>={hide_post:"内容已下架",remove_comment:"评论已移除",dismiss:"未发现违规",
  restore:"内容已恢复",uphold:"维持下架"};
const titleOf=(error:unknown,fallback:string)=>(error as {title?:string})?.title||fallback;
const timeLabel=(value:string)=>{
  const time=new Date(value);if(!Number.isFinite(time.getTime()))return "";
  const two=(part:number)=>String(part).padStart(2,"0");
  return `${time.getFullYear()}/${two(time.getMonth()+1)}/${two(time.getDate())} ${two(time.getHours())}:${two(time.getMinutes())}`;
};

Page({
  data:{chromeStyle:currentChromeStyle(),reduceMotion:shouldReduceMotion(),tabs,section:"comments" as Section,items:[] as ActivityRow[],
    nextCursor:null as string|null,matchingTotal:0,loading:true,loadingMore:false,busy:false,error:"",notice:"",epoch:0},
  sessionToken:"",alive:true,visible:true,shown:false,
  contextRevision:commerceContextRevision(),mutationSerial:0,mutationPending:false,
  onLoad(query:Record<string,string|undefined>){
    this.alive=true;this.visible=true;this.sessionToken=getApp<IAppOption>().globalData.sessionToken;
    this.contextRevision=commerceContextRevision();
    const section=query.section;
    if(tabs.some(tab=>tab.key===section))this.setData({section:section as Section});
    if(requireMemberAccess("/pages/community-activity/index"))void this.load(true);
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
    if(!requireMemberAccess("/pages/community-activity/index")){
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
  releaseMutation(serial:number,token:string,revision:number,epoch:number,succeeded:boolean){
    if(serial!==this.mutationSerial)return;
    this.mutationPending=false;
    if(this.alive&&this.visible&&token===this.sessionToken&&revision===this.contextRevision&&
      token===getApp<IAppOption>().globalData.sessionToken&&revision===commerceContextRevision()){
      this.setData({busy:false});
      // A resume/tab read may have observed the database before this write settled.
      // Supersede it, including uncertain failures, without replaying the command.
      if(succeeded||epoch!==this.data.epoch)void this.load(true);
    }
  },
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  selectSection(event:WechatMiniprogram.TouchEvent){
    const section=String(event.currentTarget.dataset.section);
    if(!this.alive||!this.visible||!tabs.some(tab=>tab.key===section)||section===this.data.section)return;
    this.setData({section:section as Section,items:[],nextCursor:null,matchingTotal:0,notice:""});
    void this.load(true);
  },
  onReachBottom(){void this.load(false);},
  retry(){void this.load(true);},
  loadMore(){void this.load(false);},
  async load(reset=true){
    if(!this.alive||!this.visible)return;
    if(!reset&&(!this.data.nextCursor||this.data.loadingMore||this.data.loading))return;
    const epoch=reset?++this.data.epoch:this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,
      section=this.data.section,cursor=reset?null:this.data.nextCursor,revision=commerceContextRevision();
    if(reset)cancelPageReads(this);
    if(reset)this.setData({items:[],nextCursor:null,matchingTotal:0,loading:true,loadingMore:false,error:""});
    else this.setData({loadingMore:true,error:""});
    try{
      const page=await pageRead<PageResult>(this,{path:`/v1/me/ugc/activity/${section}?limit=30${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`});
      if(!this.isCurrent(epoch,token,revision)||
        section!==this.data.section||(!reset&&cursor!==this.data.nextCursor))return;
      const seen=new Set(reset?[]:this.data.items.map(item=>item.id));
      const rows=page.items.filter(item=>{if(seen.has(item.id))return false;seen.add(item.id);return true;}).map(item=>({...item,
        stateLabel:stateLabels[item.state??""]??item.state??"",
        categoryLabel:categoryLabels[item.category??""]??"",
        decisionLabel:decisionLabels[item.decisionCode??""]??"",createdLabel:timeLabel(item.createdAt)}));
      this.setData({items:reset?rows:[...this.data.items,...rows],nextCursor:page.nextCursor,
        matchingTotal:page.matchingTotal,loading:false,loadingMore:false,error:""});
    }catch(error){if(this.isCurrent(epoch,token,revision)){
      this.setData({loading:false,loadingMore:false,error:titleOf(error,"社区记录暂时无法加载，请重试。")});
    }}
  },
  openPost(event:WechatMiniprogram.TouchEvent){
    const id=String(event.currentTarget.dataset.id||"");if(!id)return;
    wx.navigateTo({url:`/pages/community-post/index?id=${encodeURIComponent(id)}`,
      fail:()=>wx.showToast({title:"内容暂时无法打开",icon:"none"})});
  },
  openAppealedPost(event:WechatMiniprogram.TouchEvent){
    const id=String(event.currentTarget.dataset.id||"");if(!id)return;
    wx.navigateTo({url:`/pages/community-compose/index?id=${encodeURIComponent(id)}`,
      fail:()=>wx.showToast({title:"内容记录暂时无法打开",icon:"none"})});
  },
  async removeSaved(event:WechatMiniprogram.TouchEvent){
    const id=String(event.currentTarget.dataset.id||""),row=this.data.items.find(item=>item.postId===id);
    if(!this.alive||!this.visible||this.data.busy||!row)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,revision=commerceContextRevision();
    const answer=await wx.showModal({title:"移除收藏？",content:"这篇内容会从我的收藏中移除。",confirmText:"移除"}).catch(()=>({confirm:false}));
    if(!answer.confirm||this.data.busy||!this.isCurrent(epoch,token,revision)||
      !this.data.items.some(item=>item.postId===id))return;
    const serial=++this.mutationSerial;this.mutationPending=true;let succeeded=false;
    this.setData({busy:true,error:""});
    try{await request({path:`/v1/ugc/posts/${id}/reaction`,method:"PUT",data:{kind:"save",active:false}});
      succeeded=true;
      if(this.isCurrent(epoch,token,revision)){this.setData({notice:"已移除收藏。"});}
    }catch(error){if(this.isCurrent(epoch,token,revision))
      this.setData({error:titleOf(error,"收藏未移除，请重试。")});}
    finally{this.releaseMutation(serial,token,revision,epoch,succeeded);}
  },
  async unblock(event:WechatMiniprogram.TouchEvent){
    const id=String(event.currentTarget.dataset.id||""),row=this.data.items.find(item=>item.memberId===id);
    if(!this.alive||!this.visible||this.data.busy||!row)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,revision=commerceContextRevision();
    const answer=await wx.showModal({title:"解除屏蔽？",content:"解除后，对方公开的内容会再次出现在可见范围内。",confirmText:"解除"}).catch(()=>({confirm:false}));
    if(!answer.confirm||this.data.busy||!this.isCurrent(epoch,token,revision)||
      !this.data.items.some(item=>item.memberId===id))return;
    const serial=++this.mutationSerial;this.mutationPending=true;let succeeded=false;
    this.setData({busy:true,error:""});
    try{await request({path:`/v1/me/ugc/blocks/${id}`,method:"PUT",data:{active:false}});
      succeeded=true;
      if(this.isCurrent(epoch,token,revision)){this.setData({notice:"已解除屏蔽。"});}
    }catch(error){if(this.isCurrent(epoch,token,revision))
      this.setData({error:titleOf(error,"屏蔽状态未更新，请重试。")});}
    finally{this.releaseMutation(serial,token,revision,epoch,succeeded);}
  },
  async deleteComment(event:WechatMiniprogram.TouchEvent){
    const id=String(event.currentTarget.dataset.id||""),row=this.data.items.find(item=>item.id===id);
    if(!this.alive||!this.visible||this.data.busy||!row?.postId||row.state==="deleted")return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,revision=commerceContextRevision();
    const answer=await wx.showModal({title:"删除这条评论？",content:"删除后正文无法恢复，审核事实会保留。",confirmText:"删除"}).catch(()=>({confirm:false}));
    if(!answer.confirm||this.data.busy||!this.isCurrent(epoch,token,revision)||
      !this.data.items.some(item=>item.id===id))return;
    const serial=++this.mutationSerial;this.mutationPending=true;let succeeded=false;
    this.setData({busy:true,error:""});
    try{await request({path:`/v1/ugc/posts/${row.postId}/comments/${id}`,method:"DELETE"});
      succeeded=true;
      if(this.isCurrent(epoch,token,revision)){this.setData({notice:"评论已删除。"});}
    }catch(error){if(this.isCurrent(epoch,token,revision))
      this.setData({error:titleOf(error,"评论未删除，请重试。")});}
    finally{this.releaseMutation(serial,token,revision,epoch,succeeded);}
  },
  back(){wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/profile/index"})});}
});
