import { request, resumeAuthentication } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";

type Author = { id:string; name:string; avatar:string; postCount:number; following:boolean; isMine:boolean };
type Story = { id:string; title:string; excerpt:string; coverId:string|null; likeCount:number; publishedAt:string;
  cover:string };
const message = (error:unknown,fallback:string)=>(error as {title?:string})?.title||fallback;

Page({
  lastSessionToken:"",
  data:{chromeStyle:currentChromeStyle(),authorId:"",author:null as Author|null,items:[] as Story[],nextCursor:null as string|null,
    loading:true,loadingMore:false,busy:false,navigating:false,error:"",epoch:0},
  onLoad(query:Record<string,string|undefined>){
    this.lastSessionToken=getApp<IAppOption>().globalData.sessionToken;
    this.setData({authorId:String(query.id||"")});
  },
  onShow(){
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(token!==this.lastSessionToken){this.lastSessionToken=token;this.data.epoch+=1;
      this.setData({author:null,items:[],nextCursor:null,busy:false,navigating:false});}
    else if(this.data.author){this.setData({navigating:false});void this.refreshAuthor();return;}
    void this.load();
  },
  onUnload(){this.data.epoch+=1;},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  async load(){
    const id=this.data.authorId;
    if(!/^[0-9a-f-]{36}$/i.test(id)){this.setData({loading:false,error:"作者编号无效，请返回社区。"});return;}
    const epoch=++this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({loading:true,error:"",items:[],nextCursor:null});
    try{
      const [author,page]=await Promise.all([
        request<Author>({path:`/v1/ugc/authors/${id}`,authMode:"optional"}),
        request<{items:Story[];nextCursor:string|null}>({path:`/v1/ugc/posts?authorId=${id}&limit=20`,authMode:"optional"})
      ]);
      if(epoch!==this.data.epoch||token!==getApp<IAppOption>().globalData.sessionToken)return;
      const origin=getApp<IAppOption>().globalData.apiBaseUrl.replace(/\/$/,"");
      this.setData({author,items:page.items.map(item=>({...item,
        cover:item.coverId&&origin?`${origin}/v1/ugc/media/${item.coverId}?variant=thumbnail`:""})),
        nextCursor:page.nextCursor,loading:false});
    }catch(error){if(epoch===this.data.epoch)this.setData({loading:false,error:message(error,"作者资料暂时无法加载，请重试。")});}
  },
  async refreshAuthor(){
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    try{const author=await request<Author>({path:`/v1/ugc/authors/${this.data.authorId}`,authMode:"optional"});
      if(epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken)this.setData({author});
    }catch(error){if(epoch===this.data.epoch)this.setData({author:null,items:[],nextCursor:null,
      error:message(error,"作者资料暂时无法加载，请重试。")});}
  },
  async onReachBottom(){
    const cursor=this.data.nextCursor,id=this.data.authorId;
    if(!cursor||this.data.loading||this.data.loadingMore)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({loadingMore:true});
    try{
      const page=await request<{items:Story[];nextCursor:string|null}>({path:`/v1/ugc/posts?authorId=${id}&limit=20&cursor=${encodeURIComponent(cursor)}`,authMode:"optional"});
      if(epoch!==this.data.epoch||token!==getApp<IAppOption>().globalData.sessionToken)return;
      const origin=getApp<IAppOption>().globalData.apiBaseUrl.replace(/\/$/,"");
      this.setData({items:[...this.data.items,...page.items.map(item=>({...item,
        cover:item.coverId&&origin?`${origin}/v1/ugc/media/${item.coverId}?variant=thumbnail`:""}))],nextCursor:page.nextCursor});
    }catch(error){if(epoch===this.data.epoch)this.setData({error:message(error,"更多故事暂时无法加载，请重试。")});}
    finally{if(epoch===this.data.epoch)this.setData({loadingMore:false});}
  },
  async toggleFollow(){
    const author=this.data.author;if(!author||author.isMine||this.data.busy)return;
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(!token){resumeAuthentication(`/pages/community-author/index?id=${author.id}`);return;}
    const epoch=this.data.epoch,next=!author.following;
    this.setData({busy:true,error:""});
    try{await request({path:`/v1/me/ugc/follows/${author.id}`,method:"PUT",data:{active:next}});
      if(epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken)
        this.setData({author:{...author,following:next}});
    }catch(error){if(epoch===this.data.epoch)this.setData({error:message(error,"关注操作未完成，请重试。")});}
    finally{if(epoch===this.data.epoch)this.setData({busy:false});}
  },
  openPost(event:WechatMiniprogram.TouchEvent){
    if(this.data.navigating)return;
    const id=String(event.currentTarget.dataset.id||"");if(!/^[0-9a-f-]{36}$/i.test(id))return;
    this.setData({navigating:true});
    wx.navigateTo({url:`/pages/community-post/index?id=${id}`,fail:()=>this.setData({navigating:false})});
  },
  back(){wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/community/index"})});}
});
