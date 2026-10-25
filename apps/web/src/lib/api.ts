export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T = Record<string, unknown>>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, {
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
