/** Only fields consumed by the native card cross setData. Source models remain
 * private to the page; no cumulative raw feed is sent alongside the columns. */
export interface FeedCard { id: string; kind: string; title: string; image: string; avatar: string; author: string; engagementLabel: string; compactImage: boolean }
export function projectFeedCards(items: readonly any[]): [FeedCard[], FeedCard[]] {
  const columns: [FeedCard[], FeedCard[]] = [[], []];
  items.forEach((item, index) => columns[index % 2]!.push({ id: item.id, kind: item.kind, title: item.title || "护理故事", image: item.image || "", avatar: item.avatar || "", author: item.author || "CISME 会员", engagementLabel: item.engagementLabel || "", compactImage: index % 3 === 1 }));
  return columns;
}
export function feedColumnPatch(previous: readonly FeedCard[][], next: [FeedCard[], FeedCard[]]): WechatMiniprogram.IAnyObject {
  const patch: WechatMiniprogram.IAnyObject = {};
  for (let c = 0; c < 2; c++) {
    const before = previous[c] ?? [], after = next[c]!;
    if (after.length < before.length || before.some((row, i) => row.id !== after[i]?.id)) return { feedColumns: next };
    after.forEach((row, i) => {
      const old = before[i];
      if (!old || (Object.keys(row) as (keyof FeedCard)[]).some(key => old[key] !== row[key])) patch[`feedColumns[${c}][${i}]`] = row;
    });
  }
  return patch;
}
