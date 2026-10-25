import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import { getSessionUser } from '../common/auth-cache';

@WebSocketGateway({
  namespace: '/ws',
  cors: {
    origin: (process.env.CORS_ORIGIN || 'http://127.0.0.1:5173').split(','),
    credentials: true,
  },
})
export class RealtimeGateway implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const cookie = client.handshake.headers.cookie || '';
      const cookieName = (process.env.AUTH_COOKIE_NAME || 'sf_react_token').trim();
      const re = new RegExp(`${cookieName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]+)`);
      const match =
        re.exec(cookie) ||
        /sf_react_token=([^;]+)/.exec(cookie) ||
        /sf_token=([^;]+)/.exec(cookie);
      const q = client.handshake.query.token;
      const token =
        match?.[1] ||
        (typeof q === 'string' ? q : Array.isArray(q) ? q[0] : undefined) ||
        (client.handshake.auth?.token as string | undefined);
      if (!token) {
        client.disconnect();
        return;
      }
      const payload = this.jwt.verify(token) as { id: number; tv?: number };
      // Mesma regra do JwtAuthGuard: usuário apagado/desativado ou senha trocada = token inválido
      const db = await getSessionUser(this.prisma, Number(payload.id));
      if (!db || db.isDisabled || (payload.tv ?? 0) !== db.tokenVersion) {
        client.disconnect();
        return;
      }
      (client.data as { userId: number }).userId = payload.id;
      void client.join(`user:${payload.id}`);
    } catch {
      client.disconnect();
    }
  }

  /** Só membro do servidor (ou super admin) entra na sala e recebe os eventos dele. */
  private async canJoinServer(userId: number, serverId: number): Promise<boolean> {
    if (!userId || !Number.isInteger(serverId) || serverId <= 0) return false;
    const member = await this.prisma.communityMember.findUnique({
      where: { serverId_userId: { serverId, userId } },
      select: { userId: true },
    });
    if (member) return true;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    return user?.role === 'super_admin';
  }

  @SubscribeMessage('join_server')
  async joinServer(@ConnectedSocket() client: Socket, @MessageBody() body: { serverId: number }) {
    const serverId = Number(body?.serverId);
    if (!serverId) return;
    const userId = (client.data as { userId?: number }).userId || 0;
    if (!(await this.canJoinServer(userId, serverId))) {
      return { ok: false, error: 'forbidden' };
    }
    void client.join(`server:${serverId}`);
    return { ok: true };
  }

  @SubscribeMessage('leave_server')
  leaveServer(@ConnectedSocket() client: Socket, @MessageBody() body: { serverId: number }) {
    if (!body?.serverId) return;
    void client.leave(`server:${body.serverId}`);
    return { ok: true };
  }

  /** Tira todos os sockets do usuário da sala do servidor (expulsão, bloqueio, exclusão). */
  async leaveServerRooms(userId: number, serverId: number) {
    if (!this.server || !userId) return;
    const sockets = await this.server.in(`user:${userId}`).fetchSockets();
    for (const s of sockets) s.leave(`server:${serverId}`);
  }

  emitToServer(serverId: number, event: string, payload: unknown) {
    if (!this.server) return;
    this.server.to(`server:${serverId}`).emit(event, payload);
  }

  emitToUser(userId: number, event: string, payload: unknown) {
    if (!this.server || !userId) return;
    this.server.to(`user:${userId}`).emit(event, payload);
  }
}
