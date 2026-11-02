import { describe, expect, it, vi } from "vitest";
import { hasTextCardContent, isTextCardTemplate, layoutTextCard, normalizeTextCardTemplate, normalizeTextCardText, TEXT_CARD_TEMPLATES, textCardFontSize, textCardGraphemes } from "../../apps/miniprogram/services/ugc-text-card-layout";

describe("local text card layout",()=>{
  it("shares six real template keys while preserving legacy selections and rejecting unknown values",()=>{
    expect(TEXT_CARD_TEMPLATES.map(item=>item.value)).toEqual(["plain","minimal","care","memo","lilac","border"]);
    for(const item of TEXT_CARD_TEMPLATES){expect(isTextCardTemplate(item.value)).toBe(true);expect(normalizeTextCardTemplate(item.value)).toBe(item.value);}
    expect(normalizeTextCardTemplate("unsupported")).toBe("plain");expect(isTextCardTemplate(null)).toBe(false);
  });
  it("gives short phrases visibly larger type without clipping the card, while retaining explicit lines",()=>{
    expect(textCardFontSize("测试")).toBe(112);expect(textCardFontSize("今天给自己一段认真护理的时间")).toBe(84);
    for(const text of ["测试","护理\n记录","认真护理也是照顾自己"]){const size=textCardFontSize(text),layout=layoutTextCard(text,value=>textCardGraphemes(value).length*size);expect(layout.valid).toBe(true);expect(layout.lines.join("")).toBe(text.replace(/\n/g,""));}
    expect(textCardFontSize("护".repeat(300))).toBe(28);
  });
  it("wraps Chinese without dropping or duplicating characters",()=>{
    const input="每天认真记录护理感受".repeat(9);
    const layout=layoutTextCard(input,value=>textCardGraphemes(value).length*28,{fontSize:28});
    expect(layout.valid).toBe(true);expect(layout.lines.join("")).toBe(input);
    expect(layout.lines.every(line=>textCardGraphemes(line).length*28<=592)).toBe(true);
  });
  it("keeps emoji families, skin tones, flags and combining marks together",()=>{
    const clusters=["👨‍👩‍👧‍👦","👍🏽","🇨🇳","e\u0301","1️⃣"];
    expect(textCardGraphemes(clusters.join(""))).toEqual(clusters);
    const wrapped=layoutTextCard(clusters.join(""),value=>textCardGraphemes(value).length*100,{width:228,padding:64,height:1400});
    expect(wrapped.lines).toEqual(clusters);expect(wrapped.valid).toBe(true);
  });
  it("keeps the same emoji boundaries when Intl.Segmenter is unavailable",()=>{
    const original=(Intl as unknown as {Segmenter?:unknown}).Segmenter;
    vi.stubGlobal("Intl",{...Intl,Segmenter:undefined});
    try{expect(textCardGraphemes("👨‍👩‍👧‍👦👍🏽🇨🇳🇺🇸e\u03011️⃣")).toEqual(["👨‍👩‍👧‍👦","👍🏽","🇨🇳","🇺🇸","e\u0301","1️⃣"]);}
    finally{vi.unstubAllGlobals();expect((Intl as unknown as {Segmenter?:unknown}).Segmenter).toBe(original);}
  });
  it("rejects empty or invisible-only content",()=>{
    expect(hasTextCardContent(" \n\t\u200b\u200d\ufe0f")).toBe(false);
    expect(layoutTextCard(" \n",value=>value.length*20).valid).toBe(false);
    expect(layoutTextCard("🙂",()=>40).valid).toBe(true);
  });
  it("fits 300 Chinese characters at the bounded small type size",()=>{
    const input="护".repeat(300),size=textCardFontSize(input);
    const result=layoutTextCard(input,value=>textCardGraphemes(value).length*size);
    expect(result).toMatchObject({count:300,fontSize:28,overflow:false,valid:true});expect(result.lines.join("")).toBe(input);
    expect(layoutTextCard(input+"理",value=>value.length*28)).toMatchObject({count:301,valid:false});
  });
  it("reports multiple pages for excessive explicit breaks and retains every line",()=>{
    const input=Array.from({length:35},(_,index)=>String(index)).join("\n");
    const result=layoutTextCard(input,value=>value.length*28);
    expect(result.valid).toBe(false);expect(result.overflow).toBe(true);expect(result.pages).toBeGreaterThan(1);
    expect(result.lines.join("\n")).toBe(input);expect(result.error).toContain("超出一张卡片");
  });
  it("reports an oversized indivisible grapheme rather than splitting it",()=>{
    const result=layoutTextCard("👨‍👩‍👧‍👦",()=>800);
    expect(result.overflow).toBe(true);expect(result.valid).toBe(false);expect(result.lines).toEqual(["👨‍👩‍👧‍👦"]);
  });
  it("normalizes line endings and tabs without removing intentional blank lines",()=>{
    expect(normalizeTextCardText("  护理\r\n\r\n记录\t今天  ")).toBe("护理\n\n记录  今天");
    expect(layoutTextCard("护理\n\n记录",value=>value.length*32).lines).toEqual(["护理","","记录"]);
  });
});
