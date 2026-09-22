import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
const read=(page:string,extension:string)=>readFileSync(`apps/miniprogram/pages/${page}/index.${extension}`,"utf8");
const rule=(css:string,selector:string)=>{
  const escaped=selector.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const matches=[...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`,"g"))];
  assert.ok(matches.length,`missing ${selector}`);return matches.map(match=>match[1]).join(";");
};

describe("targeted native control polish contracts (not visual acceptance)",()=>{
  it("uses one sliding rail with five full-size native tab buttons",()=>{
    const template=read("community-activity","wxml"),css=read("community-activity","wxss");
    assert.equal((template.match(/class="activity-tabs__indicator"/g)||[]).length,1);
    assert.match(template,/<button wx:for="{{tabs}}"[\s\S]*?role="tab"/);
    assert.match(template,/aria-selected="{{section===item.key}}"/);
    assert.match(template,/translateX\(/);for(const step of [100,200,300,400])assert.ok(template.includes(`?${step}`));
    const tab=rule(css,".activity-tab");for(const style of ["display:flex","align-items:center","justify-content:center","background:transparent","min-height:48px"])assert.ok(tab.includes(style));
    assert.ok(rule(css,".activity-tabs__indicator").includes("width:20%"));
  });
  it("provides reduced-motion fallback without a JS animation runtime",()=>{
    const css=read("community-activity","wxss"),source=read("community-activity","ts");
    assert.match(css,/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*transition:none/);
    assert.doesNotMatch(source,/gsap|requestAnimationFrame|setInterval/);
  });
  it("does not show a misleading zero-record count during a failed read",()=>{
    assert.match(read("community-activity","wxml"),/wx:if="{{!loading && !error && items.length}}" class="activity-count"/);
  });
  it("centers member-rate actions including the bottom-sheet footer",()=>{
    const css=read("management-members","wxss");
    for(const selector of [".members-global-rate button",".global-rate-footer button"]){
      const body=rule(css,selector);for(const style of ["display:flex","align-items:center","justify-content:center","min-height:44px","line-height:1.3","text-align:center"])assert.ok(body.includes(style),`${selector}: ${style}`);
      assert.ok(!body.includes("translateY"));
    }
  });
  it("keeps the search input and button the same height on narrow screens",()=>{
    const css=read("management-members","wxss");for(const selector of [".members-search input",".members-search button"])assert.ok(rule(css,selector).includes("height:44px"));
  });
  it("gives the finance retry a full-width rounded-rectangle target",()=>{
    const body=rule(read("management-finance","wxss"),".finance-error .text-button");
    for(const style of ["width:100%","min-height:44px","border-radius:12px","font-size:14px","align-items:center"])assert.ok(body.includes(style));
  });
  it("shortens commission explanations without hiding financial boundaries",()=>{
    const template=read("commission","wxml");
    for(const copy of ["仅供隔离测试，不支持真实提现","佣金不是积分","退款争议可能减少下单可用额","与现金佣金、积分分账","购物下单不重复计佣","不要新建重复申请"])assert.ok(template.includes(copy));
    assert.doesNotMatch(template,/状态由已核验支付、退款、履约和结算事实重建/);
    for(const condition of ["isolatedCredit&&creditFormVisible","isolatedTransfer&&formVisible","busy||!coreReady"])assert.ok(template.includes(condition));
  });
});
