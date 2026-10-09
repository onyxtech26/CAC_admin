/**
 * Ultra-fast in-memory query cache for instant client demos & zero-latency rendering.
 *
 * Caches read queries within the server process for a configurable TTL (default 60s),
 * eliminating database round trips and transatlantic network latency entirely
 * during live client walkthroughs.
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const memoryCache = new Map<string, CacheEntry<unknown>>();

export async function memoize<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = memoryCache.get(key);

  if (hit && hit.expiresAt > now) {
    return hit.data as T;
  }

  const result = await fetcher();
  memoryCache.set(key, {
    data: result,
    expiresAt: now + ttlSeconds * 1000,
  });

  return result;
}

export function clearMemoCache(): void {
  memoryCache.clear();
}
