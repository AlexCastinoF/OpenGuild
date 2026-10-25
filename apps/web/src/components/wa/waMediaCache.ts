const WA_MEDIA_CACHE = 'sf-wa-media-v1';

export async function getWaMediaCache(): Promise<Cache | null> {
  if (!('caches' in window)) return null;
  try {
    return await caches.open(WA_MEDIA_CACHE);
  } catch {
    return null;
  }
}

export async function isWaMediaCached(url: string): Promise<boolean> {
  const cache = await getWaMediaCache();
  if (!cache || !url) return false;
  try {
    return !!(await cache.match(url));
  } catch {
    return false;
  }
}

/** Baixa do gateway (WhatsApp on-demand) e guarda só no Cache API do navegador. */
export async function getWaMediaBlob(url: string): Promise<Blob> {
  const cache = await getWaMediaCache();
  if (cache) {
    const hit = await cache.match(url);
    if (hit) return hit.blob();
  }
  const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) {
    let err = `HTTP ${res.status}`;
    try {
      const body = (await res.clone().json()) as { error?: string };
      err = body.error || err;
    } catch {
      /* ignore */
    }
    throw new Error(err);
  }
  const clone = res.clone();
  const blob = await res.blob();
  if (cache) {
    try {
      await cache.put(url, clone);
      const keys = await cache.keys();
      if (keys.length > 200) {
        for (const req of keys.slice(0, keys.length - 180)) await cache.delete(req);
      }
    } catch {
      /* quota */
    }
  }
  return blob;
}

/** Guarda blob local (ex.: áudio que acabamos de gravar/enviar). */
export async function putWaMediaCache(url: string, data: Blob | File): Promise<void> {
  const cache = await getWaMediaCache();
  if (!cache || !url) return;
  try {
    const blob: Blob = data;
    await cache.put(
      url,
      new Response(blob, {
        headers: {
          'Content-Type': blob.type || 'application/octet-stream',
          'Cache-Control': 'private, max-age=31536000',
        },
      }),
    );
  } catch {
    /* quota */
  }
}
