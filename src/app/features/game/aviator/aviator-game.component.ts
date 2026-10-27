import {
  Component,
  OnInit,
  AfterViewInit,
  OnDestroy,
  ViewChild,
  ElementRef,
  HostListener,
  signal,
  WritableSignal,
  computed,
  effect,
  inject
} from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subscription, finalize } from 'rxjs';
import { ChatMessage, GameSocketService, LiveBetBroadcast, SourceGameBet } from '../../../core/services/game-socket.service';
import { AuthService, User, TransactionRecord } from '../../../core/services/auth.service';
import { GameSoundService } from '../../../core/services/game-sound.service';
import { GameRuntimeService } from '../../../core/services/game-runtime.service';

export type GameState = 'WAITING' | 'RUNNING' | 'CRASHED';

export interface LiveBet {
  id: string;
  player: string;
  avatarIcon: string;
  bet: number;
  multiplier: number | null;
  win: number;
  cashedOut: boolean;
  isCurrentUser?: boolean;
  targetMultiplier?: number;
}

export interface PanelBetState {
  amount: number;
  selectedPreset: number | null;
  presetTapCount: number;
  placedAmount: number;
  queuedAmount: number;
  mode: 'bet' | 'auto';
  autoBetEnabled: boolean;
  autoCashoutEnabled: boolean;
  autoTarget: number;
  isPending: boolean;
  hasActiveBet: boolean;
  hasCashedOut: boolean;
  cashedOutPayout: number;
  cashedOutMultiplier: number;
}

export interface RoomState {
  id: number;
  name: string;
  panel1: WritableSignal<PanelBetState>;
  panel2: WritableSignal<PanelBetState>;
  gameState: WritableSignal<GameState>;
  currentMultiplier: WritableSignal<number>;
  animatedMultiplier: WritableSignal<number>;
  finalCrashMultiplier: WritableSignal<number>;
  countdownSeconds: WritableSignal<number>;
  countdownProgress: WritableSignal<number>;
  history: WritableSignal<number[]>;
  liveBets: WritableSignal<LiveBet[]>;
  flightProgress: number;
  crashFlightProgress: number;
  flyingStartedAt: number;
  bettingIntervalId?: any;
  mockLoopIntervalId?: any;
  fakeJoinIntervalId?: any;
}

export interface UserBetHistoryItem {
  id: string;
  time: string;
  date: string;
  bet: number;
  multiplier: number;
  win: number;
  cashedOut: boolean;
  rawTimestamp?: number;
}

interface CashoutNotification {
  id: number;
  multiplier: number;
  payout: number;
  slot: 1 | 2;
}

@Component({
  selector: 'app-aviator-game',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './aviator-game.component.html',
  styleUrl: './aviator-game.component.scss'
})
export class AviatorGameComponent implements OnInit, AfterViewInit, OnDestroy {
  public panel2Collapsed = signal<boolean>(false);
  public togglePanel2() {
    this.panel2Collapsed.update(c => !c);
  }

  public toggleAutoBet(panelIndex: 1 | 2) {
    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, autoBetEnabled: !p.autoBetEnabled }));
    } else {
      this.panel2.update(p => ({ ...p, autoBetEnabled: !p.autoBetEnabled }));
    }
  }

  public toggleAutoCashout(panelIndex: 1 | 2) {
    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, autoCashoutEnabled: !p.autoCashoutEnabled }));
    } else {
      this.panel2.update(p => ({ ...p, autoCashoutEnabled: !p.autoCashoutEnabled }));
    }
  }

  public resetAutoCashout(panelIndex: 1 | 2) {
    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, autoTarget: 1.10 }));
    } else {
      this.panel2.update(p => ({ ...p, autoTarget: 1.10 }));
    }
  }

  @HostListener('document:visibilitychange')
  public onDocumentVisibilityChange(): void {
    if (typeof document !== 'undefined' && document.hidden) {
      this.gameSound.stopAllAudio();
    } else {
      this.syncAudioWithActiveRoom();
    }
  }

  @HostListener('window:pagehide')
  public onPageHide(): void {
    this.gameSound.stopAllAudio();
  }

  @HostListener('window:blur')
  public onWindowBlur(): void {
    this.gameSound.stopAllAudio();
  }

  @HostListener('window:focus')
  public onWindowFocus(): void {
    this.syncAudioWithActiveRoom();
  }

  public syncAudioWithActiveRoom(): void {
    if (!this.soundEnabled() || (typeof document !== 'undefined' && document.hidden)) {
      this.gameSound.stopBackground();
      return;
    }
    const currentRoom = this.activeRoom();
    if (currentRoom && currentRoom.gameState() === 'RUNNING') {
      this.gameSound.playBackground();
    } else {
      this.gameSound.stopBackground();
    }
  }

  @ViewChild('flightCanvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('canvasContainer') canvasContainerRef!: ElementRef<HTMLDivElement>;
  @ViewChild('chatScroll') chatScrollRef?: ElementRef<HTMLDivElement>;

  private gameSocket = inject(GameSocketService);
  private authService = inject(AuthService);
  private gameSound = inject(GameSoundService);
  private router = inject(Router);
  private location = inject(Location);
  private runtime = inject(GameRuntimeService);

  private subs: Subscription[] = [];
  private animationFrameId: number | null = null;
  private bettingIntervalId: any = null;
  private mockLoopIntervalId: any = null;
  private resizeObserver: ResizeObserver | null = null;
  private fakeJoinIntervalId: any = null;
  private lastCanvasFrameTime = 0;
  private sunburstAngle = 0;
  private referenceFlightProgress = 0;
  private referenceCrashProgress = 0;
  private referenceRoom = 0;
  private referencePhase: GameState | null = null;
  private crashStartedAt = 0;
  private readonly crashExitDurationMs = 360;
  private raysRotation = 0;
  private lastRayFrameAt = performance.now();
  private planeRenderPosition = { x: 0, y: 0 };
  private planeRenderAngle = -0.12;
  private planeRenderReady = false;
  private lastPlaneFrameAt = performance.now();
  private lastMultiplierFrameAt = performance.now();
  private renderedMultiplierValue = 1;
  private crashFlightProgress = 0;
  private flyingPhaseStartedAt = 0;

  // --------------------------------------------------------------------------
  // ANGULAR SIGNALS STATE MACHINE
  // --------------------------------------------------------------------------
  public selectedRoom = signal<number>(1);
  public showChangeRoomModal = signal<boolean>(false);
  public pendingRoomSelection = signal<number>(1);

  public room1: RoomState = {
    id: 1,
    name: 'Room #1',
    panel1: signal<PanelBetState>({
      amount: 10, selectedPreset: null, presetTapCount: 0, placedAmount: 0, queuedAmount: 0,
      mode: 'bet', autoBetEnabled: false, autoCashoutEnabled: false, autoTarget: 1.10, isPending: false, hasActiveBet: false, hasCashedOut: false,
      cashedOutPayout: 0, cashedOutMultiplier: 0
    }),
    panel2: signal<PanelBetState>({
      amount: 10, selectedPreset: null, presetTapCount: 0, placedAmount: 0, queuedAmount: 0,
      mode: 'bet', autoBetEnabled: false, autoCashoutEnabled: false, autoTarget: 1.10, isPending: false, hasActiveBet: false, hasCashedOut: false,
      cashedOutPayout: 0, cashedOutMultiplier: 0
    }),
    gameState: signal<GameState>('WAITING'),
    currentMultiplier: signal<number>(1.00),
    animatedMultiplier: signal<number>(1.00),
    finalCrashMultiplier: signal<number>(1.00),
    countdownSeconds: signal<number>(5),
    countdownProgress: signal<number>(100),
    history: signal<number[]>([
      1.17, 2.98, 1.28, 3.03, 1.57, 1.46, 2.13, 1.72, 2.93, 1.00,
      19.26, 1.28, 6.17, 1.86, 2.27, 1.04, 2.43, 1.15, 2.29, 5.66
    ]),
    liveBets: signal<LiveBet[]>([]),
    flightProgress: 0,
    crashFlightProgress: 0,
    flyingStartedAt: 0,
    bettingIntervalId: null,
    mockLoopIntervalId: null,
    fakeJoinIntervalId: null
  };

  public room2: RoomState = {
    id: 2,
    name: 'Room #2',
    panel1: signal<PanelBetState>({
      amount: 10, selectedPreset: null, presetTapCount: 0, placedAmount: 0, queuedAmount: 0,
      mode: 'bet', autoBetEnabled: false, autoCashoutEnabled: false, autoTarget: 1.10, isPending: false, hasActiveBet: false, hasCashedOut: false,
      cashedOutPayout: 0, cashedOutMultiplier: 0
    }),
    panel2: signal<PanelBetState>({
      amount: 10, selectedPreset: null, presetTapCount: 0, placedAmount: 0, queuedAmount: 0,
      mode: 'bet', autoBetEnabled: false, autoCashoutEnabled: false, autoTarget: 1.10, isPending: false, hasActiveBet: false, hasCashedOut: false,
      cashedOutPayout: 0, cashedOutMultiplier: 0
    }),
    gameState: signal<GameState>('WAITING'),
    currentMultiplier: signal<number>(1.00),
    animatedMultiplier: signal<number>(1.00),
    finalCrashMultiplier: signal<number>(1.00),
    countdownSeconds: signal<number>(5),
    countdownProgress: signal<number>(100),
    history: signal<number[]>([
      2.15, 1.45, 5.60, 1.10, 3.25, 1.80, 8.90, 2.05, 1.50, 4.10,
      1.22, 3.45, 1.95, 6.70, 2.30, 1.18, 2.80, 1.05, 4.50, 1.60
    ]),
    liveBets: signal<LiveBet[]>([]),
    flightProgress: 0,
    crashFlightProgress: 0,
    flyingStartedAt: 0,
    bettingIntervalId: null,
    mockLoopIntervalId: null,
    fakeJoinIntervalId: null
  };

  public room3: RoomState = {
    id: 3,
    name: 'Room #3',
    panel1: signal<PanelBetState>({
      amount: 10, selectedPreset: null, presetTapCount: 0, placedAmount: 0, queuedAmount: 0,
      mode: 'bet', autoBetEnabled: false, autoCashoutEnabled: false, autoTarget: 1.10, isPending: false, hasActiveBet: false, hasCashedOut: false,
      cashedOutPayout: 0, cashedOutMultiplier: 0
    }),
    panel2: signal<PanelBetState>({
      amount: 10, selectedPreset: null, presetTapCount: 0, placedAmount: 0, queuedAmount: 0,
      mode: 'bet', autoBetEnabled: false, autoCashoutEnabled: false, autoTarget: 1.10, isPending: false, hasActiveBet: false, hasCashedOut: false,
      cashedOutPayout: 0, cashedOutMultiplier: 0
    }),
    gameState: signal<GameState>('WAITING'),
    currentMultiplier: signal<number>(1.00),
    animatedMultiplier: signal<number>(1.00),
    finalCrashMultiplier: signal<number>(1.00),
    countdownSeconds: signal<number>(5),
    countdownProgress: signal<number>(100),
    history: signal<number[]>([
      1.08, 3.90, 1.75, 12.40, 1.30, 2.40, 1.90, 6.70, 1.15, 2.80,
      1.55, 4.20, 1.02, 2.10, 8.50, 1.40, 3.10, 2.05, 1.25, 5.80
    ]),
    liveBets: signal<LiveBet[]>([]),
    flightProgress: 0,
    crashFlightProgress: 0,
    flyingStartedAt: 0,
    bettingIntervalId: null,
    mockLoopIntervalId: null,
    fakeJoinIntervalId: null
  };

  public getRoom(id: number): RoomState {
    if (id === 2) return this.room2;
    if (id === 3) return this.room3;
    return this.room1;
  }

  public activeRoom = computed(() => this.getRoom(this.selectedRoom()));
  // The template and existing bet controls continue to use panel1/panel2,
  // while the getter keeps those controls scoped to the selected room.
  public get panel1(): WritableSignal<PanelBetState> {
    return this.activeRoom().panel1;
  }

  public get panel2(): WritableSignal<PanelBetState> {
    return this.activeRoom().panel2;
  }

  public gameState = computed(() => this.activeRoom().gameState());
  public currentMultiplier = computed(() => this.activeRoom().currentMultiplier());
  public animatedMultiplier = computed(() => this.activeRoom().animatedMultiplier());
  public finalCrashMultiplier = computed(() => this.activeRoom().finalCrashMultiplier());
  public countdownSeconds = computed(() => this.activeRoom().countdownSeconds());
  public countdownProgress = computed(() => this.activeRoom().countdownProgress());
  public history = computed(() => this.activeRoom().history());
  public liveBets = computed(() => this.activeRoom().liveBets());

  public userBalance = signal<number>(0.00);
  public hasCompletedFirstDeposit = signal<boolean>(false);
  public isConnected = signal<boolean>(false);
  public activeTab = signal<'all' | 'my' | 'top'>('all');

  private readonly maxBetFeedSize = 3000;
  private readonly visibleBetRows = 100;

  // Modals & UI overlays
  public showWalletModal = signal<boolean>(false);
  public showHistoryModal = signal<boolean>(false);
  public userBetHistoryList = signal<UserBetHistoryItem[]>([]);
  public betHistoryLimit = signal<number>(10);
  public showProfileModal = signal<boolean>(false);
  public showProfileDropdown = signal<boolean>(false);
  public walletTab = signal<'deposit' | 'withdraw' | 'transactions'>('deposit');
  public depositVal = signal<number>(999);
  public minDepositAmount = signal<number>(999);
  public maxDepositAmount = signal<number>(1999);
  public depositCooldownSeconds = signal<number>(0);
  private depositCooldownTimer: any = null;
  public depositSelectedPreset = signal<number | null>(null);
  public depositPresetTapCount = signal<number>(0);
  public withdrawVal = signal<number>(500);
  public withdrawSelectedPreset = signal<number | null>(null);
  public withdrawPresetTapCount = signal<number>(0);
  public isSubmittingWithdrawal = signal<boolean>(false);
  public toastMessage = signal<string | null>(null);
  public isToastError = signal<boolean>(false);
  public cashoutNotifications = signal<CashoutNotification[]>([]);
  private cashoutNotificationSequence = 0;
  private cashoutNotificationTimeouts: ReturnType<typeof setTimeout>[] = [];

  // Withdrawal / Admin notification pop-up
  public withdrawalNotif = signal<{ id?: number; title: string; message: string; type: string; timestamp: string } | null>(null);
  private withdrawalNotifTimeout: any = null;
  private lastWithdrawalNotificationId: number | null = null;
  public bonusNotif = signal<{ title: string; message: string; type: 'success' | 'info' } | null>(null);
  public isClaimingBonus = signal<boolean>(false);
  public soundEnabled = signal<boolean>(this.gameSound.isEnabled());
  private bonusNotifTimeout: any = null;

  // Game loading splash screen (shown for 3s after login)
  public gameLoading = signal<boolean>(true);

  // Transaction History State
  public transactionHistory: TransactionRecord[] = [];
  public isLoadingTransactions = false;
  public transactionHistoryTab = signal<'deposit' | 'withdrawal'>('deposit');

  // M-Pesa STK Push state
  public mpesaPhone = signal<string>('');
  public mpesaStatus = signal<'idle' | 'sending' | 'waiting' | 'success' | 'failed'>('idle');
  public mpesaStatusMsg = signal<string>('');
  public mpesaReceipt = signal<string>('');
  private mpesaCheckoutRequestId: string = '';

  public currentUser = signal<User | null>(null);

  // Live Palpesabet chat. The server enforces this threshold; the computed value
  // keeps the composer in sync with wallet updates before the next chat event.
  public readonly chatMinimumBalance = 1000;
  public chatOpen = signal<boolean>(false);
  public showNewMessagesPill = signal<boolean>(false);
  public accumulatedNewMessagesCount = signal<number>(0);
  private isUserScrolledUp = false;
  private isUserHoldingChat = false;
  public chatDraft = signal<string>('');
  public chatMessages = signal<ChatMessage[]>([]);
  public chatOnlineCount = signal<number>(8130);
  public chatEligible = computed(() => this.userBalance() >= this.chatMinimumBalance);
  private chatSimulationIntervalId: any = null;
  private chatOnlineIntervalId: any = null;
  private readonly chatFallbackMessages = [
  'Palpesabet inalipa mbaya sana leo! Nishatoa 45k kwa M-Pesa 🤑',
  'Wazi bro, signals za leo zilikua on point sana, asante Mr Dan 🙏',
  'Nani ako Room 1 sai? Nimeona 18.5x ikitokea plane imepaa safi 🚀',
  'Aki signals ziko legit, nimeanza na 500 nikatoa 14,000!',
  'Deposit ya M-Pesa imeingia instant bila delay yoyote.',
  'Kijana tulia usitoke mapema, target 3x hadi 5x ndio safe.',
  'Naitwa Rose thank you so much Mr Dan nmetoa kwa 50K leo ubarikiwe sana!',
  'Eii plane imeenda 54x! Nani alishika hii round ya moto?',
  'Signals za leo zimecome through fiti sana, niko happy.',
  'Hapa Palpesabet hakuna delay kwa payout, 2 mins pesa iko kwa M-Pesa 🙌',
  'Tuliza boli cheza na discipline usifuate emotions wakuu.',
  'Room 3 iko moto leo, continuous purple rounds 🔥',
  'Nani ako na stake ya 1000 twende kazi kwa Room 1?',
  'Wakuu cashout at 2.50x ndio safe zone, usikue greedy.',
  'Palpesabet best platform Kenya hands down 💯',
  'Nimeangukia 12k with stake ndogo ya 300, signal ilisema 4x.',
  'Withdrawal ya 35,000 imeingia chap chap kwa M-Pesa!',
  'Mungu akubariki Mr Dan kwa signals safi sana mtafute ni legit.',
  'Leo ndio ile siku ya kuomoka na Palpesabet mabro.',
  'Room 1 prediction ilikua accurate 100% leo.',
  'Niko live hapa naona purple odds zikipanda tu.',
  'Leo round 10 zote zimepita 3x, hii ni baraka tupu.',
  'Signal ya saa nane imelipa fiti sana, nimerecover capital.',
  'Chezeni smart wakuu, aviator inataka patience na hesabu.',
  'Palpesabet engine iko smooth sana, hakuna lagging hata kidogo.',
  'Nimecatch 9.40x kwa Room 2, leo weekend imejipa mapema 💰',
  'Discipline ndio siri hapa, 2x kila round inatosha kabisa.',
  'Wadau signals za telegram ziko accurate leo, nimetoa 28k.',
  'Withdrawal yangu ya 15k imeingia instant bila stress.',
  'Room 2 inapeana ma odds kali sana, check history uone.',
  'Kila mtu anacheza Palpesabet anajua hapa hakuna delay ya cashout.',
  'Signals zimenisaidia kuelewa graph vizuri sana.',
  'Nimecashout kwa 4.50x nikaacha watu wakilia kwa crash.',
  'Small stakes with high frequency ndio format yangu ya leo.',
  'Palpesabet mko juu, engine ya spribe iko on point.',
  'Nimepiga 8k na stake ya 200 tu, asante Mr Dan!',
  'Guys remember to set auto cashout at 2.0x to protect your balance.',
  'Nani ako na tips za Room 3? Leo naona inatoa high multipliers.',
  'Kuingia na balance poa ndio unacheza bila pressure.',
  'Mimi niko disciplined, target yangu ya 20k per day nimehit tayari.',
  'Palpesabet payout speed is unmatched, seconds tu kwa simu.',
  'Bro signals za leo ziko fire 🔥🔥🔥',
  'Nimepata 6.80x kwa first bet ya leo, blessed day!',
  'Always withdraw your profits first, kisha cheza na faida.',
  'Palpesabet ndio kusema, games zote ziko provably fair.',
  'Mr Dan signals are top tier, amerecover lost funds zote.',
  'Leo niko locked in, signals zikidrop tu naweka stake.',
  'Room 1 imepanda 33x sasa hivi, what a massive flight!',
  'Cashout early, secure the bag, rinse and repeat.',
  'Nimejaribu split betting kwa panel 1 na panel 2, method inawork fiti.',
  'Palpesabet customer service pia wako fast sana.',
  'Leo niko 4 wins in a row, thanks to the live signals.',
  'Hata na stake ndogo unaeza build balance pole pole.',
  'Nani mwingine amewithdraw leo? Mpesa yangu inasoma safi.',
  'Signals ziko accurate 90%+ hii wiki nzima.',
  'Discipline over emotions always, aviator rules.',
  'Plane imepaa tena 12x, Room 1 is cooking today!',
  'Nimepata 5k with just 250 bob, Palpesabet is the real deal.',
  'Wakuu chezeni na plan, don’t gamble blindly.',
  'Mr Dan thank you bro, 40k profit in one afternoon!',
  'Palpesabet room switching is so seamless, nimeona 15x kwa Room 2!',
  'Kaa rada na signal ya 4:30pm inakam na multiplier nzito.',
  'Mimi leo sitoki kwa game hadi nihit 50k target.',
  'Nimecash out 5.20x nikamake 10,400 with 2k stake.',
  'Watu wa Palpesabet mko safe kabisa, hakuna delayed withdrawals.',
  'Respect the graph, check pink history kabla uweke heavy stake.',
  '24x caught safely! Mpesa alert ting ting 📲',
  'Chezeni na 2.0x auto cashout wakuu, consistency ndio key.',
  'Nani mwingine ako Room 2? Grafu inasoma fiti sana.',
  'Hii round imeenda 78x eish! Nani alibaki ndani?',
  'Nashukuru sana Mr Dan, nimelipa rent ya mwezi na aviator leo 🙏',
  'Deposit ya 2k imekua 26,400 in 30 mins!',
  'Wakuu never chase losses, take a break ukihit target.',
  'Signals za VIP channel ziko 98% win rate leo.',
  'Hapa Palpesabet hakuna delay ya ku-credit winnings.',
  'Plane imepaa tena! Room 1 inafanya mambo leo ✈️🔥',
  'Nimepata 16.50x na stake ya 500, day made!',
  'Leo ni mwendo wa green tu kwa history yangu.',
  'Follow the signals carefully usiruke round.',
  'M-Pesa balance inasoma vizuri sana baada ya hii session 💰',
  'Nimeeka auto cashout 3.5x imegonga pap!',
  'Watu wa 100 bob msiogope, pole pole ndio mwendo.',
  'Kila mtu anacheza smart leo, continuous wins!',
  'Room 3 has given 3 pinks in the last 10 minutes 🔥',
  'Hii game iko smooth kuliko platforms zingine zote Kenya.',
  'Signals za Mr Dan ndio zimeniokoa baada ya bad run.',
  'Withdrawal processing in 60 seconds flat, incredible 🙌',
  'Nimefika 50k milestone ya leo, sasa naenda zangu.',
  'Always set a daily stop-loss and profit target.',
  'Pink rounds zimejaa kwa table, game is on fire!',
  'Leo niko 7 out of 8 wins, pure discipline.',
  'Palpesabet is the real king of crash games in KE 👑',
  'Nani ako ready na next signal? Dropping in 2 mins!',
  'Target hit! 10k profit locked and withdrawn 💸',
  'Aviator with fast payout is unmatched.',
  'Patience pays here wakuu, don’t rush every round.',
  'Room 1 taking off again, 10x guaranteed soon!',
  'Nimecashout 4.2x with panel 1 and 8.0x with panel 2!',
  'Split betting strategy is working wonders today 🔥',
  'Signal checked, bet placed, win secured 🚀',
  'Hapa hakuna story ya pending withdrawals, instant payout.',
  'Nimeona 42x ikipaa, what a massive multiplier!',
  'Tukutane VIP session ya jioni wakuu 💪',
  'Respect the signals and manage your bankroll.',
  'Another 15,000 KES straight to my M-Pesa account!',
  'Palpesabet to the moon 🚀🚀🚀'
];


  // --------------------------------------------------------------------------
  // COMPUTED PROPERTIES
  // --------------------------------------------------------------------------
  public potentialPayout1 = computed(() => {
    const p1 = this.panel1();
    if (!p1.hasActiveBet || p1.hasCashedOut) return 0;
    return parseFloat((p1.placedAmount * this.currentMultiplier()).toFixed(2));
  });

  public potentialPayout2 = computed(() => {
    const p2 = this.panel2();
    if (!p2.hasActiveBet || p2.hasCashedOut) return 0;
    return parseFloat((p2.placedAmount * this.currentMultiplier()).toFixed(2));
  });

  public displayBetsList = computed(() => {
    const tab = this.activeTab();
    const list = this.liveBets();
    const username = this.currentUser()?.username || 'Player';
    const sortedByStake = [...list].sort((a, b) => b.bet - a.bet);

    if (tab === 'my') {
      return list
        .filter(b => b.player === username || b.isCurrentUser)
        .slice(0, 150);
    }
    if (tab === 'top') {
      return sortedByStake.slice(0, 150);
    }
    // "all" tab: sorted from highest bet placed to lowest bet placed
    return sortedByStake.slice(0, 150);
  });

  public betsCount = computed(() => {
    const tab = this.activeTab();
    const list = this.liveBets();
    const username = this.currentUser()?.username || 'Player';

    if (tab === 'my') {
      return list.filter(b => b.player === username || b.isCurrentUser).length;
    }
    return 4880 + (list.length % 65);
  });

  public get filteredTransactionHistory(): TransactionRecord[] {
    const type = this.transactionHistoryTab();
    return this.transactionHistory.filter(transaction => transaction.type === type);
  }

  // --------------------------------------------------------------------------
  // CANVAS ENGINE INTERNALS
  // --------------------------------------------------------------------------
  private ctx: CanvasRenderingContext2D | null = null;
  private planeAsset: HTMLCanvasElement | null = null;
  private flightProgress = 0; // 0.0 to 1.0
  private planeCrashOffset = { x: 0, y: 0 };
  private planeCrashVelocity = { x: 0, y: 0 };
  // The server is the sole round authority. Keeping this disabled prevents
  // disconnected tabs from inventing their own flight and crash result.
  private readonly allowStandaloneRounds = false;

  constructor() {
    // Effect to reflect balance changes or auto-cashout evaluations
    effect(() => {
      const state = this.gameState();
      const mult = this.currentMultiplier();

      if (state === 'RUNNING') {
        this.evaluateAutoCashouts(mult, this.selectedRoom());
      }
    });
  }

  ngOnInit() {
    if (!this.runtime.verifyIntegrity()) {
      this.gameLoading.set(true);
      return;
    }
    this.initAuthAndSockets();
    this.seedMockBets();
    this.initUserBetHistory();
    this.seedFallbackChat();
    this.startChatSimulation();
    this.startOnlineCounter();
    // Show loading splash for 3 seconds after login
    setTimeout(() => this.gameLoading.set(false), 3000);
  }

  ngAfterViewInit() {
    if (!this.runtime.verifyIntegrity()) {
      return;
    }
    this.initCanvas();
    this.startCanvasRenderLoop();
  }

  ngOnDestroy() {
    this.subs.forEach(s => s.unsubscribe());
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }
    if (this.bettingIntervalId) clearInterval(this.bettingIntervalId);
    if (this.mockLoopIntervalId) clearInterval(this.mockLoopIntervalId);
    if (this.fakeJoinIntervalId) clearInterval(this.fakeJoinIntervalId);
    if (this.chatSimulationIntervalId) clearTimeout(this.chatSimulationIntervalId);
    if (this.chatOnlineIntervalId) clearInterval(this.chatOnlineIntervalId);
    this.clearDepositCooldownTimer();
    this.cashoutNotificationTimeouts.forEach(timeout => clearTimeout(timeout));
    if (this.resizeObserver) this.resizeObserver.disconnect();
    this.gameSound.stopBackground();
    this.gameSocket.disconnect();
  }

  @HostListener('window:resize')
  onResize() {
    this.resizeCanvas();
  }

  @HostListener('window:keydown.space', ['$event'])
  handleSpaceKey(event: Event) {
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
      return;
    }
    event.preventDefault();
    this.triggerDualPanelAction();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    this.gameSound.unlock();
    const wrap = document.getElementById('profileDropdownWrap');
    if (wrap && !wrap.contains(event.target as Node)) {
      this.showProfileDropdown.set(false);
    }
  }

  // --------------------------------------------------------------------------
  // WEBSOCKET & BACKEND COMMUNICATION
  // --------------------------------------------------------------------------
  private initAuthAndSockets() {
    this.subs.push(
      this.authService.currentUser$.subscribe(u => {
        this.currentUser.set(u);
        if (u) {
          this.userBalance.set(u.balance);
          this.hasCompletedFirstDeposit.set(Number(u.depositCount || 0) > 0 || Number(u.balance || 0) > 0);
          if (u.phone_number && !this.mpesaPhone()) {
            this.mpesaPhone.set((u.phone_number || '').replace(/^(\+?254|0)+/, ''));
          }
        }
      }),
      this.authService.userBalance$.subscribe(b => {
        this.userBalance.set(b);
      }),
      this.gameSocket.isConnected$.subscribe(connected => {
        this.isConnected.set(connected);
      }),
      this.gameSocket.roomStates$.subscribe(roomsData => {
        if (!roomsData) return;
        [1, 2, 3].forEach(id => {
          const rData = roomsData[id];
          if (!rData) return;
          const room = this.getRoom(id);
          if (Array.isArray(rData.history)) room.history.set(rData.history);
          if (Array.isArray(rData.activeBets)) this.replaceRoomLiveBets(id, rData.activeBets);
          if (rData.phase === 'flying') {
            room.gameState.set('RUNNING');
            room.currentMultiplier.set(rData.multiplier || 1.00);
            room.animatedMultiplier.set(rData.multiplier || 1.00);
            room.flyingStartedAt = Number(rData.flyingStartedAt) || Date.now();
            room.flightProgress = Math.min(0.97, Math.max(0, 1 - 1 / Math.pow(Math.max(rData.multiplier || 1, 1), 1.55)));
          } else if (rData.phase === 'crashed') {
            room.gameState.set('CRASHED');
            room.flyingStartedAt = 0;
            const crashPoint = Number(rData.multiplier) || 1.00;
            room.currentMultiplier.set(crashPoint);
            room.animatedMultiplier.set(crashPoint);
            room.finalCrashMultiplier.set(crashPoint);
            room.crashFlightProgress = Math.min(1.08, Math.max(0, 1 - 1 / Math.pow(Math.max(crashPoint, 1), 1.55)));
            room.flightProgress = room.crashFlightProgress;
          } else {
            this.onRoomRoundStart(room, rData.bettingDuration);
          }
        });
      }),
      this.gameSocket.roomTick$.subscribe(data => {
        if (data && data.roomId) {
          this.onRoomMultiplierUpdate(data.roomId, data.multiplier);
        }
      }),
      this.gameSocket.roomPhase$.subscribe(data => {
        if (data && data.roomId) {
          this.onRoomSocketPhaseChange(data.roomId, data.phase, data.durationMs, data.multiplier);
        }
      }),
      this.gameSocket.roomCrashed$.subscribe(data => {
        if (data && data.roomId) {
          this.onRoomCrash(data.roomId, data.crashPoint);
        }
      }),
      this.gameSocket.roomHistory$.subscribe(data => {
        if (data && data.roomId && Array.isArray(data.history)) {
          this.getRoom(data.roomId).history.set(data.history);
        }
      }),
      this.gameSocket.roomBets$.subscribe(data => {
        if (data && data.roomId && Array.isArray(data.bets)) {
          this.replaceRoomLiveBets(data.roomId, data.bets);
        }
      }),
      this.gameSocket.chatHistory$.subscribe(messages => {
        if (messages.length > 0) {
          this.chatMessages.set(messages.slice(-120));
          this.scrollChatToLatest();
        }
      }),
      this.gameSocket.chatMessage$.subscribe(message => {
        if (message) {
          const currentUserId = this.currentUser()?.id;
          this.chatMessages.update(messages => {
            const exists = messages.some(m => m.id === message.id || (m.text === message.text && m.userId && currentUserId && String(m.userId) === String(currentUserId) && Math.abs(new Date(m.timestamp).getTime() - new Date(message.timestamp).getTime()) < 4000));
            if (exists) return messages;
            return [...messages, message].slice(-200);
          });
          if (this.chatOpen()) {
            if (this.isUserScrolledUp || this.isUserHoldingChat) {
              this.showNewMessagesPill.set(true);
              this.accumulatedNewMessagesCount.update(c => c + 1);
            } else {
              this.scrollChatToLatest('smooth');
              this.showNewMessagesPill.set(false);
              this.accumulatedNewMessagesCount.set(0);
            }
          }
        }
      }),
      this.gameSocket.chatOnline$.subscribe(count => {
        this.chatOnlineCount.set(count);
      }),
      this.gameSocket.chatError$.subscribe(error => {
        if (error) this.showToast(error.message, true);
      }),
      this.gameSocket.roundState$.subscribe(roundState => {
        if (this.isConnected()) {
          this.onSocketPhaseChange(roundState);
        }
      }),
      this.gameSocket.multiplier$.subscribe(mult => {
        if (this.isConnected() && this.gameState() === 'RUNNING') {
          this.onMultiplierUpdate(mult);
        }
      }),
      this.gameSocket.balance$.subscribe(balance => {
        if (this.isConnected()) {
          this.userBalance.set(balance);
          this.authService.updateBalance(balance);
        }
      }),
      this.gameSocket.walletUpdated$.subscribe(event => {
        if (!event) return;
        if (event.balance !== undefined) {
          this.userBalance.set(event.balance);
          this.authService.updateBalance(event.balance, event.depositCount);
        }
        if (event.depositCount !== undefined || event.balance !== undefined) {
          this.hasCompletedFirstDeposit.set(Number(event.depositCount || 0) > 0 || Number(event.balance ?? this.userBalance()) > 0);
        }
      }),
      this.gameSocket.roundHistory$.subscribe(h => {
        if (h && h.length > 0) this.room1.history.set(h);
      }),
      this.gameSocket.activeBets$.subscribe(bets => {
        if (this.isConnected()) this.replaceRoomLiveBets(1, bets);
      }),
      this.gameSocket.betConfirmed$.subscribe(b => {
        if (b) {
          const panel = this.resolveResponsePanel(b.slot, b.roomId);
          if (panel) this.confirmBet(panel, b.amount, b.roomId);
        }
      }),
      this.gameSocket.cashOutSuccess$.subscribe(c => {
        if (c) {
          const panel = this.resolveResponsePanel(c.slot, c.roomId);
          if (panel) this.confirmCashout(panel, c.multiplier, c.payoutAmount, c.roomId);
          else this.triggerCashoutNotification(c.multiplier, c.payoutAmount, c.slot || 1);
        }
      }),
      this.gameSocket.betPlacedBroadcast$.subscribe(b => {
        if (b) this.addLiveBetBroadcast(b);
      }),
      this.gameSocket.betCashedOutBroadcast$.subscribe(c => {
        if (c) this.updateLiveBetBroadcast(c);
      }),
      this.gameSocket.errorNotification$.subscribe(err => {
        if (err) {
          if (err.slot) {
            this.setPanelPending(err.slot, false, false, err.roomId);
          } else {
            this.clearPendingPanels(err.roomId);
          }
          this.showToast(err.message, true);
        }
      }),
      this.gameSocket.withdrawalNotification$.subscribe(payload => {
        if (payload) {
          this.showWithdrawalNotification(payload);
        }
      }),
      this.gameSocket.transactionsUpdated$.subscribe(event => {
        if (event) {
          this.loadTransactionsHistory();
          if (event.action === 'mpesa_deposit_completed' && this.mpesaStatus() === 'waiting') {
            this.mpesaStatus.set('success');
            this.showToast('💰 M-Pesa deposit confirmed!');
            setTimeout(() => this.showWalletModal.set(false), 2500);
          }
          if (event.action === 'mpesa_deposit_failed' && (this.mpesaStatus() === 'waiting' || this.mpesaStatus() === 'sending')) {
            this.mpesaStatus.set('failed');
            this.mpesaStatusMsg.set('❌ Payment failed or was cancelled.');
          }
        }
      }),
      this.gameSocket.depositsUpdated$.subscribe(event => {
        if (event) {
          this.loadTransactionsHistory();
          if (event.action === 'mpesa_deposit_completed' && this.mpesaStatus() === 'waiting') {
            this.mpesaStatus.set('success');
            this.showToast('💰 M-Pesa deposit confirmed!');
            setTimeout(() => this.showWalletModal.set(false), 2500);
          }
          if (event.action === 'mpesa_deposit_failed' && (this.mpesaStatus() === 'waiting' || this.mpesaStatus() === 'sending')) {
            this.mpesaStatus.set('failed');
            this.mpesaStatusMsg.set('❌ Payment failed or was cancelled.');
          }
        }
      }),
      this.gameSocket.withdrawalsUpdated$.subscribe(event => {
        if (event) this.loadTransactionsHistory();
      }),
      this.gameSocket.userUpdated$.subscribe(event => {
        if (event) this.authService.loadCurrentUser().subscribe();
      })
    );

    const token = this.authService.getToken();
    if (token) {
      this.gameSocket.connect(token);
      this.authService.getWallet().subscribe({
        next: wallet => {
          this.userBalance.set(wallet.balance);
          this.hasCompletedFirstDeposit.set(Number(wallet.depositCount || 0) > 0 || Number(wallet.balance || 0) > 0);
        },
      });
    }

    this.authService.getDepositCooldown().subscribe(res => {
      if (res.inCooldown && res.retryAfterSeconds > 0) {
        this.startDepositCooldown(res.retryAfterSeconds);
      }
    });

    this.authService.getPaymentConfig().subscribe(config => {
      const oldMin = this.minDepositAmount();
      this.minDepositAmount.set(config.minDepositAmount);
      if (config.maxDepositAmount) this.maxDepositAmount.set(config.maxDepositAmount);
      if (!this.depositVal() || this.depositVal() === oldMin || this.depositVal() < config.minDepositAmount) {
        this.depositVal.set(config.minDepositAmount);
      }
    });

    // Listen for server-pushed M-Pesa success & failed events
    this.subs.push(
      this.gameSocket.paymentConfig$.subscribe(config => {
        if (!config?.minDepositAmount) return;
        const oldMin = this.minDepositAmount();
        this.minDepositAmount.set(config.minDepositAmount);
        if (config.maxDepositAmount) this.maxDepositAmount.set(config.maxDepositAmount);
        if (!this.depositVal() || this.depositVal() === oldMin || this.depositVal() < config.minDepositAmount) {
          this.depositVal.set(config.minDepositAmount);
        }
      }),
      this.gameSocket.mpesaSuccess$.subscribe(payload => {
        if (!payload) return;
        console.log(`[${new Date().toISOString()}] [PAYMENT_LOG] Player UI updated: mpesa_success`, payload);
        this.mpesaStatus.set('success');
        this.mpesaReceipt.set(payload.receipt);
        this.mpesaStatusMsg.set(`✅ KES ${payload.amount} deposited! Receipt: ${payload.receipt}`);
        this.userBalance.set(payload.balance);
        this.authService.updateBalance(payload.balance);
        this.showToast(`💰 M-Pesa deposit of KES ${payload.amount} confirmed!`);
        this.loadTransactionsHistory();
        setTimeout(() => this.showWalletModal.set(false), 2500);
      }),
      this.gameSocket.mpesaFailed$.subscribe(payload => {
        if (!payload) return;
        this.mpesaStatus.set('failed');
        this.mpesaStatusMsg.set(`❌ Deposit of KES ${payload.amount} failed or was cancelled (${payload.reason}).`);
        this.showToast(`❌ Payment Failed: ${payload.reason}`, true);
        this.loadTransactionsHistory();
      })
    );
  }

  // --------------------------------------------------------------------------
  // MULTI-ROOM ENGINE STATE MANAGERS (Ligibet Style)
  // --------------------------------------------------------------------------
  public onRoomSocketPhaseChange(roomId: number, phase: GameState | string, durationMs?: number, multiplier?: number) {
    const room = this.getRoom(roomId);
    if (phase === 'betting' || phase === 'WAITING') {
      this.onRoomRoundStart(room, durationMs);
    } else if (phase === 'flying' || phase === 'RUNNING') {
      room.gameState.set('RUNNING');
      room.flyingStartedAt = Date.now();
      room.crashFlightProgress = 0;
      const mult = multiplier || 1.00;
      room.currentMultiplier.set(mult);
      room.animatedMultiplier.set(mult);
      room.flightProgress = Math.min(0.97, Math.max(0, 1 - 1 / Math.pow(Math.max(mult, 1), 1.55)));
      if (this.selectedRoom() === roomId && this.soundEnabled()) {
        this.gameSound.playBackground();
      }
    } else if (phase === 'crashed' || phase === 'CRASHED') {
      this.onRoomCrash(roomId, multiplier || room.currentMultiplier());
    }
  }

  public onRoomRoundStart(room: RoomState, durationMs = 5000) {
    room.gameState.set('WAITING');
    room.currentMultiplier.set(1.00);
    room.animatedMultiplier.set(1.00);
    room.flightProgress = 0;
    room.crashFlightProgress = 0;
    room.flyingStartedAt = 0;

    // A room continues cycling while it is not selected. Reset its panel
    // round-state here as well, so switching into it cannot show stale
    // cash-out/pending UI from a previous round.
    room.panel1.update(p => ({
      ...p,
      hasActiveBet: p.placedAmount > 0,
      isPending: false,
      hasCashedOut: false,
      cashedOutPayout: 0,
      cashedOutMultiplier: 0,
      selectedPreset: null,
      presetTapCount: 0
    }));
    room.panel2.update(p => ({
      ...p,
      hasActiveBet: p.placedAmount > 0,
      isPending: false,
      hasCashedOut: false,
      cashedOutPayout: 0,
      cashedOutMultiplier: 0,
      selectedPreset: null,
      presetTapCount: 0
    }));

    if (this.selectedRoom() === room.id) {
      this.planeCrashOffset = { x: 0, y: 0 };
      this.activateQueuedBet(1, room.id);
      this.activateQueuedBet(2, room.id);
      if (room.panel1().autoBetEnabled && !room.panel1().hasActiveBet && !room.panel1().queuedAmount) {
        setTimeout(() => this.placeBet(1), 120);
      }
      if (room.panel2().autoBetEnabled && !room.panel2().hasActiveBet && !room.panel2().queuedAmount && !this.panel2Collapsed()) {
        setTimeout(() => this.placeBet(2), 120);
      }
    } else {
      // Keep queued bets scoped to the room that is opening. This allows a
      // user to switch rooms without reusing another room's panel state.
      this.activateQueuedBet(1, room.id);
      this.activateQueuedBet(2, room.id);
    }

    this.seedRoomMockBets(room);

    const totalDuration = Math.max(0, durationMs || 5000);
    room.countdownSeconds.set(Math.ceil(totalDuration / 1000));
    room.countdownProgress.set(100);
    const startTime = Date.now();

    if (room.bettingIntervalId) clearInterval(room.bettingIntervalId);
    room.bettingIntervalId = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, totalDuration - elapsed);
      room.countdownSeconds.set(Math.ceil(remaining / 1000));
      const progress = Math.max(0, Math.min(100, (remaining / totalDuration) * 100));
      room.countdownProgress.set(progress);

      if (remaining <= 0) {
        clearInterval(room.bettingIntervalId);
        if (!this.isConnected() && this.allowStandaloneRounds) {
          this.startRoomFlightPhase(room);
        }
      }
    }, 30);
  }

  private startRoomFlightPhase(room: RoomState) {
    room.gameState.set('RUNNING');
    room.flyingStartedAt = Date.now();
    room.currentMultiplier.set(1.00);
    room.animatedMultiplier.set(1.00);
    room.flightProgress = 0;

    if (this.selectedRoom() === room.id && this.soundEnabled()) {
      this.gameSound.playBackground();
    }

    if (this.isConnected()) return;

    const r = Math.random();
    const crashPoint: number = r < 0.03
      ? 1.00
      : parseFloat(Math.max(1.00, Math.min(100000, 0.97 / (1 - r))).toFixed(2));

    const flightStartTime = Date.now();
    if (room.mockLoopIntervalId) clearInterval(room.mockLoopIntervalId);

    room.mockLoopIntervalId = setInterval(() => {
      if (this.isConnected()) {
        clearInterval(room.mockLoopIntervalId);
        return;
      }

      const elapsedSec = (Date.now() - flightStartTime) / 1000;
      const nextMult = parseFloat((1.00 + 0.06 * elapsedSec + 0.01 * Math.pow(elapsedSec, 2)).toFixed(2));

      if (nextMult >= crashPoint) {
        clearInterval(room.mockLoopIntervalId);
        this.onRoomCrash(room.id, crashPoint);
      } else {
        this.onRoomMultiplierUpdate(room.id, nextMult);
      }
    }, 16);
  }

  public onRoomMultiplierUpdate(roomId: number, multiplier: number) {
    const room = this.getRoom(roomId);
    room.currentMultiplier.set(multiplier);

    const currentAnim = room.animatedMultiplier();
    room.animatedMultiplier.set(parseFloat((currentAnim + (multiplier - currentAnim) * 0.4).toFixed(2)));
    room.flightProgress = Math.min(0.97, Math.max(0, 1 - 1 / Math.pow(Math.max(multiplier, 1), 1.55)));

    this.simulateRoomAICashouts(room, multiplier);

    room.liveBets.update(bets =>
      bets.map(b => {
        if (!b.cashedOut) {
          return {
            ...b,
            win: parseFloat((b.bet * multiplier).toFixed(2))
          };
        }
        return b;
      })
    );

    // Auto-cashout belongs to the room that produced this tick. It must keep
    // running even when the player is viewing another room.
    this.evaluateAutoCashouts(multiplier, roomId);
  }

  public onRoomCrash(roomId: number, finalPoint: number) {
    const room = this.getRoom(roomId);
    room.gameState.set('CRASHED');
    room.finalCrashMultiplier.set(finalPoint);
    room.currentMultiplier.set(finalPoint);
    room.animatedMultiplier.set(finalPoint);
    room.crashFlightProgress = Math.min(1.08, Math.max(0, 1 - 1 / Math.pow(Math.max(finalPoint, 1), 1.55)));
    room.flightProgress = room.crashFlightProgress;

    room.flyingStartedAt = 0;
    room.panel1.update(p => ({ ...p, placedAmount: 0, isPending: false, hasActiveBet: false }));
    room.panel2.update(p => ({ ...p, placedAmount: 0, isPending: false, hasActiveBet: false }));

    if (this.selectedRoom() === roomId) {
      this.gameSound.stopBackground();
      if (this.soundEnabled() && (typeof document === 'undefined' || !document.hidden)) {
        this.gameSound.playCrash();
      }
    }

    if (!this.isConnected()) {
      room.history.update(h => [finalPoint, ...h.slice(0, 19)]);
      if (this.allowStandaloneRounds) {
        setTimeout(() => this.onRoomRoundStart(room), 1500);
      }
    }
  }

  private seedRoomMockBets(room: RoomState) {
    if (room.fakeJoinIntervalId) clearInterval(room.fakeJoinIntervalId);

    const initialBatch: LiveBet[] = [];
    for (let i = 0; i < 160; i++) {
      initialBatch.push(this.makeFakePlayer(i));
    }
    room.liveBets.set(initialBatch);

    let trickleCount = 0;
    room.fakeJoinIntervalId = setInterval(() => {
      if (trickleCount >= 40 || room.gameState() !== 'WAITING') {
        clearInterval(room.fakeJoinIntervalId);
        return;
      }
      const burst = Math.floor(Math.random() * 4) + 2;
      const newPlayers: LiveBet[] = [];
      for (let j = 0; j < burst && trickleCount < 40; j++, trickleCount++) {
        newPlayers.push(this.makeFakePlayer(160 + trickleCount));
      }
      room.liveBets.update(list => [...newPlayers, ...list].slice(0, this.maxBetFeedSize));
    }, 250);
  }

  private simulateRoomAICashouts(room: RoomState, currentMult: number) {
    room.liveBets.update(bets =>
      bets.map(b => {
        if (!b.cashedOut && !b.isCurrentUser) {
          const target = b.targetMultiplier || 2.00;
          if (currentMult >= target) {
            const mult = parseFloat(target.toFixed(2));
            return {
              ...b,
              multiplier: mult,
              win: parseFloat((b.bet * mult).toFixed(2)),
              cashedOut: true
            };
          }
        }
        return b;
      })
    );
  }

  private replaceRoomLiveBets(roomId: number, bets: SourceGameBet[]) {
    const room = this.getRoom(roomId);
    const currentUserId = String(this.currentUser()?.id ?? '');
    const realBets: LiveBet[] = bets.map((bet, index) => ({
      id: `${bet.odlutUserId || bet.username}-${bet.betId || index}`,
      player: bet.username || 'Player',
      avatarIcon: bet.isBot ? this.FAKE_AVATARS[index % this.FAKE_AVATARS.length] : 'assets/avatars/avatar-pilot.svg',
      bet: Number(bet.amount) || 0,
      multiplier: bet.status === 'cashed_out' ? Number(bet.cashoutMultiplier) || null : null,
      win: bet.status === 'cashed_out' ? Number(bet.payout) || 0 : 0,
      cashedOut: bet.status === 'cashed_out',
      isCurrentUser: Boolean(bet.odlutUserId && bet.odlutUserId === currentUserId),
    }));

    if (realBets.length === 0) return;

    room.liveBets.update(existing => {
      const fakeOnly = existing.filter(b => b.id.startsWith('fake-'));
      return [...realBets, ...fakeOnly].slice(0, this.maxBetFeedSize);
    });
  }

  // Legacy single-room wrappers
  public onRoundStart(durationMs = 5000) {
    this.onRoomRoundStart(this.room1, durationMs);
  }

  public onMultiplierUpdate(multiplier: number) {
    this.onRoomMultiplierUpdate(1, multiplier);
  }

  public onCrash(finalPoint: number) {
    this.onRoomCrash(1, finalPoint);
  }

  private onSocketPhaseChange(roundState: { phase: 'betting' | 'flying' | 'crashed'; durationMs?: number; multiplier?: number; phaseStartedAt?: number }) {
    this.onRoomSocketPhaseChange(1, roundState.phase, roundState.durationMs, roundState.multiplier);
  }

  public toggleSound(): void {
    const enabled = !this.soundEnabled();
    this.gameSound.unlock();
    this.gameSound.setEnabled(enabled);
    this.soundEnabled.set(enabled);
    if (enabled && this.gameState() === 'RUNNING') this.gameSound.playBackground();
  }

  // --------------------------------------------------------------------------
  // PAYOUT & AUTO CASHOUT CALCULATIONS
  // --------------------------------------------------------------------------
  private evaluateAutoCashouts(mult: number, roomId = this.selectedRoom()) {
    const room = this.getRoom(roomId);
    const p1 = room.panel1();
    if (p1.mode === 'auto' && p1.hasActiveBet && !p1.hasCashedOut && mult >= p1.autoTarget) {
      this.cashOut(1, roomId);
    }

    const p2 = room.panel2();
    if (p2.mode === 'auto' && p2.hasActiveBet && !p2.hasCashedOut && mult >= p2.autoTarget) {
      this.cashOut(2, roomId);
    }
  }

  public placeBet(panelIndex: 1 | 2) {
    // Once the plane is in flight, a stake belongs to the following round.
    if (this.gameState() !== 'WAITING') {
      this.queueBet(panelIndex);
      return;
    }

    const panel = panelIndex === 1 ? this.panel1() : this.panel2();
    const amount = panel.amount;

    if (!Number.isFinite(amount) || amount <= 0) {
      this.showToast('Please enter a valid bet amount', true);
      return;
    }

    if (!this.hasCompletedFirstDeposit() && this.userBalance() <= 0) {
      this.showToast('Make at least one deposit to be able to play.', true);
      return;
    }

    if (panel.hasActiveBet || panel.queuedAmount > 0 || panel.isPending) return;

    if (amount > this.userBalance()) {
      this.showToast('Your wallet balance is too low. Use Deposit to add funds.', true);
      return;
    }

    if (this.isConnected()) {
      // The backend owns live balances, bet acceptance, and the admin feed.
      // Do not optimistically mutate any of those values on the client.
      this.setPanelPending(panelIndex, true);
      const autoCashoutTarget = (panel.mode === 'auto' && panel.autoCashoutEnabled && panel.autoTarget && panel.autoTarget >= 1.01) ? panel.autoTarget : undefined;
      this.gameSocket.placeBet(amount, panelIndex, autoCashoutTarget, this.selectedRoom());
      return;
    }

    // Deduct balance
    const newBalance = this.userBalance() - amount;
    this.userBalance.set(newBalance);
    this.authService.updateBalance(newBalance);

    if (panelIndex === 1) {
      this.panel1.update(p => ({
        ...p,
        placedAmount: amount,
        hasActiveBet: true,
        hasCashedOut: false
      }));
    } else {
      this.panel2.update(p => ({
        ...p,
        placedAmount: amount,
        hasActiveBet: true,
        hasCashedOut: false
      }));
    }

    // Add user bet to live sidebar table
    const username = this.currentUser()?.username || 'You';
    const newBetRow: LiveBet = {
      id: Math.random().toString(36).substring(2, 9),
      player: username,
      avatarIcon: 'assets/avatars/avatar-pilot.svg',
      bet: amount,
      multiplier: null,
      win: 0,
      cashedOut: false,
      isCurrentUser: true
    };

    this.activeRoom().liveBets.update(list => [newBetRow, ...list]);
  }

  /**
   * Reserve a stake while a round is in flight. It is promoted to an active
   * bet by activateQueuedBet as soon as the next betting phase opens.
   */
  public queueBet(panelIndex: 1 | 2) {
    const panel = panelIndex === 1 ? this.panel1() : this.panel2();
    const amount = panel.amount;

    if (this.gameState() === 'WAITING') {
      this.placeBet(panelIndex);
      return;
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      this.showToast('Please enter a valid bet amount', true);
      return;
    }

    if (!this.hasCompletedFirstDeposit() && this.userBalance() <= 0) {
      this.showToast('Make at least one deposit to be able to play.', true);
      return;
    }

    if (panel.queuedAmount > 0 || panel.isPending) return;

    if (amount > this.userBalance()) {
      this.showToast('Your wallet balance is too low. Use Deposit to add funds.', true);
      return;
    }

    if (this.isConnected()) {
      if (panelIndex === 1) {
        this.panel1.update(p => ({ ...p, queuedAmount: amount }));
      } else {
        this.panel2.update(p => ({ ...p, queuedAmount: amount }));
      }
      return;
    }

    const newBalance = this.userBalance() - amount;
    this.userBalance.set(newBalance);
    this.authService.updateBalance(newBalance);

    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, queuedAmount: amount }));
    } else {
      this.panel2.update(p => ({ ...p, queuedAmount: amount }));
    }
  }

  /** Moves a reserved next-round stake into the current betting phase. */
  public activateQueuedBet(panelIndex: 1 | 2, roomId = this.selectedRoom()) {
    const room = this.getRoom(roomId);
    const panel = panelIndex === 1 ? room.panel1() : room.panel2();
    const queuedAmount = panel.queuedAmount;

    if (queuedAmount <= 0) return;

    if (this.isConnected()) {
      this.setPanelPending(panelIndex, true, true, roomId);
      this.gameSocket.placeBet(
        queuedAmount,
        panelIndex,
        panel.mode === 'auto' ? panel.autoTarget : undefined,
        roomId
      );
      return;
    }

    const activate = (p: PanelBetState): PanelBetState => ({
      ...p,
      placedAmount: queuedAmount,
      queuedAmount: 0,
      hasActiveBet: true,
      hasCashedOut: false,
      cashedOutPayout: 0,
      cashedOutMultiplier: 0
    });

    if (panelIndex === 1) {
      room.panel1.update(activate);
    } else {
      room.panel2.update(activate);
    }

  }

  public cancelQueuedBet(panelIndex: 1 | 2) {
    const panel = panelIndex === 1 ? this.panel1() : this.panel2();
    if (panel.queuedAmount <= 0) return;

    if (!this.isConnected()) {
      const refunded = this.userBalance() + panel.queuedAmount;
      this.userBalance.set(refunded);
      this.authService.updateBalance(refunded);
    }

    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, queuedAmount: 0 }));
    } else {
      this.panel2.update(p => ({ ...p, queuedAmount: 0 }));
    }

    this.showToast('Next-round bet cancelled');
  }

  public cancelBet(panelIndex: 1 | 2) {
    const panel = panelIndex === 1 ? this.panel1() : this.panel2();
    if (this.gameState() !== 'WAITING' || !panel.hasActiveBet) return;

    if (this.isConnected()) {
      this.showToast('A live bet cannot be cancelled after the server confirms it.', true);
      return;
    }

    // Refund balance
    const refunded = this.userBalance() + panel.placedAmount;
    this.userBalance.set(refunded);
    this.authService.updateBalance(refunded);

    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, hasActiveBet: false, placedAmount: 0 }));
    } else {
      this.panel2.update(p => ({ ...p, hasActiveBet: false, placedAmount: 0 }));
    }

    this.showToast('Bet cancelled');
  }

  public cashOut(panelIndex: 1 | 2, roomId = this.selectedRoom()) {
    const room = this.getRoom(roomId);
    const mult = room.currentMultiplier();
    const panel = panelIndex === 1 ? room.panel1() : room.panel2();

    if (room.gameState() !== 'RUNNING' || !panel.hasActiveBet || panel.hasCashedOut || panel.isPending) return;

    if (this.isConnected()) {
      this.setPanelPending(panelIndex, true, false, roomId);
      this.gameSocket.cashOut(panelIndex, roomId);
      return;
    }

    const payout = parseFloat((panel.placedAmount * mult).toFixed(2));

    // Credit win to wallet balance
    const updatedBalance = this.userBalance() + payout;
    this.userBalance.set(updatedBalance);
    this.authService.updateBalance(updatedBalance);

    if (panelIndex === 1) {
      room.panel1.update(p => ({
        ...p,
        hasCashedOut: true,
        cashedOutPayout: payout,
        cashedOutMultiplier: mult
      }));
    } else {
      room.panel2.update(p => ({
        ...p,
        hasCashedOut: true,
        cashedOutPayout: payout,
        cashedOutMultiplier: mult
      }));
    }

    // Highlight user row in "All Bets" table
    const username = this.currentUser()?.username || 'You';
    room.liveBets.update(list =>
      list.map(b => {
        if (b.player === username || b.isCurrentUser) {
          return {
            ...b,
            multiplier: mult,
            win: payout,
            cashedOut: true
          };
        }
        return b;
      })
    );

    this.triggerCashoutNotification(mult, payout, panelIndex);
    // Cashout notification banner at top of canvas is displayed above
  }

  private setPanelPending(panelIndex: 1 | 2, isPending: boolean, clearQueued = false, roomId = this.selectedRoom()) {
    const room = this.getRoom(roomId);
    const apply = (panel: PanelBetState): PanelBetState => ({
      ...panel,
      isPending,
      queuedAmount: clearQueued ? 0 : panel.queuedAmount
    });

    if (panelIndex === 1) {
      room.panel1.update(apply);
    } else {
      room.panel2.update(apply);
    }
  }

  /** Supports a backend restart rolling out the two-panel protocol. */
  private resolveResponsePanel(slot?: 1 | 2, roomId = this.selectedRoom()): 1 | 2 | null {
    const room = this.getRoom(roomId);
    if (slot === 1 || slot === 2) return slot;
    if (room.panel1().isPending) return 1;
    if (room.panel2().isPending) return 2;
    return null;
  }

  private clearPendingPanels(roomId = this.selectedRoom()) {
    this.setPanelPending(1, false, false, roomId);
    this.setPanelPending(2, false, false, roomId);
  }

  private confirmBet(panelIndex: 1 | 2, amount: number, roomId = this.selectedRoom()) {
    const room = this.getRoom(roomId);
    const apply = (panel: PanelBetState): PanelBetState => ({
      ...panel,
      placedAmount: amount,
      queuedAmount: 0,
      isPending: false,
      hasActiveBet: true,
      hasCashedOut: false,
      cashedOutPayout: 0,
      cashedOutMultiplier: 0
    });

    if (panelIndex === 1) {
      room.panel1.update(apply);
    } else {
      room.panel2.update(apply);
    }
  }

  private confirmCashout(panelIndex: 1 | 2, multiplier: number, payout: number, roomId = this.selectedRoom()) {
    const room = this.getRoom(roomId);
    const apply = (panel: PanelBetState): PanelBetState => ({
      ...panel,
      isPending: false,
      hasCashedOut: true,
      cashedOutPayout: payout,
      cashedOutMultiplier: multiplier
    });

    if (panelIndex === 1) {
      room.panel1.update(apply);
    } else {
      room.panel2.update(apply);
    }

    const p = panelIndex === 1 ? room.panel1() : room.panel2();
    const placedAmount = p.placedAmount || p.amount || 10;
    this.recordUserBetHistory(placedAmount, multiplier, payout, true);
    this.triggerCashoutNotification(multiplier, payout, panelIndex);
  }

  public triggerCashoutNotification(multiplier: number, payout: number, slot: 1 | 2 = 1) {
    const id = ++this.cashoutNotificationSequence;
    this.cashoutNotifications.update(notifications => [...notifications, { id, multiplier, payout, slot }].slice(-2));
    const timeout = setTimeout(() => {
      this.dismissCashoutNotification(id);
      this.cashoutNotificationTimeouts = this.cashoutNotificationTimeouts.filter(value => value !== timeout);
    }, 3600);
    this.cashoutNotificationTimeouts.push(timeout);
  }

  public dismissCashoutNotification(id: number): void {
    this.cashoutNotifications.update(notifications => notifications.filter(notification => notification.id !== id));
  }

  public showWithdrawalNotification(payload: { id?: number; title?: string; message: string; type?: string; timestamp?: string; createdAt?: string }) {
    if (payload.id && payload.id === this.lastWithdrawalNotificationId) return;
    if (this.withdrawalNotifTimeout) clearTimeout(this.withdrawalNotifTimeout);
    if (payload.id) this.lastWithdrawalNotificationId = payload.id;

    const createdAt = payload.createdAt || payload.timestamp;
    const timestamp = createdAt
      ? new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    this.withdrawalNotif.set({
      id: payload.id,
      title: payload.title || '📋 Palpesabet Notification',
      message: payload.message,
      type: payload.type || 'info',
      timestamp
    });
    // Auto-dismiss after 6 seconds so the player can read the admin-edited message
    this.withdrawalNotifTimeout = setTimeout(() => {
      this.withdrawalNotif.set(null);
    }, 6000);
  }

  public dismissWithdrawalNotification() {
    if (this.withdrawalNotifTimeout) clearTimeout(this.withdrawalNotifTimeout);
    this.withdrawalNotif.set(null);
  }

  public claimWelcomeBonus() {
    if (this.isClaimingBonus() || this.currentUser()?.bonus_claimed) return;

    if (!this.hasCompletedFirstDeposit()) {
      this.showBonusNotification('Bonus unavailable', 'Make at least one deposit to be able to claim the bonus.', 'info');
      return;
    }

    this.isClaimingBonus.set(true);
    this.authService.claimWelcomeBonus().subscribe({
      next: response => {
        this.userBalance.set(response.balance);
        this.showProfileDropdown.set(false);
        this.showBonusNotification('Bonus claimed!', '3,500 KES has been added to your wallet.', 'success');
        this.isClaimingBonus.set(false);
        this.loadTransactionsHistory();
      },
      error: message => {
        this.showBonusNotification('Bonus unavailable', message, 'info');
        this.isClaimingBonus.set(false);
      }
    });
  }

  public showBonusNotification(title: string, message: string, type: 'success' | 'info') {
    if (this.bonusNotifTimeout) clearTimeout(this.bonusNotifTimeout);
    this.bonusNotif.set({ title, message, type });
    this.bonusNotifTimeout = setTimeout(() => this.bonusNotif.set(null), 6500);
  }

  public dismissBonusNotification() {
    if (this.bonusNotifTimeout) clearTimeout(this.bonusNotifTimeout);
    this.bonusNotif.set(null);
  }

  public triggerDualPanelAction() {
    const state = this.gameState();
    if (state === 'WAITING') {
      if (!this.panel1().hasActiveBet && !this.panel1().queuedAmount && !this.panel1().isPending) {
        this.placeBet(1);
      }
      if (!this.panel2().hasActiveBet && !this.panel2().queuedAmount && !this.panel2().isPending) {
        this.placeBet(2);
      }
    } else if (state === 'RUNNING') {
      if (this.panel1().hasActiveBet && !this.panel1().hasCashedOut && !this.panel1().isPending) {
        this.cashOut(1);
      }
      if (this.panel2().hasActiveBet && !this.panel2().hasCashedOut && !this.panel2().isPending) {
        this.cashOut(2);
      }
    }
  }

  // --------------------------------------------------------------------------
  // SIDEBAR MOCK BETS FEED  (frontend-only — never touches backend / admin)
  // --------------------------------------------------------------------------

  /** Masked player formats matching official Aviator format: 2***9, 2***6, 0***3, etc. */
  private readonly FAKE_PREFIX_DIGITS = ['2', '2', '2', '2', '7', '1', '0', '2', '2', '7'];

  private readonly FAKE_AVATARS = [
    'assets/avatars/avatar-vulture.svg',
    'assets/avatars/avatar-soldier.svg',
    'assets/avatars/avatar-girl.svg',
    'assets/avatars/avatar-leaf.svg',
    'assets/avatars/avatar-strawberry.svg',
    'assets/avatars/avatar-lips.svg',
    'assets/avatars/avatar-jet.svg',
    'assets/avatars/avatar-wolf.svg',
    'assets/avatars/avatar-lion.svg',
    'assets/avatars/avatar-pilot.svg'
  ];

  /** Common stake amounts used by the simulated live feed. */
  private readonly FAKE_BET_POOL = [
    20, 50, 50, 100, 100, 100, 100, 150, 150,
    200, 200, 200, 250, 300, 350, 500, 500, 600,
    850, 1000, 1000, 1200, 1450, 1500, 2000
  ];

  /**
   * Large stakes are deliberately uncommon.  This keeps the high-stake end of
   * the sorted feed varied instead of filling it with repeated 10,000 KES rows.
   */
  private generateFakeBetAmount(): number {
    const roll = Math.random();
    if (roll < 0.012) return 10000;
    if (roll < 0.045) return [6000, 7000, 8000][Math.floor(Math.random() * 3)];
    if (roll < 0.16) return [2500, 3000, 3500, 3750, 4000, 5000][Math.floor(Math.random() * 6)];
    return this.FAKE_BET_POOL[Math.floor(Math.random() * this.FAKE_BET_POOL.length)];
  }

  private generateRealisticCashoutTarget(betAmount: number): number {
    const roll = Math.random();
    if (betAmount >= 2000) {
      // Bigger players are mixed risk-takers, not a near-uniform stream of
      // early cash-outs.  Most still protect their stake, while a meaningful
      // share stays in through medium and high multipliers.
      if (roll < 0.26) return parseFloat((1.20 + Math.random() * 0.75).toFixed(2));
      if (roll < 0.62) return parseFloat((2.00 + Math.random() * 2.50).toFixed(2));
      if (roll < 0.86) return parseFloat((4.60 + Math.random() * 5.40).toFixed(2));
      if (roll < 0.96) return parseFloat((10.25 + Math.random() * 14.75).toFixed(2));
      return parseFloat((25.50 + Math.random() * 34.50).toFixed(2));
    }

    if (roll < 0.30) return parseFloat((1.15 + Math.random() * 0.85).toFixed(2));
    if (roll < 0.66) return parseFloat((2.00 + Math.random() * 2.70).toFixed(2));
    if (roll < 0.88) return parseFloat((4.75 + Math.random() * 6.25).toFixed(2));
    if (roll < 0.97) return parseFloat((11.25 + Math.random() * 18.75).toFixed(2));
    return parseFloat((30.25 + Math.random() * 49.75).toFixed(2));
  }

  private makeFakePlayer(index: number): LiveBet {
    const startDigit = this.FAKE_PREFIX_DIGITS[index % this.FAKE_PREFIX_DIGITS.length];
    const endDigit = Math.floor(Math.random() * 10);
    const bet = this.generateFakeBetAmount();
    return {
      id: `fake-${index}-${Date.now()}`,
      player: `${startDigit}***${endDigit}`,
      avatarIcon: this.FAKE_AVATARS[index % this.FAKE_AVATARS.length],
      bet,
      multiplier: null,
      win: 0,
      cashedOut: false,
      targetMultiplier: this.generateRealisticCashoutTarget(bet)
    };
  }

  private seedMockBets() {
    if (this.fakeJoinIntervalId) clearInterval(this.fakeJoinIntervalId);

    const initialBatch: LiveBet[] = [];
    for (let i = 0; i < 160; i++) {
      initialBatch.push(this.makeFakePlayer(i));
    }
    this.activeRoom().liveBets.set(initialBatch);

    let trickleCount = 0;
    this.fakeJoinIntervalId = setInterval(() => {
      if (trickleCount >= 40 || this.gameState() !== 'WAITING') {
        clearInterval(this.fakeJoinIntervalId);
        return;
      }
      const burst = Math.floor(Math.random() * 4) + 2;
      const newPlayers: LiveBet[] = [];
      for (let j = 0; j < burst && trickleCount < 40; j++, trickleCount++) {
        newPlayers.push(this.makeFakePlayer(160 + trickleCount));
      }
      this.activeRoom().liveBets.update(list => [...newPlayers, ...list].slice(0, this.maxBetFeedSize));
    }, 250);
  }

  private simulateAICashouts(currentMult: number) {
    this.activeRoom().liveBets.update(bets =>
      bets.map(b => {
        if (!b.cashedOut && !b.isCurrentUser) {
          const target = b.targetMultiplier || 2.00;
          if (currentMult >= target) {
            const mult = parseFloat(target.toFixed(2));
            return {
              ...b,
              multiplier: mult,
              win: parseFloat((b.bet * mult).toFixed(2)),
              cashedOut: true
            };
          }
        }
        return b;
      })
    );
  }

  private addLiveBetBroadcast(b: LiveBetBroadcast) {
    const row: LiveBet = {
      id: b.betId ? `bet-${b.betId}` : Math.random().toString(),
      player: b.player,
      avatarIcon: 'assets/avatars/avatar-pilot.svg',
      bet: b.bet,
      multiplier: b.multiplier,
      win: b.win,
      cashedOut: b.cashedOut,
      isCurrentUser: b.userId === this.currentUser()?.id
    };
    this.activeRoom().liveBets.update(list => [row, ...list].slice(0, this.maxBetFeedSize));
  }

  private updateLiveBetBroadcast(c: LiveBetBroadcast) {
    this.activeRoom().liveBets.update(list =>
      list.map(item => {
        const isMatchingBet = c.betId
          ? item.id === `bet-${c.betId}`
          : item.player === c.player;
        if (isMatchingBet) {
          return {
            ...item,
            multiplier: c.multiplier,
            win: c.win,
            cashedOut: true
          };
        }
        return item;
      })
    );
  }

  private replaceLiveBets(bets: SourceGameBet[]) {
    const currentUserId = String(this.currentUser()?.id ?? '');
    const realBets: LiveBet[] = bets.map((bet, index) => ({
      id: `${bet.odlutUserId || bet.username}-${bet.betId || index}`,
      player: bet.username || 'Player',
      avatarIcon: bet.isBot ? this.FAKE_AVATARS[index % this.FAKE_AVATARS.length] : 'assets/avatars/avatar-pilot.svg',
      bet: Number(bet.amount) || 0,
      multiplier: bet.status === 'cashed_out' ? Number(bet.cashoutMultiplier) || null : null,
      win: bet.status === 'cashed_out' ? Number(bet.payout) || 0 : 0,
      cashedOut: bet.status === 'cashed_out',
      isCurrentUser: Boolean(bet.odlutUserId && bet.odlutUserId === currentUserId),
    }));

    if (realBets.length === 0) return;

    this.activeRoom().liveBets.update(existing => {
      const fakeOnly = existing.filter(b => b.id.startsWith('fake-'));
      return [...realBets, ...fakeOnly].slice(0, this.maxBetFeedSize);
    });
  }

  // --------------------------------------------------------------------------
  // HTML5 CANVAS RENDERING ENGINE (60 FPS Exponential Trajectory & Effects)
  // --------------------------------------------------------------------------
  private initCanvas() {
    if (!this.canvasRef) return;
    const canvas = this.canvasRef.nativeElement;
    this.ctx = canvas.getContext('2d');
    this.resizeCanvas();

    // Use ResizeObserver to re-size canvas whenever container dimensions change
    if (this.canvasContainerRef) {
      this.resizeObserver = new ResizeObserver(() => {
        this.resizeCanvas();
      });
      this.resizeObserver.observe(this.canvasContainerRef.nativeElement);
    }

    this.loadPlaneAsset();
  }

  private loadPlaneAsset() {
    const image = new Image();
    image.onload = () => {
      const asset = document.createElement('canvas');
      asset.width = image.naturalWidth;
      asset.height = image.naturalHeight;
      const assetContext = asset.getContext('2d');
      if (!assetContext) return;

      assetContext.drawImage(image, 0, 0);
      this.planeAsset = asset;
    };
    image.src = 'assets/images/aviator-reference-plane.svg';
  }

  private resizeCanvas() {
    if (!this.canvasRef || !this.canvasContainerRef) return;
    const canvas = this.canvasRef.nativeElement;
    const container = this.canvasContainerRef.nativeElement;
    const dpr = window.devicePixelRatio || 1;

    const w = container.clientWidth;
    const h = container.clientHeight;

    // Only resize if container has actual dimensions
    if (w === 0 || h === 0) return;

    // Set physical pixel dimensions
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    if (this.ctx) {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0); // reset any previous transforms
      this.ctx.scale(dpr, dpr);
    }
  }

  private startCanvasRenderLoop = () => {
    this.renderFrame(performance.now());
    this.animationFrameId = requestAnimationFrame(this.startCanvasRenderLoop);
  };

  private renderFrame(frameTime: number) {
    if (!this.ctx || !this.canvasRef || !this.canvasContainerRef) return;
    const container = this.canvasContainerRef.nativeElement;
    const w = container.clientWidth;
    const h = container.clientHeight;

    const state = this.gameState();
    const mult = this.currentMultiplier();
    this.updateAnimatedMultiplier(mult, state);
    // Rendering state is isolated from the server-driven room and betting state.
    if (this.referenceRoom !== this.selectedRoom() || this.referencePhase !== state) {
      if (state === 'WAITING' || this.referenceRoom !== this.selectedRoom()) this.referenceFlightProgress = 0;
      if (state === 'CRASHED') {
        this.referenceCrashProgress = this.referenceFlightProgress;
        this.crashStartedAt = frameTime;
      }
      this.referenceRoom = this.selectedRoom();
      this.referencePhase = state;
    }

    const elapsedMs = this.lastCanvasFrameTime
      ? Math.min(60, frameTime - this.lastCanvasFrameTime)
      : 16.67;
    this.lastCanvasFrameTime = frameTime;
    const dt = Math.min(0.06, elapsedMs / 1000);

    // ─── SLOW, SMOOTH SUNBURST ROTATION (SPRIBE SILKY BACKGROUND FLOW) ─────
    const rays = 12;
    const rayAngle = (Math.PI / 2) / rays;
    const rayCycle = rayAngle * 2;

    if (state === 'RUNNING') {
      // Gentle, slow graceful drift during flight
      const flightSpeed = 0.045 + Math.min(0.04, (mult - 1) * 0.005);
      this.sunburstAngle = (this.sunburstAngle + flightSpeed * dt) % rayCycle;
    } else if (state === 'CRASHED') {
      const crashSpeed = 0.035;
      this.sunburstAngle = (this.sunburstAngle + crashSpeed * dt) % rayCycle;
    } else {
      // WAITING state: barely noticeable subtle idle drift
      const idleSpeed = 0.018;
      this.sunburstAngle = (this.sunburstAngle + idleSpeed * dt) % rayCycle;
    }

    // 1. Deep Solid Black Background
    this.ctx.fillStyle = '#000000';
    this.ctx.fillRect(0, 0, w, h);

    // 2. Draw Moving Sunburst Radiating Fan Lines
    this.drawSunburstRays(w, h, this.sunburstAngle, rayAngle);

    // 3. Ambient Flight Glow: Blue when < 2.00x (Image 1), Purple when >= 2.00x (Image 2)
    this.drawFlightZoneGlow(w, h, mult, state, elapsedMs);

    if (state === 'RUNNING' || state === 'CRASHED') {
      const isMobileBoard = window.innerWidth <= 900;
      const spriteScale = isMobileBoard ? Math.max(0.7, w * 0.225 / 95) : 1.5;

      // ─── FLIGHT PROGRESS & SMOOTH INTERPOLATION (BETIKA / SPRIBE ULTRA-SMOOTH) ───
      if (state === 'RUNNING') {
        const m = Math.max(1.00, mult);
        // Presentation coordinates only; server multipliers and round timing are unchanged.
        const climbP = 1 - Math.exp(-(m - 1) * (isMobileBoard ? 1.7 : 2.8));
        const targetProgress = isMobileBoard
            ? Math.min(0.92, Math.max(0.04, 0.09 + climbP * 0.90))
            : Math.min(0.94, Math.max(0.04, 0.06 + climbP * 0.92));
        const dt = Math.min(0.05, elapsedMs / 1000);
        const smoothing = 1 - Math.exp(-dt * 5.5);
        this.referenceFlightProgress += (targetProgress - this.referenceFlightProgress) * smoothing;
      }

      const p = state === 'CRASHED' ? this.referenceCrashProgress : this.referenceFlightProgress;

      // ─── SAFE PLANE BOUNDS ──────────────────────────────────────────────────
      const planeDrawW = 84 * spriteScale;
      const planeDrawH = 46 * spriteScale;
      const marginX = planeDrawW * 0.50;
      const marginY = planeDrawH * 0.55;

      const minX = marginX + (isMobileBoard ? 8 : 16);
      const maxX = w - marginX - (isMobileBoard ? 10 : 20);
      const maxY = h - marginY - 6;
      const minY = marginY + (isMobileBoard ? 10 : 16);

      const basePathX = minX + (maxX - minX) * p;
      const verticalProgress = isMobileBoard
        ? Math.min(0.97, p * 1.35) : Math.pow(p, 0.84);
      const basePathY = maxY - (maxY - minY) * verticalProgress;

      // Subtle, silky Spribe aerodynamic floating (frozen at crash start for a single clean exit path)
      const flightTime = (state === 'CRASHED' && this.crashStartedAt ? this.crashStartedAt : frameTime) / 1000;
      const waveX = Math.sin(flightTime * 0.9) * 3.5;
      const waveY = Math.cos(flightTime * 1.1) * 5.0;

      const planeX = Math.max(minX, Math.min(maxX, basePathX + waveX));
      const planeY = Math.max(minY, Math.min(maxY, basePathY + waveY));

      // Gentle dynamic pitch
      const dynamicPitch = -0.045 + Math.sin(flightTime * 1.1) * 0.015;

      // Exact rear-wheel / tail point of the airplane where the red trail connects
      const tailX = planeX - planeDrawW * 0.40;
      const tailY = planeY + planeDrawH * 0.16;

      // Exponential Bezier control point anchored at the bottom
      const ctrlX = tailX * 0.42;
      const ctrlY = h;

      // ─── 1 & 2. TRANSLUCENT RED TRAIL FILL & CURVE (ONLY DURING ACTIVE FLIGHT) ───
      if (state === 'RUNNING') {
        const fill = this.ctx.createLinearGradient(0, tailY, 0, h);
        fill.addColorStop(0, 'rgba(205, 0, 46, 0.55)');
        fill.addColorStop(0.5, 'rgba(166, 0, 30, 0.62)');
        fill.addColorStop(1, 'rgba(126, 0, 20, 0.72)');

        this.ctx.beginPath();
        this.ctx.moveTo(0, h);
        this.ctx.quadraticCurveTo(ctrlX, ctrlY, tailX, tailY);
        this.ctx.lineTo(tailX, h); // Clean straight vertical drop to floor!
        this.ctx.lineTo(0, h);     // Back along floor baseline
        this.ctx.closePath();
        this.ctx.fillStyle = fill;
        this.ctx.fill();

        // ─── VIBRANT GLOWING RED TRAIL CURVE ────────────────────────────────
        this.ctx.beginPath();
        this.ctx.moveTo(0, h);
        this.ctx.quadraticCurveTo(ctrlX, ctrlY, tailX, tailY);
        this.ctx.strokeStyle = '#ff0046';
        this.ctx.lineWidth = 3.2;
        this.ctx.shadowColor = '#e50914';
        this.ctx.shadowBlur = 0;
        this.ctx.stroke();
        this.ctx.shadowBlur = 0;
      }

      // ─── 3. PLANE SPRITE (WITH NATURAL DYNAMIC PITCH & PROPELLER) ───────────
      if (state === 'RUNNING') {
        this.drawAirplaneSprite(planeX, planeY, dynamicPitch, spriteScale);
      } else if (state === 'CRASHED') {
        if (this.crashStartedAt > 0) {
          const crashProgress = Math.max(0, Math.min(1, (frameTime - this.crashStartedAt) / this.crashExitDurationMs));
          if (crashProgress < 1) {
            const exitDistance = Math.pow(crashProgress, 1.35);
            const exitDeltaX = Math.max(w * 0.60, w - planeX) + planeDrawW * 1.5;
            const exitDeltaY = Math.max(h * 0.55, planeY) + planeDrawH * 1.5;
            const crashedX = planeX + exitDeltaX * exitDistance;
            const crashedY = planeY - exitDeltaY * exitDistance;
            this.drawAirplaneSprite(crashedX, crashedY, -0.12 - crashProgress * 0.35, spriteScale);
          }
        }
      }
    } else {
      // WAITING Phase
    }
  }

  private drawSunburstRays(w: number, h: number, offsetAngle: number, rayAngle: number) {
    if (!this.ctx) return;
    this.ctx.save();
    const maxDist = Math.hypot(w, h) * 1.8;

    // Angle coverage from below horizontal baseline (-0.35 rad) to past vertical axis (PI/2 + 0.35 rad)
    const minAngle = -0.35;
    const maxAngle = Math.PI / 2 + 0.35;

    const startIndex = Math.floor(minAngle / rayAngle) - 2;
    const endIndex = Math.ceil(maxAngle / rayAngle) + 2;

    for (let i = startIndex; i <= endIndex; i++) {
      // Rotate clockwise / downward relative to bottom-left origin to simulate forward/upward flight
      const a1 = i * rayAngle - offsetAngle;
      const a2 = (i + 1) * rayAngle - offsetAngle;

      this.ctx.beginPath();
      this.ctx.moveTo(0, h);
      this.ctx.lineTo(Math.cos(a1) * maxDist, h - Math.sin(a1) * maxDist);
      this.ctx.lineTo(Math.cos(a2) * maxDist, h - Math.sin(a2) * maxDist);
      this.ctx.closePath();

      const isEven = Math.abs(i) % 2 === 0;
      this.ctx.fillStyle = isEven
        ? 'rgba(255, 255, 255, 0.04)'
        : 'rgba(0, 0, 0, 0.35)';
      this.ctx.fill();
    }
    this.ctx.restore();
  }

  private drawFlightZoneGlow(
    w: number,
    h: number,
    multiplier: number,
    state: GameState,
    _elapsedMs: number
  ) {
    if (!this.ctx || state === 'WAITING' || state === 'CRASHED') return;

    // Change only the flight backdrop at the displayed 2.00x threshold.
    const purple = multiplier >= 2;
    const r = purple ? 105 : 0;
    const g = purple ? 43 : 145;
    const b = purple ? 172 : 245;

    // Designated focal center (behind the multiplier text & flight zone)
    const cx = w * 0.50;
    const cy = h * 0.44;

    this.ctx.save();

    // Stretch horizontally to match the wide spotlight beam in reference images
    this.ctx.translate(cx, cy);
    this.ctx.scale(1.35, 1.0);

    const radius = Math.min(w * 0.38, h * 0.62);

    const glow = this.ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    glow.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.88)`);
    glow.addColorStop(0.25, `rgba(${Math.round(r * 0.85)}, ${Math.round(g * 0.85)}, ${Math.round(b * 0.85)}, 0.65)`);
    glow.addColorStop(0.52, `rgba(${Math.round(r * 0.55)}, ${Math.round(g * 0.55)}, ${Math.round(b * 0.55)}, 0.32)`);
    glow.addColorStop(0.78, `rgba(${Math.round(r * 0.25)}, ${Math.round(g * 0.25)}, ${Math.round(b * 0.25)}, 0.08)`);
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');

    this.ctx.fillStyle = glow;
    this.ctx.beginPath();
    this.ctx.arc(0, 0, radius, 0, Math.PI * 2);
    this.ctx.fill();

    this.ctx.restore();
  }

  private resetAnimatedMultiplier(value: number) {
    this.renderedMultiplierValue = value;
    this.activeRoom().animatedMultiplier.set(value);
    this.lastMultiplierFrameAt = performance.now();
  }

  private getFlightLift(maxPixels: number, room = this.activeRoom()): number {
    if (!room.flyingStartedAt) return 0;
    const elapsedInCycle = ((Date.now() - room.flyingStartedAt) % 6000 + 6000) % 6000;
    if (elapsedInCycle <= 4000) {
      const rise = elapsedInCycle / 4000;
      return maxPixels * (1 - Math.pow(1 - rise, 2));
    }
    const settle = (elapsedInCycle - 4000) / 2000;
    return maxPixels * Math.pow(1 - settle, 2);
  }

  private updateAnimatedMultiplier(target: number, state: GameState): number {
    const frameNow = performance.now();
    const elapsed = Math.min(64, Math.max(0, frameNow - this.lastMultiplierFrameAt));
    this.lastMultiplierFrameAt = frameNow;
    if (state === 'WAITING' || state === 'CRASHED') {
      if (this.renderedMultiplierValue !== target) this.resetAnimatedMultiplier(target);
      return target;
    }
    const amount = Number.isFinite(target) ? target : 1;
    const alpha = 1 - Math.exp(-12 * (elapsed / 1000));
    this.renderedMultiplierValue += (amount - this.renderedMultiplierValue) * alpha;
    if (Math.abs(amount - this.renderedMultiplierValue) < 0.0001) this.renderedMultiplierValue = amount;
    this.activeRoom().animatedMultiplier.set(this.renderedMultiplierValue);
    return this.renderedMultiplierValue;
  }

  private drawAirplaneSprite(x: number, y: number, angle: number, scale = 1.55) {
    if (!this.ctx) return;
    this.ctx.save();
    this.ctx.translate(x, y);
    this.ctx.rotate(angle);
    this.ctx.scale(scale, scale);

    // Use LIGITOK's artwork without changing flight timing or game state.
    if (this.planeAsset) {
      const drawWidth = 95;
      const drawHeight = drawWidth * this.planeAsset.height / this.planeAsset.width;
      this.ctx.drawImage(this.planeAsset, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
      this.ctx.restore();
      return;
    }

    // Engine glow behind the tail.
    const glowGradient = this.ctx.createRadialGradient(-30, 0, 1, -30, 0, 22);
    glowGradient.addColorStop(0, 'rgba(255, 56, 95, 0.72)');
    glowGradient.addColorStop(1, 'rgba(225, 29, 72, 0)');
    this.ctx.fillStyle = glowGradient;
    this.ctx.beginPath();
    this.ctx.arc(-30, 0, 22, 0, Math.PI * 2);
    this.ctx.fill();

    // Red single-prop airplane silhouette, matching the reference board.
    this.ctx.fillStyle = '#ed0042';
    this.ctx.beginPath();
    this.ctx.moveTo(-43, -3);
    this.ctx.quadraticCurveTo(-18, -9, 20, -7);
    this.ctx.lineTo(37, -4);
    this.ctx.lineTo(44, 0);
    this.ctx.lineTo(37, 4);
    this.ctx.quadraticCurveTo(6, 9, -35, 6);
    this.ctx.lineTo(-45, 2);
    this.ctx.fill();

    // Swept wings give the plane its distinctive compact Aviator profile.
    this.ctx.fillStyle = '#c90036';
    this.ctx.beginPath();
    this.ctx.moveTo(-1, -6);
    this.ctx.lineTo(12, -27);
    this.ctx.lineTo(27, -21);
    this.ctx.lineTo(14, -3);
    this.ctx.fill();

    this.ctx.beginPath();
    this.ctx.moveTo(-14, 5);
    this.ctx.lineTo(-31, 18);
    this.ctx.lineTo(-21, 9);
    this.ctx.lineTo(-4, 5);
    this.ctx.fill();

    // Tail fin.
    this.ctx.fillStyle = '#b50031';
    this.ctx.beginPath();
    this.ctx.moveTo(-30, -4);
    this.ctx.lineTo(-38, -21);
    this.ctx.lineTo(-21, -8);
    this.ctx.lineTo(-16, -4);
    this.ctx.fill();

    // Dark cockpit window and white fuselage flash.
    this.ctx.fillStyle = '#16191c';
    this.ctx.beginPath();
    this.ctx.moveTo(15, -5);
    this.ctx.lineTo(27, -3);
    this.ctx.lineTo(20, 0);
    this.ctx.lineTo(10, -1);
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.fillStyle = 'rgba(255,255,255,0.72)';
    this.ctx.fillRect(-13, -3, 18, 1.4);
    this.ctx.fillStyle = '#910027';
    this.ctx.fillRect(-8, 2, 21, 1.2);

    // Spinning three-blade propeller at the nose.
    const propRotation = (Date.now() / 20) % (Math.PI * 2);
    this.ctx.save();
    this.ctx.translate(45, 0);
    this.ctx.rotate(propRotation);
    this.ctx.fillStyle = '#ed0042';
    for (let blade = 0; blade < 3; blade++) {
      this.ctx.rotate((Math.PI * 2) / 3);
      this.ctx.beginPath();
      this.ctx.moveTo(-1, -2);
      this.ctx.lineTo(4, -16);
      this.ctx.lineTo(2, -3);
      this.ctx.closePath();
      this.ctx.fill();
    }
    this.ctx.fillStyle = '#8d0027';
    this.ctx.beginPath();
    this.ctx.arc(0, 0, 2.4, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.restore();

    this.ctx.restore();
  }

  // --------------------------------------------------------------------------
  // USER ACTION HANDLERS & MODALS
  // --------------------------------------------------------------------------
  public isEditingPanel1 = false;
  public isEditingPanel2 = false;
  public panel1InputText = '';
  public panel2InputText = '';

  /** Returns formatted amount when resting, or the raw text while the user is actively typing. */
  public getPanelAmountDisplay(panelIndex: 1 | 2): string {
    if (panelIndex === 1) {
      if (this.isEditingPanel1) {
        return this.panel1InputText;
      }
      return this.panel1().amount.toFixed(2);
    } else {
      if (this.isEditingPanel2) {
        return this.panel2InputText;
      }
      return this.panel2().amount.toFixed(2);
    }
  }

  /** When the user focuses the amount box, present an unformatted integer/number and auto-select all text. */
  public onAmountFocus(panelIndex: 1 | 2, event: Event) {
    const target = event.target as HTMLInputElement;
    const panel = panelIndex === 1 ? this.panel1() : this.panel2();
    const amt = panel.amount;
    // Show clean number without decimal places if whole number (e.g. "10" instead of "10.00")
    const cleanText = amt % 1 === 0 ? amt.toFixed(0) : amt.toString();
    if (panelIndex === 1) {
      this.isEditingPanel1 = true;
      this.panel1InputText = cleanText;
    } else {
      this.isEditingPanel2 = true;
      this.panel2InputText = cleanText;
    }
    target.value = cleanText;
    setTimeout(() => {
      try {
        target.select();
      } catch (_) {}
    }, 0);
  }

  public onAmountInput(panelIndex: 1 | 2, event: Event) {
    const target = event.target as HTMLInputElement;
    // Allow digits and at most one decimal point with max 2 decimal places
    let raw = target.value.replace(/[^0-9.]/g, '');
    const dotIndex = raw.indexOf('.');
    if (dotIndex !== -1) {
      const intPart = raw.substring(0, dotIndex);
      const decPart = raw.substring(dotIndex + 1).replace(/\./g, '').substring(0, 2);
      raw = intPart + '.' + decPart;
    }
    target.value = raw;

    if (panelIndex === 1) {
      this.panel1InputText = raw;
      const val = parseFloat(raw);
      if (!isNaN(val) && val > 0) {
        this.panel1.update(p => ({ ...p, amount: val, selectedPreset: null }));
      }
    } else {
      this.panel2InputText = raw;
      const val = parseFloat(raw);
      if (!isNaN(val) && val > 0) {
        this.panel2.update(p => ({ ...p, amount: val, selectedPreset: null }));
      }
    }
  }

  public onAmountBlur(panelIndex: 1 | 2, event: Event) {
    const target = event.target as HTMLInputElement;
    const panel = panelIndex === 1 ? this.panel1() : this.panel2();
    let val = parseFloat(target.value);
    if (isNaN(val) || val < 1) {
      val = Math.max(1, panel.amount || 10);
    }
    val = Math.min(val, 300000);
    val = Math.round(val * 100) / 100;

    if (panelIndex === 1) {
      this.isEditingPanel1 = false;
      this.panel1InputText = '';
      this.panel1.update(p => ({ ...p, amount: val, selectedPreset: null }));
    } else {
      this.isEditingPanel2 = false;
      this.panel2InputText = '';
      this.panel2.update(p => ({ ...p, amount: val, selectedPreset: null }));
    }
    target.value = val.toFixed(2);
  }

  public setPanelAmount(panelIndex: 1 | 2, value: any) {
    if (panelIndex === 1) {
      this.isEditingPanel1 = false;
      this.panel1InputText = '';
    } else {
      this.isEditingPanel2 = false;
      this.panel2InputText = '';
    }
    const num = parseFloat(value);
    if (!isNaN(num) && num > 0) {
      if (panelIndex === 1) {
        this.panel1.update(p => ({ ...p, amount: num, selectedPreset: null }));
      } else {
        this.panel2.update(p => ({ ...p, amount: num, selectedPreset: null }));
      }
    }
  }

  public adjustPanelAmount(panelIndex: 1 | 2, delta: number) {
    if (panelIndex === 1) {
      this.isEditingPanel1 = false;
      this.panel1InputText = '';
    } else {
      this.isEditingPanel2 = false;
      this.panel2InputText = '';
    }
    const updateAmount = (panel: PanelBetState): PanelBetState => ({
      ...panel,
      amount: Math.max(1, Math.round((panel.amount + delta) * 100) / 100),
      selectedPreset: null,
      presetTapCount: 0
    });

    if (panelIndex === 1) {
      this.panel1.update(updateAmount);
    } else {
      this.panel2.update(updateAmount);
    }
  }

  /** Repeated taps of one preset set its stake to preset × tap count. */
  public selectPresetAmount(panelIndex: 1 | 2, preset: number) {
    if (panelIndex === 1) {
      this.isEditingPanel1 = false;
      this.panel1InputText = '';
    } else {
      this.isEditingPanel2 = false;
      this.panel2InputText = '';
    }
    const updatePreset = (panel: PanelBetState): PanelBetState => {
      const presetTapCount = panel.selectedPreset === preset ? panel.presetTapCount + 1 : 1;
      return {
        ...panel,
        amount: preset * presetTapCount,
        selectedPreset: preset,
        presetTapCount
      };
    };

    if (panelIndex === 1) {
      this.panel1.update(updatePreset);
    } else {
      this.panel2.update(updatePreset);
    }
  }

  public setPanelMode(panelIndex: 1 | 2, mode: 'bet' | 'auto') {
    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, mode }));
    } else {
      this.panel2.update(p => ({ ...p, mode }));
    }
  }

  public setAutoCashout(panelIndex: 1 | 2, value: number) {
    const autoTarget = Math.max(1.10, Number(value) || 1.10);
    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, autoTarget }));
    } else {
      this.panel2.update(p => ({ ...p, autoTarget }));
    }
  }

  private readonly chatAvatarPool = ['pilot', 'wolf', 'vulture', 'strawberry', 'soldier', 'lips', 'lion', 'leaf', 'jet', 'girl'];
  private readonly chatNamePool = [
  '2***5', '2***1', '2***7', '2***4', '2***9', '2***3', '2***8', '2***6', '2***2', '2***0',
  '071***28', '072***91', '079***45', '070***63', '074***19', '075***82', '076***34', '078***50',
  '2547***12', '2547***99', '2547***34', '2547***88', '2547***56', '2547***71', '2547***03',
  'd***n', 'k***o', 'm***a', 'j***2', 'w***4', 'b***9', 'e***7', 'p***1', 'v***x', 's***8',
  'r***5', 'c***0', 'g***3', 't***6', 'h***8', 'l***2', 'n***9', 'y***4', 'a***1', 'f***7'
];

  private seedFallbackChat() {
    const now = Date.now();
    const initialCount = 35;
    const initialMessages: ChatMessage[] = [];
    for (let i = 0; i < initialCount; i++) {
      const textIndex = i % this.chatFallbackMessages.length;
      const nameIndex = i % this.chatNamePool.length;
      const avatarIndex = i % this.chatAvatarPool.length;
      initialMessages.push({
        id: `initial-chat-${i}`,
        username: this.chatNamePool[nameIndex],
        text: this.chatFallbackMessages[textIndex],
        timestamp: new Date(now - ((initialCount - i) * 6_500)).toISOString(),
        avatar: `assets/avatars/avatar-${this.chatAvatarPool[avatarIndex]}.svg`,
        likes: (i * 3) % 7,
        isBot: true,
      });
    }
    this.chatMessages.set(initialMessages);
  }

  private startChatSimulation() {
    if (this.chatSimulationIntervalId) clearTimeout(this.chatSimulationIntervalId);
    
    const scheduleNext = () => {
      // Rapid, continuous Betika-style chat cadence (900ms - 2200ms)
      const delay = 900 + Math.floor(Math.random() * 1300);
      this.chatSimulationIntervalId = setTimeout(() => {
        const textIndex = Math.floor(Math.random() * this.chatFallbackMessages.length);
        const nameIndex = Math.floor(Math.random() * this.chatNamePool.length);
        const avatarIndex = Math.floor(Math.random() * this.chatAvatarPool.length);
        const newMsg: ChatMessage = {
          id: `sim-chat-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          username: this.chatNamePool[nameIndex],
          text: this.chatFallbackMessages[textIndex],
          timestamp: new Date().toISOString(),
          avatar: `assets/avatars/avatar-${this.chatAvatarPool[avatarIndex]}.svg`,
          likes: Math.floor(Math.random() * 4),
          isBot: true,
        };

        this.chatMessages.update(list => {
          const next = [...list, newMsg];
          return next.slice(-200);
        });

        if (this.chatOpen()) {
          if (this.isUserScrolledUp || this.isUserHoldingChat) {
            this.showNewMessagesPill.set(true);
            this.accumulatedNewMessagesCount.update(c => c + 1);
          } else {
            this.scrollChatToLatest('smooth');
            this.showNewMessagesPill.set(false);
            this.accumulatedNewMessagesCount.set(0);
          }
        }

        // Occasional double-message burst like a real active sports betting chat
        if (Math.random() < 0.28) {
          setTimeout(() => {
            const burstTextIdx = Math.floor(Math.random() * this.chatFallbackMessages.length);
            const burstNameIdx = Math.floor(Math.random() * this.chatNamePool.length);
            const burstAvatarIdx = Math.floor(Math.random() * this.chatAvatarPool.length);
            const burstMsg: ChatMessage = {
              id: `sim-chat-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
              username: this.chatNamePool[burstNameIdx],
              text: this.chatFallbackMessages[burstTextIdx],
              timestamp: new Date().toISOString(),
              avatar: `assets/avatars/avatar-${this.chatAvatarPool[burstAvatarIdx]}.svg`,
              likes: Math.floor(Math.random() * 3),
              isBot: true,
            };
            this.chatMessages.update(list => [...list, burstMsg].slice(-200));
            if (this.chatOpen()) {
              if (this.isUserHoldingChat || this.isUserScrolledUp) {
                this.showNewMessagesPill.set(true);
                this.accumulatedNewMessagesCount.update(c => c + 1);
              } else {
                this.scrollChatToLatest('smooth');
                this.showNewMessagesPill.set(false);
                this.accumulatedNewMessagesCount.set(0);
              }
            }
          }, 260);
        }

        scheduleNext();
      }, delay);
    };

    scheduleNext();
  }

  private startOnlineCounter() {
    if (this.chatOnlineIntervalId) clearInterval(this.chatOnlineIntervalId);
    this.chatOnlineIntervalId = setInterval(() => {
      const delta = Math.floor(Math.random() * 31) - 15;
      this.chatOnlineCount.update(c => Math.max(7800, Math.min(9200, c + delta)));
    }, 3000);
  }

  public onChatScroll() {
    const el = this.chatScrollRef?.nativeElement;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.isUserScrolledUp = distanceFromBottom > 50;
    if (!this.isUserScrolledUp && !this.isUserHoldingChat) {
      this.showNewMessagesPill.set(false);
      this.accumulatedNewMessagesCount.set(0);
    }
  }

  public onChatPointerDown() {
    this.isUserHoldingChat = true;
  }

  public onChatPointerUp() {
    this.isUserHoldingChat = false;
    this.onChatScroll();
  }

  public onChatTouchStart() {
    this.isUserHoldingChat = true;
  }

  public onChatTouchEnd() {
    this.isUserHoldingChat = false;
    this.onChatScroll();
  }

  public onNewMessagesPillClick() {
    this.isUserHoldingChat = false;
    this.isUserScrolledUp = false;
    this.showNewMessagesPill.set(false);
    this.scrollChatToLatest('smooth');
  }

  public toggleLikeMessage(message: ChatMessage) {
    this.chatMessages.update(list =>
      list.map(m => {
        if (m.id === message.id) {
          return { ...m, likes: (m.likes || 0) + 1 };
        }
        return m;
      })
    );
  }

  public scrollChatToLatest(behavior: ScrollBehavior = 'smooth') {
    requestAnimationFrame(() => {
      const element = this.chatScrollRef?.nativeElement;
      if (element) {
        try {
          element.scrollTo({
            top: element.scrollHeight + 2000,
            behavior
          });
        } catch {
          element.scrollTop = element.scrollHeight;
        }
      }
    });
  }

  public toggleChat() {
    this.chatOpen.update(open => !open);
    if (this.chatOpen()) {
      this.isUserHoldingChat = false;
      this.isUserScrolledUp = false;
      this.showNewMessagesPill.set(false);
      this.gameSocket.openChat();
      this.scrollChatToLatest('auto');
    }
  }

  public closeChat() {
    this.chatOpen.set(false);
  }

  public sendChatMessage() {
    const text = this.chatDraft().trim();
    if (!text) return;

    if (!this.chatEligible()) {
      const noticeMessage: ChatMessage = {
        id: `restrict-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        username: 'System',
        text: 'Chat access is restricted for players with balance below 1,000 KES',
        timestamp: new Date().toISOString(),
        isRestrictionNotice: true,
        isBot: false,
      };
      this.chatMessages.update(list => [...list, noticeMessage].slice(-150));
      this.scrollChatToLatest();
      this.chatDraft.set('');
      return;
    }

    if (!this.isConnected()) {
      this.showToast('Chat is connecting. Please try again in a moment.', true);
      return;
    }

    const user = this.currentUser();
    const ownMessage: ChatMessage = {
      id: `own-${Date.now()}`,
      username: user?.username || 'You',
      text,
      timestamp: new Date().toISOString(),
      userId: user?.id || 'current-user',
      avatar: 'assets/avatars/avatar-pilot.svg',
      isBot: false,
      likes: 0
    };
    this.chatMessages.update(list => [...list, ownMessage].slice(-200));
    this.isUserScrolledUp = false;
    this.isUserHoldingChat = false;
    this.showNewMessagesPill.set(false);
    this.accumulatedNewMessagesCount.set(0);
    this.scrollChatToLatest('smooth');

    this.gameSocket.sendChatMessage(text);
    this.chatDraft.set('');
  }

  public formatChatTime(timestamp: string): string {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '--:--:--';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }

  public trackChatMessage(_index: number, message: ChatMessage): string {
    return message.id;
  }

  public isOwnChatMessage(message: ChatMessage): boolean {
    const user = this.currentUser();
    const currentUserId = user?.id;
    const currentUsername = user?.username;
    if (message.userId && currentUserId && String(message.userId) === String(currentUserId)) {
      return true;
    }
    if (message.username && currentUsername && message.username.toLowerCase() === currentUsername.toLowerCase()) {
      return true;
    }
    if (message.username === 'You' || message.userId === 'current-user') {
      return true;
    }
    return false;
  }

  public getChatUsernameColor(username: string): string {
    if (!username) return '#60a5fa';
    const colors = [
      '#facc15', // yellow
      '#4ade80', // light green
      '#f87171', // red
      '#38bdf8', // light blue
      '#c084fc', // purple
      '#fb923c', // orange
      '#34d399', // emerald
      '#818cf8', // indigo
      '#f472b6'  // pink
    ];
    let hash = 0;
    for (let i = 0; i < username.length; i++) {
      hash = (hash * 31 + username.charCodeAt(i)) >>> 0;
    }
    return colors[hash % colors.length];
  }

  public openChangeRoomModal(targetRoom?: number) {
    const r = targetRoom || this.selectedRoom();
    this.pendingRoomSelection.set(r);
    this.showChangeRoomModal.set(true);
  }

  public closeChangeRoomModal() {
    this.showChangeRoomModal.set(false);
  }

  public confirmRoomChange() {
    const targetRoom = this.pendingRoomSelection();
    const room = this.getRoom(targetRoom);
    this.selectedRoom.set(targetRoom);
    // Reset renderer-only state to the selected room's live snapshot. The
    // server engines keep running; this only prevents the canvas from carrying
    // the previous room's interpolation or crash animation across the switch.
    this.renderedMultiplierValue = room.animatedMultiplier();
    this.flightProgress = room.flightProgress;
    this.crashFlightProgress = room.crashFlightProgress;
    this.flyingPhaseStartedAt = room.flyingStartedAt;
    this.planeRenderReady = false;
    this.planeRenderPosition = { x: 0, y: 0 };
    this.planeRenderAngle = -0.12;
    this.showChangeRoomModal.set(false);
    this.syncAudioWithActiveRoom();
  }

  private initUserBetHistory() {
    try {
      const stored = localStorage.getItem('pakabet_my_bet_history');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.userBetHistoryList.set(parsed);
          return;
        }
      }
    } catch {
      // fallback
    }

    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const formattedDate = `${now.getFullYear().toString().slice(-2)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    const seedItems: UserBetHistoryItem[] = [
      { id: 'h-1', time: '06:55', date: formattedDate, bet: 10.00, multiplier: 1.00, win: 0, cashedOut: false, rawTimestamp: Date.now() - 60000 },
      { id: 'h-2', time: '06:55', date: formattedDate, bet: 10.00, multiplier: 1.01, win: 10.10, cashedOut: true, rawTimestamp: Date.now() - 120000 },
      { id: 'h-3', time: '06:55', date: formattedDate, bet: 10.00, multiplier: 1.01, win: 10.10, cashedOut: true, rawTimestamp: Date.now() - 180000 },
      { id: 'h-4', time: '06:55', date: formattedDate, bet: 10.00, multiplier: 1.01, win: 10.10, cashedOut: true, rawTimestamp: Date.now() - 240000 },
      { id: 'h-5', time: '06:54', date: formattedDate, bet: 10.00, multiplier: 1.01, win: 10.10, cashedOut: true, rawTimestamp: Date.now() - 300000 },
      { id: 'h-6', time: '06:54', date: formattedDate, bet: 10.00, multiplier: 1.01, win: 10.10, cashedOut: true, rawTimestamp: Date.now() - 360000 },
      { id: 'h-7', time: '06:54', date: formattedDate, bet: 10.00, multiplier: 1.03, win: 10.30, cashedOut: true, rawTimestamp: Date.now() - 420000 },
      { id: 'h-8', time: '06:53', date: formattedDate, bet: 10.00, multiplier: 1.04, win: 10.40, cashedOut: true, rawTimestamp: Date.now() - 480000 },
      { id: 'h-9', time: '06:53', date: formattedDate, bet: 10.00, multiplier: 1.31, win: 0, cashedOut: false, rawTimestamp: Date.now() - 540000 },
      { id: 'h-10', time: '06:53', date: formattedDate, bet: 10.00, multiplier: 1.44, win: 0, cashedOut: false, rawTimestamp: Date.now() - 600000 },
      { id: 'h-11', time: '06:52', date: formattedDate, bet: 10.00, multiplier: 2.15, win: 21.50, cashedOut: true, rawTimestamp: Date.now() - 660000 },
      { id: 'h-12', time: '06:50', date: formattedDate, bet: 20.00, multiplier: 3.40, win: 68.00, cashedOut: true, rawTimestamp: Date.now() - 720000 },
    ];
    this.userBetHistoryList.set(seedItems);
    this.saveUserBetHistory();
  }

  private saveUserBetHistory() {
    try {
      localStorage.setItem('pakabet_my_bet_history', JSON.stringify(this.userBetHistoryList().slice(0, 50)));
    } catch {}
  }

  public recordUserBetHistory(betAmount: number, multiplier: number, win: number, cashedOut: boolean) {
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const dateStr = `${now.getFullYear().toString().slice(-2)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    const newRecord: UserBetHistoryItem = {
      id: `mybet-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      time: timeStr,
      date: dateStr,
      bet: betAmount,
      multiplier: Math.max(1.00, multiplier),
      win: cashedOut ? win : 0,
      cashedOut,
      rawTimestamp: Date.now(),
    };

    this.userBetHistoryList.update(list => [newRecord, ...list].slice(0, 60));
    this.saveUserBetHistory();
  }

  public loadMoreHistory() {
    this.betHistoryLimit.update(lim => lim + 10);
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const dateStr = `${now.getFullYear().toString().slice(-2)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const extra: UserBetHistoryItem[] = [
      { id: `gen-${Date.now()}-1`, time: '06:48', date: dateStr, bet: 10.00, multiplier: 1.02, win: 10.20, cashedOut: true, rawTimestamp: Date.now() - 900000 },
      { id: `gen-${Date.now()}-2`, time: '06:46', date: dateStr, bet: 10.00, multiplier: 1.15, win: 11.50, cashedOut: true, rawTimestamp: Date.now() - 1000000 },
      { id: `gen-${Date.now()}-3`, time: '06:44', date: dateStr, bet: 10.00, multiplier: 1.00, win: 0, cashedOut: false, rawTimestamp: Date.now() - 1100000 },
      { id: `gen-${Date.now()}-4`, time: '06:42', date: dateStr, bet: 10.00, multiplier: 1.05, win: 10.50, cashedOut: true, rawTimestamp: Date.now() - 1200000 },
    ];
    this.userBetHistoryList.update(list => [...list, ...extra]);
    this.saveUserBetHistory();
  }

  public shareBetToChat(item: UserBetHistoryItem) {
    if (item.cashedOut && item.win > 0) {
      this.chatDraft.set(`I just won ${item.win.toFixed(2)} KES at ${item.multiplier.toFixed(2)}x! 🚀`);
    } else {
      this.chatDraft.set(`Just played a round at ${item.multiplier.toFixed(2)}x! 🔥`);
    }
    if (!this.chatOpen()) {
      this.chatOpen.set(true);
      this.gameSocket.openChat();
    }
    this.showToast('Bet copied to chat draft!');
  }

  public openHistoryModal() {
    this.showHistoryModal.set(true);
  }

  public navigateToAdmin() {
    this.showProfileDropdown.set(false);
    this.router.navigate(['/admin']);
  }

  public setWalletTab(tab: 'deposit' | 'withdraw' | 'transactions') {
    this.walletTab.set(tab);
    if (tab === 'transactions') {
      this.loadTransactionsHistory();
    }
  }

  public loadTransactionsHistory() {
    this.isLoadingTransactions = true;
    this.authService.getTransactionHistory().subscribe({
      next: (res) => {
        this.transactionHistory = res.transactions || [];
        this.isLoadingTransactions = false;
      },
      error: () => {
        this.isLoadingTransactions = false;
      }
    });
  }

  /** Open the standalone, scrollable deposit page instead of a game overlay. */
  public openWalletModal() {
    localStorage.setItem('walletReturnUrl', '/play');
    this.router.navigate(['/deposit'], { state: { returnUrl: '/play' } });
  }

  /** Reset M-Pesa state when switching to deposit tab */
  public resetMpesaState() {
    this.mpesaStatus.set('idle');
    this.mpesaStatusMsg.set('');
    this.mpesaReceipt.set('');
    this.mpesaCheckoutRequestId = '';
  }

  public formatCooldown(totalSeconds: number): string {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  public startDepositCooldown(seconds: number): void {
    this.clearDepositCooldownTimer();
    this.depositCooldownSeconds.set(Math.max(1, Math.ceil(seconds)));
    this.depositCooldownTimer = setInterval(() => {
      if (this.depositCooldownSeconds() > 1) {
        this.depositCooldownSeconds.update(s => s - 1);
      } else {
        this.depositCooldownSeconds.set(0);
        this.clearDepositCooldownTimer();
        if (this.mpesaStatus() === 'failed' && this.mpesaStatusMsg().includes('rapid')) {
          this.mpesaStatus.set('idle');
          this.mpesaStatusMsg.set('');
        }
      }
    }, 1000);
  }

  public clearDepositCooldownTimer(): void {
    if (this.depositCooldownTimer) {
      clearInterval(this.depositCooldownTimer);
      this.depositCooldownTimer = null;
    }
  }

  public adjustDepositAmount(delta: number) {
    const current = this.depositVal() || 0;
    this.depositVal.set(Math.max(this.minDepositAmount(), current + delta));
    // Deselect any preset when manually adjusting
    this.depositSelectedPreset.set(null);
    this.depositPresetTapCount.set(0);
  }

  public setDepositAmount(amount: number) {
    this.depositVal.set(amount);
  }

  /** Tap once: set amount to preset. Tap again: multiply by tap count. */
  public selectDepositPreset(preset: number) {
    if (this.depositSelectedPreset() === preset) {
      const newTapCount = this.depositPresetTapCount() + 1;
      this.depositPresetTapCount.set(newTapCount);
      this.depositVal.set(preset * newTapCount);
    } else {
      this.depositSelectedPreset.set(preset);
      this.depositPresetTapCount.set(1);
      this.depositVal.set(preset);
    }
  }

  public addDepositAmount(val: number) {
    const current = this.depositVal() || 0;
    this.depositVal.set(current + val);
  }

  public adjustWithdrawAmount(delta: number) {
    const current = this.withdrawVal() || 0;
    this.withdrawVal.set(Math.max(10, current + delta));
    this.withdrawSelectedPreset.set(null);
    this.withdrawPresetTapCount.set(0);
  }

  public selectWithdrawPreset(preset: number) {
    if (this.withdrawSelectedPreset() === preset) {
      const newTapCount = this.withdrawPresetTapCount() + 1;
      this.withdrawPresetTapCount.set(newTapCount);
      this.withdrawVal.set(preset * newTapCount);
    } else {
      this.withdrawSelectedPreset.set(preset);
      this.withdrawPresetTapCount.set(1);
      this.withdrawVal.set(preset);
    }
  }

  public addWithdrawAmount(val: number) {
    const current = this.withdrawVal() || 0;
    this.withdrawVal.set(current + val);
  }

  private mpesaPollingInterval: any = null;

  public submitDeposit() {
    if (this.depositCooldownSeconds() > 0) {
      const waitMsg = `Too many rapid deposit prompts. Please wait ${this.formatCooldown(this.depositCooldownSeconds())} before trying again.`;
      this.showToast(waitMsg, true);
      this.mpesaStatus.set('failed');
      this.mpesaStatusMsg.set(waitMsg);
      return;
    }
    const amount = this.depositVal();
    const minDeposit = this.minDepositAmount();
    if (isNaN(amount) || amount < minDeposit) {
      this.showToast(`Minimum deposit is KES ${minDeposit.toLocaleString()}`, true);
      return;
    }
    const maxDeposit = this.maxDepositAmount();
    if (amount > maxDeposit) {
      const maxMsg = `Maximum deposit amount is KES ${maxDeposit.toLocaleString()} per transaction.`;
      this.showToast(maxMsg, true);
      this.mpesaStatus.set('failed');
      this.mpesaStatusMsg.set(maxMsg);
      return;
    }

    const rawPhone = this.mpesaPhone() || this.currentUser()?.phone_number || '';
    const cleanDigits = rawPhone.replace(/\D/g, '').replace(/^(254|0)+/, '');
    if (!cleanDigits || cleanDigits.length < 9) {
      this.showToast('Please enter a valid phone number for the M-Pesa prompt.', true);
      return;
    }
    const phone = `254${cleanDigits}`;

    this.mpesaStatus.set('sending');
    this.mpesaStatusMsg.set('Initiating M-Pesa STK Push...');

    this.authService.initiateMpesaSTKPush(amount, phone).pipe(
      finalize(() => {
        if (this.mpesaStatus() === 'sending') {
          this.mpesaStatus.set('idle');
        }
      })
    ).subscribe({
      next: (res) => {
        this.mpesaCheckoutRequestId = res.checkoutRequestId;
        this.mpesaStatus.set('idle');
        this.mpesaStatusMsg.set(`📱 Check phone (${phone})! Enter your M-Pesa PIN to confirm KES ${amount}.`);
        this.loadTransactionsHistory();
        this.startMpesaStatusPolling();
      },
      error: (err: any) => {
        this.mpesaStatus.set('failed');
        const msg = typeof err === 'string' ? err : (err?.message || 'STK Push failed.');
        this.mpesaStatusMsg.set(this.friendlyPaymentError(msg));
        if (err?.code === 'RATE_LIMIT_COOLDOWN' || err?.retryAfterSeconds || err?.status === 429) {
          const cooldownSec = Number(err?.retryAfterSeconds) || 600;
          this.startDepositCooldown(cooldownSec);
        }
      }
    });
  }

  private startMpesaStatusPolling() {
    if (this.mpesaPollingInterval) {
      clearInterval(this.mpesaPollingInterval);
    }

    const reqId = this.mpesaCheckoutRequestId;
    let pollCount = 0;
    this.mpesaPollingInterval = setInterval(() => {
      pollCount++;
      if (this.mpesaStatus() !== 'waiting' || pollCount > 30) {
        clearInterval(this.mpesaPollingInterval);
        this.mpesaPollingInterval = null;
        if (pollCount > 30 && this.mpesaStatus() === 'waiting') {
          this.mpesaStatus.set('failed');
          this.mpesaStatusMsg.set('❌ M-Pesa payment prompt timed out.');
          this.showToast('M-Pesa payment prompt timed out.', true);
        }
        return;
      }

      if (reqId) {
        this.authService.checkMpesaStatus(reqId).subscribe({
          next: (res) => {
            if (res.status === 'completed') {
              this.mpesaStatus.set('success');
              if (res.balance !== undefined) this.authService.updateBalance(Number(res.balance));
              this.showToast('💰 M-Pesa deposit confirmed!');
              clearInterval(this.mpesaPollingInterval);
              this.mpesaPollingInterval = null;
            } else if (res.status === 'failed') {
              this.mpesaStatus.set('failed');
              this.mpesaStatusMsg.set(`❌ ${res.reason || 'Payment failed or was cancelled.'}`);
              clearInterval(this.mpesaPollingInterval);
              this.mpesaPollingInterval = null;
            }
          },
          error: () => undefined
        });
      }
    }, 1500);
  }

  public cancelPendingStk() {
    const reqId = this.mpesaCheckoutRequestId;
    if (reqId) {
      this.authService.cancelPendingMpesa(reqId).subscribe({
        next: () => {
          this.resetMpesaState();
          this.showToast('M-Pesa STK request cancelled.');
          this.loadTransactionsHistory();
        },
        error: () => {
          this.resetMpesaState();
          this.loadTransactionsHistory();
        }
      });
    } else {
      this.resetMpesaState();
    }
  }

  public submitWithdraw() {
    const val = this.withdrawVal();
    if (this.isSubmittingWithdrawal()) return;
    if (val < 200) {
      this.showToast('Minimum withdrawal is 200 KES', true);
      return;
    }
    const phone = this.mpesaPhone() || this.currentUser()?.phone_number || '';
    this.isSubmittingWithdrawal.set(true);
    this.authService.withdraw(val, phone).subscribe({
      next: (res) => {
        const notification = typeof res.notification === 'string'
          ? {
              id: Date.now(),
              title: 'Withdrawal Notice',
              message: res.notification,
              type: res.status === 'completed' ? 'completed' : 'pending',
              createdAt: new Date().toISOString()
            }
          : res.notification;
        // Keep the modal open and on the withdraw tab so player sees admin-edited notification
        this.walletTab.set('withdraw');
        this.showWithdrawalNotification(notification);
        this.loadTransactionsHistory();
        // Close the modal after the notification auto-dismisses (6s)
        setTimeout(() => this.showWalletModal.set(false), 6000);
        this.isSubmittingWithdrawal.set(false);
      },
      error: (message: string) => {
        this.showToast(message || 'Withdrawal could not be completed.', true);
        // An insufficient-balance request is recorded server-side as failed.
        this.transactionHistoryTab.set('withdrawal');
        this.loadTransactionsHistory();
        this.isSubmittingWithdrawal.set(false);
      }
    });
  }

  public goBack() {
    this.router.navigate(['/bets']);
  }


  public toggleProfileDropdown() {
    this.showProfileDropdown.update(v => !v);
  }

  public closeProfileDropdown() {
    this.showProfileDropdown.set(false);
  }

  public openDepositFromProfile() {
    this.showProfileDropdown.set(false);
    localStorage.setItem('walletReturnUrl', '/play');
    this.router.navigate(['/deposit'], { state: { returnUrl: '/play' } });
  }

  public openWalletPage() {
    localStorage.setItem('walletReturnUrl', '/play');
    this.router.navigate(['/wallet'], { state: { returnUrl: '/play' } });
  }

  public openWithdrawFromProfile() {
    this.showProfileDropdown.set(false);
    localStorage.setItem('walletReturnUrl', '/play');
    this.router.navigate(['/withdraw'], { state: { returnUrl: '/play' } });
  }

  public claimBonus() {
    this.claimWelcomeBonus();
  }

  private friendlyPaymentError(message: string): string {
    const detail = String(message || '').trim();
    if (/endpoint not found|stk push failed|payhero/i.test(detail)) {
      return 'M-Pesa is temporarily unavailable. No payment request was sent. Please try again shortly.';
    }
    if (/unauthorized|log in/i.test(detail)) {
      return 'Your session has expired. Log in again, then retry the deposit.';
    }
    return detail || 'We could not start the M-Pesa request. Please try again.';
  }

  public logout() {
    this.showProfileDropdown.set(false);
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  public toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  public showToast(msg: string, isError = false) {
    this.toastMessage.set(msg);
    this.isToastError.set(isError);
    setTimeout(() => {
      if (this.toastMessage() === msg) {
        this.toastMessage.set(null);
      }
    }, 4000);
  }
}
