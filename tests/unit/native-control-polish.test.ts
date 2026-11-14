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
  it("uses the community-standard tab component for both activity categories",()=>{
    const template=read("community-activity","wxml"),css=readFileSync('apps/miniprogram/components/section-tabs/index.wxss','utf8');
    assert.equal((template.match(/<section-tabs /g)||[]).length,2);
    assert.match(template,/items="{{sources}}"[\s\S]*?bindchange="selectSource"/);
    assert.match(template,/items="{{tabs}}"[\s\S]*?bindchange="selectSection"/);
    const tab=rule(css,'.section-tabs__tab');for(const style of ['display:flex','align-items:center','justify-content:center','background:transparent','min-height:44px','border:0'])assert.ok(tab.includes(style));
    const marker=rule(css,'.section-tabs__marker');for(const style of ['width:24px','height:2px','margin-top:4px'])assert.ok(marker.includes(style));
    assert.doesNotMatch(template,/activity-tabs__indicator|translateX/);
  });
  it("provides reduced-motion fallback without a JS animation runtime",()=>{
    const css=readFileSync('apps/miniprogram/components/section-tabs/index.wxss','utf8'),source=readFileSync('apps/miniprogram/components/section-tabs/index.ts','utf8');
    assert.match(css,/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*transition:none/);
    assert.doesNotMatch(source,/gsap|requestAnimationFrame|setInterval/);
  });
  it("does not show a misleading zero-record count during a failed read",()=>{
    assert.match(read("community-activity","wxml"),/wx:if="{{activityReady && !error && items.length}}" class="activity-count"/);
  });
  it("centers member-rate actions including the bottom-sheet footer",()=>{
    const css=read("management-members/commercial","wxss");
    for(const selector of [".members-global-rate button",".global-rate-footer button"]){
      const body=rule(css,selector);for(const style of ["display:flex","align-items:center","justify-content:center","min-height:44px","line-height:1.3","text-align:center"])assert.ok(body.includes(style),`${selector}: ${style}`);
      assert.ok(!body.includes("translateY"));
    }
  });
  it("keeps the search input and button the same height on narrow screens",()=>{
    const css=read("management-members/commercial","wxss");for(const selector of [".members-search input",".members-search button"])assert.ok(rule(css,selector).includes("height:44px"));
  });
  it("gives the finance retry a full-width rounded-rectangle target",()=>{
    const body=rule(read("management-finance","wxss"),".finance-error .text-button");
    for(const style of ["width:100%","min-height:44px","border-radius:12px","font-size:14px","align-items:center"])assert.ok(body.includes(style));
  });
  it("shortens commission explanations without hiding financial boundaries",()=>{
    const template=read("commission","wxml");
    for(const copy of ["测试记录，不涉及真实结算或提现。","金额随订单、退款和结算更新","退款争议可能减少下单可用额","购物权益与佣金、积分分别记录","使用时不重复计算佣金","勿重复申请"])assert.ok(template.includes(copy));
    assert.doesNotMatch(template,/状态由已核验支付、退款、履约和结算事实重建/);
    for(const condition of ["isolatedCredit&&creditFormVisible","isolatedTransfer&&formVisible","busy||!coreReady"])assert.ok(template.includes(condition));
  });
});
