import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';

@Injectable()
export class ZapoClient {
  private readonly log = new Logger(ZapoClient.name);

  baseUrl(): string {
    const port = Number(process.env.ZAPO_PORT || 8788);
    return `http://127.0.0.1:${port}`;
  }

  private secret(): string {
    return (
      process.env.ZAPO_GATEWAY_SECRET ||
      process.env.ZAPO_INBOUND_SECRET ||
      ''
    ).trim();
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/json',
      ...(extra || {}),
    };
    const secret = this.secret();
    if (secret) h['X-Zapo-Secret'] = secret;
    return h;
  }

  async sessionRequest(
    method: string,
    sessionId: string,
    path: string,
    opts?: {
      payload?: Record<string, unknown> | null;
      query?: string;
      timeoutMs?: number;
    },
  ): Promise<Record<string, unknown>> {
    const sid = encodeURIComponent(sessionId);
    const suffix = path.replace(/^\//, '');
    let urlPath = `/sessions/${sid}/${suffix}`;
    const query = (opts?.query || '').replace(/^[?&]/, '');
    if (query) urlPath += (urlPath.includes('?') ? '&' : '?') + query;
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const init: RequestInit = {
        method,
        headers: this.headers(
          opts?.payload != null ? { 'Content-Type': 'application/json' } : undefined,
        ),
        signal: ctrl.signal,
      };
      if (opts?.payload != null) {
        init.body = JSON.stringify(opts.payload);
      }
      const res = await fetch(this.baseUrl() + urlPath, init);
      const raw = Buffer.from(await res.arrayBuffer());
      const ctype = (res.headers.get('content-type') || '').toLowerCase();
      let body: Record<string, unknown> = {};
      if (ctype.includes('application/json') || raw[0] === 0x7b || raw[0] === 0x5b) {
        try {
          body = JSON.parse(raw.toString('utf8') || '{}') as Record<string, unknown>;
        } catch {
          body = { error: raw.toString('utf8').slice(0, 200) };
        }
      } else {
        body = { ok: true, _raw: raw.toString('base64'), _content_type: ctype };
      }
      if (!res.ok) {
        throw new Error(String(body.error || `HTTP ${res.status}`));
      }
      return body;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn(`zapo ${method} ${urlPath}: ${msg}`);
      throw new Error(msg);
    } finally {
      clearTimeout(timer);
    }
  }

  async sessionBinary(
    sessionId: string,
    path: string,
    query: string,
    timeoutMs = 90_000,
  ): Promise<{ contentType: string; body: Buffer }> {
    const sid = encodeURIComponent(sessionId);
    const q = query.replace(/^[?&]/, '');
    const url = `${this.baseUrl()}/sessions/${sid}/${path.replace(/^\//, '')}${q ? `?${q}` : ''}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: this.headers({ Accept: '*/*' }),
        signal: ctrl.signal,
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) {
        let err = `HTTP ${res.status}`;
        try {
          err = String((JSON.parse(buf.toString('utf8') || '{}') as { error?: string }).error || err);
        } catch {
          /* ignore */
        }
        throw new Error(err);
      }
      return {
        contentType: res.headers.get('content-type') || 'application/octet-stream',
        body: buf,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async sessionSendMultipart(
    sessionId: string,
    fields: Record<string, string | undefined | null>,
    file?: { filename: string; mimetype: string; buffer: Buffer } | null,
  ): Promise<Record<string, unknown>> {
    const boundary = `----SFWa${randomBytes(12).toString('hex')}`;
    const parts: Buffer[] = [];
    for (const [key, val] of Object.entries(fields || {})) {
      if (val == null) continue;
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`,
          'utf8',
        ),
      );
    }
    if (file) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${file.filename}"\r\nContent-Type: ${file.mimetype}\r\n\r\n`,
          'utf8',
        ),
      );
      parts.push(file.buffer);
      parts.push(Buffer.from('\r\n', 'utf8'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
    const body = Buffer.concat(parts);
    const sid = encodeURIComponent(sessionId);
    const res = await fetch(`${this.baseUrl()}/sessions/${sid}/send`, {
      method: 'POST',
      headers: this.headers({
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      }),
      body,
    });
    const raw = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(raw || '{}') as Record<string, unknown>;
    } catch {
      parsed = { error: raw.slice(0, 200) };
    }
    if (!res.ok) throw new Error(String(parsed.error || `HTTP ${res.status}`));
    return parsed;
  }

  eventsUrl(sessionId: string): string {
    return `${this.baseUrl()}/sessions/${encodeURIComponent(sessionId)}/events`;
  }

  eventsHeaders(): Record<string, string> {
    const h: Record<string, string> = { Accept: 'text/event-stream' };
    const secret = this.secret();
    if (secret) h['X-Zapo-Secret'] = secret;
    return h;
  }
}
