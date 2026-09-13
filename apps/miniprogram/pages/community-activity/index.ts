import { request, requireMemberAccess } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";

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
  data:{chromeStyle:currentChromeStyle(),tabs,section:"comments" as Section,items:[] as ActivityRow[],
    nextCursor:null as string|null,matchingTotal:0,loading:true,loadingMore:false,busy:false,error:"",notice:"",epoch:0},
  sessionToken:"",alive:true,shown:false,
  onLoad(query:Record<string,string|undefined>){
    this.alive=true;this.sessionToken=getApp<IAppOption>().globalData.sessionToken;
    const section=query.section;
    if(tabs.some(tab=>tab.key===section))this.setData({section:section as Section});
    if(requireMemberAccess("/pages/community-activity/index"))void this.load(true);
  },
  onShow(){
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(!requireMemberAccess("/pages/community-activity/index")){
      this.data.epoch+=1;this.setData({items:[],nextCursor:null,matchingTotal:0,loading:false,error:""});return;
    }
    if(this.shown||token!==this.sessionToken){this.sessionToken=token;void this.load(true);}
    this.shown=true;
  },
  onUnload(){this.alive=false;this.data.epoch+=1;},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  selectSection(event:WechatMiniprogram.TouchEvent){
    const section=String(event.currentTarget.dataset.section);
    if(!tabs.some(tab=>tab.key===section)||section===this.data.section)return;
    this.setData({section:section as Section,items:[],nextCursor:null,matchingTotal:0,notice:""});
    void this.load(true);
  },
  onReachBottom(){void this.load(false);},
  retry(){void this.load(true);},
  loadMore(){void this.load(false);},
  async load(reset=true){
    if(!reset&&(!this.data.nextCursor||this.data.loadingMore||this.data.loading))return;
    const epoch=reset?++this.data.epoch:this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,
      section=this.data.section,cursor=reset?null:this.data.nextCursor;
    if(reset)this.setData({items:[],nextCursor:null,matchingTotal:0,loading:true,loadingMore:false,error:""});
    else this.setData({loadingMore:true,error:""});
    try{
      const page=await request<PageResult>({path:`/v1/me/ugc/activity/${section}?limit=30${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`});
      if(!this.alive||epoch!==this.data.epoch||token!==getApp<IAppOption>().globalData.sessionToken||
        section!==this.data.section||(!reset&&cursor!==this.data.nextCursor))return;
      const seen=new Set(reset?[]:this.data.items.map(item=>item.id));
      const rows=page.items.filter(item=>!seen.has(item.id)).map(item=>({...item,
        stateLabel:stateLabels[item.state??""]??item.state??"",
        categoryLabel:categoryLabels[item.category??""]??"",
        decisionLabel:decisionLabels[item.decisionCode??""]??"",createdLabel:timeLabel(item.createdAt)}));
      this.setData({items:reset?rows:[...this.data.items,...rows],nextCursor:page.nextCursor,
        matchingTotal:page.matchingTotal,loading:false,loadingMore:false,error:""});
    }catch(error){if(this.alive&&epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken){
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
    if(this.data.busy||!row)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    const answer=await wx.showModal({title:"移除收藏？",content:"这篇内容会从我的收藏中移除。",confirmText:"移除"});
    if(!answer.confirm||epoch!==this.data.epoch||token!==getApp<IAppOption>().globalData.sessionToken||
      !this.data.items.some(item=>item.postId===id))return;
    this.setData({busy:true,error:""});
    try{await request({path:`/v1/ugc/posts/${id}/reaction`,method:"PUT",data:{kind:"save",active:false}});
      if(epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken){this.setData({busy:false,notice:"已移除收藏。"});void this.load(true);}
    }catch(error){if(epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken)
      this.setData({error:titleOf(error,"收藏未移除，请重试。")});}
    finally{if(epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken)this.setData({busy:false});}
  },
  async unblock(event:WechatMiniprogram.TouchEvent){
    const id=String(event.currentTarget.dataset.id||""),row=this.data.items.find(item=>item.memberId===id);
    if(this.data.busy||!row)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    const answer=await wx.showModal({title:"解除屏蔽？",content:"解除后，对方公开的内容会再次出现在可见范围内。",confirmText:"解除"});
    if(!answer.confirm||epoch!==this.data.epoch||token!==getApp<IAppOption>().globalData.sessionToken||
      !this.data.items.some(item=>item.memberId===id))return;
    this.setData({busy:true,error:""});
    try{await request({path:`/v1/me/ugc/blocks/${id}`,method:"PUT",data:{active:false}});
      if(epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken){this.setData({busy:false,notice:"已解除屏蔽。"});void this.load(true);}
    }catch(error){if(epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken)
      this.setData({error:titleOf(error,"屏蔽状态未更新，请重试。")});}
    finally{if(epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken)this.setData({busy:false});}
  },
  async deleteComment(event:WechatMiniprogram.TouchEvent){
    const id=String(event.currentTarget.dataset.id||""),row=this.data.items.find(item=>item.id===id);
    if(this.data.busy||!row?.postId||row.state==="deleted")return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    const answer=await wx.showModal({title:"删除这条评论？",content:"删除后正文无法恢复，审核事实会保留。",confirmText:"删除"});
    if(!answer.confirm||epoch!==this.data.epoch||token!==getApp<IAppOption>().globalData.sessionToken||
      !this.data.items.some(item=>item.id===id))return;
    this.setData({busy:true,error:""});
    try{await request({path:`/v1/ugc/posts/${row.postId}/comments/${id}`,method:"DELETE"});
      if(epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken){this.setData({busy:false,notice:"评论已删除。"});void this.load(true);}
    }catch(error){if(epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken)
      this.setData({error:titleOf(error,"评论未删除，请重试。")});}
    finally{if(epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken)this.setData({busy:false});}
  },
  back(){wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/profile/index"})});}
});
