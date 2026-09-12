import { request, resumeAuthentication } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";

type PublicPost = { id: string; version: number; authorId: string; author: string; avatar: string; title: string; body: string;
  aiUsage: string; isMine: boolean; following: boolean; media: Array<{ id: string; position: number }>;
  likeCount: number; saveCount: number; liked: boolean; saved: boolean;
  comments: Array<{ id: string; author: string; body: string; parentId: string | null; replyToId:string|null; createdAt: string }>;
  commentsTotal:number;commentsNextCursor:string|null };
const key = () => `ugc-comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const titleOf = (error: unknown, fallback: string) => (error as { title?: string })?.title || fallback;

Page({
  lastSessionToken:"",
  data: { chromeStyle: currentChromeStyle(), postId: "", post: null as PublicPost | null,
    images: [] as Array<{ id: string; src: string; index: number }>, comment: "", commentKey: key(), commentAttempted: false,
    replyTo:null as null|{id:string;parentId:string;author:string},commentsLoadingMore:false,commentsError:"",
    myComments:[] as Array<{id:string;body:string|null;state:string;stateLabel:string}>,myCommentsError:"",signedIn:false,
    loading: true, busy: false, authorNavigating:false, error: "", notice: "", epoch: 0 },
  onLoad(query: Record<string, string | undefined>) {
    this.lastSessionToken=getApp<IAppOption>().globalData.sessionToken;
    this.setData({signedIn:Boolean(this.lastSessionToken)});
    const id = String(query.id || ""); this.setData({ postId: id });
    if (id) void this.load(); else this.setData({ loading: false, error: "内容编号缺失，请返回社区重试。" });
  },
  onShow() {
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(token!==this.lastSessionToken){
      this.lastSessionToken=token;this.data.epoch+=1;
      this.setData({post:null,images:[],comment:"",commentKey:key(),commentAttempted:false,replyTo:null,commentsLoadingMore:false,commentsError:"",
        myComments:[],myCommentsError:"",signedIn:Boolean(token),
        busy:false,authorNavigating:false,notice:"",error:"",loading:true});
      if(this.data.postId)void this.load();
    }else{this.setData({authorNavigating:false});if(this.data.post&&this.data.postId)void this.load();}
  },
  onUnload() { this.data.epoch += 1; },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  async load() {
    const epoch = ++this.data.epoch, token = getApp<IAppOption>().globalData.sessionToken;
    this.setData({ loading: !this.data.post, error: "" });
    try {
      const post = await request<PublicPost>({ path: `/v1/ugc/posts/${this.data.postId}`, authMode: "optional" });
      if (epoch !== this.data.epoch || token !== getApp<IAppOption>().globalData.sessionToken) return;
      const origin = getApp<IAppOption>().globalData.apiBaseUrl.replace(/\/$/, "");
      this.setData({ post,commentsLoadingMore:false,commentsError:"",images: post.media.map((item, index) => ({ id: item.id, index: index + 1,
        src: origin ? `${origin}/v1/ugc/media/${item.id}` : "" })), loading: false });
      if(token)void this.loadMyComments(epoch,token,post.id);
    } catch (error) { if (epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken)
      this.setData({ post:null,images:[],loading: false, error: titleOf(error, "护理故事暂时无法加载，请重试。") }); }
  },
  async loadMyComments(epoch:number,token:string,postId:string){
    try{const page=await request<{items:Array<{id:string;body:string|null;state:string}>}>({
      path:`/v1/me/ugc/activity/comments?postId=${postId}&limit=30`});
      if(epoch!==this.data.epoch||token!==getApp<IAppOption>().globalData.sessionToken||this.data.post?.id!==postId)return;
      this.setData({myComments:page.items.filter(row=>row.state!=="published").map(row=>({...row,
        stateLabel:row.state==="pending_review"?"审核中":row.state==="rejected"?"未通过":"已删除"})),myCommentsError:""});
    }catch{if(epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken)
      this.setData({myComments:[],myCommentsError:"我的评论状态暂未同步，可在“我的社区”查看。"});}
  },
  onReachBottom(){void this.loadMoreComments();},
  async loadMoreComments(){
    const post=this.data.post,cursor=post?.commentsNextCursor;
    if(!post||!cursor||this.data.commentsLoadingMore)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({commentsLoadingMore:true,commentsError:""});
    try{const page=await request<{items:PublicPost["comments"];nextCursor:string|null;matchingTotal:number}>({
      path:`/v1/ugc/posts/${post.id}/comments?limit=30&cursor=${encodeURIComponent(cursor)}`,authMode:"optional"});
      if(epoch!==this.data.epoch||token!==getApp<IAppOption>().globalData.sessionToken||this.data.post?.id!==post.id||
        this.data.post.commentsNextCursor!==cursor)return;
      const seen=new Set(this.data.post.comments.map(row=>row.id));
      this.setData({post:{...this.data.post,comments:[...this.data.post.comments,...page.items.filter(row=>!seen.has(row.id))],
        commentsNextCursor:page.nextCursor,commentsTotal:page.matchingTotal},commentsLoadingMore:false});
    }catch(error){if(epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken)
      this.setData({commentsLoadingMore:false,commentsError:titleOf(error,"更多评论暂未加载，请重试。")});}
  },
  chooseReply(event:WechatMiniprogram.TouchEvent){const id=String(event.currentTarget.dataset.id||"");
    const found=this.data.post?.comments.find(row=>row.id===id);if(!found)return;
    this.setData({replyTo:{id:found.id,parentId:found.parentId||found.id,author:found.author},commentKey:key(),commentAttempted:false});
  },
  cancelReply(){this.setData({replyTo:null,commentKey:key(),commentAttempted:false});},
  editComment(event: WechatMiniprogram.Input) {
    const changed=event.detail.value!==this.data.comment;
    this.setData({ comment: event.detail.value,
      ...(changed&&this.data.commentAttempted?{commentKey:key(),commentAttempted:false}:{}) });
  },
  async sendComment() {
    if (this.data.busy || !this.data.comment.trim()) return;
    if (!getApp<IAppOption>().globalData.sessionToken) { resumeAuthentication(`/pages/community-post/index?id=${this.data.postId}`); return; }
    const epoch = this.data.epoch, token = getApp<IAppOption>().globalData.sessionToken;
    const body=this.data.comment.trim(),operationKey=this.data.commentKey,replyTo=this.data.replyTo;
    this.setData({ busy: true, commentAttempted:true, error: "", notice: "" });
    try {
      const created=await request<{id:string;state:string}>({ path: `/v1/ugc/posts/${this.data.postId}/comments`, method: "POST", idempotencyKey: operationKey,
        data: { body,...(replyTo?{parentId:replyTo.parentId,replyToId:replyTo.id}:{}) } });
      if (epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken)
        {this.setData({ ...(this.data.comment.trim()===body?{comment:"",replyTo:null}:{}), commentKey:key(),commentAttempted:false,
          notice: created.state==="pending_review"?"评论已提交，审核中；只有你能在此查看状态。":"评论状态已更新。" });
          void this.loadMyComments(epoch,token,this.data.postId);}
    } catch (error) { if (epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken)
      this.setData({ error: titleOf(error, "评论未提交，请重试。") }); }
    finally { if (epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken) this.setData({ busy: false }); }
  },
  openMyComments(){
    if(!this.data.signedIn){resumeAuthentication(`/pages/community-post/index?id=${this.data.postId}`);return;}
    wx.navigateTo({url:"/pages/community-activity/index?section=comments",
      fail:()=>wx.showToast({title:"我的评论暂时无法打开",icon:"none"})});
  },
  async toggleReaction(event: WechatMiniprogram.TouchEvent) {
    const kind = String(event.currentTarget.dataset.kind || "");
    if (!this.data.post || this.data.busy || !["like", "save"].includes(kind)) return;
    if (!getApp<IAppOption>().globalData.sessionToken) { resumeAuthentication(`/pages/community-post/index?id=${this.data.postId}`); return; }
    const active = kind === "like" ? !this.data.post.liked : !this.data.post.saved;
    const epoch = this.data.epoch, token = getApp<IAppOption>().globalData.sessionToken;
    this.setData({ busy: true, error: "" });
    try {
      const answer = await request<{ count: number }>({ path: `/v1/ugc/posts/${this.data.postId}/reaction`, method: "PUT", data: { kind, active } });
      if (epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken && this.data.post)
        this.setData({ post: { ...this.data.post, ...(kind === "like" ? { liked: active, likeCount: answer.count } : { saved: active, saveCount: answer.count }) } });
    } catch (error) { if (epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken)
      this.setData({ error: titleOf(error, "操作未完成，请重试。") }); }
    finally { if (epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken) this.setData({ busy: false }); }
  },
  async toggleFollow(){
    const post=this.data.post;
    if(!post||post.isMine||this.data.busy)return;
    if(!getApp<IAppOption>().globalData.sessionToken){resumeAuthentication(`/pages/community-post/index?id=${this.data.postId}`);return;}
    const next=!post.following,epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({busy:true,error:""});
    try{
      await request({path:`/v1/me/ugc/follows/${post.authorId}`,method:"PUT",data:{active:next}});
      if(epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken&&this.data.post?.authorId===post.authorId)
        this.setData({post:{...this.data.post,following:next}});
    }catch(error){if(epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken)this.setData({error:titleOf(error,"关注操作未完成，请重试。")});}
    finally{if(epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken)this.setData({busy:false});}
  },
  openAuthor(){const id=this.data.post?.authorId;if(!id||this.data.authorNavigating)return;
    this.setData({authorNavigating:true});
    wx.navigateTo({url:`/pages/community-author/index?id=${id}`,fail:()=>this.setData({authorNavigating:false})});
  },
  async report() {
    const post=this.data.post;if (!post || this.data.busy) return;
    if (!getApp<IAppOption>().globalData.sessionToken) { resumeAuthentication(`/pages/community-post/index?id=${this.data.postId}`); return; }
    const token=getApp<IAppOption>().globalData.sessionToken,epoch=this.data.epoch,postId=this.data.postId;
    const current=()=>token===getApp<IAppOption>().globalData.sessionToken&&epoch===this.data.epoch&&
      this.data.postId===postId&&this.data.post?.id===post.id&&this.data.post.version===post.version;
    const categories = ["不当广告", "骚扰", "不安全建议", "违法内容", "侵权", "隐私泄露", "其他"];
    const codes = ["spam", "harassment", "unsafe_advice", "illegal", "intellectual_property", "privacy", "other"];
    try {
      const chosen = await wx.showActionSheet({ itemList: categories });
      const category = codes[chosen.tapIndex]; if (!category||!current()) return;
      this.setData({ busy: true, error: "" });
      if(!current())return;
      await request({ path: `/v1/ugc/reports/post/${postId}`, method: "POST", data: { category } });
      if(current())this.setData({ notice: "已收到举报，我们会核查这篇内容。" });
    } catch (error) { if (current()&&!/cancel/i.test((error as { errMsg?: string })?.errMsg || "")) this.setData({ error: titleOf(error, "举报未提交，请重试。") }); }
    finally { if(current())this.setData({ busy: false }); }
  },
  async blockAuthor() {
    const post=this.data.post;if (!post || post.isMine || this.data.busy) return;
    if (!getApp<IAppOption>().globalData.sessionToken) { resumeAuthentication(`/pages/community-post/index?id=${this.data.postId}`); return; }
    const token=getApp<IAppOption>().globalData.sessionToken,epoch=this.data.epoch,postId=this.data.postId;
    const current=()=>token===getApp<IAppOption>().globalData.sessionToken&&epoch===this.data.epoch&&
      this.data.postId===postId&&this.data.post?.id===post.id&&this.data.post.version===post.version;
    const answer = await wx.showModal({ title: "屏蔽这位作者？", content: "屏蔽后，你的推荐列表中不再显示其内容。", confirmText: "屏蔽" });
    if (!answer.confirm||!current()) return;
    try {
      this.setData({ busy: true, error: "" });
      if(!current())return;
      await request({ path: `/v1/me/ugc/blocks/${post.authorId}`, method: "PUT", data: { active: true } });
      if(current())wx.navigateBack({ fail: () => wx.switchTab({ url: "/pages/community/index" }) });
    } catch (error) { if(current())this.setData({ error: titleOf(error, "屏蔽未完成，请重试。") }); }
    finally { if(current())this.setData({ busy: false }); }
  },
  editOwn() { if (this.data.post?.isMine) wx.navigateTo({ url: `/pages/community-compose/index?id=${this.data.postId}` }); },
  async deleteOwn() {
    const post=this.data.post;if (!post?.isMine || this.data.busy) return;
    const token=getApp<IAppOption>().globalData.sessionToken,epoch=this.data.epoch,postId=this.data.postId;
    const current=()=>token===getApp<IAppOption>().globalData.sessionToken&&epoch===this.data.epoch&&
      this.data.postId===postId&&this.data.post?.id===post.id&&this.data.post.version===post.version;
    const answer = await wx.showModal({ title: "删除这篇故事？", content: "删除后不会再公开显示，无法在小程序中恢复。", confirmText: "删除", confirmColor: "#8c354e" });
    if (!answer.confirm || !current()) return;
    try {
      this.setData({ busy: true, error: "" });
      if(!current())return;
      await request({ path: `/v1/me/ugc/posts/${postId}`, method: "DELETE", data: { expectedVersion: post.version } });
      if(current())wx.navigateBack({ fail: () => wx.switchTab({ url: "/pages/community/index" }) });
    } catch (error) { if(current())this.setData({ error: titleOf(error, "删除未完成，请重试。") }); }
    finally { if(current())this.setData({ busy: false }); }
  },
  previewImage(event: WechatMiniprogram.TouchEvent) {
    const src = String(event.currentTarget.dataset.src || ""), urls = this.data.images.map(item => item.src).filter(Boolean);
    if (src && urls.length) wx.previewImage({ current: src, urls });
  },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: "/pages/community/index" }) }); }
});
