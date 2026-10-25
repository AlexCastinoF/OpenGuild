import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { promises as dns } from 'dns';
import { createSocket, RemoteInfo, Socket } from 'dgram';

const MAGIC = Buffer.from('SFC2');
const TYPE_REG = 1;
const TYPE_OK = 2;
const TYPE_DATA = 3;
const TYPE_PING = 4;
const TYPE_PONG = 5;
const TYPE_ERR = 6;
const PORT_MIN = 28100;
const PORT_MAX = 28131;

type Session = {
  matchId: string;
  token: string;
  publicPort: number;
  publicSock: Socket;
  hostRinfo: RemoteInfo | null;
};

function packData(ip: string, port: number, payload: Buffer) {
  const parts = ip.split('.').map((x) => Number(x));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    return null;
  }
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

function unpackData(buf: Buffer) {
  if (buf.length < 11 || buf.subarray(0, 4).compare(MAGIC) !== 0 || buf[4] !== TYPE_DATA) {
    return null;
  }
  const ip = `${buf[5]}.${buf[6]}.${buf[7]}.${buf[8]}`;
  const port = buf.readUInt16BE(9);
  return { ip, port, payload: buf.subarray(11) };
}

@Injectable()
export class Cs2TunnelService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(Cs2TunnelService.name);
  private ctrl: Socket | null = null;
  private readonly byToken = new Map<string, Session>();
  private readonly byMatch = new Map<string, Session>();
  private readonly usedPorts = new Set<number>();

  private ctrlPort() {
    return Number(process.env.MATCH_RELAY_PORT || 27040);
  }

  publicHost() {
    const envIp = (process.env.MATCH_RELAY_PUBLIC_IP || '').trim();
    if (envIp) return envIp;
    const env = (process.env.MATCH_RELAY_PUBLIC_HOST || '').trim();
    if (env) return env;
    try {
      const u = new URL(process.env.PUBLIC_URL || 'https://chat.example.com');
      return u.hostname;
    } catch {
      return 'chat.example.com';
    }
  }

  async publicIpv4() {
    const host = this.publicHost();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
    try {
      const r = await dns.lookup(host, { family: 4 });
      return r.address || host;
    } catch {
      return host;
    }
  }

  relayHost() {
    return (process.env.MATCH_RELAY_HOST || this.publicHost()).trim();
  }

  async onModuleInit() {
    const sock = createSocket('udp4');
    this.ctrl = sock;
    sock.on('message', (msg, rinfo) => this.onCtrl(msg, rinfo));
    sock.on('error', (err) => this.log.warn(`ctrl udp: ${err.message}`));
    await new Promise<void>((resolve, reject) => {
      sock.bind(this.ctrlPort(), '0.0.0.0', () => resolve());
      sock.once('error', reject);
    }).catch((err) => {
      this.log.warn(`não bind UDP ${this.ctrlPort()}: ${err?.message || err}`);
      this.ctrl = null;
    });
    if (this.ctrl) this.log.log(`CS2 tunnel ctrl UDP :${this.ctrlPort()}`);
  }

  async onModuleDestroy() {
    for (const s of this.byMatch.values()) this.closeSession(s);
    await new Promise<void>((resolve) => {
      if (!this.ctrl) return resolve();
      this.ctrl.close(() => resolve());
    });
    this.ctrl = null;
  }

  async allocate(matchId: string) {
    const publicHost = await this.publicIpv4();
    const existing = this.byMatch.get(matchId);
    if (existing) {
      return {
        token: existing.token,
        publicPort: existing.publicPort,
        publicHost,
        relayHost: this.relayHost(),
        relayPort: this.ctrlPort(),
      };
    }
    let port = 0;
    for (let p = PORT_MIN; p <= PORT_MAX; p += 1) {
      if (!this.usedPorts.has(p)) {
        port = p;
        break;
      }
    }
    if (!port) throw new Error('no_relay_slot');

    const publicSock = createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      publicSock.once('error', reject);
      publicSock.bind(port, '0.0.0.0', () => resolve());
    });
    this.usedPorts.add(port);
    const token = randomBytes(16).toString('hex');
    const session: Session = {
      matchId,
      token,
      publicPort: port,
      publicSock,
      hostRinfo: null,
    };
    publicSock.on('message', (msg, rinfo) => this.onGuest(session, msg, rinfo));
    publicSock.on('error', (err) => this.log.warn(`guest ${port}: ${err.message}`));
    this.byToken.set(token, session);
    this.byMatch.set(matchId, session);
    return {
      token,
      publicPort: port,
      publicHost,
      relayHost: this.relayHost(),
      relayPort: this.ctrlPort(),
    };
  }

  release(matchId: string) {
    const s = this.byMatch.get(matchId);
    if (s) this.closeSession(s);
  }

  private closeSession(s: Session) {
    this.byToken.delete(s.token);
    this.byMatch.delete(s.matchId);
    this.usedPorts.delete(s.publicPort);
    try {
      s.publicSock.close();
    } catch {
      /* ignore */
    }
  }

  private onCtrl(msg: Buffer, rinfo: RemoteInfo) {
    if (msg.length < 5 || msg.subarray(0, 4).compare(MAGIC) !== 0) return;
    const type = msg[4];
    if (type === TYPE_REG) {
      const token = msg.subarray(5).toString('utf8').trim();
      const s = this.byToken.get(token);
      if (!s || !this.ctrl) {
        const err = Buffer.concat([MAGIC, Buffer.from([TYPE_ERR])]);
        this.ctrl?.send(err, rinfo.port, rinfo.address);
        return;
      }
      s.hostRinfo = rinfo;
      const ok = Buffer.alloc(7);
      MAGIC.copy(ok, 0);
      ok[4] = TYPE_OK;
      ok.writeUInt16BE(s.publicPort, 5);
      this.ctrl.send(ok, rinfo.port, rinfo.address);
      return;
    }
    if (type === TYPE_PING) {
      const pong = Buffer.concat([MAGIC, Buffer.from([TYPE_PONG])]);
      this.ctrl?.send(pong, rinfo.port, rinfo.address);
      const s = [...this.byToken.values()].find(
        (x) => x.hostRinfo?.address === rinfo.address && x.hostRinfo?.port === rinfo.port,
      );
      if (s) s.hostRinfo = rinfo;
      return;
    }
    if (type === TYPE_DATA) {
      const parsed = unpackData(msg);
      const s = [...this.byToken.values()].find(
        (x) => x.hostRinfo?.address === rinfo.address && x.hostRinfo?.port === rinfo.port,
      );
      if (!parsed || !s) return;
      s.publicSock.send(parsed.payload, parsed.port, parsed.ip);
    }
  }

  private onGuest(session: Session, msg: Buffer, rinfo: RemoteInfo) {
    if (!session.hostRinfo || !this.ctrl) return;
    const packed = packData(rinfo.address, rinfo.port, msg);
    if (!packed) return;
    this.ctrl.send(packed, session.hostRinfo.port, session.hostRinfo.address);
  }
}
