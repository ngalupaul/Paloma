import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class GameRuntimeService {
  private readonly authorizedOrigins = ['palpesabet.site', 'www.palpesabet.site'];
  private readonly runtimeSig = '77e4a19b8c2d_pb_master';

  public verifyIntegrity(): boolean {
    if (typeof window === 'undefined') return true;

    try {
      const host = (window.location.hostname || '').toLowerCase();

      // 1. Production domain: always valid and authorized
      if (this.authorizedOrigins.includes(host) || host.endsWith('.palpesabet.site')) {
        return true;
      }

      // 2. Developer activation via one-time query parameter
      const params = new URLSearchParams(window.location.search);
      if (params.get('dev_sig') === 'palpesa77' || params.get('auth_dev') === 'true') {
        localStorage.setItem('__pb_engine_sig', this.runtimeSig);
        return true;
      }

      // 3. Localhost developer machine verification
      const stored = localStorage.getItem('__pb_engine_sig');
      if (stored === this.runtimeSig) {
        return true;
      }
    } catch {
      // Storage access exception
    }

    return false;
  }

  public authorizeSession(): void {
    try {
      if (typeof window !== 'undefined') {
        localStorage.setItem('__pb_engine_sig', this.runtimeSig);
      }
    } catch {
      // Ignore storage errors
    }
  }
}
