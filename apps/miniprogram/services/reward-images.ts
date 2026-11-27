export const rewardDetailPhotos={moisture:'/pages/checkout/assets/travel-moisture-detail-v1.jpg',dandruff:'/pages/checkout/assets/travel-dandruff-detail-v1.jpg'} as const;

const rewardOrderPhotos = {
  moisture: '/pages/rewards/assets/moisture-100-100-v1.jpg',
  dandruff: '/pages/rewards/assets/dandruff-50-100-v1.jpg',
} as const;

export function rewardOrderThumbnail(code: string | undefined): string {
  if (code === 'moisture' || code === 'dandruff') return rewardOrderPhotos[code];
  return '/assets/icons/gift-plum.svg';
}
/** Packaged paths display in <image>, but do not open reliably in the native
 * previewer. Materialize only these two public photographs after an explicit
 * details action. Fixed versioned names keep storage bounded; no member data. */
export async function prepareRewardDetailImages(scope:'checkout'|'sharing-officer'='checkout'){
 const fs=wx.getFileSystemManager();
 const prepare=(code:'moisture'|'dandruff')=>new Promise<string>((resolve,reject)=>{
  const dest=`${wx.env.USER_DATA_PATH}/cisme-travel-detail-${code}-v1.jpg`;
  fs.access({path:dest,success:()=>resolve(dest),fail:()=>fs.copyFile({srcPath:rewardDetailPhotos[code].replace('/checkout/','/'+scope+'/').slice(1),destPath:dest,success:()=>resolve(dest),fail:reject})});
 });
 const [moisture,dandruff]=await Promise.all([prepare('moisture'),prepare('dandruff')]);return {moisture,dandruff};
}
