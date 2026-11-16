import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket() {
  if (socket) return socket;
  let url = import.meta.env.VITE_WS_URL || undefined;
  if (!url && typeof window !== 'undefined') {
    const isTauri =
      window.location.protocol === 'tauri:' ||
      window.location.hostname.includes('tauri.localhost') ||
      (window.location.hostname === 'localhost' && !window.location.port);
    if (isTauri) {
      url = 'http://127.0.0.1:8014';
    }
  }
  socket = io(url ? `${url}/ws` : '/ws', {
    withCredentials: true,
    transports: ['websocket', 'polling'],
  });
  return socket;
}
