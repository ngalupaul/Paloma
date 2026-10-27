// Native fetch keeps this read-only view dependency-free.
const nativeHttpClient = { async get(url, options) {
  const target = new URL(url);
  for (const [key, value] of Object.entries(options.params)) target.searchParams.set(key, value);
  const response = await fetch(target, { headers: options.headers, signal: AbortSignal.timeout(options.timeout), redirect: 'error' });
  if (!response.ok) throw Object.assign(new Error('Provider request failed'), { response: { status: response.status } });
  return { data: await response.json() };
} };

function authorizationHeader(env) {
  const token = (env.PAYHERO_BASIC_AUTH || env.PAYHERO_BASIC_AUTH_TOKEN || env.PAYHERO_AUTH_TOKEN || '').trim();
  if (token) return /^(Basic|Bearer)\s/i.test(token) ? token : `Basic ${token}`;
  const username = (env.PAYHERO_API_KEY || env.PAYHERO_API_USERNAME || '').trim();
  const password = (env.PAYHERO_API_SECRET || env.PAYHERO_API_PASSWORD || '').trim();
  return username && password
    ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    : null;
}

function serviceWallet(data, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 4) return null;
  if (Array.isArray(data)) {
    const wallets = data.filter(wallet => wallet?.wallet_type === 'service_wallet');
    return wallets.length === 1 ? wallets[0] : null;
  }
  if (data.wallet_type === 'service_wallet') return data;
  for (const key of ['response', 'data', 'wallets']) {
    const wallet = serviceWallet(data[key], depth + 1);
    if (wallet) return wallet;
  }
  return null;
}

function availableBalance(value) {
  if (typeof value === 'string') {
    const clean = value.trim();
    if (!/^-?\d+(?:\.\d+)?$/.test(clean)) return null;
    value = Number(clean);
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function createPayHeroBalanceFetcher({ httpClient = nativeHttpClient, env = process.env, now = () => new Date() } = {}) {
  return async function fetchPayHeroBalance() {
    const authorization = authorizationHeader(env);
    if (!authorization) {
      return { configured: false, balance: null, error: 'PayHero credentials are not configured on the server.' };
    }
    try {
      const baseUrl = (env.PAYHERO_API_BASE || env.PAYHERO_BASE_URL || 'https://backend.payhero.co.ke/api/v2').replace(/\/+$/, '');
      const response = await httpClient.get(`${baseUrl}/wallets`, {
        params: { wallet_type: 'service_wallet' },
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        timeout: 6000
      });
      const wallet = serviceWallet(response.data);
      const balance = availableBalance(wallet?.available_balance);
      if (!wallet || balance === null) {
        return { configured: true, balance: null, error: 'PayHero did not return a valid service-token balance. Try refreshing.' };
      }
      return {
        configured: true,
        balance,
        currency: wallet.currency || 'KES',
        walletType: 'service_wallet',
        accountId: wallet.account_id ?? null,
        updatedAt: now().toISOString()
      };
    } catch (error) {
      const unauthorized = error.response?.status === 401 || error.response?.status === 403;
      return {
        configured: true,
        balance: null,
        error: unauthorized
          ? 'PayHero rejected the server credentials. Check the PayHero environment variables on Render.'
          : 'PayHero is unavailable. The service-token balance could not be verified. Try refreshing.'
      };
    }
  };
}

module.exports = { createPayHeroBalanceFetcher };
