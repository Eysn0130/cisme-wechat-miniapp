import { createHash } from 'node:crypto';
import jpeg from 'jpeg-js';
import { DomainError } from '@cisme/domain';

// Decode and re-encode: client paths, arbitrary URLs, metadata and oversized
// decompression payloads never become member avatars or server-side fetches.
export function normalizeMemberAvatar(value: unknown): { dataUrl: string; revision: string } | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 100_000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new DomainError('AVATAR_INVALID', '请重新选择头像', 422);
  }
  try {
    const decoded = jpeg.decode(Buffer.from(value.slice(23), 'base64'), {
      useTArray: true, maxResolutionInMP: 1, maxMemoryUsageInMB: 16, tolerantDecoding: false
    });
    if (decoded.width < 1 || decoded.height < 1 || decoded.width > 512 || decoded.height > 512) throw new Error('dimensions');
    const size = 128, pixels = Buffer.alloc(size * size * 4);
    const crop = Math.min(decoded.width, decoded.height);
    const offsetX = (decoded.width - crop) / 2, offsetY = (decoded.height - crop) / 2;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const source = (Math.min(decoded.height - 1, Math.floor(offsetY + (y + 0.5) * crop / size)) * decoded.width + Math.min(decoded.width - 1, Math.floor(offsetX + (x + 0.5) * crop / size))) * 4;
      const target = (y * size + x) * 4;
      pixels[target] = decoded.data[source]!; pixels[target + 1] = decoded.data[source + 1]!; pixels[target + 2] = decoded.data[source + 2]!; pixels[target + 3] = 255;
    }
    const encoded = jpeg.encode({ data: pixels, width: size, height: size }, 60).data;
    const dataUrl = `data:image/jpeg;base64,${encoded.toString('base64')}`;
    if (dataUrl.length > 22000) throw new Error('size');
    return { dataUrl, revision: createHash('sha256').update(encoded).digest('hex') };
  } catch {
    throw new DomainError('AVATAR_INVALID', '头像未能处理，请换一张清晰图片重试', 422);
  }
}
