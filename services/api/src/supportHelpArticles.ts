/** Reviewed, public-facing help text. Source paths are for maintainers only. */
export type SupportHelpArticle = {
  id: string;
  title: string;
  version: string;
  terms: readonly string[];
  content: string;
  source: readonly string[];
  action?: 'orders' | 'care-records' | 'points' | 'invite' | 'my-community' | 'settings' | 'sharing-officer' | 'shop' | 'privacy';
};

export const supportHelpArticles: readonly SupportHelpArticle[] = [
  {
    id: 'cisme.help-login', title: '登录与游客浏览', version: '2026-11-24.1',
    terms: ['微信登录', '登录不了', '无法登录', '登录失败', '游客浏览', '游客能看', '需要登录', '头像昵称确认'],
    content: '未登录可浏览公开社区、帖子和作者；护理、商城和「我的」等需要微信登录并确认头像昵称。无法登录时，可在登录页点「无法登录？联系微信客服」，打开和送达情况以微信平台实际结果为准。',
    source: ['apps/miniprogram/services/route-access.ts', 'apps/miniprogram/pages/account/index.wxml', 'docs/product/CISME-产品需求文档-PRD-V2.1-R4.md']
  },
  {
    id: 'cisme.help-profile', title: '修改头像、昵称和地址', version: '2026-11-24.1',
    terms: ['修改头像', '更换头像', '修改昵称', '更改昵称', '个人资料', '收货地址', '添加地址', '修改地址'],
    content: '登录后，在「我的」点头像或昵称可修改会员资料；也可进入「我的 → 设置」，选择「头像与昵称」或「收货地址」。填写后按页面提示保存，已有订单的收货信息请在订单中核对。',
    source: ['apps/miniprogram/pages/profile/index.wxml', 'apps/miniprogram/pages/profile/index.ts', 'apps/miniprogram/pages/settings/index.wxml'],
    action: 'settings'
  },
  {
    id: 'cisme.help-support', title: '联系人工客服', version: '2026-11-24.1',
    terms: ['申请人工', '转人工', '联系人工', '人工客服', '联系客服', '人工接待', '客服入口', '人工处理'],
    content: '登录后可从「我的 → 客服」留言，主动点「申请人工」；咨询订单时可在会话中选择订单。是否已申请、等待或接入，以会话实际状态为准；申请失败时按页面提示重试。',
    source: ['apps/miniprogram/pages/profile/index.wxml', 'apps/miniprogram/pages/support/index.wxml', 'services/api/src/supportService.ts']
  },
  {
    id: 'cisme.help-care-records', title: '查看与调整护理记录', version: '2026-11-24.1',
    terms: ['护理记录', '查看护理', '今天的记录', '调整今日记录', '护理记录在哪', '护理感受', '查看打卡', '记录在哪里'],
    content: '在「护理」页点击今日记录旁的「详情」，可按日期查看实际使用的产品、感受和对应积分。当天需修改时，可按护理页显示的「调整今日记录」更新；结果未确认时先刷新记录核对。',
    source: ['apps/miniprogram/pages/home/index.wxml', 'apps/miniprogram/pages/home/index.ts', 'apps/miniprogram/pages/records/index.wxml'],
    action: 'care-records'
  },
  {
    id: 'cisme.help-points', title: '积分明细与规则', version: '2026-11-24.1',
    terms: ['我的积分', '积分明细', '积分记录', '积分规则', '积分攻略', '积分怎么用', '积分没到账', '积分兑换', '积分余额', '积分在哪里', '积分有什么用'],
    content: '登录后点「我的」会员卡，可查看积分明细与兑换；社区顶部也有「积分攻略」。积分获得、抵扣和兑换以页面显示的当前规则及本人记录为准；有疑问可申请人工核对。',
    source: ['apps/miniprogram/pages/profile/index.wxml', 'apps/miniprogram/pages/community/index.wxml', 'apps/miniprogram/pages/points/index.ts', 'apps/miniprogram/pages/points/index.wxml'],
    action: 'points'
  },
  {
    id: 'cisme.help-invite', title: '邀请好友', version: '2026-11-24.1',
    terms: ['邀请好友', '邀请朋友', '分享给朋友', '生成分享卡片', '邀请卡片', '邀请链接', '好友邀请', '邀请入口', '如何邀请'],
    content: '登录后进入「我的 → 邀请好友」，按页面提示生成分享卡片，再点「分享给朋友」。分享记录和链接状态以页面为准；点分享不代表好友已完成注册、购买或奖励已到账。',
    source: ['apps/miniprogram/pages/profile/index.wxml', 'apps/miniprogram/pages/invite/index.wxml', 'apps/miniprogram/pages/invite/index.ts'],
    action: 'invite'
  },
  {
    id: 'cisme.help-orders', title: '查找订单', version: '2026-11-24.1',
    terms: ['我的订单', '查看订单', '找不到订单', '订单在哪', '订单列表', '查找订单', '订单入口', '订单详情', '订单不见了'],
    content: '登录后从「我的 → 我的订单」进入订单列表，点订单可查看详情；商城页也有「我的订单」入口。列表加载失败可点「重试」；仍找不到时可申请人工核对。',
    source: ['apps/miniprogram/pages/profile/index.wxml', 'apps/miniprogram/pages/shop/index.wxml', 'apps/miniprogram/pages/orders/index.wxml'],
    action: 'orders'
  },
  {
    id: 'cisme.help-payment', title: '支付结果待确认', version: '2026-11-24.1',
    terms: ['支付失败', '付款失败', '支付结果', '付款结果', '已经扣款', '付款没反应', '支付未完成', '重复付款', '微信支付', '扣钱了', '支付成功'],
    content: '先到「我的 → 我的订单」打开原订单，查看当前状态；如页面出现「查询付款结果」，可先查询。付款或操作结果尚未确认时不要重复下单或付款，仍有疑问请申请人工核实。',
    source: ['apps/miniprogram/pages/order-detail/index.wxml', 'apps/miniprogram/pages/order-detail/index.ts', 'apps/miniprogram/services/commerce-command-discovery.ts'],
    action: 'orders'
  },
  {
    id: 'cisme.help-logistics', title: '物流与收货', version: '2026-11-24.1',
    terms: ['查看物流', '物流信息', '物流详情', '快递到哪', '运单号', '查快递', '确认收货', '订单发货', '我的快递', '发货了吗'],
    content: '在「我的 → 我的订单」打开订单，查看「物流与收货」。已有运单时可复制运单号；物流详情和确认收货入口以订单当前显示为准。查询失败可重试，仍有问题可申请人工核实。',
    source: ['apps/miniprogram/pages/order-detail/index.wxml', 'apps/miniprogram/pages/order-detail/index.ts', 'services/api/src/wechatLogisticsQuery.ts'],
    action: 'orders'
  },
  {
    id: 'cisme.help-aftersale', title: '申请售后与查看进度', version: '2026-11-24.1',
    terms: ['申请售后', '售后服务', '申请退款', '退货退款', '仅退款', '售后进度', '退款进度', '退款申请', '订单售后', '退款没到账', '退货怎么申请', '怎么退款', '退款入口'],
    content: '在「我的 → 我的订单」打开已支付订单，点「售后服务」，按页面选择商品、数量和售后情形并提交，也可先咨询客服。申请进度以售后页面记录为准，提交申请不等于退款已完成。',
    source: ['apps/miniprogram/pages/order-detail/index.wxml', 'apps/miniprogram/pages/aftersale/index.wxml', 'services/api/src/aftersale.ts'],
    action: 'orders'
  },
  {
    id: 'cisme.help-return', title: '退货地址与寄件', version: '2026-11-24.1',
    terms: ['退货地址', '退货寄哪里', '退回地址', '退货运单', '寄回商品', '填写退货物流', '退货运费', '怎么寄回'],
    content: '退货申请后，请先在本单售后进度中查看客服提供的退货指引，未收到地址前不要寄出。页面需要登记寄件时，选择实际使用的指引并填写快递信息；运费承担以本案指引为准。',
    source: ['apps/miniprogram/pages/order-detail/index.wxml', 'apps/miniprogram/pages/aftersale/index.wxml'],
    action: 'orders'
  },
  {
    id: 'cisme.help-product-use', title: '查看产品说明', version: '2026-11-24.1',
    terms: ['产品怎么用', '产品用法', '使用方法', '使用说明', '产品成分', '产品说明', '洗发水用法', '精华怎么用', '适合什么人', '洗发水怎么用', '精华使用'],
    content: '可在「商城」打开商品，查看详情图及产品包装上的成分和使用说明；具体用量、频次与适用情况以产品说明为准。如使用后明显不适，请暂停使用并寻求专业帮助，也可联系人工反馈。',
    source: ['apps/miniprogram/pages/shop/index.wxml', 'apps/miniprogram/pages/product/index.wxml', 'apps/miniprogram/services/commerce-content.ts', 'services/api/src/deepseekSupportAi.ts'],
    action: 'shop'
  },
  {
    id: 'cisme.help-shop', title: '商城选购与结算', version: '2026-11-24.1',
    terms: ['下单流程','怎么买','购买流程','商品购买','选择规格','立即购买','怎么结算','商品下单'],
    content: '在「商城」打开商品，选择规格和数量，再点「立即购买」。结算时核对收货地址、商品和实付金额，是否可购买、可付款以当前页面为准。',
    source: ['apps/miniprogram/pages/shop/index.wxml','apps/miniprogram/pages/product/index.wxml','apps/miniprogram/pages/checkout/index.wxml'],
    action: 'shop'
  },
  {
    id: 'cisme.help-sharing-officer', title: '申请分享官', version: '2026-11-24.1',
    terms: ['申请分享官', '成为分享官', '分享官资格', '分享官审核', '分享官申请', '申请推荐官', '成为推荐官', '分享官协议'],
    content: '登录后进入「我的 → 分享官」，按页面核对购买资格与申请状态。满足页面条件后，阅读并同意已启用的合作协议再提交申请；审核通过并开通分享权限后，才可开展推广。',
    source: ['apps/miniprogram/pages/profile/index.wxml', 'apps/miniprogram/pages/sharing-officer/index.wxml', 'packages/contracts/src/sharingOfficerAgreement.ts'],
    action: 'sharing-officer'
  },
  {
    id: 'cisme.help-community-publish', title: '发布社区内容', version: '2026-11-24.1',
    terms: ['社区发帖', '怎么发帖', '发布帖子', '发布笔记', '发布作品', '去发布', '发布草稿', '发图文', '发布失败'],
    content: '登录后从「社区」发布入口选择相册、相机或写文字，完成内容后可先「存草稿」或主动点「去发布」。草稿仅自己可见；公开发布需通过微信内容安全检查，状态以页面显示为准。',
    source: ['apps/miniprogram/pages/community/index.wxml', 'apps/miniprogram/pages/community-compose/index.wxml', 'docs/product/CISME-产品需求文档-PRD-V2.1-R4.md']
  },
  {
    id: 'cisme.help-community-appeal', title: '查看下架原因与申诉', version: '2026-11-24.1',
    terms: ['帖子下架', '作品下架', '内容下架', '下架原因', '下架申诉', '帖子申诉', '作品申诉', '恢复展示'],
    content: '在「我的 → 我的社区」打开本人标记「已下架」的作品，可查看下架信息；符合页面条件时点「申诉」。如有未保存修改，请先保留并重新打开；处理结果以页面显示为准。',
    source: ['apps/miniprogram/pages/profile/index.wxml', 'apps/miniprogram/pages/community-author/index.ts', 'apps/miniprogram/pages/community-compose/index.wxml'],
    action: 'my-community'
  },
  {
    id: 'cisme.help-privacy', title: '数据与账号权利', version: '2026-11-24.1',
    terms: ['注销账号', '删除账号', '删除资料', '导出数据', '数据副本', '撤回授权', '隐私政策', '用户协议', '个人数据'],
    content: '登录后可在「我的 → 设置」查看「隐私政策与用户协议」及「数据与账号权利」，按页面提交相应申请；已有内容使用授权可在设置中管理。申请及处理结果以页面记录为准。',
    source: ['apps/miniprogram/pages/settings/index.wxml', 'apps/miniprogram/pages/privacy-rights/index.wxml'],
    action: 'privacy'
  }
];
