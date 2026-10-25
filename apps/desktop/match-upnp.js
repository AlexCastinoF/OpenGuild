/**
 * Abre UDP no router via UPnP (IGD) para o dedicated CS2.
 * Sem TAP/Hamachi: o Steam vê o teu IP público na porta real do server.
 */
const dgram = require('dgram');
const http = require('http');
const { URL } = require('url');

function httpGet(urlStr, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(urlStr, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function httpPost(urlStr, body, soapAction) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request(
      {
        hostname: u.hostname,
        port: Number(u.port || 80),
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPAction: `"${soapAction}"`,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 5000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end(body);
  });
}

function ssdpSearch(timeoutMs = 3200, ifaceIp = '') {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Set();
    const sts = [
      'urn:schemas-upnp-org:service:WANIPConnection:1',
      'urn:schemas-upnp-org:service:WANIPConnection:2',
      'urn:schemas-upnp-org:service:WANPPPConnection:1',
      'upnp:rootdevice',
    ];
    sock.on('message', (buf) => {
      const loc = String(buf).match(/LOCATION:\s*(\S+)/i);
      if (loc) found.add(loc[1].trim());
    });
    sock.on('error', () => {
      /* ignore */
    });
    sock.bind(() => {
      if (ifaceIp) {
        try {
          sock.setMulticastInterface(ifaceIp);
        } catch {
          /* ignore */
        }
      }
      try {
        sock.addMembership('239.255.255.250');
      } catch {
        /* ignore */
      }
      for (const st of sts) {
        const payload = Buffer.from(
          [
            'M-SEARCH * HTTP/1.1',
            'HOST: 239.255.255.250:1900',
            'MAN: "ssdp:discover"',
            'MX: 2',
            `ST: ${st}`,
            '',
            '',
          ].join('\r\n'),
        );
        sock.send(payload, 1900, '239.255.255.250');
      }
    });
    setTimeout(() => {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      resolve([...found]);
    }, timeoutMs);
  });
}

function pickService(xml) {
  const blocks = String(xml).split(/<service>/i).slice(1);
  for (const b of blocks) {
    const st = b.match(/<serviceType>\s*(urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:\d)\s*<\/serviceType>/i);
    const cu = b.match(/<controlURL>\s*([^<]+)\s*<\/controlURL>/i);
    if (st && cu) return { serviceType: st[1].trim(), controlPath: cu[1].trim() };
  }
  return null;
}

async function addMapping(controlUrl, serviceType, port, internalIp, protocol) {
  const proto = protocol === 'TCP' ? 'TCP' : 'UDP';
  const envelope = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:AddPortMapping xmlns:u="${serviceType}">
      <NewRemoteHost></NewRemoteHost>
      <NewExternalPort>${port}</NewExternalPort>
      <NewProtocol>${proto}</NewProtocol>
      <NewInternalPort>${port}</NewInternalPort>
      <NewInternalClient>${internalIp}</NewInternalClient>
      <NewEnabled>1</NewEnabled>
      <NewPortMappingDescription>SteamFarm CS2 ${proto}</NewPortMappingDescription>
      <NewLeaseDuration>0</NewLeaseDuration>
    </u:AddPortMapping>
  </s:Body>
</s:Envelope>`;
  const r = await httpPost(controlUrl, envelope, `${serviceType}#AddPortMapping`);
  if (r.status >= 200 && r.status < 300 && !/UPnPError/i.test(r.body)) return true;
  // 718 = already mapped (ok if this PC already opened the port)
  return /errorCode>\s*718\s*</i.test(r.body) || /ConflictInMappingEntry/i.test(r.body);
}

async function openUdp(port, internalIp) {
  const p = Number(port);
  const ip = String(internalIp || '').trim();
  if (!p || !ip || ip.startsWith('127.')) return { ok: false, error: 'bad_lan' };
  const locs = await ssdpSearch(3200, ip);
  for (const loc of locs) {
    if (!/^http:\/\//i.test(loc)) continue;
    try {
      const xml = await httpGet(loc);
      const svc = pickService(xml);
      if (!svc) continue;
      const controlUrl = new URL(svc.controlPath, loc).href;
      const ok = await addMapping(controlUrl, svc.serviceType, p, ip, 'UDP');
      if (ok) {
        try {
          await addMapping(controlUrl, svc.serviceType, p, ip, 'TCP');
        } catch {
          /* TCP is optional */
        }
        return { ok: true, port: p, via: 'upnp', controlUrl };
      }
    } catch {
      /* next IGD */
    }
  }
  return { ok: false, error: 'no_igd', locations: locs.length };
}

module.exports = { openUdp };
