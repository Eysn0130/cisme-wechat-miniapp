/** Classify native transport failures without forwarding potentially sensitive
 * errMsg text. These are diagnostic categories, not a filing-status verdict. */
export function nativeNetworkFailure(message: unknown): { code: string; title: string } {
  const text = typeof message === "string" ? message.slice(0, 2048) : "";
  if (/abort|cancel/i.test(text)) return { code: "REQUEST_ABORTED", title: "请求已取消" };
  if (/timeout|time out/i.test(text)) return { code: "NETWORK_TIMEOUT", title: "网络响应超时，请检查网络后重试" };
  if (/url not in domain list|domain (?:is )?not (?:allowed|configured)|不在.*合法域名|域名.*(?:未配置|不合法)/i.test(text))
    return { code: "NETWORK_DOMAIN_NOT_ALLOWED", title: "服务连接暂不可用，请稍后重试" };
  if (/ssl|tls|certificate|cert_|证书/i.test(text))
    return { code: "NETWORK_TLS_ERROR", title: "安全连接未建立，请稍后重试" };
  if (/name_not_resolved|enotfound|eai_again|resolve host|dns|域名解析/i.test(text))
    return { code: "NETWORK_DNS_ERROR", title: "服务地址暂时无法连接，请稍后重试" };
  if (/connection[_ ]refused|econnrefused/i.test(text))
    return { code: "NETWORK_CONNECTION_REFUSED", title: "服务暂时无法连接，请稍后重试" };
  return { code: "NETWORK_ERROR", title: "网络连接未完成，请检查连接后重试" };
}
