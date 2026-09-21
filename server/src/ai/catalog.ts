/** Provider catalog is discovery metadata, not a guarantee of per-key entitlement. */
export async function discoverModels(baseUrl: string, key: string): Promise<string[]> {
  const url = new URL(baseUrl.replace(/\/+$/, '').replace(/\/(responses|chat\/completions)$/, '') + '/models');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid provider URL');
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${key}` },
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Provider model list unavailable (HTTP ${response.status})`);
  const body = await response.json() as { data?: { id?: unknown }[]; has_more?: boolean };
  if (!Array.isArray(body.data)) throw new Error('Provider does not return a compatible model list');
  const ids = body.data.map(m => m?.id).filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length < 256);
  return [...new Set(ids)].sort();
}
