export const TEXT_CARD_TEMPLATES = [
  {value:"plain",label:"基础"},{value:"minimal",label:"简约"},{value:"care",label:"护理"},
  {value:"memo",label:"笔记"},{value:"lilac",label:"渐变"},{value:"border",label:"边框"}
] as const;
export type TextCardTemplate = typeof TEXT_CARD_TEMPLATES[number]["value"];
export function isTextCardTemplate(value:unknown):value is TextCardTemplate {return TEXT_CARD_TEMPLATES.some(template=>template.value===value);}
export function normalizeTextCardTemplate(value:unknown):TextCardTemplate {return isTextCardTemplate(value)?value:"plain";}
export const textCardWidth = 720;
export const textCardHeight = 960;
export const textCardCharacterLimit = 300;

type Segmenter = new (locale: string, options: { granularity: "grapheme" }) => {
  segment(text: string): Iterable<{ segment: string }>;
};

/** Keep emoji families, skin tones, flags and combining characters intact. */
export function textCardGraphemes(text: string): string[] {
  const NativeSegmenter = typeof Intl === "undefined" ? undefined : (Intl as unknown as { Segmenter?: Segmenter }).Segmenter;
  if (NativeSegmenter) return Array.from(new NativeSegmenter("zh", { granularity: "grapheme" }).segment(text), item => item.segment);
  const result: string[] = [];
  let joinNext = false, regionalCount = 0;
  for (const point of Array.from(text)) {
    const code = point.codePointAt(0)!;
    const regional = code >= 0x1f1e6 && code <= 0x1f1ff;
    const modifier = code === 0xfe0e || code === 0xfe0f || code === 0x20e3 ||
      code >= 0x1f3fb && code <= 0x1f3ff || code >= 0x300 && code <= 0x36f ||
      code >= 0x1ab0 && code <= 0x1aff || code >= 0x1dc0 && code <= 0x1dff ||
      code >= 0x20d0 && code <= 0x20ff || code >= 0xfe20 && code <= 0xfe2f ||
      code >= 0xe0020 && code <= 0xe007f;
    if (result.length && (joinNext || modifier || code === 0x200d || regional && regionalCount % 2 === 1)) result[result.length - 1] += point;
    else result.push(point);
    joinNext = code === 0x200d;
    regionalCount = regional ? regionalCount + 1 : 0;
  }
  return result;
}

export function normalizeTextCardText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").trim();
}

export function hasTextCardContent(text: string): boolean {
  return text.replace(/[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufe0e\ufe0f]/g, "").length > 0;
}

export function textCardFontSize(text: string): number {
  const count = textCardGraphemes(normalizeTextCardText(text)).length;
  return count <= 8 ? 112 : count <= 24 ? 84 : count <= 60 ? 46 : count <= 130 ? 38 : count <= 220 ? 32 : 28;
}

/** Preserve short, intentional lines using widths measured at the base font. */
export function textCardParagraphFontSize(text:string,measureAtBase:(line:string)=>number):number {
  const normalized=normalizeTextCardText(text),base=textCardFontSize(normalized),paragraphs=normalized.split("\n").filter(hasTextCardContent);
  if(textCardGraphemes(normalized).length>24||paragraphs.length<2||paragraphs.length>3)return base;
  const longest=Math.max(...paragraphs.map(measureAtBase));
  return Number.isFinite(longest)&&longest>0?Math.max(46,Math.min(base,Math.floor(base*(textCardWidth-128)/longest))):base;
}

export type TextCardLayout = {
  text: string; lines: string[]; count: number; fontSize: number; lineHeight: number;
  maxLines: number; pages: number; overflow: boolean; valid: boolean; error: string;
};

/** Pure line wrapping; callers supply the same Canvas measureText used to draw. */
export function layoutTextCard(text: string, measure: (text: string) => number, options: {
  width?: number; height?: number; fontSize?: number; top?: number; bottom?: number; padding?: number;
} = {}): TextCardLayout {
  const normalized = normalizeTextCardText(text);
  const count = textCardGraphemes(normalized).length;
  const fontSize = options.fontSize ?? textCardFontSize(normalized);
  const lineHeight = Math.ceil(fontSize * 1.55);
  const width = (options.width ?? textCardWidth) - (options.padding ?? 64) * 2;
  const maxLines = Math.max(1, Math.floor(((options.height ?? textCardHeight) - (options.top ?? 148) - (options.bottom ?? 96)) / lineHeight));
  const lines: string[] = [];
  let tooWide = false;
  for (const paragraph of normalized.split("\n")) {
    let line = "";
    for (const grapheme of textCardGraphemes(paragraph)) {
      if (measure(grapheme) > width) tooWide = true;
      if (line && measure(line + grapheme) > width) { lines.push(line); line = grapheme; }
      else line += grapheme;
    }
    lines.push(line);
  }
  const pages = Math.max(1, Math.ceil(lines.length / maxLines));
  const overflow = tooWide || pages > 1;
  const error = !hasTextCardContent(normalized) ? "请先写下至少一个字。" : count > textCardCharacterLimit ? "文字卡片最多300字，请精简后重试。" :
    overflow ? `这些文字超出一张卡片${pages > 1 ? `（约需${pages}张）` : ""}，请减少换行或精简内容。` : "";
  return { text: normalized, lines, count, fontSize, lineHeight, maxLines, pages, overflow, valid: !error, error };
}
