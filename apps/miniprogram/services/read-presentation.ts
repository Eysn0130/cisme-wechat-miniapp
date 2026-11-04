import { commerceContextRevision } from "./commerce-command-store";

/** Owns displayed content only. It never skips a request or grants access. */
export function readPresentationKey(resource = ""): string {
  const context = getApp<IAppOption>().globalData;
  return JSON.stringify([context.sessionToken, context.privacyRightsToken, commerceContextRevision(),
    context.apiBaseUrl, context.cloudFunction?.env, context.cloudFunction?.name, resource]);
}

const owners = new WeakMap<object, string>();
export function retainReadPresentation(page: object, resource = ""): boolean {
  const key = readPresentationKey(resource);
  const retain = owners.get(page) === key;
  owners.set(page, key);
  return retain;
}
