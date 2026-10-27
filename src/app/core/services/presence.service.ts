import { Injectable, inject } from '@angular/core';
import { AuthService } from './auth.service';
import { io, Socket } from 'socket.io-client';
import { API_ORIGIN } from '../config/api-url';

@Injectable({ providedIn: 'root' })
export class PresenceService {
  private readonly auth = inject(AuthService);
  private socket: Socket | null = null;
  private token: string | null = null;

  connect(token: string): void {
    if (!token) return;
    if (this.socket && this.token === token) {
      if (!this.socket.connected) this.socket.connect();
      return;
    }

    this.disconnect();
    this.token = token;
    this.socket = io(API_ORIGIN, {
      auth: { token, presenceOnly: true },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    this.socket.on('connect', () => this.socket?.emit('auth', token));
    this.socket.on('auth:blocked', (data: { message?: string }) => {
      this.disconnect();
      this.auth.handleAccountBlocked(data?.message);
    });
    this.socket.on('auth:logout', (data: { message?: string }) => {
      this.disconnect();
      this.auth.handleAccountBlocked(data?.message);
    });
  }

  disconnect(): void {
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.token = null;
  }
}
