/**
 * Tunel UDP da VPS: o dedicated fica em 127.0.0.1; os convidados
 * falam com a VPS. Sem TAP/Hamachi — só o Electron.
 */
const dgram = require('dgram');

const MAGIC = Buffer.from('SFC2');
const TYPE_REG = 1;
const TYPE_OK = 2;
const TYPE_DATA = 3;
const TYPE_PING = 4;
const TYPE_PONG = 5;

let ctrl = null;
let pingTimer = null;
let localPort = 0;
/** @type {Map<string, { sock: import('dgram').Socket, at: number }>} */
const guests = new Map();
let relayHost = '';
let relayPort = 0;
let started = false;

function packData(ip, port, payload) {
  const parts = String(ip)
    .split('.')
    .map((x) => Number(x));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const head = Buffer.alloc(11);
  MAGIC.copy(head, 0);
  head[4] = TYPE_DATA;
  head[5] = parts[0];
  head[6] = parts[1];
  head[7] = parts[2];
  head[8] = parts[3];
  head.writeUInt16BE(port & 0xffff, 9);
  return Buffer.concat([head, payload]);
}

function unpackData(buf) {
  if (buf.length < 11 || buf.subarray(0, 4).compare(MAGIC) !== 0 || buf[4] !== TYPE_DATA) {
    return null;
  }
  return {
    ip: `${buf[5]}.${buf[6]}.${buf[7]}.${buf[8]}`,
    port: buf.readUInt16BE(9),
    payload: buf.subarray(11),
  };
}

function guestKey(ip, port) {
  return `${ip}:${port}`;
}

function ensureGuest(ip, port) {
  const key = guestKey(ip, port);
  let g = guests.get(key);
  if (g) {
    g.at = Date.now();
    return g.sock;
  }
  const sock = dgram.createSocket('udp4');
  sock.bind({ address: '127.0.0.1', port: 0 });
  sock.on('message', (msg) => {
    if (!ctrl || !relayHost) return;
    const packed = packData(ip, port, msg);
    if (packed) ctrl.send(packed, relayPort, relayHost);
  });
  sock.on('error', () => {
    /* ignore */
  });
  guests.set(key, { sock, at: Date.now() });
  return sock;
}

function pruneGuests() {
  const now = Date.now();
  for (const [key, g] of guests) {
    if (now - g.at > 120000) {
      try {
        g.sock.close();
      } catch {
        /* ignore */
      }
      guests.delete(key);
    }
  }
}

function stop() {
  started = false;
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  for (const g of guests.values()) {
    try {
      g.sock.close();
    } catch {
      /* ignore */
    }
  }
  guests.clear();
  if (ctrl) {
    try {
      ctrl.close();
    } catch {
      /* ignore */
    }
    ctrl = null;
  }
}

function start(opts) {
  stop();
  const token = String(opts?.token || '').trim();
  relayHost = String(opts?.relayHost || '').trim();
  relayPort = Number(opts?.relayPort) || 27040;
  localPort = Number(opts?.localPort) || 0;
  const publicHost = String(opts?.publicHost || '').trim();
  const publicPort = Number(opts?.publicPort) || 0;
  if (!token || !relayHost || !localPort) {
    return Promise.resolve({ ok: false, error: 'missing_tunnel_opts' });
  }

  return new Promise((resolve) => {
    ctrl = dgram.createSocket('udp4');
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      stop();
      finish({ ok: false, error: 'tunnel_timeout' });
    }, 8000);

    ctrl.on('message', (msg) => {
      if (msg.length < 5 || msg.subarray(0, 4).compare(MAGIC) !== 0) return;
      const type = msg[4];
      if (type === TYPE_OK) {
        started = true;
        pingTimer = setInterval(() => {
          if (!ctrl || !started) return;
          const ping = Buffer.concat([MAGIC, Buffer.from([TYPE_PING])]);
          ctrl.send(ping, relayPort, relayHost);
          pruneGuests();
        }, 4000);
        finish({
          ok: true,
          publicHost,
          publicPort: msg.length >= 7 ? msg.readUInt16BE(5) : publicPort,
          via: 'vps-relay',
        });
        return;
      }
      if (type === TYPE_PONG) return;
      if (type === TYPE_DATA) {
        const parsed = unpackData(msg);
        if (!parsed) return;
        const sock = ensureGuest(parsed.ip, parsed.port);
        sock.send(parsed.payload, localPort, '127.0.0.1');
      }
    });
    ctrl.on('error', (err) => {
      finish({ ok: false, error: err.message || 'tunnel_udp' });
    });
    ctrl.bind(() => {
      const reg = Buffer.concat([MAGIC, Buffer.from([TYPE_REG]), Buffer.from(token, 'utf8')]);
      ctrl.send(reg, relayPort, relayHost);
    });
  });
}

function status() {
  return {
    ok: true,
    running: started,
    guests: guests.size,
    localPort,
    relayHost,
    relayPort,
  };
}

module.exports = { start, stop, status };
