import { describe, expect, it } from "vitest";
import { feedColumnPatch, projectFeedCards } from "../../apps/miniprogram/services/feed-projection";
const rows=(start:number,count:number)=>Array.from({length:count},(_,i)=>({id:`post-${start+i}`,kind:"formal",title:"护理故事",author:"合成会员",body:"must not cross bridge",author_avatar:"must not cross bridge",image:"/thumbnail",avatar:"/neutral",engagementLabel:"0 赞"}));
describe("native feed view projection and incremental bridge",()=>{
  it("appends only new card paths, never the cumulative raw feed",()=>{
    const before=projectFeedCards(rows(0,30)),after=projectFeedCards(rows(0,60));const patch=feedColumnPatch(before,after);
    expect(Object.keys(patch)).toHaveLength(30);expect(Object.keys(patch)).not.toContain("feedColumns");expect(Object.keys(patch)).not.toContain("feed");
    expect(JSON.stringify(patch)).not.toMatch(/must not cross bridge|author_avatar|body/);
  });
  it("does not transmit unchanged columns and updates just one changed card",()=>{
    const before=projectFeedCards(rows(0,100));expect(feedColumnPatch(before,projectFeedCards(rows(0,100)))).toEqual({});
    const changed=rows(0,100);changed[42]!.title="修订标题";expect(Object.keys(feedColumnPatch(before,projectFeedCards(changed)))).toEqual(["feedColumns[0][21]"]);
  });
  it("replaces columns when shrinking, reordering or switching to an empty view",()=>{
    const before=projectFeedCards(rows(0,30));
    for(const next of [rows(0,10),rows(0,30).reverse(),[]])expect(Object.keys(feedColumnPatch(before,projectFeedCards(next)))).toEqual(["feedColumns"]);
  });
  it("preserves stable two-column identity and compact-image placement for 300 cards",()=>{
    const result=projectFeedCards(rows(0,300));expect(result[0]).toHaveLength(150);expect(result[1]).toHaveLength(150);
    for(let i=0;i<300;i++)expect(result[i%2]![Math.floor(i/2)]).toMatchObject({id:`post-${i}`,compactImage:i%3===1});
  });
});
