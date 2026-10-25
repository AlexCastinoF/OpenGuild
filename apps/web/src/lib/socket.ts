import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket() {
  if (socket) return socket;
  const url = import.meta.env.VITE_WS_URL || undefined;
  socket = io(url ? `${url}/ws` : '/ws', {
    withCredentials: true,
    transports: ['websocket', 'polling'],
  });
  return socket;
}
