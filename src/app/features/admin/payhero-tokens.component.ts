import { ChangeDetectorRef, Component, OnInit, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { API_BASE_URL } from '../../core/config/api-url';

@Component({ selector: 'app-payhero-tokens', standalone:true, imports:[CommonModule], templateUrl:'./payhero-tokens.component.html', styleUrl:'./payhero-tokens.component.css' })
export class PayheroTokensComponent implements OnInit, OnDestroy {
  private authService = inject(AuthService);
  private http = inject(HttpClient);
  private cdr = inject(ChangeDetectorRef);
  public payHeroBalance: number | null = null;
  public payHeroAccountId: string | number | null = null;
  public payHeroLastUpdated: string | null = null;
  public payHeroError = '';
  public isLoadingPayHeroBalance = false;
  private payHeroRequest?: Subscription;
  private payHeroTimer?: ReturnType<typeof setInterval>;

  public fetchPayHeroBalance(force = false): void {
    const token = this.authService.getToken();
    if (!token || this.isLoadingPayHeroBalance) return;
    this.isLoadingPayHeroBalance = true;
    this.payHeroRequest = this.http.get<any>(`${API_BASE_URL}/admin/payhero/balance${force ? '?force=true' : ''}`, {
      headers: { Authorization: `Bearer ${token}` }
    }).subscribe({
      next: result => {
        this.isLoadingPayHeroBalance = false;
        this.cdr.markForCheck();
        if (!result.error && typeof result.balance === 'number' && Number.isFinite(result.balance)) {
          this.payHeroBalance = result.balance;
          this.payHeroAccountId = result.accountId ?? null;
          this.payHeroLastUpdated = result.updatedAt ?? null;
          this.payHeroError = '';
        } else {
          this.clearPayHeroBalance(result.error || 'The service-token balance could not be verified.');
        }
      },
      error: () => {
        this.isLoadingPayHeroBalance = false;
        this.cdr.markForCheck();
        this.clearPayHeroBalance('Unable to check PayHero service tokens. Try refreshing.');
      }
    });
  }

  private clearPayHeroBalance(message: string): void {
    this.payHeroBalance = null;
    this.payHeroAccountId = null;
    this.payHeroLastUpdated = null;
    this.payHeroError = message;
  }


  ngOnInit(): void {
    this.fetchPayHeroBalance();
    this.payHeroTimer = setInterval(() => { if (!document.hidden) this.fetchPayHeroBalance(); }, 60000);
  }
  ngOnDestroy(): void {
    this.payHeroRequest?.unsubscribe();
    if (this.payHeroTimer) clearInterval(this.payHeroTimer);
  }
}
