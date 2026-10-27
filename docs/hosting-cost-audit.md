# Hosting cost audit and lite deployment

Reviewed 27 October 2026. All sizes below are decimal MB from the local checkout,
not measurements of the deployed Render service.

## Invoice findings

The supplied September 2026 invoice totals $37.69:

| Charge | Usage shown | Amount |
| --- | --- | --- |
| Bandwidth | 170.1 GB | $25.65 |
| Servers | 1,237h 57m 40s across 4 instances | $12.04 |
| Storage | No separate charge shown | - |

The invoice does not identify individual services, indicate that all four
instances ran simultaneously, or attribute bandwidth to specific endpoints.
Use Render's invoice usage details to identify each billed service. Do not assume
the four instances are four replicas of this project. No existing cloud services
were stopped or deleted during this audit.

## Pakabet versus LIGITOK

| Item | Pakabet | LIGITOK |
| --- | --- | --- |
| Frontend public assets | 7.90 MB | 18.70 MB |
| Frontend dependencies | 246.15 MB | 241.94 MB |
| Frontend build output | 15.53 MB | 19.94 MB |
| Angular cache | 7.76 MB | 7.50 MB |
| Render build configuration | Backend only, npm install | Builds frontend and backend |
| Realtime delivery | All three rooms broadcast to all sockets | Room-scoped player broadcasts, with compatibility aliases |
| Persistence | In-memory state with local snapshots and MongoDB upserts | Model-based MongoDB persistence, including round records |

Pakabet's already tracked files total approximately 9.25 MB before this audit's
new files. Dependencies, build output, caches, local data, and real .env files are
excluded by existing Git ignore rules. Deleting local node_modules will not fix
Render bandwidth charges. Frontend assets belong on Cloudflare Pages, not the API.

The local data directory has two identical 3.18 MB snapshots (6.37 MB total), each
containing 5,066 user records, 5,119 wallets and 45 recent transactions. No records
were deleted. Compact JSON represents the same snapshot in 2.34 MB per file,
approximately 26.4% smaller. This takes effect on the next normal save; the existing
snapshots were not rewritten during the audit.

## Implemented reductions

1. Presence connections opt out of game/chat broadcasts and initial game/chat
   snapshots. They retain authentication, online presence, account-block and
   logout notifications. A logged-in player previously received game traffic on
   both the presence socket and the game socket. Game events now use only the
   game socket for upgraded clients.
2. Upgraded game clients consume Room 1's multiplier from the multi-room tick,
   avoiding a second compatibility tick packet. Old clients still receive the
   original events. Game updates remain at 100 ms; no round timing, multiplier,
   crash selection or payout calculation was changed. All three room streams
   are retained so hidden-room betting/auto-cashout behavior remains supported.
3. MongoDB writes fingerprint records locally and upsert only changed users,
   wallets and transactions after the first save. Failed/partial batches remain
   eligible for retry. Restart clears the in-process cache. Cache eviction never
   deletes database records. This reduces outbound writes, not accumulated MongoDB
   storage. Database updatedAt now reflects actual data writes rather than every
   unrelated save.
4. Local snapshots use compact JSON with the same fields and both restore copies.
5. The Render blueprint explicitly requests one instance, installs production
   dependencies only, and restricts automatic builds to backend/config changes.
   The existing backend rootDir already avoided normal frontend-only builds;
   the filter makes the intended scope explicit. No cloud settings were changed.

These changes reduce unnecessary work; they do not guarantee a monthly bill.
For illustration, when all three rooms are flying, the old presence+game socket
pair received eight multiplier packets per 100 ms; the upgraded pair receives
three. That is 62.5% fewer tick packets in that scenario, not a measured reduction
in total bytes or the final invoice.

## Verification

- Backend tests cover unchanged-record skipping, a 5,000-wallet case with a
  one-wallet update, failed/partial-write retry, transaction status changes,
  delete/restore cache handling, and modern/legacy/presence socket audiences.
- No live payment request or production database migration was used for tests.
- All five backend tests passed. All 51 HTTP route registrations match the
  original source. Production frontend build passed with the existing initial
  bundle/component stylesheet budget warnings; no build error occurred.
- Run `npm test --prefix backend` and `npm run build` before deployment.

## New deployment checklist

- Use one backend service and keep the frontend on Cloudflare Pages.
- Supply the new private repository URL through chat; do not send passwords.
- Transfer source only, never backend/data, .env, node_modules, build output or
  this invoice. Keep database backups and preserve current user/payment records.
- Re-enter secrets in Render and verify MongoDB points at the intended database.
- Preserve or update the API custom domain, allowed frontend origins, payment
  callback URL and existing frontend domain authorization together.
- Inspect the old workspace's four billed instances before creating duplicates.
  Removing a repository does not stop paid Render services or clear an invoice.
- Keep a single process: this game's authoritative room state is in memory.
- Set the build-pipeline spend limit in Render, monitor outbound bandwidth, and
  review the smallest suitable compute plan. Build limits are not total-bill caps.

## Provider documentation

- https://render.com/docs/outbound-bandwidth
- https://render.com/docs/build-pipeline
- https://render.com/docs/blueprint-spec

Render counts WebSocket responses and service-initiated public network traffic
as outbound bandwidth. Both socket fan-out and repeated MongoDB writes are relevant
to this invoice, but their historical shares cannot be established from source
code or the invoice summary alone.
