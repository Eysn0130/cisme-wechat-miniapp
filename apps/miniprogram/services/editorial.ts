export interface EditorialStory {
  id: string;
  kind: "brand";
  title: string;
  excerpt: string;
  image: string;
  media?: string[];
  avatar: string;
  author: string;
  publishedLabel: string;
  engagementLabel: string;
  provenanceLabel: string;
}

export const editorialStories: EditorialStory[] = [
  {
    id: "brand-scalp-ritual",
    kind: "brand",
    title: "今晚的三分钟头皮仪式",
    excerpt: "从发际线缓慢梳到头顶，先让头皮回到舒展、清爽的状态。",
    image: "/assets/cisme/community-hero-scalp-ritual-v1.jpg",
    media: ["/assets/cisme/community-hero-scalp-ritual-v1.jpg", "/assets/cisme/community-card-scalp-massage-v2.jpg", "/assets/cisme/community-card-care-flatlay-v2.jpg"],
    avatar: "/assets/cisme/avatars/avatar-jingyu-v1.jpg",
    author: "CISME 护理编辑部",
    publishedLabel: "品牌护理内容",
    engagementLabel: "护理指南",
    provenanceLabel: "仅供测试预览 · 内容授权尚待确认 · 非用户投稿"
  },
  {
    id: "brand-night-routine",
    kind: "brand",
    title: "不赶时间的夜晚，我这样慢慢按摩头皮",
    excerpt: "指腹轻贴头皮，沿耳后、枕骨与头顶分区移动，不用指甲抓挠。",
    image: "/assets/cisme/community-card-scalp-massage-v2.jpg",
    avatar: "/assets/cisme/avatars/avatar-luna-v1.jpg",
    author: "CISME 护理编辑部",
    publishedLabel: "品牌护理内容",
    engagementLabel: "3 分钟",
    provenanceLabel: "仅供测试预览 · 内容授权尚待确认 · 非用户投稿"
  },
  {
    id: "brand-care-journal",
    kind: "brand",
    title: "洗完不急着下结论，先把真实感受写下来",
    excerpt: "以同一光线和角度记录 D1、D7、D14、D28，变化才更容易被看见。",
    image: "/assets/cisme/community-card-care-journal-v2.jpg",
    avatar: "/assets/cisme/avatars/avatar-muguang-v1.jpg",
    author: "CISME 护理编辑部",
    publishedLabel: "品牌护理内容",
    engagementLabel: "记录方法",
    provenanceLabel: "仅供测试预览 · 内容授权尚待确认 · 非用户投稿"
  },
  {
    id: "brand-roots-check",
    kind: "brand",
    title: "护理后如何观察发根与头皮状态",
    excerpt: "避开美颜和强滤镜，用自然光记录发缝、发际线与头皮舒适度。",
    image: "/assets/cisme/community-card-mirror-roots-v2.jpg",
    avatar: "/assets/cisme/avatars/avatar-zhihe-v1.jpg",
    author: "CISME 护理编辑部",
    publishedLabel: "品牌护理内容",
    engagementLabel: "观察清单",
    provenanceLabel: "仅供测试预览 · 内容授权尚待确认 · 非用户投稿"
  },
  {
    id: "brand-product-ritual",
    kind: "brand",
    title: "把护理瓶放在看得见的地方",
    excerpt: "让流程自然进入每天的生活，比偶尔用力坚持更容易形成长期习惯。",
    image: "/assets/cisme/community-card-purple-bottle-v1.jpg",
    avatar: "/assets/cisme/avatars/avatar-yurou-v1.jpg",
    author: "CISME 护理编辑部",
    publishedLabel: "品牌护理内容",
    engagementLabel: "习惯设计",
    provenanceLabel: "仅供测试预览 · 内容授权尚待确认 · 非用户投稿"
  }
];

export function editorialStory(id: string): EditorialStory | null {
  return editorialStories.find((item) => item.id === id) ?? null;
}
