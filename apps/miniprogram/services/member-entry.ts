/** Identity tokens can belong to unfinished logins. Entry confirmation stays
 * in memory and is bound to this session and API environment. */
let confirmedContext = '';
function context() {
  const data = getApp<IAppOption>().globalData;
  return JSON.stringify([data.sessionToken, data.apiBaseUrl,
    data.cloudFunction?.env ?? null, data.cloudFunction?.name ?? null]);
}
export function clearMemberEntry() { confirmedContext = ''; }
export function memberEntryReady(): boolean {
  return Boolean(getApp<IAppOption>().globalData.sessionToken && confirmedContext === context());
}
/** Account calls this only after reading a complete canonical profile. */
export function confirmMemberEntry(token: string): boolean {
  if (!token || token !== getApp<IAppOption>().globalData.sessionToken) return false;
  confirmedContext = context();
  return true;
}
