import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";

// Geometry comes from the original 6.57.8 sprite, SHA-256
// c404bf69297e6d527a5af5c76fba2b3fbee4e3bad99ca98d06f7dd7617efc814.
// These independent source digests deliberately ignore SVG serialization.
const icons=[
  {name:"like_b",viewBox:"0 0 24 24",fill:"#333333",d:"f853dae3bcbf11a2cd867479f0b5c61cabd2cddd960ee26f969ddcce26a186fc"},
  {name:"liked",viewBox:"0 0 24 24",fill:"#FF2442",d:"6d433a0b3a724aa1854d32e445d6fb4d55cdef1323115ea805ed251834bee69d"},
  {name:"collect",viewBox:"0 0 24 24",fill:"#333333",d:"3b6b3bf909fad510d0553c4409777f9235c59f430de9ab60603f9647beb5d9ff"},
  {name:"collected",viewBox:"0 0 24 24",fill:"#FDBC5F",d:"185a7221465fbbdf0ef08b2719b914437da09ff9bfc981893fc6abba9bffeaae"},
  {name:"chat",viewBox:"0 0 24 24",fill:"#333333",d:"43fc003f5eaad592df7788217d2afaf7c4fc5fc4508e14c61fd2f6017639f070"},
  {name:"share_forward",viewBox:"0 0 26 26",fill:"#333333",d:"473e236705393415881ef66b4f245242a1c34da3914edc4e5b4484ef59d95b84"},
  {name:"close",viewBox:"0 0 24 24",fill:"#333333",d:"34e8b6add4e098f0c5cde3bf3c059b45677794a2ee623aaa508b5a168c40c6c0"}
]as const;
const attribute=(tag:string,name:string)=>tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];

describe("native detail uses the exact reference icon geometry",()=>{
  it.each(icons)("keeps $name geometry, viewport and original state color",({name,viewBox,fill,d})=>{
    const xml=readFileSync(new URL(`../../apps/miniprogram/assets/icons/post-reference/${name}.svg`,import.meta.url),"utf8");
    const svg=xml.match(/<svg\b[^>]*>/)?.[0];const paths=xml.match(/<path\b[^>]*\/?\s*>/g)??[];
    expect(svg).toBeDefined();expect(paths).toHaveLength(1);
    expect(attribute(svg!,"viewBox")).toBe(viewBox);
    const geometry=attribute(paths[0]!,"d");expect(geometry).toBeDefined();
    expect(createHash("sha256").update(geometry!).digest("hex")).toBe(d);
    expect(attribute(paths[0]!,"fill")??attribute(svg!,"fill")??"#000000").toBe(fill);
    expect(xml).not.toMatch(/<!DOCTYPE|<!ENTITY|<script|<style|<foreignObject|\b(?:href|on\w+)\s*=|url\(|currentColor/i);
    expect([...xml.matchAll(/<\/?([a-zA-Z][\w:-]*)\b/g)].map(match=>match[1])).toEqual(expect.arrayContaining(["svg","path"]));
    expect(new Set([...xml.matchAll(/<\/?([a-zA-Z][\w:-]*)\b/g)].map(match=>match[1]))).toEqual(new Set(["svg","path"]));
    if(name==="chat"){expect(attribute(paths[0]!,"fill-rule")).toBe("evenodd");expect(attribute(paths[0]!,"clip-rule")).toBe("evenodd");}
  });
});

const markup=readFileSync(new URL("../../apps/miniprogram/pages/post/index.wxml",import.meta.url),"utf8");
const css=readFileSync(new URL("../../apps/miniprogram/pages/post/index.wxss",import.meta.url),"utf8");
const stylesFor=(selector:string)=>[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(match=>match[1]!.split(",").map(value=>value.trim()).includes(selector)).map(match=>match[2]).join(";");
const propertiesFor=(selector:string,source=css)=>Object.fromEntries(
  [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match=>match[1]!.split(",").map(value=>value.trim()).includes(selector))
    .flatMap(match=>match[2]!.split(";").filter(value=>value.includes(":")))
    .map(value=>{const at=value.indexOf(":");return[value.slice(0,at).trim(),value.slice(at+1).trim()];})
);
const sizePx=(value:string,rootSize=16)=>{
  const match=value.match(/^(-?(?:\d+\.?\d*|\.\d+))(px|rem)?$/);
  if(!match)throw new Error(`Unsupported size in source contract: ${value}`);
  return Number(match[1])*(match[2]==="rem"?rootSize:1);
};
const boxSides=(value:string)=>{
  const parts=value.trim().split(/\s+/).map(part=>sizePx(part));
  return{top:parts[0]!,right:parts[1]??parts[0]!,bottom:parts[2]??parts[0]!,left:parts[3]??parts[1]??parts[0]!};
};
const resolveBlockWidth=(value:string,containingWidth:number,leftMargin:number,rightMargin:number)=>{
  if(value==="auto")return containingWidth-leftMargin-rightMargin;
  const percentage=value.match(/^(\d+(?:\.\d+)?)%$/);
  if(percentage)return containingWidth*Number(percentage[1])/100;
  const calc=value.match(/^calc\((\d+(?:\.\d+)?)%\s*-\s*(\d+(?:\.\d+)?px)\)$/);
  return calc?containingWidth*Number(calc[1])/100-sizePx(calc[2]!):sizePx(value);
};
const editorialBar=()=>{
  const body=markup.match(/<view\b[^>]*class="[^"]*\bpost-editorial-actions\b[^"]*"[^>]*>([\s\S]*?)<\/view>/)?.[1];
  expect(body).toBeDefined();return body!;
};

describe("native detail presentation preserves the authorized comments and source contracts",()=>{
  it("uses a declarative system root font without navigation, authentication bindings or events",()=>{
    const metas=[...markup.matchAll(/<page-meta\b(?:[^>"']|"[^"]*"|'[^']*')*\/?\s*>/g)].map(match=>match[0]);
    expect(metas).toHaveLength(1);expect(markup.trimStart().startsWith(metas[0]!)).toBe(true);
    expect([...metas[0]!.matchAll(/\b([\w-]+)\s*=/g)].map(match=>match[1])).toEqual(["root-font-size"]);
    expect(attribute(metas[0]!,"root-font-size")).toBe("system");
    expect(metas[0]).not.toMatch(/\{\{|\bbind|\bcatch|session|token|auth|url|route/i);
  });

  it("keeps the reference type sizes at16px while text scales with the system root",()=>{
    const typography:[string,number,number?][]=[
      [".post-title",18,28],[".post-copy",16,26],[".post-copy__topic",16,26],
      [".post-action-count",14,16.1],[".post-comment-label",14,16.1],[".post-comment-entry__label",14,16.1],
      [".post-ai-label",12,18],[".post-published",14,16.8],
      [".post-page .state",12,19.2],[".post-page .text-button",14,20]
    ];
    for(const [selector,font,line]of typography){
      const style=propertiesFor(selector);expect(style["font-size"],selector).toMatch(/rem$/);
      expect(sizePx(style["font-size"]!),selector).toBeCloseTo(font);
      expect(sizePx(style["font-size"]!,20),selector).toBeCloseTo(font*1.25);
      if(line){expect(style["line-height"],selector).toMatch(/rem$/);expect(sizePx(style["line-height"]!),selector).toBeCloseTo(line);expect(sizePx(style["line-height"]!,20),selector).toBeCloseTo(line*1.25);}
    }
    expect(propertiesFor(".post-title")["font-weight"]).toBe("500");
    expect(propertiesFor(".post-copy__topic").color).toBe("#133667");
  });

  it("uses five distinct idle editorial actions with true counts and an explicit composer entry, without invented views",()=>{
    const body=editorialBar();
    const buttons=[...body.matchAll(/<button\b(?:(?:"[^"]*")|(?:'[^']*')|[^'">])*?>[\s\S]*?<\/button>/g)].map(match=>match[0]);
    expect(buttons).toHaveLength(5);
    expect(buttons.map(button=>attribute(button,"bindtap")??`@${attribute(button,"open-type")}`))
      .toEqual(["startComment","toggleLike","toggleSave","showComments","@share"]);
    expect(body).not.toMatch(/<(?:input|textarea)\b|bind(?:input|confirm)=|sendComment|(?:view|read)Count|阅读量/);
    expect(buttons[0]).toContain("commentsEnabled !== true ? '查看评论'");expect(buttons[0]).toContain("'说点什么…'");
    expect(buttons[3]).toContain("{{commentCount === null ? '评论' : commentCount}}");
    expect(markup).toContain('<view wx:if="{{editorialSource && composerOpen}}" class="post-editorial-composer">');
    const textarea=markup.match(/<textarea\b[^>]*\/>/)?.[0];expect(textarea).toBeDefined();
    expect(attribute(textarea!,"bindinput")).toBe("inputComment");expect(attribute(textarea!,"maxlength")).toBe("360");
    expect(attribute(textarea!,"disabled")).toContain("commentSendUnknown");
    expect(attribute(buttons[1]!,"class")).toContain("post-like-action");
    expect(attribute(buttons[2]!,"class")).toContain("post-save-action");
    expect(buttons[1]).toContain("social.liked ? '/assets/icons/post-reference/liked.svg' : '/assets/icons/post-reference/like_b.svg'");
    expect(buttons[1]).toContain("{{social.likeCount}}");
    expect(buttons[2]).toContain("social.saved ? '/assets/icons/post-reference/collected.svg' : '/assets/icons/post-reference/collect.svg'");
    expect(buttons[2]).toContain("{{social.saveCount}}");
    expect(buttons[3]).toContain('/assets/icons/post-reference/chat.svg');
    expect(buttons[4]).toContain('/assets/icons/post-reference/share_forward.svg');
    for(const button of [buttons[1]!,buttons[2]!])expect(attribute(button,"disabled")).toBe("{{socialBusy || !socialEnabled}}");
    expect(markup).toMatch(/<button\b[^>]*bindtap="back"[^>]*>[\s\S]*?<image\b[^>]*src="\/assets\/icons\/arrow-left-ink\.svg"/);
  });

  it("reuses measured native navigation and places the conditional author in content flow below media before the title",()=>{
    const appCss=readFileSync(new URL("../../apps/miniprogram/app.wxss",import.meta.url),"utf8");
    expect(markup).toContain('class="topbar post-topbar"');
    expect(markup).toMatch(/<button\b[^>]*class="topbar__back post-back[^>]*bindtap="back"/);
    const back=propertiesFor(".topbar__back",appCss),glyph=propertiesFor(".topbar__back-icon",appCss),nav=propertiesFor(".topbar",appCss);
    expect(sizePx(back.width!)).toBeGreaterThanOrEqual(44);expect(sizePx(back.height!)).toBeGreaterThanOrEqual(44);
    expect(sizePx(glyph.width!)).toBe(18);expect(sizePx(glyph.height!)).toBe(18);
    expect(back.top).toContain("--cisme-back-top");expect(nav.height).toContain("--cisme-topbar-height");expect(nav.padding).toContain("--cisme-nav-side");
    expect(markup).toContain('<view wx:if="{{item}}" class="post-authorbar">');
    expect(propertiesFor(".post-page").padding).toMatch(/^var\(--cisme-topbar-height\) 0 /);
    expect(propertiesFor(".post-authorbar").position).not.toBe("fixed");
    expect(sizePx(propertiesFor(".post-authorbar")["min-height"]!)).toBeGreaterThanOrEqual(44);
    expect(markup.indexOf('class="post-authorbar"')).toBeGreaterThan(markup.indexOf('class="post-gallery"'));
    expect(markup.indexOf('class="post-authorbar"')).toBeLessThan(markup.indexOf('class="post-title"'));
    expect(markup).not.toContain("post-page--with-author");
    expect(markup).not.toContain('class="error-scene__eyebrow"');
    expect(markup).toMatch(/<text\b[^>]*class="post-title"[^>]*aria-role="heading"[^>]*aria-level="1"/);
    expect(markup).toMatch(/<image\b[^>]*class="post-cover"[^>]*bindtap="previewMedia"[^>]*aria-role="button"/);
    expect(markup).toMatch(/class="page page--stack post-page[^>]*bindtouchstart="interruptReadingRestore"/);
  });

  it("keeps the idle composer label readable and retains distinct44px controls without duplicate editorial gaps",()=>{
    const entry=propertiesFor(".post-comment-entry"),label=propertiesFor(".post-comment-entry__label");
    expect(entry.display).toBe("flex");expect(entry["align-items"]).toBe("center");expect(sizePx(entry["min-height"]!)).toBeGreaterThanOrEqual(44);
    expect(editorialBar()).toContain('class="post-comment-entry__label"');expect(editorialBar()).toContain("'继续编辑…'");
    expect(label.overflow).toBe("hidden");expect(label["text-overflow"]).toBe("ellipsis");expect(label["min-width"]).toBe("0");
    const action=propertiesFor(".post-bottom-action"),group=propertiesFor(".post-editorial-actions .post-bottom-action");
    const first=propertiesFor(".post-editorial-actions .post-like-action");
    expect(sizePx(action["min-width"]!)).toBeGreaterThanOrEqual(44);expect(sizePx(action["min-height"]!)).toBeGreaterThanOrEqual(44);
    expect(sizePx(group["margin-left"]!)).toBe(0);expect(sizePx(first["margin-left"]!)).toBe(4);
    const share={...propertiesFor(".post-share-action"),...propertiesFor(".post-editorial-actions .post-share-action")};
    const touchWidth=sizePx(share.width!),flowWidth=touchWidth+sizePx(share["margin-right"]!);
    expect(touchWidth).toBeGreaterThanOrEqual(44);expect(flowWidth).toBe(40);
    // Only the last control can use the negative end margin: its hit area fits
    // inside the16px outer inset and does not extend back over the comment button.
    expect(sizePx(share["margin-right"]!)).toBeGreaterThanOrEqual(-16);
    expect(sizePx(group["margin-left"]!)).toBeGreaterThanOrEqual(0);
    expect(sizePx(share["padding-left"]!)+24+sizePx(share["padding-right"]!)).toBeLessThanOrEqual(touchWidth);
  });

  it("grows the footer row and reserved body space together when the system text grows",()=>{
    const row=propertiesFor(".post-bottom-actions"),page=propertiesFor(".post-page");
    const safe="var(--cisme-safe-bottom,env(safe-area-inset-bottom))";
    expect(page.padding).toContain(safe);
    const remainder=page.padding!.slice(page.padding!.indexOf(safe)+safe.length).replace(/\)\s*$/,"");
    const extra=(root:number)=>remainder.split("+").map(value=>value.trim()).filter(Boolean).reduce((sum,value)=>sum+sizePx(value,root),0);
    for(const root of [16,20,24]){
      const rowHeight=Math.max(sizePx(row.height!,root),sizePx(row["min-height"]!,root));
      expect(rowHeight).toBeGreaterThanOrEqual(40);expect(extra(root)-rowHeight).toBeCloseTo(72);
    }
    expect(sizePx(row.height!)).toBe(40);expect(sizePx(row.height!,20)).toBe(50);
  });

  it("keeps the unavailable card inside its containing viewport despite inherited full-width error styling",()=>{
    const appCss=readFileSync(new URL("../../apps/miniprogram/app.wxss",import.meta.url),"utf8");
    const style={...propertiesFor(".error-scene",appCss),...propertiesFor(".post-unavailable")};
    const margin=boxSides(style.margin!);
    for(const viewport of [320,375,390,412]){
      const left=margin.left,right=left+resolveBlockWidth(style.width!,viewport,margin.left,margin.right);
      expect(left).toBeGreaterThanOrEqual(0);expect(right,`card right at${viewport}`).toBeLessThanOrEqual(viewport);
      expect(left,`symmetric insets at${viewport}`).toBeCloseTo(viewport-right);
      expect(right-left).toBeGreaterThan(0);
    }
  });

  it("fits media to bounded verified canvases and keeps non-intercepting pagination over the native swiper",()=>{
    const gallery=markup.match(/<view\b[^>]*class="post-gallery"[^>]*>([\s\S]*?)<view wx:if="\{\{editorialSource && mediaError\}\}"/)?.[1];
    expect(gallery).toBeDefined();
    expect(gallery).toMatch(/<image\b[^>]*class="post-cover"[^>]*mode="aspectFit"/);
    expect(gallery).toContain('data-image-identity="{{imageEventId}}"');
    expect(gallery).toContain('indicator-dots="{{false}}"');
    expect(gallery).toContain('duration="300"');expect(gallery).toContain('easing-function="easeOutCubic"');
    expect(gallery).toContain('autoplay="{{false}}"');expect(gallery).toContain('circular="{{false}}"');
    const afterSwiper=gallery!.slice(gallery!.indexOf("</swiper>")+"</swiper>".length);
    expect(afterSwiper).toContain('class="post-gallery-count"');expect(afterSwiper).toContain("{{mediaIndex + 1}}/{{media.length}}");
    expect(afterSwiper).toContain('class="post-gallery-pagination"');
    expect(propertiesFor(".post-gallery").position).toBe("relative");
    for(const selector of [".post-gallery-count",".post-gallery-pagination"]){expect(propertiesFor(selector).position).toBe("absolute");expect(propertiesFor(selector)["pointer-events"]).toBe("none");}
    expect(gallery).toContain("index === mediaIndex ? 'is-current' : ''");
    expect(gallery).toContain('style="height:{{galleryHeight}}rpx"');
    for(const selector of [".post-cover",".post-video"]){const fallback=propertiesFor(selector).height?.match(/^([\d.]+)rpx$/);expect(fallback).toBeDefined();expect(Number(fallback![1])).toBeGreaterThanOrEqual(375);expect(Number(fallback![1])).toBeLessThanOrEqual(1000);}
    const video=markup.match(/<video\b[^>]*\/>/)?.[0];expect(video).toBeDefined();
    expect(attribute(video!,"object-fit")).toBe("contain");expect(attribute(video!,"autoplay")).toBe("{{false}}");
    expect(attribute(video!,"style")).toBe("height:{{videoHeightRpx}}rpx");
    expect(stylesFor(".post-gallery-dot")).toMatch(/width\s*:\s*6px\s*;/);
    expect(stylesFor(".post-gallery-dot")).toMatch(/height\s*:\s*6px\s*;/);
  });

  it("renders exact text segments without automatic bold or rich HTML and retains the short AI label and explicit source-menu entry",()=>{
    const body=markup.match(/<text wx:if="\{\{editorialSource\}\}" class="post-copy">([\s\S]*?)<\/text><\/text>/)?.[1];
    expect(body).toBeDefined();expect(body).toContain('wx:for="{{item.readingSegments}}"');expect(body).toContain("{{item.text}}");
    expect(body).not.toMatch(/<(?:strong|b|rich-text)\b/);
    expect(stylesFor(".post-copy")).toMatch(/white-space\s*:\s*pre-wrap\s*;/);
    for(const selector of [".post-copy",".post-copy__body",".post-copy__heading",".post-copy__topic"])
      expect(stylesFor(selector)).toMatch(/font-weight\s*:\s*400\s*;/);
    expect(markup).toMatch(/<text\b[^>]*wx:if="\{\{editorialSource && aiLabel\}\}"[^>]*class="post-ai-label">\{\{aiLabel\}\}<\/text>/);
    expect(markup).toMatch(/<button\b[^>]*bindtap="openPostMore"[^>]*aria-label="文章更多操作"/);
    const logic=readFileSync(new URL("../../apps/miniprogram/pages/post/index.ts",import.meta.url),"utf8");
    expect(logic).toContain('if(this.data.item.sourceUrl)actions.push({label:"复制原文链接",run:()=>this.copySource()});');
    expect(logic).toContain('if(typeof url==="string"&&/^https:\\/\\//.test(url))wx.setClipboardData({data:url});');
  });
});
