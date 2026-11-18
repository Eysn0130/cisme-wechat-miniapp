/** A verified identity may resume profile setup without entering member
 * services. Legal information and personal data rights remain reachable. */
export function pendingRegistrationRoute(method: string, path: string): boolean {
  return method === 'GET' && (path === '/v1/me' || path === '/v1/me/profile') ||
    method === 'PUT' && path === '/v1/me/profile' ||
    method === 'POST' && path === '/v1/me/legal-acceptances' ||
    path === '/v1/me/privacy-requests' && ['GET', 'POST'].includes(method) ||
    /^\/v1\/me\/privacy-requests\/[0-9a-f-]{36}(?:\/(?:reply|export|export-revoke|export-retry|export\/parts\/[1-9][0-9]*|export\/manifest-pages\/[1-9][0-9]*|media\/[0-9a-f-]{36}))?$/i.test(path) && ['GET', 'POST'].includes(method);
}

export function registrationProfileComplete(name: string, avatar: string | null | undefined): boolean {
  return Boolean(avatar && name.trim() && !['CISME 会员', '微信用户'].includes(name.trim()));
}
