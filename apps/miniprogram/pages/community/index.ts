import { request } from "../../services/api";
import { editorialStories } from "../../services/editorial";
import { currentChromeStyle } from "../../services/layout";
import { consumerTaskEntries } from "../../services/task-entry";

const feedColumns = (items: any[]) => [0,1].map(column => items.map((item,index) => ({ ...item, compactImage: index % 3 === 1 })).filter((_,index) => index % 2 === column));

Page({
  data: { feed: [] as any[], displayFeed: editorialStories, feedColumns: feedColumns(editorialStories), hero: editorialStories[0], tasks: [] as any[], tasksLoading: false, tasksError: "", feedAttempt: 0, tasksAttempt: 0, chromeStyle: currentChromeStyle(), loading: true, navigating: false, error: "" },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onShow() { this.setData({ navigating: false }); const tab = this.getTabBar?.(); if (tab) tab.setData({ active: 2, externalBusy: false }); tab?.syncActive?.(2); void this.load(); },
  onUnload() { this.data.feedAttempt += 1; this.data.tasksAttempt += 1; },
  async load() {
    const attempt = this.data.feedAttempt + 1;
    this.setData({ feedAttempt: attempt, feed: [], displayFeed: editorialStories, feedColumns: feedColumns(editorialStories), loading: true, error: "" });
    const tasksPromise = this.loadTasks();
    try {
      const feed = await request<any[]>({ path: "/v1/feed", authMode: "public" });
      if (this.data.feedAttempt !== attempt) return;
      // The feed exposes an object key, not an authorized media URL or avatar.
      // Never attribute bundled brand imagery or a local portrait to a submission.
      const reviewed = feed.map((item) => ({ ...item, kind: "ugc", image: "", avatar: "", author: "CISME 会员", publishedLabel: "经审用户投稿", engagementLabel: "只读展示" }));
      this.setData({ feed, displayFeed: reviewed.concat(editorialStories), feedColumns: feedColumns(reviewed.concat(editorialStories)), error: "" });
    } catch (error) {
      if (this.data.feedAttempt === attempt) this.setData({ feed: [], displayFeed: editorialStories, feedColumns: feedColumns(editorialStories), error: "经审用户内容暂时无法同步；当前仅保留已标明的品牌编辑内容。" });
    } finally {
      if (this.data.feedAttempt === attempt) this.setData({ loading: false });
      await tasksPromise;
    }
  },
  async loadTasks() {
    if (!getApp<IAppOption>().globalData.sessionToken) {
      this.data.tasksAttempt += 1;
      this.setData({ tasks: [], tasksLoading: false, tasksError: "" });
      return;
    }
    const attempt = this.data.tasksAttempt + 1;
    this.setData({ tasksAttempt: attempt, tasks: [], tasksLoading: true, tasksError: "" });
    try {
      const taskHistory = await request<any[]>({ path: "/v1/me/tasks", authMode: "optional" });
      if (this.data.tasksAttempt !== attempt) return;
      const tasks = consumerTaskEntries(taskHistory);
      this.setData({ tasks, tasksError: "" });
    } catch (error) {
      if (this.data.tasksAttempt === attempt) this.setData({ tasks: [], tasksError: "有效邀请暂时无法同步" });
    } finally {
      if (this.data.tasksAttempt === attempt) this.setData({ tasksLoading: false });
    }
  },
  openPost(event: WechatMiniprogram.TouchEvent) {
    if (this.data.navigating) return;
    const id = String(event.currentTarget.dataset.id ?? "");
    if (!id) { wx.showToast({ title: "内容编号缺失，请刷新后重试", icon: "none" }); return; }
    this.setData({ navigating: true });
    const tab = this.getTabBar?.(); if (tab) tab.setData({ externalBusy: true });
    wx.navigateTo({ url: `/pages/post/index?id=${encodeURIComponent(id)}`, fail: () => { this.setData({ navigating: false }); const currentTab = this.getTabBar?.(); if (currentTab) currentTab.setData({ externalBusy: false }); wx.showToast({ title: "护理故事暂时无法打开", icon: "none" }); } });
  },
  openInvite(event: WechatMiniprogram.TouchEvent) {
    if (this.data.tasksLoading || this.data.navigating) return;
    const id = String(event.currentTarget.dataset.id ?? "");
    const task = this.data.tasks.find((entry) => entry.id === id);
    if (!task) {
      this.setData({ tasksError: "邀请状态已更新，正在重新核验。" });
      wx.showToast({ title: "邀请状态已更新，请重试", icon: "none" });
      void this.loadTasks();
      return;
    }
    this.setData({ navigating: true });
    const tab = this.getTabBar?.(); if (tab) tab.setData({ externalBusy: true });
    wx.navigateTo({ url: `/pages/task/index?id=${task.id}`, fail: () => { this.setData({ navigating: false }); const currentTab = this.getTabBar?.(); if (currentTab) currentTab.setData({ externalBusy: false }); wx.showToast({ title: "投稿与邀请暂时无法打开", icon: "none" }); } });
  }
});
