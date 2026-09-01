export function normalizeBridgeBaseUrl(value) {
  const raw = String(value ?? '');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('로컬 서버 URL 형식이 올바르지 않습니다.');
  }
  const normalizedInput = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  const port = Number(parsed.port);
  if (parsed.protocol !== 'http:'
    || parsed.hostname !== '127.0.0.1'
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65_535
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || parsed.origin !== normalizedInput) {
    throw new Error('로컬 서버 URL은 http://127.0.0.1:<port> exact origin이어야 합니다.');
  }
  return parsed.origin;
}

export function bridgeApiUrl(baseUrl, requestPath) {
  const base = normalizeBridgeBaseUrl(baseUrl);
  const relative = String(requestPath ?? '');
  if (!relative.startsWith('/') || relative.startsWith('//') || relative.includes('\\')) {
    throw new Error('로컬 API path가 올바르지 않습니다.');
  }
  const target = new URL(relative, `${base}/`);
  if (target.origin !== base) throw new Error('로컬 API path가 bridge origin을 벗어났습니다.');
  return target.toString();
}
