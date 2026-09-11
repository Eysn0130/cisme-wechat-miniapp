export const defaultMemberAvatar = '/assets/icons/user-circle-plum.svg';
const runId = Date.now().toString(36);
const files = new Map<string, Promise<string>>();
let generation = 0;

function remove(path: string) {
  try { wx.getFileSystemManager().unlink({ filePath: path, fail() {} }); } catch { /* already gone */ }
}

// Avatars reach the mini program through the authenticated/public API, not a
// new download domain. setData carries small local paths rather than Base64.
export async function localMemberAvatar(dataUrl?: string | null, revision?: string | null): Promise<string> {
  if (!dataUrl || !revision || !/^[a-f0-9]{64}$/.test(revision) || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl) || dataUrl.length > 22000) return defaultMemberAvatar;
  const current = generation;
  const key = `${generation}:${revision}`;
  const cached = files.get(key);
  if (cached) return cached;
  const path = `${wx.env.USER_DATA_PATH}/cisme-avatar-${runId}-${generation}-${revision}.jpg`;
  const pending = new Promise<string>(resolve => {
    try {
      wx.getFileSystemManager().writeFile({ filePath: path, data: dataUrl.slice(23), encoding: 'base64',
        success: () => { if (generation !== current) { remove(path); resolve(defaultMemberAvatar); } else resolve(path); },
        fail: () => { files.delete(key); resolve(defaultMemberAvatar); }
      });
    } catch { files.delete(key); resolve(defaultMemberAvatar); }
  });
  files.set(key, pending);
  void pending.then(result=>{if(result===defaultMemberAvatar && files.get(key)===pending)files.delete(key);});
  if (files.size > 100) {
    const oldest = files.keys().next().value;
    if (oldest) { void files.get(oldest)?.then(value => { if (value !== defaultMemberAvatar) remove(value); }); files.delete(oldest); }
  }
  return pending;
}

export function clearMemberAvatarCache() {
  generation++;
  for (const file of files.values()) void file.then(path => { if (path !== defaultMemberAvatar) remove(path); });
  files.clear();
}

export function clearPreviousAvatarFiles() {
  try {
    wx.getFileSystemManager().readdir({ dirPath: wx.env.USER_DATA_PATH, success: ({ files: names }) => {
      for (const name of names) if (/^cisme-avatar-[a-z0-9]+-\d+-[a-f0-9]{64}\.jpg$/.test(name) && !name.startsWith(`cisme-avatar-${runId}-`)) remove(`${wx.env.USER_DATA_PATH}/${name}`);
    }, fail() {} });
  } catch { /* Unsupported clients can still use the neutral avatar. */ }
}

export async function prepareFeedAuthors(rows: any[]): Promise<any[]> {
  return Promise.all(rows.map(async row => {
    const { author_avatar, ...safe } = row;
    return { ...safe, avatar: await localMemberAvatar(author_avatar, row.author_avatar_revision), author: row.author_name || 'CISME 会员' };
  }));
}

export async function prepareFeedPage(page: { items: any[]; authors?: Record<string,{name:string;avatar:string;avatarRevision:string|null}> }): Promise<any[]> {
  return Promise.all(page.items.map(async row => {
    const author = page.authors?.[row.author_id];
    return { ...row, avatar: await localMemberAvatar(author?.avatar, author?.avatarRevision), author: author?.name || "CISME 会员" };
  }));
}

export function prepareAvatarUpload(page: WechatMiniprogram.Page.TrivialInstance, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('头像处理超时，请重新选择')), 12000);
    const fail = () => { clearTimeout(timeout); reject(new Error('头像暂时无法处理，请重新选择')); };
    wx.createSelectorQuery().in(page).select('#member-avatar-canvas').fields({ node: true, size: true }).exec(results => {
      const canvas = results?.[0]?.node as WechatMiniprogram.Canvas | undefined;
      if (!canvas) { fail(); return; }
      canvas.width = 256; canvas.height = 256;
      const image = canvas.createImage();
      image.onerror = fail;
      image.onload = () => {
        try {
          const ctx = canvas.getContext('2d');
          const side = Math.min(image.width, image.height);
          if (!side) throw new Error('empty');
          ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,256,256);
          ctx.drawImage(image,(image.width-side)/2,(image.height-side)/2,side,side,0,0,256,256);
          const data = canvas.toDataURL('image/jpeg',0.7);
          if (!data.startsWith('data:image/jpeg;base64,') || data.length > 100000) throw new Error('size');
          clearTimeout(timeout); resolve(data);
        } catch { fail(); }
      };
      image.src = path;
    });
  });
}
