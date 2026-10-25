import { Injectable, Logger } from '@nestjs/common';

/** Reverse-geocode / IP geo — paridade com Flask community.py */
@Injectable()
export class GeoService {
  private readonly log = new Logger(GeoService.name);
  private readonly geoCache = new Map<string, { expires: number; label: string }>();
  private readonly coordCache = new Map<string, { expires: number; label: string }>();

  private isPrivateIp(ip: string): boolean {
    const v = (ip || '').trim().toLowerCase();
    if (!v || v === 'unknown' || v === 'localhost') return true;
    if (v === '127.0.0.1' || v === '::1') return true;
    if (v.startsWith('192.168.') || v.startsWith('10.') || v.startsWith('127.')) return true;
    if (v.startsWith('172.')) {
      const second = Number(v.split('.')[1]);
      if (second >= 16 && second <= 31) return true;
    }
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:')) return true;
    return false;
  }

  private formatPlace(city: string, region: string, cc: string): string {
    const c = (city || '').trim();
    const r = (region || '').trim();
    const code = (cc || '').trim().toUpperCase();
    let base = '';
    if (c && r && r.length <= 3) base = `${c}, ${r}`;
    else if (c) base = c;
    else if (r) base = r;
    if (base && code) return `${base} · ${code}`;
    return base || code;
  }

  async resolveIpLocation(ip: string): Promise<string> {
    const v = (ip || '').trim();
    if (!v || v === 'unknown') return '';
    if (this.isPrivateIp(v)) return 'Rede local';
    const now = Date.now();
    const hit = this.geoCache.get(v);
    if (hit && hit.expires > now) return hit.label;
    let label = '';
    try {
      const url = new URL(`http://ip-api.com/json/${encodeURIComponent(v)}`);
      url.searchParams.set('fields', 'status,city,regionName,countryCode');
      url.searchParams.set('lang', 'pt-BR');
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      const data = (await res.json()) as {
        status?: string;
        city?: string;
        regionName?: string;
        countryCode?: string;
      };
      if (data.status === 'success') {
        label = this.formatPlace(
          data.city || '',
          data.regionName || '',
          data.countryCode || '',
        );
      }
    } catch (e) {
      this.log.debug(`ip geo fail: ${e instanceof Error ? e.message : e}`);
    }
    if (!label) label = 'Localização indisponível';
    this.geoCache.set(v, { expires: now + 6 * 3600_000, label });
    return label;
  }

  async resolveCoordsLocation(lat: number, lon: number): Promise<string> {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return '';
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const now = Date.now();
    const hit = this.coordCache.get(key);
    if (hit && hit.expires > now) return hit.label;
    let label = '';
    try {
      const url = new URL('https://nominatim.openstreetmap.org/reverse');
      url.searchParams.set('lat', lat.toFixed(5));
      url.searchParams.set('lon', lon.toFixed(5));
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('zoom', '12');
      url.searchParams.set('addressdetails', '1');
      url.searchParams.set('accept-language', 'pt-BR');
      const res = await fetch(url, {
        headers: { 'User-Agent': 'SteamFarmMeeting/1.0 (community presence)' },
        signal: AbortSignal.timeout(3500),
      });
      const data = (await res.json()) as {
        address?: Record<string, string>;
      };
      const addr = data.address || {};
      const city =
        addr.city ||
        addr.town ||
        addr.village ||
        addr.municipality ||
        addr.suburb ||
        '';
      const region = addr.state || addr.region || '';
      const cc = addr.country_code || '';
      label = this.formatPlace(city, region, cc);
    } catch (e) {
      this.log.debug(`coord geo fail: ${e instanceof Error ? e.message : e}`);
    }
    if (!label) label = '';
    this.coordCache.set(key, { expires: now + 6 * 3600_000, label });
    return label;
  }

  async resolvePresenceLocation(opts: {
    lat?: string;
    lon?: string;
    ip?: string;
    prevLocation?: string;
    prevSource?: string;
    prevGpsTs?: number;
  }): Promise<{ location: string; location_source: string; gps_ts?: number }> {
    const now = Date.now() / 1000;
    let gpsLabel = '';
    let gpsTs = opts.prevGpsTs || 0;
    if (opts.lat != null && opts.lon != null && opts.lat !== '' && opts.lon !== '') {
      const la = Number(opts.lat);
      const lo = Number(opts.lon);
      if (Number.isFinite(la) && Number.isFinite(lo)) {
        gpsLabel = await this.resolveCoordsLocation(la, lo);
        if (gpsLabel) gpsTs = now;
      }
    }
    if (gpsLabel) {
      return { location: gpsLabel, location_source: 'gps', gps_ts: gpsTs };
    }
    const gpsFresh =
      opts.prevSource === 'gps' &&
      gpsTs >= now - 1800 &&
      String(opts.prevLocation || '').trim();
    if (gpsFresh) {
      return {
        location: String(opts.prevLocation),
        location_source: 'gps',
        gps_ts: gpsTs,
      };
    }
    const ipLabel = await this.resolveIpLocation(opts.ip || '');
    return { location: ipLabel, location_source: ipLabel ? 'ip' : '' };
  }
}
