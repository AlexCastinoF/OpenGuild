export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const isTauri =
      window.location.protocol === 'tauri:' ||
      window.location.hostname.includes('tauri.localhost') ||
      (window.location.hostname === 'localhost' && !window.location.port);
    if (isTauri) {
      return 'http://127.0.0.1:8014';
    }
  }
  return '';
}

export async function api<T = Record<string, unknown>>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const base = getApiBaseUrl();
  const fullPath =
    path.startsWith('http://') || path.startsWith('https://')
      ? path
      : `${base}${path.startsWith('/') ? '' : '/'}${path}`;

  const res = await fetch(fullPath, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
    ...init,
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    message?: string | string[];
  };
  if (!res.ok || data.ok === false) {
    const msg = Array.isArray(data.message)
      ? data.message.join(', ')
      : data.message;
    throw new ApiError(
      (typeof msg === 'string' && msg) || data.error || `http_${res.status}`,
    );
  }
  return data as T;
}
