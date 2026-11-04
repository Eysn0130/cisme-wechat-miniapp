import sharp from "sharp";
import { DomainError } from "@cisme/domain";

/** The synchronous endpoint receives the exact, metadata-free detail image
 * that will be public. Oversize images are never treated as checked. */
export async function prepareUgcSyncImage(original: Uint8Array): Promise<Buffer> {
  const image = sharp(Buffer.from(original), { limitInputPixels: 36_000_000 })
    .rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" });
  for (const quality of [90, 85, 80, 75]) {
    const bytes = await image.clone().jpeg({ quality, chromaSubsampling: "4:4:4" }).toBuffer();
    if (bytes.length <= 1024 * 1024) return bytes;
  }
  throw new DomainError("UGC_SCAN_IMAGE_TOO_LARGE", "图片暂无法完成安全检查，请更换图片后重试，草稿仍保留。", 422);
}
