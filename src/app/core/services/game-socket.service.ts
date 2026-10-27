import { Injectable, inject } from '@angular/core';
import { AuthService } from './auth.service';
import { GameRuntimeService } from './game-runtime.service';
import { io, Socket } from 'socket.io-client';
import { BehaviorSubject } from 'rxjs';
import { API_ORIGIN } from '../config/api-url';

export interface PhaseUpdate {
  phase: 'betting' | 'flying' | 'crashed';
  durationMs?: number;
  roundId?: string;
  multiplier?: number;
  phaseStartedAt?: number;
}

export interface BetConfirmed {
  betId: string;
  amount: number;
  slot?: 1 | 2;
  roomId?: number;
}

export interface CashOutSuccess {
  multiplier: number;
  payoutAmount: number;
  slot?: 1 | 2;
  roomId?: number;
}

export interface LiveBetBroadcast {
  betId?: string;
  player: string;
  bet: number;
  multiplier: number | null;
  win: number;
  cashedOut: boolean;
  userId?: string | number;
  slot?: 1 | 2;
}

export interface SourceGameBet {
  odlutUserId?: string;
  username: string;
  betId?: 'A' | 'B' | string;
  amount: number;
  status: 'active' | 'cashed_out' | 'lost';
  cashoutMultiplier?: number;
  payout?: number;
  isBot?: boolean;
}

export interface ChatMessage {
  id: string;
  username: string;
  text: string;
  timestamp: string;
  avatar?: string;
  likes?: number;
  isBot?: boolean;
  userId?: string | number | null;
  isRestrictionNotice?: boolean;
}

export interface ChatAccess {
  allowed: boolean;
  balance: number;
  minimumBalance: number;
}

export interface WithdrawalNotificationPayload {
  id: number;
  title: string;
  message: string;
  type: string;
  amount?: number;
  status?: string;
  createdAt: string;
}

export interface GameErrorNotification {
  message: string;
  slot?: 1 | 2;
  roomId?: number;
}

export interface PlayerRealtimeEvent {
  action: string;
  userId: string | number | null;
  occurredAt: string;
  balance?: number;
  depositCount?: number;
}

export interface PaymentConfigPayload {
  provider?: string;
  minDepositAmount: number;
  maxDepositAmount?: number;
  minWithdrawalAmount?: number;
  updatedAt?: string | null;
}

@Injectable({ providedIn: 'root' })
export class GameSocketService {
  private readonly auth = inject(AuthService);
  private readonly runtime = inject(GameRuntimeService);
  private socket: Socket | null = null;
  private readonly serverUrl = API_ORIGIN;

  public phase$ = new BehaviorSubject<'betting' | 'flying' | 'crashed'>('betting');
  public roundState$ = new BehaviorSubject<PhaseUpdate>({ phase: 'betting', multiplier: 1.00 });
  public multiplier$ = new BehaviorSubject<number>(1.00);
  public balance$ = new BehaviorSubject<number>(0);
  public paymentConfig$ = new BehaviorSubject<PaymentConfigPayload>({ minDepositAmount: 999, maxDepositAmount: 1999 });
  public roundHistory$ = new BehaviorSubject<number[]>([]);
  public activeBets$ = new BehaviorSubject<SourceGameBet[]>([]);

  // Multi-room independent streams
  public roomStates$ = new BehaviorSubject<{ [key: number]: any }>({});
  public roomTick$ = new BehaviorSubject<{ roomId: number; multiplier: number } | null>(null);
  public roomPhase$ = new BehaviorSubject<{ roomId: number; phase: PhaseUpdate['phase']; multiplier?: number; roundId?: string; durationMs?: number; phaseStartedAt?: number } | null>(null);
  public roomCrashed$ = new BehaviorSubject<{ roomId: number; crashPoint: number } | null>(null);
  public roomHistory$ = new BehaviorSubject<{ roomId: number; history: number[] } | null>(null);
  public roomBets$ = new BehaviorSubject<{ roomId: number; bets: SourceGameBet[] } | null>(null);
  public chatHistory$ = new BehaviorSubject<ChatMessage[]>([]);
  public chatMessage$ = new BehaviorSubject<ChatMessage | null>(null);
  public chatOnline$ = new BehaviorSubject<number>(8130);
  public chatAccess$ = new BehaviorSubject<ChatAccess | null>(null);
  public chatError$ = new BehaviorSubject<{ message: string; code?: string } | null>(null);

  public betConfirmed$ = new BehaviorSubject<BetConfirmed | null>(null);
  public cashOutSuccess$ = new BehaviorSubject<CashOutSuccess | null>(null);
  public errorNotification$ = new BehaviorSubject<GameErrorNotification | null>(null);
  public withdrawalNotification$ = new BehaviorSubject<WithdrawalNotificationPayload | null>(null);
  public isConnected$ = new BehaviorSubject<boolean>(false);

  private pendingActionRooms: Partial<Record<1 | 2, number>> = {};

  // Retained for the surrounding app's existing subscriptions. The Aviator
  // backend publishes a complete `game:bets` snapshot instead.
  public betPlacedBroadcast$ = new BehaviorSubject<LiveBetBroadcast | null>(null);
  public betCashedOutBroadcast$ = new BehaviorSubject<LiveBetBroadcast | null>(null);
  public mpesaSuccess$ = new BehaviorSubject<{ amount: number; receipt: string; balance: number } | null>(null);
  public mpesaFailed$ = new BehaviorSubject<{ reason: string; amount: number } | null>(null);
  public walletUpdated$ = new BehaviorSubject<PlayerRealtimeEvent | null>(null);
  public transactionsUpdated$ = new BehaviorSubject<PlayerRealtimeEvent | null>(null);
  public depositsUpdated$ = new BehaviorSubject<PlayerRealtimeEvent | null>(null);
  public withdrawalsUpdated$ = new BehaviorSubject<PlayerRealtimeEvent | null>(null);
  public userUpdated$ = new BehaviorSubject<PlayerRealtimeEvent | null>(null);

  public getSocket(): Socket | null {
    return this.socket;
  }

  public connect(token: string): void {
    if (!this.runtime.verifyIntegrity()) return;
    this.disconnect();

    this.socket = io(this.serverUrl, {
      auth: { token, roomTicksOnly: true },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    this.socket.on('connect', () => {
      this.socket?.emit('auth', token);
      this.isConnected$.next(true);
      this.errorNotification$.next(null);
    });

    this.socket.on('connect_error', (error) => {
      this.isConnected$.next(false);
      this.errorNotification$.next({ message: error.message || 'Failed to connect to the game server.' });
    });

    this.socket.on('game:rooms:state', (roomsData: { [key: number]: any }) => {
      this.roomStates$.next(roomsData);
    });

    this.socket.on('game:room:tick', (data: { roomId: number; multiplier: number }) => {
      // Keep Room 1's compatibility observable without a second network packet.
      if (Number(data.roomId) === 1) this.multiplier$.next(Number(data.multiplier));
      this.roomTick$.next({ roomId: Number(data.roomId), multiplier: Number(data.multiplier) });
    });

    this.socket.on('game:room:phase', (data: any) => {
      this.roomPhase$.next({
        roomId: Number(data.roomId),
        phase: data.phase,
        roundId: data.roundId,
        durationMs: data.bettingDuration,
        multiplier: data.multiplier ?? 1,
        phaseStartedAt: data.phase === 'flying' ? data.flyingStartedAt : data.bettingStartedAt,
      });
    });

    this.socket.on('game:room:crashed', (data: { roomId: number; crashPoint: number }) => {
      this.roomCrashed$.next({ roomId: Number(data.roomId), crashPoint: Number(data.crashPoint) });
    });

    this.socket.on('game:room:history', (data: { roomId: number; history: number[] }) => {
      if (Array.isArray(data.history)) {
        this.roomHistory$.next({ roomId: Number(data.roomId), history: data.history });
      }
    });

    this.socket.on('game:room:bets', (data: { roomId: number; bets: SourceGameBet[] }) => {
      if (Array.isArray(data.bets)) {
        this.roomBets$.next({ roomId: Number(data.roomId), bets: data.bets });
      }
    });

    this.socket.on('chat:history', (messages: ChatMessage[]) => {
      if (Array.isArray(messages)) this.chatHistory$.next(messages.slice(-120));
    });
    this.socket.on('chat:message', (message: ChatMessage) => {
      if (message?.text) this.chatMessage$.next(message);
    });
    this.socket.on('chat:online', (data: { count?: number } | number) => {
      const count = typeof data === 'number' ? data : Number(data?.count);
      if (Number.isFinite(count)) this.chatOnline$.next(Math.max(0, Math.floor(count)));
    });
    this.socket.on('chat:access', (access: ChatAccess) => {
      if (access) this.chatAccess$.next({
        allowed: Boolean(access.allowed),
        balance: Number(access.balance) || 0,
        minimumBalance: Number(access.minimumBalance) || 1000,
      });
    });
    this.socket.on('chat:error', (error: { message?: string; code?: string }) => {
      this.chatError$.next({
        message: error?.message || 'Chat message was not sent.',
        code: error?.code,
      });
    });

    this.socket.on('game:state', (data: {
      phase: PhaseUpdate['phase']; multiplier?: number; roundId?: string;
      bettingDuration?: number; bettingStartedAt?: number; flyingStartedAt?: number; history?: number[]; activeBets?: SourceGameBet[];
    }) => {
      this.publishPhase({
        phase: data.phase,
        roundId: data.roundId,
        durationMs: data.bettingDuration,
        multiplier: data.multiplier ?? 1,
        phaseStartedAt: data.phase === 'flying' ? data.flyingStartedAt : data.bettingStartedAt,
      });
      if (Array.isArray(data.history)) this.roundHistory$.next(data.history);
      if (Array.isArray(data.activeBets)) this.activeBets$.next(data.activeBets);
    });

    this.socket.on('game:phase', (data: {
      phase: PhaseUpdate['phase']; multiplier?: number; roundId?: string; bettingDuration?: number; bettingStartedAt?: number; flyingStartedAt?: number;
    }) => this.publishPhase({
      phase: data.phase,
      roundId: data.roundId,
      durationMs: data.bettingDuration,
      multiplier: data.multiplier ?? (data.phase === 'betting' ? 1 : this.multiplier$.value),
      phaseStartedAt: data.phase === 'flying' ? data.flyingStartedAt : data.bettingStartedAt,
    }));

    this.socket.on('game:tick', (data: { multiplier: number }) => {
      this.multiplier$.next(Number(data.multiplier));
    });

    this.socket.on('game:crashed', (data: { crashPoint: number }) => {
      this.publishPhase({ phase: 'crashed', multiplier: Number(data.crashPoint) });
    });

    this.socket.on('game:history', (history: number[]) => {
      if (Array.isArray(history)) this.roundHistory$.next(history);
    });

    this.socket.on('game:bets', (bets: SourceGameBet[]) => {
      if (Array.isArray(bets)) this.activeBets$.next(bets);
    });

    this.socket.on('bet:placed', (data: { amount: number; balance: number | string; betId: string; roomId?: number }) => {
      const slot = this.toSlot(data.betId);
      const roomId = Number(data.roomId) || (slot ? this.pendingActionRooms[slot] : undefined);
      if (slot) delete this.pendingActionRooms[slot];
      this.betConfirmed$.next({ betId: data.betId, amount: Number(data.amount), slot, roomId });
      this.publishBalance(data.balance);
    });

    this.socket.on('bet:cashout', (data: { multiplier: number; payout: number; balance: number | string; betId: string; roomId?: number }) => {
      const slot = this.toSlot(data.betId);
      const roomId = Number(data.roomId) || (slot ? this.pendingActionRooms[slot] : undefined);
      if (slot) delete this.pendingActionRooms[slot];
      this.cashOutSuccess$.next({
        multiplier: Number(data.multiplier),
        payoutAmount: Number(data.payout),
        slot,
        roomId,
      });
      this.publishBalance(data.balance);
    });

    this.socket.on('wallet:update', (data: { balance: number | string; depositCount?: number }) => {
      this.publishBalance(data.balance);
      this.walletUpdated$.next({
        action: 'wallet_update',
        userId: null,
        occurredAt: new Date().toISOString(),
        balance: Number(data.balance),
        depositCount: data.depositCount,
      });
    });
    this.socket.on('deposit:success', (data: { amount: number; balance: number | string; receipt?: string }) => {
      this.publishBalance(data.balance);
      this.mpesaSuccess$.next({
        amount: Number(data.amount),
        receipt: String(data.receipt || ''),
        balance: Number(data.balance),
      });
    });
    this.socket.on('deposit:failed', (data: { message?: string; amount?: number }) => {
      this.mpesaFailed$.next({
        reason: data?.message || 'The M-Pesa payment was not completed.',
        amount: Number(data?.amount || 0),
      });
    });
    this.socket.on('payment:config', (data: PaymentConfigPayload) => {
      if (data && typeof data.minDepositAmount === 'number' && data.minDepositAmount >= 1) {
        this.paymentConfig$.next({
          ...data,
          maxDepositAmount: typeof data.maxDepositAmount === 'number' && data.maxDepositAmount >= 1 ? data.maxDepositAmount : 1999
        });
      }
    });
    this.socket.on('error', (data: { message?: string; roomId?: number; betId?: string }) => {
      const slot = this.toSlot(data?.betId);
      const roomId = Number(data?.roomId) || (slot ? this.pendingActionRooms[slot] : undefined);
      if (slot) delete this.pendingActionRooms[slot];
      this.errorNotification$.next({
        message: data?.message || 'The game server rejected that action.',
        slot,
        roomId,
      });
    });
    this.socket.on('disconnect', () => this.isConnected$.next(false));
    this.socket.on('auth:blocked', (data: { message?: string }) => {
      this.disconnect();
      this.auth.handleAccountBlocked(data?.message);
    });
    this.socket.on('auth:logout', (data: { message?: string }) => {
      this.disconnect();
      this.auth.handleAccountBlocked(data?.message);
    });
  }

  public placeBet(amount: number, slot: 1 | 2, autoCashout?: number, roomId: number = 1): void {
    if (!this.socket?.connected) {
      this.errorNotification$.next({ message: 'Socket connection offline. Please reconnect.', slot });
      return;
    }
    this.pendingActionRooms[slot] = roomId;
    this.socket.emit('bet:place', {
      amount,
      betId: slot === 1 ? 'A' : 'B',
      roomId,
      ...(autoCashout ? { autoCashout } : {}),
    });
  }

  public cashOut(slot: 1 | 2, roomId: number = 1): void {
    if (!this.socket?.connected) {
      this.errorNotification$.next({ message: 'Socket connection offline. Please reconnect.', slot });
      return;
    }
    this.pendingActionRooms[slot] = roomId;
    this.socket.emit('bet:cashout', { betId: slot === 1 ? 'A' : 'B', roomId });
  }

  public openChat(): void {
    this.socket?.emit('chat:open');
  }

  public sendChatMessage(text: string): void {
    if (!this.socket?.connected) {
      this.chatError$.next({ message: 'Chat is offline. Please reconnect and try again.', code: 'OFFLINE' });
      return;
    }
    this.socket.emit('chat:send', { text });
  }

  public clearNotification(): void {
    this.errorNotification$.next(null);
  }

  public disconnect(): void {
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.pendingActionRooms = {};
    this.isConnected$.next(false);
  }

  private publishPhase(update: PhaseUpdate): void {
    this.phase$.next(update.phase);
    this.roundState$.next(update);
    if (update.multiplier !== undefined) this.multiplier$.next(update.multiplier);
    if (update.phase === 'betting') {
      this.betConfirmed$.next(null);
      this.cashOutSuccess$.next(null);
    }
  }

  private publishBalance(value: number | string): void {
    const balance = Number(value);
    if (Number.isFinite(balance)) this.balance$.next(balance);
  }

  private toSlot(betId?: string): 1 | 2 | undefined {
    if (betId === 'A' || betId === '1') return 1;
    if (betId === 'B' || betId === '2') return 2;
    return undefined;
  }
}
