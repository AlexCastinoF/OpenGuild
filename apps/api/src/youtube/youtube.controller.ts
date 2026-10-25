import {
  Controller,
  Get,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

type YtItem = {
  id: string;
  title: string;
  channel: string;
  thumb: string;
  published?: string;
};

function extractIdFromPipedUrl(url: string): string {
  const m = String(url || '').match(/[?&]v=([\w-]{11})/);
  if (m) return m[1];
  const m2 = String(url || '').match(/\/watch\?v=([\w-]{11})/);
  return m2?.[1] || '';
}

@Controller('api/community/youtube')
@UseGuards(JwtAuthGuard)
export class YoutubeController {
  @Get('search')
  async search(@Query('q') q?: string): Promise<{ ok: true; items: YtItem[] }> {
    const query = String(q || '').trim().slice(0, 120);
    if (query.length < 2) {
      throw new BadRequestException({ ok: false, error: 'query_required' });
    }

    const key = (process.env.YOUTUBE_API_KEY || '').trim();
    if (key) {
      try {
        const url =
          `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=24` +
          `&q=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}`;
        const res = await fetch(url);
        if (res.ok) {
          const data = (await res.json()) as {
            items?: Array<{
              id?: { videoId?: string };
              snippet?: {
                title?: string;
                channelTitle?: string;
                publishedAt?: string;
                thumbnails?: { medium?: { url?: string }; default?: { url?: string } };
              };
            }>;
          };
          const items: YtItem[] = (data.items || [])
            .map((it) => ({
              id: it.id?.videoId || '',
              title: it.snippet?.title || '',
              channel: it.snippet?.channelTitle || '',
              thumb:
                it.snippet?.thumbnails?.medium?.url ||
                it.snippet?.thumbnails?.default?.url ||
                '',
              published: it.snippet?.publishedAt,
            }))
            .filter((it) => it.id);
          if (items.length) return { ok: true, items };
        }
      } catch {
        /* fallback abaixo */
      }
    }

    // Piped (mais estável que Invidious público)
    const pipedHosts = (
      process.env.PIPED_API_HOSTS ||
      'https://api.piped.private.coffee,https://pipedapi.ducks.party,https://pipedapi.adminforge.de'
    )
      .split(',')
      .map((h) => h.trim().replace(/\/$/, ''))
      .filter(Boolean);

    for (const host of pipedHosts) {
      try {
        const res = await fetch(
          `${host}/search?q=${encodeURIComponent(query)}&filter=videos`,
          { headers: { Accept: 'application/json' } },
        );
        if (!res.ok) continue;
        const data = (await res.json()) as {
          items?: Array<{
            url?: string;
            title?: string;
            uploaderName?: string;
            thumbnail?: string;
            uploadedDate?: string;
            type?: string;
          }>;
        };
        const items: YtItem[] = (data.items || [])
          .filter((it) => (it.type || 'stream') === 'stream' || !!it.url)
          .map((it) => ({
            id: extractIdFromPipedUrl(it.url || ''),
            title: it.title || '',
            channel: it.uploaderName || '',
            thumb: it.thumbnail || '',
            published: it.uploadedDate,
          }))
          .filter((it) => it.id)
          .slice(0, 24);
        if (items.length) return { ok: true, items };
      } catch {
        /* try next */
      }
    }

    // Invidious fallback
    const invHosts = (
      process.env.INVIDIOUS_HOSTS ||
      'https://inv.nadeko.net,https://yewtu.be'
    )
      .split(',')
      .map((h) => h.trim().replace(/\/$/, ''))
      .filter(Boolean);

    for (const host of invHosts) {
      try {
        const res = await fetch(
          `${host}/api/v1/search?q=${encodeURIComponent(query)}&type=video`,
        );
        if (!res.ok) continue;
        const data = (await res.json()) as Array<{
          type?: string;
          videoId?: string;
          title?: string;
          author?: string;
          videoThumbnails?: Array<{ url?: string }>;
          publishedText?: string;
        }>;
        const items: YtItem[] = (Array.isArray(data) ? data : [])
          .filter((it) => (it.type || 'video') === 'video' && it.videoId)
          .slice(0, 24)
          .map((it) => ({
            id: it.videoId!,
            title: it.title || '',
            channel: it.author || '',
            thumb: it.videoThumbnails?.[0]?.url || '',
            published: it.publishedText,
          }));
        if (items.length) return { ok: true, items };
      } catch {
        /* try next */
      }
    }

    // Último recurso: página de resultados do YouTube (server-side)
    try {
      const res = await fetch(
        `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        },
      );
      if (res.ok) {
        const html = await res.text();
        const items = parseYoutubeResultsHtml(html);
        if (items.length) return { ok: true, items };
      }
    } catch {
      /* ignore */
    }

    throw new BadRequestException({
      ok: false,
      error: 'search_unavailable',
      message: 'Busca indisponível no momento. Cole um link do YouTube.',
    });
  }
}

function parseYoutubeResultsHtml(html: string): YtItem[] {
  const m = html.match(/ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (!m?.[1]) return [];
  let data: unknown;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return [];
  }
  const out: YtItem[] = [];
  const seen = new Set<string>();

  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    const obj = node as Record<string, unknown>;
    const vr = obj.videoRenderer as Record<string, unknown> | undefined;
    if (vr && typeof vr.videoId === 'string' && /^[\w-]{11}$/.test(vr.videoId)) {
      if (!seen.has(vr.videoId)) {
        seen.add(vr.videoId);
        const titleRuns = (vr.title as { runs?: Array<{ text?: string }> })?.runs;
        const owner =
          (vr.ownerText as { runs?: Array<{ text?: string }> })?.runs?.[0]?.text ||
          (vr.longBylineText as { runs?: Array<{ text?: string }> })?.runs?.[0]?.text ||
          '';
        const thumbs =
          (vr.thumbnail as { thumbnails?: Array<{ url?: string }> })?.thumbnails || [];
        out.push({
          id: vr.videoId,
          title: titleRuns?.map((r) => r.text || '').join('') || vr.videoId,
          channel: owner,
          thumb: thumbs[thumbs.length - 1]?.url || thumbs[0]?.url || '',
        });
      }
    }
    for (const v of Object.values(obj)) walk(v);
  };
  walk(data);
  return out.slice(0, 24);
}
