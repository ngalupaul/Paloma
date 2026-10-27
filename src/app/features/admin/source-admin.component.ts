import { PayheroTokensComponent } from './payhero-tokens.component';
import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { Subscription, forkJoin } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { API_BASE_URL } from '../../core/config/api-url';
import { AdminSocketService } from '../../core/services/admin-socket';
import { GameSocketService } from '../../core/services/game-socket.service';

type Tab = 'overview' | 'live' | 'transactions' | 'users' | 'leaderboard' | 'settings';
type BalanceMode = 'set' | 'add' | 'subtract';
interface AdminUser { id: string; username: string; email?: string; phone?: string; balance: string | number; depositCount: number; totalDeposited: number; role: string; isActive: boolean; createdAt: string; withdrawPopupTitleOverride?: string | null; withdrawPopupMessageOverride?: string | null; }
interface AdminTransaction { id: string; userId: string; type: string; amount: string | number; status: string; createdAt: string; phone?: string; username?: string; reference?: string; externalReference?: string; mpesa_receipt_number?: string; }
interface AdminStats { totalRounds: number; totalBets: number; totalWagered: number; totalPayouts: number; averageCrashPoint: number; connectedClients: number; currentMultiplier: number; currentPhase: string; roundNumber: number; }
interface GameSettings { minBet: number; maxBet: number; minDepositAmount?: number; maxDepositAmount?: number; bettingDuration: number; multiplierSpeed: number; houseEdge: number; }
interface WithdrawalPopupSettings { withdrawPopupTitle?: string; withdrawPopupMessage: string; withdrawPopupEnabled: boolean; withdrawPopupTTL: number; mpesaCodePrefix?: string; }
interface FinancialSummary { today: { deposits: number; withdrawals: number; pending: number; failed: number }; totalPlayerBalances: number; gameProfit: number; totalWagered: number; totalPayouts: number; crashHistory: number[]; }
interface OnlinePlayer { userId: string; username: string; phone?: string | null; email?: string | null; balance: string | number; depositCount: number; totalDeposited: number; role: string; isActive: boolean; connectedAt?: string | null; socketId: string; }
interface RoundHistory { history: Array<{ round: number; crashPoint: number }>; }
interface LeaderboardPlayer { rank: number; username: string; phone?: string; balance: number; totalDeposited: number; totalWagered: number; totalWon: number; }

@Component({
  selector: 'app-source-admin',
  standalone: true,
  imports: [CommonModule, FormsModule, PayheroTokensComponent],
  styles: [`
    :host {
      --bg: #090b10;
      --bg-alt: #0e121a;
      --panel: #121622;
      --panel-alt: #171d2b;
      --border: rgba(255, 255, 255, 0.08);
      --border-soft: rgba(255, 255, 255, 0.045);
      --border-focus: #6366f1;
      --text: #f8fafc;
      --text-dim: #94a3b8;
      --text-faint: #64748b;
      --primary: #6366f1;
      --primary-dark: #4f46e5;
      --primary-soft: rgba(99, 102, 241, 0.14);
      --cyan: #06b6d4;
      --cyan-soft: rgba(6, 182, 212, 0.12);
      --green: #10b981;
      --green-soft: rgba(16, 185, 129, 0.14);
      --red: #f43f5e;
      --red-soft: rgba(244, 63, 94, 0.14);
      --amber: #f59e0b;
      --amber-soft: rgba(245, 158, 11, 0.14);
      
      display: block;
      min-height: 100vh;
      background: var(--bg);
      background-image: radial-gradient(circle at 50% 0%, rgba(99, 102, 241, 0.04) 0%, transparent 55%),
                        radial-gradient(circle at 100% 100%, rgba(6, 182, 212, 0.03) 0%, transparent 45%);
      color: var(--text);
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      line-height: 1.5;
    }

    .admin {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    * {
      box-sizing: border-box;
      -webkit-font-smoothing: inherit;
    }

    /* TOPBAR */
    .topbar {
      display: flex;
      align-items: center;
      gap: 16px;
      min-height: 64px;
      padding: 0 24px;
      background: rgba(14, 18, 26, 0.85);
      backdrop-filter: blur(14px);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 50;
    }

    .brand-mark {
      display: grid;
      place-items: center;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: var(--text);
      color: var(--bg);
      font-weight: 900;
      font-size: 11px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }

    .brand {
      font-size: 18px;
      font-weight: 900;
      letter-spacing: -0.3px;
      color: #fff;
      display: flex;
      align-items: center;
    }

    .brand small {
      margin-left: 8px;
      padding: 2px 7px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-dim);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0;
    }

    .super {
      border-radius: 6px;
      background: linear-gradient(135deg, #f59e0b, #d97706);
      color: #fff;
      padding: 3px 8px;
      font-size: 10px;
      font-weight: 900;
      letter-spacing: 0.5px;
      box-shadow: 0 2px 6px rgba(245, 158, 11, 0.3);
    }

    .live-summary {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 12px;
      color: var(--text-dim);
      font-size: 13px;
    }

    .phase {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.4px;
      background: var(--panel-alt);
      border: 1px solid var(--border);
    }

    .phase.betting {
      color: var(--amber);
      border-color: rgba(245, 158, 11, 0.3);
      background: var(--amber-soft);
    }

    .phase.flying {
      color: var(--green);
      border-color: rgba(16, 185, 129, 0.3);
      background: var(--green-soft);
    }

    .phase.crashed {
      color: var(--red);
      border-color: rgba(244, 63, 94, 0.3);
      background: var(--red-soft);
    }

    .divider {
      width: 1px;
      height: 18px;
      background: var(--border);
    }

    .game-link {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel-alt);
      color: var(--text-dim);
      padding: 7px 14px;
      font-weight: 700; font-size: 12px; font-family: inherit;
      cursor: pointer;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .game-link:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.15);
    }
.admin-withdraw-btn .ico {
      width: 14px;
      height: 14px;
      display: inline-flex;
    }

    /* TABS */
    .tabs {
      display: flex;
      gap: 6px;
      padding: 8px 24px;
      background: var(--bg-alt);
      border-bottom: 1px solid var(--border-soft);
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }

    .tabs button {
      border: 1px solid transparent;
      border-radius: 8px;
      background: transparent;
      color: var(--text-dim);
      padding: 8px 16px;
      font-weight: 600; font-size: 13px; font-family: inherit;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s ease;
    }

    .tabs button:hover {
      background: rgba(255, 255, 255, 0.04);
      color: #fff;
    }

    .tabs button.active {
      background: var(--panel-alt);
      border-color: rgba(255, 255, 255, 0.12);
      color: #fff;
      font-weight: 700;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
    }

    /* CONTENT LAYOUT */
    .content {
      max-width: 1400px;
      width: 100%;
      margin: 0 auto;
      padding: 24px 28px 48px;
      flex: 1;
    }

    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
    }

    .section-head h1 {
      margin: 0;
      color: #fff;
      font-size: 19px;
      font-weight: 800;
      letter-spacing: -0.2px;
    }

    .section-head p {
      margin: 3px 0 0;
      color: var(--text-faint);
      font-size: 12px;
    }

    .flash {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 18px;
      border: 1px solid rgba(16, 185, 129, 0.3);
      border-radius: 10px;
      background: rgba(16, 185, 129, 0.08);
      color: #6ee7b7;
      padding: 12px 16px;
      font-size: 13px;
      font-weight: 500;
      animation: flashFadeIn 0.25s ease-out;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);
    }

    .flash.error {
      border-color: rgba(244, 63, 94, 0.3);
      background: rgba(244, 63, 94, 0.08);
      color: #fda4af;
    }

    .flash-text {
      flex: 1 1 auto;
      line-height: 1.4;
    }

    .flash-close {
      flex: 0 0 auto;
      background: transparent;
      border: 0;
      color: inherit;
      font-size: 20px;
      line-height: 1;
      padding: 0 4px;
      cursor: pointer;
      opacity: 0.7;
      transition: opacity 0.15s ease;
    }

    .flash-close:hover {
      opacity: 1;
    }

    @keyframes flashFadeIn {
      from { opacity: 0; transform: translateY(-6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* STAT CARDS (OVERVIEW) */
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
    }

    .stat {
      display: flex;
      align-items: center;
      gap: 15px;
      min-height: 80px;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: linear-gradient(180deg, var(--panel) 0%, #0e121a 100%);
      padding: 16px 18px;
      box-shadow: 0 4px 16px -2px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.03);
      transition: all 0.2s ease;
    }

    .stat:hover {
      border-color: rgba(255, 255, 255, 0.14);
      transform: translateY(-1px);
    }

    .stat-icon {
      display: grid;
      place-items: center;
      width: 42px;
      height: 42px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.06);
      font-size: 20px;
      flex-shrink: 0;
    }

    .stat-label {
      display: block;
      color: var(--text-dim);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }

    .stat strong {
      display: block;
      margin-top: 3px;
      color: #fff;
      font-size: 19px;
      font-weight: 800;
      letter-spacing: -0.3px;
    }

    .stat.blue { border-left: 3px solid #3b82f6; }
    .stat.pink { border-left: 3px solid #ec4899; }
    .stat.gold { border-left: 3px solid var(--amber); }
    .stat.red { border-left: 3px solid var(--red); }
    .stat.green { border-left: 3px solid var(--green); }
    .stat.cyan { border-left: 3px solid var(--cyan); }

    /* PREDICTOR HERO & MONITOR */
    .monitor-grid {
      display: grid;
      grid-template-columns: 1.25fr 1fr;
      gap: 16px;
    }

    /* Predictor sits beside the admin crash setter, centred as a pair */
    .predictor-row {
      display: flex;
      flex-wrap: wrap;
      align-items: stretch;
      justify-content: center;
      gap: 14px;
      margin-bottom: 18px;
    }

    .crash-setter {
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 8px;
      padding: 14px 18px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background: var(--panel);
      box-shadow: 0 8px 32px -4px rgba(0, 0, 0, 0.45);
    }

    .crash-setter-head {
      display: flex;
      align-items: center;
      gap: 7px;
      color: var(--primary);
    }

    .crash-setter-head small {
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.6px;
      text-transform: uppercase;
    }

    .crash-setter-status {
      font-size: 12px;
      color: var(--text-faint);
    }

    .crash-setter-status.armed {
      color: var(--green);
    }

    .crash-setter-status strong {
      font: 800 14px ui-monospace, SFMono-Regular, Consolas, monospace;
    }

    .crash-setter-controls {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .crash-setter-controls select,
    .crash-setter-controls input {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #090c12;
      color: #fff;
      padding: 7px 9px;
      font-size: 12px; font-family: inherit;
    }

    .crash-setter-controls select { width: 88px; }
    .crash-setter-controls input { width: 78px; }

    .crash-setter-controls select:focus,
    .crash-setter-controls input:focus {
      outline: none;
      border-color: var(--border-focus);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
    }

    .crash-setter-controls .action:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .crash-setter-note {
      margin: 0;
      color: var(--text-faint);
      font-size: 10.5px;
    }

    .predictor-hero {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 16px;
      width: max-content;
      max-width: 100%;
      margin: 0;
      padding: 16px 26px;
      border-radius: 16px;
      border: 1px solid rgba(244, 63, 94, 0.4);
      background: linear-gradient(135deg, rgba(244, 63, 94, 0.14) 0%, rgba(14, 18, 26, 0.95) 80%);
      box-shadow: 0 8px 32px -4px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(244, 63, 94, 0.08);
      overflow: hidden;
      text-align: left;
    }

    .predictor-hero-icon {
      display: grid;
      place-items: center;
      width: 58px;
      height: 58px;
      flex-shrink: 0;
      border-radius: 14px;
      background: rgba(244, 63, 94, 0.18);
      border: 1px solid rgba(244, 63, 94, 0.4);
      font-size: 26px;
      animation: predictor-pulse 2.4s ease-in-out infinite;
    }

    .predictor-hero-body small {
      display: block;
      color: #fb7185;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.6px;
      text-transform: uppercase;
    }

    .predictor-hero-body strong {
      display: block;
      margin: 4px 0 3px;
      font-size: 36px;
      font-weight: 900;
      color: #fff;
      text-shadow: 0 0 24px rgba(244, 63, 94, 0.4);
      letter-spacing: -0.5px;
    }

    .predictor-hero-body p {
      margin: 0;
      color: var(--text-dim);
      font-size: 13px;
    }

    @keyframes predictor-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(244, 63, 94, 0.4); }
      50% { box-shadow: 0 0 0 10px rgba(244, 63, 94, 0); }
    }

    .monitor-stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
      margin-bottom: 16px;
    }

    .monitor-stat {
      border: 1px solid var(--border);
      border-radius: 14px;
      background: var(--panel);
      padding: 16px;
      text-align: center;
      box-shadow: 0 4px 16px -2px rgba(0, 0, 0, 0.3);
    }

    .monitor-stat small {
      display: block;
      color: var(--text-dim);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }

    .monitor-stat strong {
      display: block;
      margin: 8px 0 4px;
      font-size: 24px;
      font-weight: 800;
      color: #fff;
    }

    .monitor-stat p {
      margin: 0;
      color: var(--text-faint);
      font-size: 12px;
    }

    /* PANELS & LISTS */
    .panel {
      border: 1px solid var(--border);
      border-radius: 14px;
      background: var(--panel);
      box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.03);
      overflow: hidden;
    }

    .panel-title {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-soft);
      color: #fff;
      font-size: 14px;
      font-weight: 800;
      letter-spacing: -0.1px;
    }

    .online-list {
      padding: 8px 12px;
      max-height: 500px;
      overflow-y: auto;
    }

    .online-row {
      display: grid;
      grid-template-columns: minmax(180px, 1.25fr) minmax(140px, 1fr) auto;
      align-items: center;
      gap: 14px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border-soft);
      transition: background-color 0.15s ease;
      border-radius: 8px;
    }

    .online-row:hover {
      background: rgba(255, 255, 255, 0.025);
    }

    .online-row:last-child {
      border-bottom: 0;
    }

    .online-name {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 700;
      font-size: 13px;
      color: #fff;
    }

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 0 3px var(--green-soft);
    }

    .online-detail {
      margin-top: 3px;
      color: var(--text-faint);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .online-meta {
      color: var(--text-dim);
      font-size: 11px;
      line-height: 1.5;
    }

    .online-money {
      text-align: right;
      color: var(--green);
      font: 800 13px ui-monospace, SFMono-Regular, Consolas, monospace;
    }

    .role {
      display: inline-block;
      margin-left: 6px;
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-dim);
      padding: 2px 6px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.4px;
    }

    .history {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 18px;
      max-height: 500px;
      overflow-y: auto;
    }

    .history-pill {
      min-width: 60px;
      border-radius: 8px;
      background: var(--panel-alt);
      border: 1px solid var(--border-soft);
      color: var(--text-dim);
      padding: 8px 10px;
      text-align: center;
      font: 800 12.5px ui-monospace, SFMono-Regular, Consolas, monospace;
      transition: transform 0.15s ease;
    }

    .history-pill:hover {
      transform: scale(1.05);
    }

    .history-pill.high {
      color: #c084fc;
      border-color: rgba(192, 132, 252, 0.3);
      background: rgba(192, 132, 252, 0.1);
    }

    .history-pill.low {
      color: #fb7185;
      border-color: rgba(251, 113, 133, 0.3);
      background: rgba(251, 113, 133, 0.1);
    }

    /* TABLES */
    .table-panel {
      overflow: auto;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: var(--panel);
      box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.35);
    }

    .table-tools {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .table-tools input {
      width: 240px;
      max-width: 40vw;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #090c12;
      color: #fff;
      padding: 8px 12px;
      font-size: 13px; font-family: inherit;
      transition: border-color 0.15s ease;
    }

    .table-tools input:focus {
      outline: none;
      border-color: var(--border-focus);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
    }

    .table-tools button, .action {
      border: 1px solid var(--border);
      border-radius: 7px;
      background: var(--panel-alt);
      color: var(--text);
      padding: 8px 12px;
      font-weight: 700; font-size: 11px; font-family: inherit;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .table-tools button:hover, .action:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.16);
    }

    .action.primary {
      background: var(--primary-soft);
      border-color: rgba(99, 102, 241, 0.4);
      color: #c7d2fe;
    }

    .action.primary:hover {
      background: var(--primary);
      color: #fff;
    }

    .action.warn {
      background: var(--red-soft);
      border-color: rgba(244, 63, 94, 0.4);
      color: #fecdd3;
    }

    .action.warn:hover {
      background: var(--red);
      color: #fff;
    }

    .action.gold {
      background: var(--amber-soft);
      border-color: rgba(245, 158, 11, 0.4);
      color: #fef3c7;
    }

    .action.gold:hover {
      background: var(--amber);
      color: #111;
    }

    .action.info {
      background: var(--cyan-soft);
      border-color: rgba(6, 182, 212, 0.4);
      color: #a5f3fc;
    }

    .action.info:hover {
      background: var(--cyan);
      color: #05242b;
    }

    /* Status dot that replaced the bullet glyph in the topbar phase pill */
    .phase-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      flex: 0 0 auto;
    }

    .action.create-user {
      background: var(--green-soft);
      border-color: rgba(16, 185, 129, 0.45);
      color: #6ee7b7;
    }

    .action.create-user:hover {
      background: var(--green);
      color: #042f1a;
    }

    .balance-close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      font-size: 15px;
    }

    /* Inline SVG icons: sized in em so they track the text they sit beside */
    .ico {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      width: 1.15em;
      height: 1.15em;
      vertical-align: -0.18em;
    }

    .ico svg {
      width: 100%;
      height: 100%;
      display: block;
    }

    .tabs button, .action, .table-tools button, .game-link, .save, .editor-actions button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }

    .section-head h1 {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }

    .stat-icon .ico {
      width: 1em;
      height: 1em;
    }

    .predictor-hero-icon .ico {
      width: 24px;
      height: 24px;
      color: #fb7185;
    }

    /* Row actions stay on one line; the table itself scrolls if space runs out */
    .actions .action {
      flex: 0 0 auto;
      white-space: nowrap;
      padding: 7px 11px;
      border-radius: 8px;
      font-weight: 700; font-size: 11.5px; font-family: inherit;
    }

    /* Desktop table default: visible on laptop/desktop */
    table {
      width: 100%;
      min-width: 960px;
      border-collapse: collapse;
      text-align: left;
    }

    .btn-text-full { display: inline; }
    .btn-text-short { display: none; }
    .tx-action-col { display: table-cell; }
    .tx-date { display: inline; }
    .tx-hour { display: inline; margin-left: 4px; color: var(--text-faint); }

    /* Search input and button kept strictly on the same line */
    .search-input-group {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1 1 auto;
      min-width: 0;
    }

    .search-input-group input {
      flex: 1 1 auto;
      min-width: 0;
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #090c12;
      color: #fff;
      padding: 8px 12px;
      font-size: 13px;
      font-family: inherit;
      transition: border-color 0.15s ease;
    }

    .search-input-group input:focus {
      outline: none;
      border-color: var(--border-focus);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
    }

    .search-input-group .search-btn {
      flex: 0 0 auto;
      white-space: nowrap;
    }

    .tx-tools, .user-tools {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      width: 100%;
    }

    .tx-action-btns {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* Small screens / mobile phone view: straight compact table */
    @media (max-width: 820px) {
      .btn-text-full { display: none; }
      .btn-text-short { display: inline; }

      .tx-table-panel {
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
      }

      table.tx-table {
        min-width: 100% !important;
        width: 100% !important;
        table-layout: auto;
      }

      table.tx-table th, table.tx-table td {
        padding: 7px 4px !important;
        font-size: 9.5px !important;
      }

      table.tx-table th {
        font-size: 8.5px !important;
        padding: 7px 4px !important;
        letter-spacing: 0;
      }

      /* Hide actions column on mobile to provide space */
      .tx-action-col {
        display: none !important;
      }

      /* Stack time under date */
      .tx-time-cell {
        display: flex;
        flex-direction: column;
        line-height: 1.25;
        font-size: 8.5px !important;
        white-space: nowrap;
      }

      .tx-date {
        display: block !important;
        font-size: 8.5px !important;
        color: var(--text);
        white-space: nowrap;
      }

      .tx-hour {
        display: block !important;
        font-size: 8px !important;
        color: var(--text-faint);
        margin-left: 0 !important;
        white-space: nowrap;
      }

      /* Whole mobile number visible without truncation */
      .tx-player-cell {
        font-size: 9.5px !important;
        white-space: nowrap !important;
        max-width: none !important;
        overflow: visible !important;
        text-overflow: clip !important;
      }

      .tx-amount-cell {
        font-size: 9.5px !important;
        font-weight: 700;
        white-space: nowrap;
      }

      .tx-status-cell .badge {
        font-size: 8px !important;
        padding: 2px 4px !important;
      }

      .tx-status-cell .badge-dot {
        width: 4px;
        height: 4px;
      }

      .tx-ref-cell {
        font-size: 8.5px !important;
        max-width: 55px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .tx-receipt-cell {
        font-size: 8.5px !important;
        max-width: 45px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .tx-recheck-btn {
        padding: 3px 6px !important;
        font-size: 8.5px !important;
        white-space: nowrap;
      }

      .tx-recheck-btn .ico {
        display: none !important;
      }

      .tx-tools, .user-tools {
        flex-direction: column;
        align-items: stretch;
        gap: 8px;
      }

      .search-input-group {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 6px;
        width: 100%;
      }

      .search-input-group input {
        flex: 1 1 auto;
        min-width: 0;
        width: 100%;
      }

      .search-input-group .search-btn {
        flex: 0 0 auto;
        white-space: nowrap;
      }

      .tx-action-btns {
        display: flex;
        width: 100%;
        gap: 8px;
      }

      .tx-action-btns button {
        flex: 1;
        justify-content: center;
      }

      .user-tools .action.create-user {
        width: 100%;
        justify-content: center;
      }
    }

    th, td {
      border-bottom: 1px solid var(--border-soft);
      padding: 13px 16px;
      font-size: 13px;
    }

    th {
      background: var(--bg-alt);
      color: var(--text-faint);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      border-bottom: 1px solid var(--border);
    }

    td {
      color: var(--text);
    }

    tbody tr {
      transition: background-color 0.15s ease;
    }

    tbody tr:hover {
      background: rgba(255, 255, 255, 0.025);
    }

    tbody tr:last-child td {
      border-bottom: 0;
    }

    .user-name {
      color: #fff;
      font-weight: 700;
      font-size: 13px;
    }

    .sub {
      display: block;
      margin-top: 2px;
      color: var(--text-faint);
      font-size: 11px;
    }

    .money {
      color: var(--green);
      font: 800 13px ui-monospace, SFMono-Regular, Consolas, monospace;
    }

    .code {
      color: var(--text-dim);
      font: 12px ui-monospace, SFMono-Regular, Consolas, monospace;
      letter-spacing: 0.2px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 20px;
      border: 1px solid rgba(16, 185, 129, 0.3);
      background: var(--green-soft);
      color: var(--green);
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.3px;
      text-transform: uppercase;
    }

    .badge-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }

    .badge.failed {
      background: var(--red-soft);
      border-color: rgba(244, 63, 94, 0.3);
      color: #fb7185;
    }

    .badge.pending {
      background: var(--amber-soft);
      border-color: rgba(245, 158, 11, 0.3);
      color: #fbbf24;
    }

    .actions {
      display: flex;
      gap: 6px;
      flex-wrap: nowrap;
      align-items: center;
    }

    /* SETTINGS CARDS */
    .settings-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }

    .settings-card {
      border: 1px solid var(--border);
      border-radius: 14px;
      background: var(--panel);
      padding: 22px 24px;
      box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.35);
    }

    .settings-card h2 {
      margin: 0 0 18px;
      font-size: 16px;
      font-weight: 800;
      color: #fff;
      letter-spacing: -0.2px;
    }

    .fields {
      display: grid;
      gap: 14px;
    }

    .fields label {
      color: var(--text-dim);
      font-size: 12px;
      font-weight: 700;
    }

    .fields input, .fields textarea {
      box-sizing: border-box;
      width: 100%;
      margin-top: 6px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #090c12;
      color: #fff;
      padding: 10px 12px;
      font-size: 13px; font-family: inherit;
      transition: all 0.15s ease;
    }

    .fields input:focus, .fields textarea:focus {
      outline: none;
      border-color: var(--border-focus);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
    }

    .fields textarea {
      height: 96px;
      resize: vertical;
    }

    .fields .checkbox {
      display: flex;
      align-items: center;
      gap: 10px;
      cursor: pointer;
    }

    .fields .checkbox input {
      width: 16px;
      height: 16px;
      margin: 0;
      cursor: pointer;
      accent-color: var(--primary);
    }

    .save {
      border: 0;
      border-radius: 8px;
      background: linear-gradient(135deg, #10b981, #059669);
      color: #fff;
      padding: 11px 18px;
      font-weight: 800; font-size: 13px; font-family: inherit;
      cursor: pointer;
      transition: all 0.15s ease;
      box-shadow: 0 2px 10px rgba(16, 185, 129, 0.25);
    }

    .save:hover {
      opacity: 0.92;
      transform: translateY(-1px);
    }

    /* MODALS & POPUPS */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: grid;
      place-items: center;
      padding: 20px;
      background: rgba(4, 6, 10, 0.75);
      backdrop-filter: blur(10px);
    }

    .popup-editor {
      width: min(520px, 100%);
      border: 1px solid var(--border);
      border-radius: 14px;
      background: var(--panel);
      padding: 24px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.06);
    }

    .popup-editor h2 {
      margin: 0 0 8px;
      font-size: 17px;
      font-weight: 800;
      color: #fff;
    }

    .popup-editor p {
      margin: 0 0 16px;
      color: var(--text-dim);
      font-size: 13px;
    }

    .popup-editor textarea, .popup-editor input {
      box-sizing: border-box;
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #090c12;
      color: #fff;
      padding: 10px 12px;
      font-size: 13px; font-family: inherit;
    }

    .popup-editor textarea:focus, .popup-editor input:focus {
      outline: none;
      border-color: var(--border-focus);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
    }

    .popup-editor textarea {
      min-height: 110px;
      resize: vertical;
    }

    .popup-editor input {
      margin-top: 6px;
    }

    .balance-editor {
      width: min(500px, 100%);
      border-color: rgba(16, 185, 129, 0.35);
    }

    .balance-editor h2 {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .balance-close {
      border: 0;
      background: transparent;
      color: var(--text-dim);
      font: 500 28px/1 Arial;
      cursor: pointer;
      padding: 0 4px;
    }

    .balance-close:hover {
      color: #fff;
    }

    .balance-current {
      margin: 0 0 16px !important;
      color: var(--text-dim) !important;
      font-size: 13px;
    }

    .balance-current strong {
      color: var(--green);
      font-size: 16px;
      font-weight: 800;
    }

    .balance-modes {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin: 0 0 18px;
    }

    .balance-modes button {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel-alt);
      color: var(--text-dim);
      padding: 10px 6px;
      font-weight: 800; font-size: 13px; font-family: inherit;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .balance-modes button.active {
      background: var(--green);
      border-color: var(--green);
      color: #042f1a;
    }

    .balance-editor label {
      display: block;
      color: var(--text-dim);
      font-size: 12px;
      font-weight: 700;
    }

    .balance-editor .save-popup {
      background: var(--green);
      color: #042f1a;
      font-weight: 800;
    }

    .editor-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 18px;
    }

    .editor-actions button {
      border: 0;
      border-radius: 8px;
      padding: 10px 16px;
      font-weight: 800; font-size: 13px; font-family: inherit;
      cursor: pointer;
      transition: opacity 0.15s ease;
    }

    .editor-actions button:hover {
      opacity: 0.9;
    }

    .editor-actions .cancel {
      background: var(--panel-alt);
      border: 1px solid var(--border);
      color: var(--text);
    }

    .editor-actions .save-popup {
      background: var(--primary);
      color: #fff;
    }

    .balance-editor .editor-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
    }

    .empty {
      padding: 32px 16px;
      color: var(--text-faint);
      text-align: center;
      font-size: 13px;
    }

    /* ---- COMPACT TYPE SCALE (desktop) ---- */
    .brand { font-size: 16px; }
    .brand small { font-size: 10px; padding: 2px 6px; }
    .super { font-size: 9px; padding: 3px 7px; }
    .live-summary { font-size: 12px; gap: 10px; white-space: nowrap; }
    .phase { font-size: 10px; padding: 3px 9px; }
    .game-link { font-weight: 700; font-size: 11px; font-family: inherit; padding: 6px 12px; }
    .tabs button { font-weight: 600; font-size: 12px; font-family: inherit; padding: 7px 13px; }
    .section-head h1 { font-size: 17px; }
    .section-head p { font-size: 11px; }
    .flash { font-size: 12px; padding: 10px 14px; }
    .stat { min-height: 70px; padding: 13px 15px; gap: 12px; }
    .stat-icon { width: 36px; height: 36px; font-size: 17px; }
    .stat-label { font-size: 10px; }
    .stat strong { font-size: 17px; }
    .predictor-hero-body small { font-size: 10px; }
    .predictor-hero-body strong { font-size: 32px; }
    .predictor-hero-body p { font-size: 12px; }
    .monitor-stat { padding: 14px; }
    .monitor-stat small { font-size: 10px; }
    .monitor-stat strong { font-size: 21px; }
    .monitor-stat p { font-size: 11px; }
    .panel-title { font-size: 13px; padding: 14px 18px; }
    .online-name { font-size: 12px; }
    .online-detail { font-size: 10px; }
    .online-meta { font-size: 10px; }
    .online-money { font-size: 12px; }
    .history-pill { font-size: 11.5px; padding: 7px 9px; min-width: 56px; }
    th, td { font-size: 12px; padding: 11px 14px; }
    th { font-size: 10px; }
    .user-name { font-size: 12px; }
    .sub { font-size: 10px; }
    .money { font-size: 12px; }
    .code { font-size: 11px; }
    .badge { font-size: 10px; padding: 3px 9px; }
    .table-tools input { font-size: 12px; padding: 7px 11px; }
    .table-tools button, .action { font-weight: 700; font-size: 11px; font-family: inherit; padding: 7px 11px; }
    .settings-card h2 { font-size: 15px; }
    .fields label { font-size: 11px; }
    .fields input, .fields textarea { font-size: 12px; padding: 9px 11px; }
    .save { font-weight: 800; font-size: 12px; font-family: inherit; padding: 10px 16px; }

    /* Narrower desktops and laptops: tighten the widest table (Users) so its
       action column stops running past the right edge of the window. */
    @media (max-width: 1450px) {
      th, td { padding: 10px 11px; }
      .actions { gap: 4px; }
      .actions .action { padding: 6px 9px; font-weight: 700; font-size: 11px; font-family: inherit; }
      .actions .action .ico { display: none; }
      table { min-width: 820px; }
    }

    @media (max-width: 1150px) {
      th, td { padding: 9px 7px; }
      .actions { gap: 3px; }
      .actions .action { padding: 5px 6px; font-weight: 700; font-size: 10.5px; font-family: inherit; }
      .sub { font-size: 9.5px; }
      .content { padding: 20px 18px 48px; }
    }

    @media (max-width: 900px) {
      .topbar { padding: 0 12px; gap: 8px; min-height: 50px; }
      .tabs { overflow: auto; padding: 6px 12px; gap: 4px; }
      .content { padding: 12px; }
      .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
      .monitor-grid, .settings-grid { grid-template-columns: 1fr; }
      .monitor-stats { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 10px !important; }
      /* The predictor is the one thing that gets bigger on a phone, not
         smaller: it is the number the admin is actually watching. */
      .predictor-row { gap: 10px; }
      .predictor-hero { width: 100%; padding: 18px 20px; gap: 16px; }
      .predictor-hero-icon { width: 54px; height: 54px; }
      .predictor-hero-icon .ico { width: 27px; height: 27px; }
      .predictor-hero-body small { font-size: 10.5px; }
      .predictor-hero-body strong { font-size: 40px; margin: 4px 0 2px; }
      .predictor-hero-body p { font-size: 11.5px; }
      .crash-setter { width: 100%; }
      .online-row { grid-template-columns: 1fr; padding: 10px 12px; }
      .online-money { text-align: left; font-size: 11px; }
      .online-name { font-size: 11.5px; }
      .online-meta, .online-detail { font-size: 9.5px; }
      .live-summary { gap: 6px; font-size: 10px; }
      .brand { font-size: 13px; }
      .brand small, .divider { display: none; }
      .tabs button { font-weight: 600; font-size: 11px; font-family: inherit; padding: 6px 10px; }
      .section-head { margin-bottom: 14px; }
      .section-head h1 { font-size: 14px; }
      .section-head p { font-size: 10px; }
      .stat { min-height: 54px; padding: 10px 12px; gap: 10px; border-radius: 12px; }
      .stat-icon { width: 28px; height: 28px; border-radius: 8px; }
      .stat-label { font-size: 9px; }
      .stat strong { font-size: 14px; }
      .monitor-stat { padding: 12px 10px; border-radius: 12px; }
      .monitor-stat small { font-size: 9px; }
      .monitor-stat strong { font-size: 16px; margin: 6px 0 3px; }
      .monitor-stat p { font-size: 9.5px; }
      .panel-title { font-size: 12px; padding: 12px 14px; }
      th, td { font-size: 10.5px; padding: 9px 10px; }
      th { font-size: 9px; }
      .user-name { font-size: 11px; }
      .sub { font-size: 9px; }
      .money, .code { font-size: 10.5px; }
      .badge { font-size: 9px; padding: 3px 8px; }
      .role { font-size: 8.5px; }
      .history-pill { font-size: 10.5px; padding: 6px 8px; min-width: 50px; }
      .actions .action { font-weight: 700; font-size: 10px; font-family: inherit; padding: 5px 8px; }
      .table-tools button, .action { font-weight: 700; font-size: 10px; font-family: inherit; padding: 6px 9px; }
      .table-tools input { font-size: 11px; padding: 7px 10px; }
      .settings-card { padding: 16px; }
      .settings-card h2 { font-size: 13.5px; margin-bottom: 14px; }
      .fields { gap: 11px; }
      .fields label { font-size: 10.5px; }
      .fields input, .fields textarea { font-size: 11.5px; padding: 8px 10px; }
      .save { font-weight: 800; font-size: 11.5px; font-family: inherit; padding: 9px 14px; }
      .crash-setter { padding: 12px 14px; }
      .crash-setter-head small { font-size: 9px; }
      .crash-setter-status { font-size: 11px; }
      .crash-setter-note { font-size: 9.5px; }
      .flash { font-size: 11px; padding: 9px 12px; }
      .empty { font-size: 11.5px; padding: 24px 14px; }
    }

    @media (max-width: 520px) {
      .topbar { min-height: 46px; }
      .brand { font-size: 12px; }
      .super { display: none; }
      .live-summary { font-size: 9.5px; gap: 5px; }
      .phase { font-size: 8.5px; padding: 3px 7px; }
      .game-link { font-weight: 700; font-size: 9.5px; font-family: inherit; padding: 5px 8px; }
      .stat-grid { grid-template-columns: 1fr; }
      .section-head { align-items: flex-start; gap: 6px; flex-direction: column; }
      .section-head h1 { font-size: 13px; }
      .section-head p { font-size: 9.5px; }
      .monitor-stats { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 8px !important; }
      .monitor-stat { padding: 10px 8px; }
      .monitor-stat small { font-size: 8.5px; }
      .monitor-stat strong { font-size: 14px; }
      .monitor-stat strong.phase { font-size: 12px; padding: 4px 8px; }
      .monitor-stat p { font-size: 9px; }
      .predictor-hero { flex-direction: row; align-items: center; padding: 16px 16px; gap: 14px; }
      .predictor-hero-icon { width: 50px; height: 50px; }
      .predictor-hero-icon .ico { width: 25px; height: 25px; }
      .predictor-hero-body strong { font-size: 36px; }
      .predictor-hero-body small { font-size: 10px; }
      .predictor-hero-body p { font-size: 11px; }
      .panel-title { font-size: 11.5px; padding: 11px 13px; }
      th, td { font-size: 10px; padding: 8px 9px; }
      th { font-size: 8.5px; }
      .money, .code { font-size: 10px; }
      .fields label { font-size: 10px; }
      .fields input, .fields textarea { font-size: 11px; }
      /* Let the Users toolbar wrap instead of forcing the page wider than
         the phone: search box on one line, its buttons underneath. */
      .table-tools { flex-wrap: wrap; width: 100%; }
      .table-tools input { font-size: 11.5px; width: 100%; max-width: 100%; flex: 1 1 100%; }
      .section-head .table-tools button { flex: 1 1 auto; }
    }
  `],
  template: `
    <main class="admin"><header class="topbar"><img src="/assets/icons/palpesabet-mark.png" alt="Palpesabet" style="width:35px;height:35px;border-radius:9px;object-fit:cover;"><div class="brand">Palpesabet <small>Admin Panel</small></div><span class="super">{{ isSuperAdmin ? 'SUPER' : 'ADMIN' }}</span><div class="live-summary"><span class="phase" [class.betting]="stats.currentPhase === 'betting'" [class.flying]="stats.currentPhase === 'flying'" [class.crashed]="stats.currentPhase === 'crashed'"><span class="phase-dot"></span>{{ stats.currentPhase | uppercase }}</span><span class="divider"></span><strong>{{ stats.currentMultiplier | number:'1.2-2' }}x</strong><span class="divider"></span><span>{{ stats.connectedClients }} online</span><button class="game-link" (click)="router.navigate(['/'])"><span class="ico" [innerHTML]="icons.back"></span>Game View</button></div></header>
      <nav class="tabs"><button [class.active]="tab === 'overview'" (click)="selectTab('overview')"><span class="ico" [innerHTML]="icons.dashboard"></span>Dashboard</button><button [class.active]="tab === 'live'" (click)="selectTab('live')"><span class="ico" [innerHTML]="icons.activity"></span>Live Monitor</button><button [class.active]="tab === 'transactions'" (click)="selectTab('transactions')"><span class="ico" [innerHTML]="icons.transactions"></span>Transactions ({{ depositsList.length }})</button><button [class.active]="tab === 'users'" (click)="selectTab('users')"><span class="ico" [innerHTML]="icons.users"></span>Users</button><button [class.active]="tab === 'leaderboard'" (click)="selectTab('leaderboard')"><span class="ico" [innerHTML]="icons.trophy"></span>Leaderboard</button><button [class.active]="tab === 'settings'" (click)="selectTab('settings')"><span class="ico" [innerHTML]="icons.settings"></span>Settings</button></nav>
      <section class="content"><p *ngIf="message" class="flash" [class.error]="isError" (click)="clearMessage()" role="alert" title="Click to dismiss"><span class="flash-text">{{ message }}</span><button type="button" class="flash-close" (click)="clearMessage(); $event.stopPropagation()" aria-label="Dismiss">&times;</button></p>
        <div *ngIf="balanceEditorUser" class="modal-backdrop" role="presentation" (click)="closeBalanceEditor()"><section class="popup-editor balance-editor" role="dialog" aria-modal="true" aria-labelledby="balance-editor-title" (click)="$event.stopPropagation()"><h2 id="balance-editor-title">Edit Balance — {{ balanceEditorUser.username }}<button type="button" class="balance-close" aria-label="Close balance editor" (click)="closeBalanceEditor()"><span class="ico" [innerHTML]="icons.close"></span></button></h2><p class="balance-current">Current: <strong>{{ balanceEditorUser.balance | number:'1.2-2' }} KES</strong></p><div class="balance-modes" aria-label="Balance update mode"><button type="button" [class.active]="balanceEditorMode === 'set'" (click)="selectBalanceMode('set')">Set To</button><button type="button" [class.active]="balanceEditorMode === 'add'" (click)="selectBalanceMode('add')">Add</button><button type="button" [class.active]="balanceEditorMode === 'subtract'" (click)="selectBalanceMode('subtract')">Subtract</button></div><label for="wallet-balance-input">Amount (KES)</label><input id="wallet-balance-input" type="number" min="0" step="0.01" [(ngModel)]="balanceEditorValue" (keyup.enter)="saveBalance()" autofocus><div class="editor-actions"><button type="button" class="cancel" (click)="closeBalanceEditor()">Cancel</button><button type="button" class="save-popup" (click)="saveBalance()">Update</button></div></section></div>
        <div *ngIf="popupEditorUser" class="modal-backdrop" role="presentation" (click)="closeWithdrawPopupEditor()"><section class="popup-editor" role="dialog" aria-modal="true" aria-labelledby="popup-editor-title" (click)="$event.stopPropagation()"><h2 id="popup-editor-title">Withdrawal notice for {{ popupEditorUser.username }}</h2><p>Leave blank to use the saved global withdrawal notice.</p><label style="display:block;margin-bottom:4px;color:#8b9bb0;font-size:11px;font-weight:700;">Heading / Title</label><input [(ngModel)]="popupEditorTitle" placeholder="e.g. Withdrawal Submitted"><label style="display:block;margin:10px 0 4px;color:#8b9bb0;font-size:11px;font-weight:700;">Message</label><textarea [(ngModel)]="popupEditorMessage" maxlength="500" placeholder="Enter a personal withdrawal notice"></textarea><div class="editor-actions"><button type="button" class="cancel" (click)="closeWithdrawPopupEditor()">Cancel</button><button type="button" class="save-popup" (click)="saveUserWithdrawPopup()">Save notice</button></div></section></div>
        <div *ngIf="createUserModalVisible" class="modal-backdrop" role="presentation" (click)="closeCreateAdminModal()"><section class="popup-editor" role="dialog" aria-modal="true" aria-labelledby="create-user-title" (click)="$event.stopPropagation()"><h2 id="create-user-title">Create New Account</h2><label style="display:block;margin-bottom:4px;color:#8b9bb0;font-size:11px;font-weight:700;">Username</label><input [(ngModel)]="newUsername" placeholder="Username (optional)"><label style="display:block;margin:8px 0 4px;color:#8b9bb0;font-size:11px;font-weight:700;">Phone Number *</label><input [(ngModel)]="newPhone" placeholder="e.g. 0712345678 or 254712345678"><label style="display:block;margin:8px 0 4px;color:#8b9bb0;font-size:11px;font-weight:700;">Password * (min 6 chars)</label><input type="password" [(ngModel)]="newPassword" placeholder="Password"><label style="display:block;margin:8px 0 4px;color:#8b9bb0;font-size:11px;font-weight:700;">Role</label><select [(ngModel)]="newRole" style="box-sizing:border-box;width:100%;border:1px solid #30333a;border-radius:7px;background:#090a0c;color:#fff;padding:10px;font-size: 13px; font-family: inherit;"><option value="ADMIN">ADMIN</option><option value="USER">USER (Player)</option></select><div class="editor-actions"><button type="button" class="cancel" (click)="closeCreateAdminModal()">Cancel</button><button type="button" class="save-popup" style="background:#159447;" (click)="saveNewUser()">Create Account</button></div></section></div>
        
        <ng-container *ngIf="tab === 'overview'"><div class="section-head"><h1>Overview</h1><p>Updates every 2 seconds</p></div><div class="stat-grid"><app-payhero-tokens></app-payhero-tokens><article class="stat blue"><span class="stat-icon"><span class="ico" [innerHTML]="icons.rounds"></span></span><div><span class="stat-label">Total rounds</span><strong>{{ stats.totalRounds | number }}</strong></div></article><article class="stat pink"><span class="stat-icon"><span class="ico" [innerHTML]="icons.dice"></span></span><div><span class="stat-label">Total bets</span><strong>{{ stats.totalBets | number }}</strong></div></article><article class="stat gold"><span class="stat-icon"><span class="ico" [innerHTML]="icons.wallet"></span></span><div><span class="stat-label">Total wagered</span><strong>{{ stats.totalWagered | number:'1.0-0' }} KES</strong></div></article><article class="stat red"><span class="stat-icon"><span class="ico" [innerHTML]="icons.trendingDown"></span></span><div><span class="stat-label">House profit</span><strong>{{ financial.gameProfit | number:'1.0-0' }} KES</strong></div></article><article class="stat pink"><span class="stat-icon"><span class="ico" [innerHTML]="icons.plane"></span></span><div><span class="stat-label">Average crash</span><strong>{{ stats.averageCrashPoint | number:'1.2-2' }}x</strong></div></article><article class="stat cyan"><span class="stat-icon"><span class="ico" [innerHTML]="icons.online"></span></span><div><span class="stat-label">Online</span><strong>{{ stats.connectedClients }}</strong></div></article><article class="stat gold"><span class="stat-icon"><span class="ico" [innerHTML]="icons.zap"></span></span><div><span class="stat-label">Phase</span><strong>{{ stats.currentPhase | uppercase }}</strong></div></article><article class="stat green"><span class="stat-icon"><span class="ico" [innerHTML]="icons.trendingUp"></span></span><div><span class="stat-label">Multiplier</span><strong>{{ stats.currentMultiplier | number:'1.2-2' }}x</strong></div></article></div></ng-container>
        <ng-container *ngIf="tab === 'live'"><div class="section-head"><h1><span class="ico" [innerHTML]="icons.activity"></span>Live Monitor</h1><p>Auto-refreshes every 2 seconds · {{ lastUpdated }}</p></div><div class="predictor-row"><article class="predictor-hero" *ngIf="predatorData"><div class="predictor-hero-icon"><span class="ico" [innerHTML]="icons.zap"></span></div><div class="predictor-hero-body"><small>Next Crash — Prediction Engine</small><strong>{{ predatorData.decision?.status === 'locked' && predatorData.decision?.lockedCrashPoint ? (predatorData.decision.lockedCrashPoint | number:'1.2-2') + 'x' : 'Waiting…' }}</strong><p>{{ predatorData.decision?.status === 'locked' ? 'Round #' + predatorData.decision?.roundNumber : (predatorData.decision?.note || 'Waiting for the next round to lock in…') }}</p></div></article><article class="crash-setter"><div class="crash-setter-head"><span class="ico" [innerHTML]="icons.target"></span><small>Set Next Crash</small></div><div class="crash-setter-status" [class.armed]="armedCrashPoint !== null"><ng-container *ngIf="armedCrashPoint !== null">Armed at <strong>{{ armedCrashPoint | number:'1.2-2' }}x</strong></ng-container><ng-container *ngIf="armedCrashPoint === null">Default engine value</ng-container></div><div class="crash-setter-controls"><select [(ngModel)]="crashRoomId" aria-label="Room"><option [ngValue]="1">Room 1</option><option [ngValue]="2">Room 2</option><option [ngValue]="3">Room 3</option></select><input type="number" min="1" step="0.01" placeholder="2.50" [(ngModel)]="crashInput" (keyup.enter)="armNextCrash()" aria-label="Crash point"><button class="action primary" [disabled]="crashBusy" (click)="armNextCrash()">Set</button><button class="action warn" [disabled]="crashBusy || armedCrashPoint === null" (click)="clearNextCrash()">Clear</button></div><p class="crash-setter-note">Applies to the next round only, then returns to default.</p></article></div><div class="monitor-stats"><article class="monitor-stat"><small>Current phase</small><strong class="phase" [class.betting]="(gameSocket.phase$ | async) === 'betting'" [class.flying]="(gameSocket.phase$ | async) === 'flying'" [class.crashed]="(gameSocket.phase$ | async) === 'crashed'">{{ (gameSocket.phase$ | async) | uppercase }}</strong><p>Round #{{ (gameSocket.roundState$ | async)?.roundId || stats.roundNumber }}</p></article><article class="monitor-stat"><small>Live multiplier</small><strong class="phase flying">{{ gameSocket.multiplier$ | async | number:'1.2-2' }}x</strong><p>Average {{ stats.averageCrashPoint | number:'1.2-2' }}x</p></article><article class="monitor-stat"><small>Connected clients</small><strong class="phase cyan">{{ stats.connectedClients }}</strong><p>{{ onlinePlayers.length }} authenticated player{{ onlinePlayers.length === 1 ? '' : 's' }}</p></article></div><div class="monitor-grid"><article class="panel"><div class="panel-title">Online players ({{ onlinePlayers.length }})</div><div class="online-list"><div class="online-row" *ngFor="let player of onlinePlayers"><div><div class="online-name"><span class="dot"></span>{{ player.username }}<span class="role">{{ player.role | uppercase }}</span></div><span class="online-detail">{{ player.phone || 'No phone' }} · {{ player.email || 'No email' }}</span></div><div class="online-meta">ID: {{ player.userId }}<br>Deposits: {{ player.depositCount }} · Total: {{ player.totalDeposited | number:'1.2-2' }} KES</div><div class="online-money">{{ player.balance | number:'1.2-2' }} KES<br><span class="online-detail">{{ player.isActive ? 'Active' : 'Inactive' }}</span></div></div><p *ngIf="!onlinePlayers.length" class="empty">No authenticated players online right now.</p></div></article><article class="panel"><div class="panel-title">Recent crash history</div><div class="history"><span *ngFor="let round of roundHistory" class="history-pill" [class.high]="round.crashPoint >= 10" [class.low]="round.crashPoint <= 1.2">{{ round.crashPoint | number:'1.2-2' }}x</span></div></article></div></ng-container>
        <ng-container *ngIf="tab === 'transactions'">
          <div class="section-head">
            <h1>Transactions ({{ filteredDepositsList.length }})</h1>
            <div class="table-tools tx-tools">
              <div class="search-input-group">
                <input [(ngModel)]="txSearch" placeholder="Search phone, receipt, ref...">
                <button type="button" class="action search-btn" (click)="cdr.detectChanges()"><span class="ico" [innerHTML]="icons.search"></span>Search</button>
              </div>
              <div class="tx-action-btns">
                <button (click)="loadTransactions()"><span class="ico" [innerHTML]="icons.refresh"></span>Refresh</button>
                <button class="action warn" (click)="clearTransactions()"><span class="ico" [innerHTML]="icons.trash"></span>Clear History</button>
              </div>
            </div>
          </div>
          <article class="panel table-panel tx-table-panel">
            <table class="tx-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Player</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Reference</th>
                  <th>Receipt</th>
                  <th class="tx-action-col">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let tx of filteredDepositsList">
                  <td class="tx-time-cell"><span class="tx-date">{{ tx.createdAt | date:'dd MMM' }}</span><span class="tx-hour">{{ tx.createdAt | date:'HH:mm' }}</span></td>
                  <td class="tx-player-cell" [title]="tx.username || tx.userId">{{ tx.username || tx.userId }}</td>
                  <td class="money tx-amount-cell">+{{ tx.amount | number:'1.2-2' }} KES</td>
                  <td class="tx-status-cell">
                    <span class="badge" [class.failed]="tx.status === 'failed'" [class.pending]="tx.status === 'pending'">
                      <span class="badge-dot"></span>{{ tx.status }}
                    </span>
                  </td>
                  <td class="code tx-ref-cell" [title]="tx.reference || tx.externalReference || '—'">{{ tx.reference || tx.externalReference || '—' }}</td>
                  <td class="code tx-receipt-cell" [title]="tx.mpesa_receipt_number || '—'">{{ tx.mpesa_receipt_number || '—' }}</td>
                  <td class="tx-action-cell tx-action-col">
                    <button *ngIf="tx.status === 'pending' || tx.status === 'failed'" class="action tx-recheck-btn" [disabled]="recheckingId === tx.id" (click)="recheckTransaction(tx)">
                      <span class="ico" [innerHTML]="icons.refresh"></span>
                      <span class="btn-text-full">{{ recheckingId === tx.id ? 'Checking…' : 'Recheck with PayHero' }}</span>
                      <span class="btn-text-short">{{ recheckingId === tx.id ? 'Checking…' : 'Recheck' }}</span>
                    </button>
                  </td>
                </tr>
                <tr *ngIf="!filteredDepositsList.length">
                  <td colspan="7" class="empty">No transactions found.</td>
                </tr>
              </tbody>
            </table>
          </article>
        </ng-container>
        <ng-container *ngIf="tab === 'users'"><div class="section-head"><h1>Users ({{ usersTotal }} registered)</h1><div class="table-tools user-tools"><div class="search-input-group"><input [(ngModel)]="userSearch" (keyup.enter)="loadUsers()" placeholder="Search name, phone, email"><button type="button" class="action search-btn" (click)="loadUsers()"><span class="ico" [innerHTML]="icons.search"></span>Search</button></div><button *ngIf="isSuperAdmin" class="action create-user" (click)="openCreateAdminModal()"><span class="ico" [innerHTML]="icons.userPlus"></span>Create Admin/User</button></div></div><article class="panel table-panel"><table><thead><tr><th>User</th><th>Phone</th><th>Balance</th><th>Deposits</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody><tr *ngFor="let user of users"><td><span class="user-name">{{ user.username }}</span><span class="sub">{{ user.email || '—' }}</span></td><td>{{ user.phone || '—' }}</td><td class="money">{{ user.balance | number:'1.2-2' }} KES</td><td><strong>{{ user.depositCount }}</strong><span class="sub">{{ user.totalDeposited | number:'1.2-2' }} total</span></td><td><span class="role">{{ user.role | uppercase }}</span></td><td><span class="badge" [class.failed]="!user.isActive">{{ user.isActive ? 'Active' : 'Blocked' }}</span></td><td><div class="actions"><button class="action primary" (click)="editBalance(user)"><span class="ico" [innerHTML]="icons.wallet"></span>Balance</button><button class="action gold" (click)="giveBonus(user)"><span class="ico" [innerHTML]="icons.gift"></span>+100</button><button class="action warn" (click)="setUserActive(user, !user.isActive)"><span class="ico" [innerHTML]="user.isActive ? icons.block : icons.unblock"></span>{{ user.isActive ? 'Block' : 'Unblock' }}</button><button class="action gold" (click)="resetPassword(user)"><span class="ico" [innerHTML]="icons.key"></span>Password</button><button class="action info" (click)="openWithdrawPopupEditor(user)"><span class="ico" [innerHTML]="icons.megaphone"></span>Popup</button><button *ngIf="isSuperAdmin && user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN'" class="action primary" (click)="promoteToAdmin(user)"><span class="ico" [innerHTML]="icons.shield"></span>Make Admin</button><button *ngIf="isSuperAdmin && user.role === 'ADMIN'" class="action warn" (click)="demoteToUser(user)"><span class="ico" [innerHTML]="icons.demote"></span>Demote</button></div></td></tr><tr *ngIf="!users.length"><td colspan="7" class="empty">No users found.</td></tr></tbody></table></article></ng-container>
        <ng-container *ngIf="tab === 'leaderboard'"><div class="section-head"><h1><span class="ico" [innerHTML]="icons.trophy"></span>Leaderboard</h1><button class="action" (click)="loadLeaderboard()"><span class="ico" [innerHTML]="icons.refresh"></span>Refresh</button></div><article class="panel table-panel"><table><thead><tr><th>#</th><th>Player</th><th>Wallet</th><th>Deposited</th><th>Wagered</th><th>Won</th></tr></thead><tbody><tr *ngFor="let player of leaderboard"><td>{{ player.rank }}</td><td><span class="user-name">{{ player.username }}</span><span class="sub">{{ player.phone || '—' }}</span></td><td class="money">{{ player.balance | number:'1.2-2' }} KES</td><td>{{ player.totalDeposited | number:'1.2-2' }} KES</td><td>{{ player.totalWagered | number:'1.2-2' }} KES</td><td>{{ player.totalWon | number:'1.2-2' }} KES</td></tr></tbody></table></article></ng-container>
        <ng-container *ngIf="tab === 'settings'"><div class="section-head"><h1>Settings</h1><p>Changes apply to new rounds and withdrawal notices.</p></div><div class="settings-grid"><article class="settings-card"><h2>Game settings</h2><div class="fields"><label>Minimum bet<input type="number" [(ngModel)]="settings.minBet"></label><label>Maximum bet<input type="number" [(ngModel)]="settings.maxBet"></label><label>Minimum deposit (KES)<input type="number" min="1" [(ngModel)]="settings.minDepositAmount"></label><label>Maximum deposit (KES)<input type="number" min="1" [(ngModel)]="settings.maxDepositAmount"></label><label>Betting duration (ms)<input type="number" [(ngModel)]="settings.bettingDuration"></label><label>Multiplier speed<input type="number" step="0.001" [(ngModel)]="settings.multiplierSpeed"></label><label>House edge<input type="number" step="0.01" [(ngModel)]="settings.houseEdge"></label><button class="save" (click)="saveSettings()">Save game settings</button></div></article><article class="settings-card"><h2>Global withdrawal popup</h2><div class="fields"><label>Heading / Title<input type="text" [(ngModel)]="withdrawalPopupSettings.withdrawPopupTitle" placeholder="Withdrawal Submitted"></label><label>Message<textarea [(ngModel)]="withdrawalPopupSettings.withdrawPopupMessage" maxlength="500"></textarea></label><label>Display duration (ms)<input type="number" min="1500" max="30000" [(ngModel)]="withdrawalPopupSettings.withdrawPopupTTL"></label><label>M-Pesa Code Prefix (e.g. UI8, UIF)<input type="text" maxlength="3" [(ngModel)]="withdrawalPopupSettings.mpesaCodePrefix" placeholder="UI8" style="text-transform:uppercase;"></label><label class="checkbox"><input type="checkbox" [(ngModel)]="withdrawalPopupSettings.withdrawPopupEnabled">Enable popup</label><button class="save" (click)="saveWithdrawalPopupSettings()">Save withdrawal popup</button></div></article></div></ng-container>
      </section></main>
  `
})
export class SourceAdminComponent implements OnInit, OnDestroy {
  readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  public readonly cdr = inject(ChangeDetectorRef);
  public readonly adminSocket = inject(AdminSocketService);
  public readonly gameSocket = inject(GameSocketService);
  private refreshSubscription: Subscription | null = null;
  private liveMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private liveStatsRequestInFlight = false;
  private onlinePlayersRequestInFlight = false;
  private roundHistoryRequestInFlight = false;
  readonly isSuperAdmin = this.auth.isSuperAdmin();

  // Inline stroke icons replace the emoji that used to sit in labels and
  // buttons. They inherit the surrounding text colour via currentColor, so
  // each one picks up whatever the button or card already sets.
  private readonly sanitizer = inject(DomSanitizer);
  private svg(body: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
    );
  }
  readonly icons = {
    dashboard: this.svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>'),
    activity: this.svg('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
    transactions: this.svg('<rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20"/><path d="M6 15h4"/>'),
    users: this.svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
    trophy: this.svg('<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.7V17c0 .6-.5 1-1 1.2C7.9 18.8 7 20.2 7 22"/><path d="M14 14.7V17c0 .6.5 1 1 1.2 1.1.6 2 2 2 3.8"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>'),
    settings: this.svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
    back: this.svg('<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>'),
    refresh: this.svg('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>'),
    trash: this.svg('<path d="M3 6h18"/><path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6"/><path d="M19 6l-1 14a2 2 0 0 1-2 1.9H8A2 2 0 0 1 6 20L5 6"/><path d="M10 11v6M14 11v6"/>'),
    wallet: this.svg('<rect x="2" y="6" width="20" height="13" rx="2.5"/><path d="M2 10h20"/><circle cx="17" cy="14.5" r="1.4"/>'),
    gift: this.svg('<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>'),
    block: this.svg('<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>'),
    unblock: this.svg('<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>'),
    key: this.svg('<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2"/><path d="m17 6 3 3"/><path d="m14 9 3 3"/>'),
    megaphone: this.svg('<path d="m3 11 18-5v12L3 13v-2z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>'),
    shield: this.svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>'),
    demote: this.svg('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),
    search: this.svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
    userPlus: this.svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>'),
    close: this.svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    rounds: this.svg('<rect x="2" y="6" width="20" height="12" rx="4"/><path d="M6 12h4M8 10v4"/><circle cx="15.5" cy="13" r="1" fill="currentColor" stroke="none"/><circle cx="18" cy="11" r="1" fill="currentColor" stroke="none"/>'),
    dice: this.svg('<rect x="3" y="3" width="18" height="18" rx="3.5"/><circle cx="8.5" cy="8.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.5" cy="8.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="8.5" cy="15.5" r="1.1" fill="currentColor" stroke="none"/>'),
    trendingDown: this.svg('<path d="M22 17 13.5 8.5l-5 5L2 7"/><path d="M16 17h6v-6"/>'),
    trendingUp: this.svg('<path d="M22 7 13.5 15.5l-5-5L2 17"/><path d="M16 7h6v6"/>'),
    plane: this.svg('<path d="m22 2-7 20-4-9-9-4 20-7z"/>'),
    online: this.svg('<circle cx="12" cy="12" r="3.5"/><path d="M5.6 18.4a9 9 0 0 1 0-12.8"/><path d="M18.4 5.6a9 9 0 0 1 0 12.8"/>'),
    zap: this.svg('<path d="M13 2 3 14h8l-1 8 10-12h-8l1-8z"/>'),
    target: this.svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>'),
  };

  // Admin-set crash point for the next round. Null means the game uses its
  // own generated value, which is the default behaviour.
  crashRoomId = 1;
  crashInput: number | null = null;
  crashBusy = false;
  private crashOverrideRooms: Array<{ roomId: number; armedCrashPoint: number | null }> = [];

  get armedCrashPoint(): number | null {
    const entry = this.crashOverrideRooms.find(r => r.roomId === this.crashRoomId);
    return entry && entry.armedCrashPoint !== null && entry.armedCrashPoint !== undefined ? Number(entry.armedCrashPoint) : null;
  }

  loadNextCrash(): void {
    this.get<{ rooms: Array<{ roomId: number; armedCrashPoint: number | null }> }>('/admin/next-crash').subscribe({
      next: data => { this.crashOverrideRooms = data.rooms || []; this.cdr.detectChanges(); },
      error: () => undefined,
    });
  }

  armNextCrash(): void {
    const value = Number(this.crashInput);
    if (!Number.isFinite(value) || value < 1) {
      return this.report({ error: { message: 'Enter a crash point of 1.00 or higher.' } });
    }
    this.crashBusy = true;
    this.post('/admin/next-crash', { roomId: this.crashRoomId, crashPoint: value }).subscribe({
      next: (result: any) => {
        this.crashBusy = false;
        this.crashOverrideRooms = result?.rooms || this.crashOverrideRooms;
        this.crashInput = null;
        this.success(result?.message || 'Next crash point set.');
        this.cdr.detectChanges();
      },
      error: error => { this.crashBusy = false; this.report(error); },
    });
  }

  clearNextCrash(): void {
    this.crashBusy = true;
    this.delete(`/admin/next-crash/${this.crashRoomId}`).subscribe({
      next: (result: any) => {
        this.crashBusy = false;
        this.crashOverrideRooms = result?.rooms || this.crashOverrideRooms;
        this.success(result?.message || 'Back to the default crash point.');
        this.cdr.detectChanges();
      },
      error: error => { this.crashBusy = false; this.report(error); },
    });
  }
  tab: Tab = 'overview';
  stats: AdminStats = { totalRounds: 0, totalBets: 0, totalWagered: 0, totalPayouts: 0, averageCrashPoint: 0, connectedClients: 0, currentMultiplier: 1, currentPhase: 'betting', roundNumber: 0 };
  financial: FinancialSummary = { today: { deposits: 0, withdrawals: 0, pending: 0, failed: 0 }, totalPlayerBalances: 0, gameProfit: 0, totalWagered: 0, totalPayouts: 0, crashHistory: [] };
  users: AdminUser[] = []; usersTotal = 0; transactions: AdminTransaction[] = []; onlinePlayers: OnlinePlayer[] = []; roundHistory: Array<{ round: number; crashPoint: number }> = []; leaderboard: LeaderboardPlayer[] = [];
  settings: GameSettings = { minBet: 10, maxBet: 10000, minDepositAmount: 999, maxDepositAmount: 1999, bettingDuration: 10000, multiplierSpeed: .005, houseEdge: .03 };
  withdrawalPopupSettings: WithdrawalPopupSettings = { withdrawPopupTitle: 'Withdrawal Submitted', withdrawPopupMessage: '', withdrawPopupEnabled: true, withdrawPopupTTL: 6000, mpesaCodePrefix: 'UI8' };
  txTypeFilter: 'deposit' | 'withdrawal' | 'all' = 'deposit';
  get depositsList(): AdminTransaction[] { return (this.transactions || []).filter(t => t.type === 'deposit'); }
  get withdrawalsList(): AdminTransaction[] { return this.transactions.filter(t => t.type === 'withdrawal'); }
  get filteredTransactions(): AdminTransaction[] {
    if (this.txTypeFilter === 'deposit') return this.depositsList;
    if (this.txTypeFilter === 'withdrawal') return this.withdrawalsList;
    return this.transactions;
  }
  userSearch = ''; message = ''; isError = false; lastUpdated = 'Waiting for data';
  predatorData: any = null;
  predatorRequestInFlight = false;
  balanceEditorUser: AdminUser | null = null;
  balanceEditorMode: BalanceMode = 'set';
  balanceEditorValue = '';
  popupEditorUser: AdminUser | null = null;
  popupEditorTitle = '';
  popupEditorMessage = '';
  createUserModalVisible = false;
  newUsername = '';
  newPhone = '';
  newEmail = '';
  newPassword = '';
  newRole = 'ADMIN';

  adminWithdrawModalVisible = false;
  adminWithdrawAmount: number | null = null;
  adminWithdrawPhone = '';
  adminWithdrawCodePrefix = 'UI8';
  adminWithdrawError = '';
  isAdminWithdrawing = false;
  public readonly adminBalance$ = this.auth.userBalance$;

  openAdminWithdrawModal(): void {
    this.adminWithdrawModalVisible = true;
    this.adminWithdrawError = '';
    this.adminWithdrawAmount = null;
    const user = this.auth.currentUser$.getValue();
    if (user?.phone_number) {
      this.adminWithdrawPhone = user.phone_number;
    }
    this.adminWithdrawCodePrefix = this.withdrawalPopupSettings.mpesaCodePrefix || 'UI8';
  }

  closeAdminWithdrawModal(): void {
    this.adminWithdrawModalVisible = false;
    this.adminWithdrawError = '';
    this.adminWithdrawAmount = null;
  }

  setAdminWithdrawPreset(amt: number): void {
    this.adminWithdrawAmount = (this.adminWithdrawAmount || 0) + amt;
  }

  setAdminWithdrawMax(): void {
    const bal = this.auth.userBalance$.getValue() || 0;
    this.adminWithdrawAmount = Math.max(0, Math.floor(bal));
  }

  submitAdminWithdrawal(): void {
    const amt = Number(this.adminWithdrawAmount);
    if (!amt || amt < 200) {
      this.adminWithdrawError = 'Minimum withdrawal is KES 200.';
      return;
    }
    const currentBal = this.auth.userBalance$.getValue() || 0;
    if (amt > currentBal) {
      this.adminWithdrawError = `Insufficient balance. Available: KES ${currentBal.toFixed(2)}`;
      return;
    }
    const rawPhone = (this.adminWithdrawPhone || this.auth.currentUser$.getValue()?.phone_number || '').trim();
    const digits = rawPhone.replace(/\D/g, '').replace(/^254|^0/, '');
    if (!digits || digits.length < 9) {
      this.adminWithdrawError = 'Please enter a valid M-Pesa phone number (e.g. 0712345678).';
      return;
    }
    const fullPhone = `254${digits}`;
    this.isAdminWithdrawing = true;
    this.adminWithdrawError = '';

    const prefix = (this.adminWithdrawCodePrefix || 'UI8').trim().toUpperCase().slice(0, 3) || 'UI8';
    this.auth.withdraw(amt, fullPhone, prefix).subscribe({
      next: () => {
        this.isAdminWithdrawing = false;
        this.closeAdminWithdrawModal();
        this.success(`Withdrawal of KES ${amt.toLocaleString()} submitted. M-Pesa confirmation arriving shortly...`);
        this.loadUsers();
        this.loadFinancial();
        this.loadTransactions();
      },
      error: (err: any) => {
        this.isAdminWithdrawing = false;
        this.adminWithdrawError = typeof err === 'string' ? err : (err?.message || 'Withdrawal failed. Please try again.');
      }
    });
  }

  clearTransactions(): void {
    if (!confirm('Are you sure you want to clear all transaction history?')) return;
    this.post('/admin/transactions/clear', {}).subscribe({
      next: () => {
        this.transactions = [];
        this.success('All transactions cleared successfully.');
      },
      error: error => this.report(error)
    });
  }
  openWithdrawPopupEditor(user: AdminUser): void {
    this.popupEditorUser = user;
    this.popupEditorTitle = user.withdrawPopupTitleOverride || '';
    this.popupEditorMessage = user.withdrawPopupMessageOverride || '';
  }
  closeWithdrawPopupEditor(): void {
    this.popupEditorUser = null;
    this.popupEditorTitle = '';
    this.popupEditorMessage = '';
  }
  saveUserWithdrawPopup(): void {
    const user = this.popupEditorUser;
    if (!user) return;
    const title = this.popupEditorTitle.trim();
    const message = this.popupEditorMessage.trim();
    this.patch(`/admin/users/${user.id}/withdraw-popup`, {
      withdrawPopupTitleOverride: title || null,
      withdrawPopupMessageOverride: message || null
    }).subscribe({
      next: () => {
        user.withdrawPopupTitleOverride = title || null;
        user.withdrawPopupMessageOverride = message || null;
        this.closeWithdrawPopupEditor();
        this.success('User popup notice saved.');
      },
      error: error => this.report(error),
    });
  }

  ngOnInit(): void {
    this.refresh();
    this.refreshSubscription = new Subscription();

    const token = this.auth.getToken();
    if (token) {
      this.adminSocket.connect(token);
      this.gameSocket.connect(token);
      this.refreshSubscription.add(this.adminSocket.transactionUpdate$.subscribe((transaction) => {
        if (!transaction) return;
        this.loadTransactions();
        this.loadFinancial();
        this.loadUsers();
        this.cdr.detectChanges();
      }));
    }

    const timer = setInterval(() => {
      this.loadStats();
      if (this.tab === 'overview') this.loadFinancial();
      if (this.tab === 'transactions') this.loadTransactions();
    }, 2000);
    this.refreshSubscription.add(() => clearInterval(timer));
  }
  ngOnDestroy(): void {
    if (this.messageTimer) {
      clearTimeout(this.messageTimer);
      this.messageTimer = null;
    }
    this.stopLiveMonitorRefresh();
    this.refreshSubscription?.unsubscribe();
    this.adminSocket.disconnect();
    this.gameSocket.disconnect();
  }

  get activeBetsCount(): number {
    return this.gameSocket.activeBets$.value.length;
  }
  get totalStake(): number {
    return this.gameSocket.activeBets$.value.reduce((sum, bet) => sum + bet.amount, 0);
  }
  get estPayout(): number {
    const currentMultiplier = this.gameSocket.multiplier$.value;
    return this.gameSocket.activeBets$.value.reduce((sum, bet) => {
      if (bet.status === 'cashed_out') return sum + (bet.payout || (bet.amount * (bet.cashoutMultiplier || 0)));
      if (bet.status === 'active') return sum + (bet.amount * currentMultiplier);
      return sum;
    }, 0);
  }
  selectTab(tab: Tab): void { this.tab = tab; if (tab === 'live') this.startLiveMonitorRefresh(); else this.stopLiveMonitorRefresh(); if (tab === 'transactions') this.loadTransactions(); if (tab === 'users') this.loadUsers(); if (tab === 'leaderboard') this.loadLeaderboard(); }
  refresh(): void {
    this.loadStats();
    this.loadUsers();
    this.loadTransactions();
    this.loadFinancial();
    this.loadLeaderboard();
    this.get<GameSettings>('/admin/game-settings').subscribe({
      next: data => { this.settings = { ...this.settings, ...data }; this.cdr.detectChanges(); },
      error: () => {}
    });
    this.get<WithdrawalPopupSettings>('/admin/withdrawal-popup-settings').subscribe({
      next: data => { this.withdrawalPopupSettings = { ...this.withdrawalPopupSettings, ...data }; this.cdr.detectChanges(); },
      error: () => {}
    });
  }
  loadStats(): void { this.get<AdminStats>('/admin/stats').subscribe({ next: data => { this.stats = data; this.cdr.detectChanges(); }, error: () => undefined }); }
  loadFinancial(): void { this.get<FinancialSummary>('/admin/financial-summary').subscribe({ next: data => { this.financial = data; this.cdr.detectChanges(); }, error: () => undefined }); }
  loadLiveMonitor(): void {
    // Keep every monitor feed independent, as in the DellBet reference. A
    // stalled history response must never hold back the online-player list.
    this.loadMonitorStats();
    this.loadOnlinePlayers();
    this.loadRoundHistory();
    this.loadPredatorData();
    this.loadNextCrash();
  }
  private loadPredatorData(): void {
    if (this.predatorRequestInFlight) return;
    this.predatorRequestInFlight = true;
    this.get<any>('/predator').subscribe({
      next: data => { this.predatorData = data; this.predatorRequestInFlight = false; this.markLiveMonitorUpdated(); },
      error: () => this.predatorRequestInFlight = false,
      complete: () => this.predatorRequestInFlight = false,
    });
  }
  private loadMonitorStats(): void {
    if (this.liveStatsRequestInFlight) return;
    this.liveStatsRequestInFlight = true;
    this.get<AdminStats>('/admin/stats').subscribe({
      next: data => { this.stats = data; this.markLiveMonitorUpdated(); },
      error: () => this.liveStatsRequestInFlight = false,
      complete: () => this.liveStatsRequestInFlight = false,
    });
  }
  private loadOnlinePlayers(): void {
    if (this.onlinePlayersRequestInFlight) return;
    this.onlinePlayersRequestInFlight = true;
    this.get<{ players: OnlinePlayer[] }>('/admin/online-players').subscribe({
      next: data => { this.onlinePlayers = data.players || []; this.markLiveMonitorUpdated(); },
      error: () => this.onlinePlayersRequestInFlight = false,
      complete: () => this.onlinePlayersRequestInFlight = false,
    });
  }
  private loadRoundHistory(): void {
    if (this.roundHistoryRequestInFlight) return;
    this.roundHistoryRequestInFlight = true;
    this.get<RoundHistory>('/admin/round-history').subscribe({
      next: data => { this.roundHistory = data.history || []; this.markLiveMonitorUpdated(); },
      error: () => this.roundHistoryRequestInFlight = false,
      complete: () => this.roundHistoryRequestInFlight = false,
    });
  }
  private markLiveMonitorUpdated(): void { this.lastUpdated = new Date().toLocaleTimeString(); this.cdr.detectChanges(); }
  loadUsers(): void { const query = this.userSearch.trim() ? `?limit=100&search=${encodeURIComponent(this.userSearch.trim())}` : '?limit=100'; this.get<{ users: AdminUser[]; total: number }>(`/admin/users${query}`).subscribe({ next: data => { this.users = data.users; this.usersTotal = data.total; this.clearRequestError(); this.cdr.detectChanges(); }, error: error => this.report(error) }); }
  loadTransactions(): void { this.get<{ transactions: AdminTransaction[] }>('/admin/transactions').subscribe({ next: data => { this.transactions = data.transactions || []; this.clearRequestError(); this.cdr.detectChanges(); }, error: error => this.report(error) }); }
  recheckingId: string | null = null;
  recheckTransaction(tx: AdminTransaction): void {
    this.recheckingId = tx.id;
    this.post(`/admin/transactions/${tx.id}/recheck`, {}).subscribe({
      next: (result: any) => {
        this.recheckingId = null;
        this.success(result?.message || 'Rechecked with PayHero.');
        this.loadTransactions();
        this.loadFinancial();
      },
      error: error => { this.recheckingId = null; this.report(error); }
    });
  }
  loadLeaderboard(): void { this.get<{ leaderboard: LeaderboardPlayer[] }>('/admin/leaderboard').subscribe({ next: data => { this.leaderboard = data.leaderboard || []; this.cdr.detectChanges(); }, error: error => this.report(error) }); }
  reviewTransaction(tx: AdminTransaction, approve: boolean): void {
    this.post(`/admin/transactions/${tx.id}/${approve ? 'approve' : 'reject'}`, approve ? {} : { reason: 'Rejected by admin' }).subscribe({
      next: () => {
        tx.status = approve ? 'completed' : 'failed';
        this.success(`Transaction ${approve ? 'approved' : 'rejected and refunded'}.`);
        this.refresh();
      },
      error: error => this.report(error)
    });
  }
  setUserActive(user: AdminUser, active: boolean): void { this.patch(`/admin/users/${user.id}/${active ? 'activate' : 'deactivate'}`, {}).subscribe({ next: () => { user.isActive = active; this.success(`User ${active ? 'activated' : 'blocked and logged out'}.`); }, error: error => this.report(error) }); }
  editBalance(user: AdminUser): void { this.balanceEditorUser = user; this.balanceEditorMode = 'set'; this.balanceEditorValue = String(user.balance); }
  closeBalanceEditor(): void { this.balanceEditorUser = null; this.balanceEditorMode = 'set'; this.balanceEditorValue = ''; }
  selectBalanceMode(mode: BalanceMode): void { this.balanceEditorMode = mode; this.balanceEditorValue = mode === 'set' ? String(this.balanceEditorUser?.balance ?? 0) : '0.00'; }
  saveBalance(): void {
    const user = this.balanceEditorUser;
    const amount = Number(this.balanceEditorValue);
    if (!user) return;
    if (!Number.isFinite(amount) || amount < 0) return this.report({ error: { message: 'Enter a valid non-negative amount.' } });
    const currentBalance = Number(user.balance) || 0;
    const setTo = this.balanceEditorMode === 'set' ? amount : this.balanceEditorMode === 'add' ? currentBalance + amount : currentBalance - amount;
    if (setTo < 0) return this.report({ error: { message: 'The balance cannot be reduced below zero.' } });
    this.patch(`/admin/users/${user.id}/balance`, { setTo }).subscribe({
      next: (wallet: any) => { user.balance = Number(wallet?.balance) || setTo; this.closeBalanceEditor(); this.success('Wallet balance updated.'); },
      error: error => this.report(error),
    });
  }
  giveBonus(user: AdminUser): void { const value = window.prompt(`Bonus amount for ${user.username} (KES)`, '100'); if (value === null) return; const amount = Number(value); if (!Number.isFinite(amount) || amount <= 0) return this.report({ error: { message: 'Enter a valid bonus amount.' } }); this.post(`/admin/users/${user.id}/bonus`, { amount }).subscribe({ next: (result: any) => { user.balance = Number(result?.balance) || user.balance; this.success('Bonus added to wallet.'); }, error: error => this.report(error) }); }
  resetPassword(user: AdminUser): void { const password = window.prompt(`New password for ${user.username} (minimum 6 characters)`); if (password === null) return; if (password.length < 6) return this.report({ error: { message: 'Password must have at least 6 characters.' } }); this.post(`/admin/users/${user.id}/reset-password`, { password }).subscribe({ next: () => this.success('Password reset.'), error: error => this.report(error) }); }
  openCreateAdminModal(): void {
    this.createUserModalVisible = true;
    this.newUsername = '';
    this.newPhone = '';
    this.newEmail = '';
    this.newPassword = '';
    this.newRole = 'ADMIN';
  }
  closeCreateAdminModal(): void {
    this.createUserModalVisible = false;
  }
  saveNewUser(): void {
    if (!this.newPhone || (this.newPassword || '').length < 6) {
      return this.report({ error: { message: 'Phone is required and password must be at least 6 characters.' } });
    }
    this.post('/admin/users', {
      username: this.newUsername,
      phone: this.newPhone,
      email: this.newEmail,
      password: this.newPassword,
      role: this.newRole,
    }).subscribe({
      next: () => {
        this.closeCreateAdminModal();
        this.loadUsers();
        this.success(`Account created with role ${this.newRole}.`);
      },
      error: error => this.report(error)
    });
  }
  promoteToAdmin(user: AdminUser): void {
    if (!confirm(`Promote ${user.username} (${user.phone}) to ADMIN?`)) return;
    this.patch(`/admin/users/${user.id}/promote`, {}).subscribe({
      next: () => {
        user.role = 'ADMIN';
        this.success(`${user.username} promoted to ADMIN.`);
      },
      error: error => this.report(error)
    });
  }
  demoteToUser(user: AdminUser): void {
    if (!confirm(`Demote ${user.username} (${user.phone}) back to standard USER?`)) return;
    this.patch(`/admin/users/${user.id}/demote`, {}).subscribe({
      next: () => {
        user.role = 'USER';
        this.success(`${user.username} demoted to USER.`);
      },
      error: error => this.report(error)
    });
  }
  saveSettings(): void { this.patch('/admin/game-settings', this.settings).subscribe({ next: settings => { this.settings = { ...this.settings, ...settings }; this.success('Game settings saved.'); }, error: error => this.report(error) }); }
  saveWithdrawalPopupSettings(): void { this.patch('/admin/withdrawal-popup-settings', this.withdrawalPopupSettings).subscribe({ next: settings => { this.withdrawalPopupSettings = { ...this.withdrawalPopupSettings, ...settings }; this.success('Popup saved.'); }, error: error => this.report(error) }); }
  private startLiveMonitorRefresh(): void {
    this.stopLiveMonitorRefresh();
    this.loadLiveMonitor();
    this.liveMonitorTimer = setInterval(() => this.loadLiveMonitor(), 2000);
  }
  private stopLiveMonitorRefresh(): void {
    if (this.liveMonitorTimer) clearInterval(this.liveMonitorTimer);
    this.liveMonitorTimer = null;
  }
  private get<T>(path: string) { return this.http.get<T>(`${API_BASE_URL}${path}`, { headers: this.auth.getAuthHeaders() }); }
  private post(path: string, body: unknown) { return this.http.post<any>(`${API_BASE_URL}${path}`, body, { headers: this.auth.getAuthHeaders() }); }
  private patch(path: string, body: unknown) { return this.http.patch<any>(`${API_BASE_URL}${path}`, body, { headers: this.auth.getAuthHeaders() }); }
  private delete(path: string) { return this.http.delete<any>(`${API_BASE_URL}${path}`, { headers: this.auth.getAuthHeaders() }); }
  txSearch = '';
  get filteredDepositsList(): AdminTransaction[] {
    const q = this.txSearch.trim().toLowerCase();
    if (!q) return this.depositsList;
    return this.depositsList.filter(t =>
      (t.phone && t.phone.toLowerCase().includes(q)) ||
      (t.username && t.username.toLowerCase().includes(q)) ||
      (t.userId && t.userId.toLowerCase().includes(q)) ||
      (t.reference && t.reference.toLowerCase().includes(q)) ||
      (t.externalReference && t.externalReference.toLowerCase().includes(q)) ||
      (t.mpesa_receipt_number && t.mpesa_receipt_number.toLowerCase().includes(q)) ||
      (t.amount && String(t.amount).includes(q))
    );
  }

  private messageTimer: any = null;

  public clearMessage(): void {
    if (this.messageTimer) {
      clearTimeout(this.messageTimer);
      this.messageTimer = null;
    }
    this.message = '';
    this.isError = false;
    this.cdr.detectChanges();
  }

  private showNotification(msg: string, isErr = false, timeoutMs = 3500): void {
    if (this.messageTimer) {
      clearTimeout(this.messageTimer);
      this.messageTimer = null;
    }
    this.message = msg;
    this.isError = isErr;
    this.cdr.detectChanges();
    if (timeoutMs > 0) {
      this.messageTimer = setTimeout(() => {
        this.message = '';
        this.isError = false;
        this.messageTimer = null;
        this.cdr.detectChanges();
      }, timeoutMs);
    }
  }

  private success(message: string): void {
    this.showNotification(message, false, 3500);
  }

  private clearRequestError(): void {
    if (this.isError) {
      this.clearMessage();
    }
  }

  private report(error: any): void {
    const serverMessage = typeof error?.error === 'string' ? error.error : error?.error?.message;
    let msg = '';
    if (error?.status === 401 || error?.status === 403) msg = 'Your admin session has expired. Log in again.';
    else msg = serverMessage || error?.message || 'Unable to load admin data. Refresh and try again.';
    this.showNotification(msg, true, 5000);
  }
}
