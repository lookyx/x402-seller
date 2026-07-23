# x402 Seller — Multi-Product Data API

A live, working example of selling data to AI agents via the [x402 protocol](https://x402.org).
Agents pay per call in USDC on Base, no accounts, no API keys on their end, no subscriptions.

**Live at:** `https://x402-seller.onrender.com`

## What's for sale

| Endpoint | Sells | Price |
|---|---|---|
| `GET /geo/lookup?address=...` | Address → lat/lng + IANA timezone (LocationIQ) | $0.001 |
| `GET /geo/reverse?lat=...&lng=...` | Coordinates → place name + timezone (LocationIQ) | $0.001 |
| `GET /oil/price?benchmark=wti\|brent` | Latest daily WTI/Brent spot price (EIA) | $0.001 |
| `GET /gas/price` | Latest Henry Hub natural gas spot price (EIA) | $0.001 |
| `GET /electricity/price?state=US` | Latest US retail electricity price, national or by state (EIA) | $0.001 |
| `GET /weather/forecast?lat=...&lng=...` | Official US weather forecast by coordinates (NWS/NOAA, US only) | $0.001 |
| `GET /nuclear/outages` | Daily US nuclear plant outage data (NRC via EIA) | $0.001 |
| `GET /earthquakes/recent?minmagnitude=...&limit=...` | Recent significant earthquakes worldwide (USGS) | $0.001 |
| `GET /currency/rate?from=...&to=...` | Official daily FX rate between 30+ currencies (ECB) | $0.001 |
| `GET /air/quality?lat=...&lng=...` | Current US air quality index readings (EPA AirNow) | $0.001 |
| `GET /space/asteroids?date=...` | Near-Earth asteroids by closest approach date (NASA JPL) | $0.001 |
| `GET /chain/balance?address=...&token=...` | Live ETH + ERC20 balance on Base mainnet (Base RPC) | $0.001 |
| `GET /treasury/debt` | Latest total US national debt "to the penny" (US Treasury) | $0.001 |
| `GET /ocean/tides?station=...` or `?lat=...&lng=...` | Tide predictions (next 48h) or latest water level at US coastal stations, nearest-station lookup by coordinates (NOAA CO-OPS) | $0.001 |
| `GET /water/streamflow?site=...` | Real-time river streamflow + gauge height at US stream gauges (USGS) | $0.001 |
| `GET /payments/history?hours=24&address=...` | This seller's own recent USDC settlement history on Base (self-referential, max 72h window) | $0.001 |

All data sources are either explicitly licensed for commercial resale (LocationIQ) or
official public-domain government data with no redistribution restriction (EIA, NWS).
See "Data sourcing" below before adding new endpoints — some obvious-looking free APIs
(e.g. raw Nominatim, most commercial oil-price APIs) explicitly forbid this exact use case.

## How it works (2-request handshake)

1. Agent calls a paid route with no payment
2. Server replies `402 Payment Required` with price + wallet address
3. Agent's wallet signs a USDC payment authorization, retries with a payment header
4. CDP's facilitator verifies and settles the payment on-chain
5. Server returns the actual data

## Setup

```bash
npm install
cp .env.example .env
```

Required environment variables (see `.env.example`):
- `PAY_TO_ADDRESS` — your wallet address, receives all USDC payments
- `LOCATIONIQ_API_KEY` — free at locationiq.com (5,000 req/day free tier, licensed for commercial resale)
- `EIA_API_KEY` — free at eia.gov/opendata/register.php (no rate limit stated; official US government data)
- `NETWORK` / `FACILITATOR_URL` — testnet by default; see "Mainnet" below
- `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` — only needed for mainnet (see below)

## Run locally (testnet)

```bash
npm start
```

Test the unpaid flow:
```bash
curl -i "http://localhost:4021/geo/lookup?address=Tokyo"
```
You should get `402 Payment Required` — that's correct, the paywall is working.

## Go to mainnet (get paid for real)

1. Sign up at [cdp.coinbase.com](https://cdp.coinbase.com), create a project, generate API keys
   (read-only / View permission is sufficient — no Trade/Transfer/Receive scopes needed)
2. In `.env`, set:
NETWORK=eip155:8453
FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
CDP_API_KEY_ID=your-key-id
CDP_API_KEY_SECRET=your-key-secret
3. Confirm `PAY_TO_ADDRESS` is a mainnet wallet you actually control.

## Deploying (Render, or any always-on Node host)

This repo auto-deploys from GitHub — pushing to `main` triggers a new deploy automatically
once connected. Environment variables live in the host's dashboard, not in the repo
(`.env` is gitignored).

**Important:** if deploying behind a reverse proxy (Render, Railway, etc.), you MUST set:
```js
app.set("trust proxy", 1);
```
right after creating the Express app. Without this, the server reports its own resource
URL as `http://` instead of `https://`, and CDP's Bazaar discovery will silently reject
every route's metadata (rejection reason: "resource must start with 'https://'"). This
has regressed twice during full-file rewrites of `server.js` — if Bazaar discovery starts
failing again, check this line first.

## Get discovered by agents (Bazaar)

Routes are registered for CDP's Bazaar catalog via `bazaarResourceServerExtension` and
`declareDiscoveryExtension()` on each route (see `server.js`). Two things must both be
true for a route to actually get indexed:

1. **CDP facilitator + trust proxy set** (see above) — check your server logs for
   `[x402] extension responses: {"bazaar":{"status":"processing"}}` after a real
   settlement. If you see `"status":"rejected"` instead, read the `rejectedReason`.
2. **A real payment must actually settle against the route at least once.** Discovery
   is not proactive — Bazaar indexes a resource the first time it sees a successful
   settlement, not on deploy. Use `buyer.js` (below) to trigger this yourself rather
   than waiting for an outside buyer.

Check discoverability at [agentic.market](https://agentic.market) or by querying
`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources` directly. Indexing
can take up to ~10 minutes after settlement, and the catalog API itself can be cached
for longer than that — don't panic if it's not instant.

## Testing a real payment yourself (`buyer.js`)

To trigger a real settlement (needed for both testing and Bazaar indexing), you need a
**separate buyer wallet** — never reuse your `PAY_TO_ADDRESS` wallet's private key in a
script. Fund a fresh/burner wallet with a small amount of USDC on Base (a dollar covers
thousands of calls at $0.001 each), export its private key, and add it locally:

```bash
echo "BUYER_PRIVATE_KEY=0xyourburnerkey" >> .env
npm install @x402/fetch @x402/evm viem
```

`buyer.js` isn't checked in (edit the URL inline each time you test a different route) —
it wraps `fetch` with automatic 402-handling and prints the response + settlement status:

```bash
node buyer.js
```

Look for `Payment status: settled` and a transaction hash to confirm it worked.

## Data sourcing — what's safe to add, what isn't

Before adding a new endpoint, check the data source's terms of service for resale/
redistribution restrictions. Lessons learned building this:

- **Nominatim (OpenStreetMap)** — free, but explicitly disallows this kind of bulk
  commercial resale via their usage policy. We switched to **LocationIQ**, a
  Nominatim-compatible commercial provider built for exactly this use case.
- **Commercial oil/gas price APIs** (OilPriceAPI, API Ninjas, etc.) — typically ban
  redistribution outright in their ToS, since real-time exchange data is licensed
  separately from the API subscription. **EIA** (U.S. government) has no such
  restriction and covers oil, gas, and electricity pricing.
- **EIA v2 API quirks**: the `series_id` shorthand parameter (e.g. `PET.RWTC.D`) from
  the old v1 API is fully deprecated — current valid params are `frequency`, `data`,
  `facets`, `sort`, `offset`, `length`, `api_key`. Always verify a category's actual
  route/facet structure by hitting it without `/data` first (EIA's API is
  self-documenting — it returns a list of sub-routes) rather than guessing.
- **Not every EIA category has fresh data.** Coal pricing and CO2 emissions/SEDS are
  both annual-only and lag a year or more — not worth shipping as "current price"
  endpoints. Petroleum, natural gas, and electricity retail sales are the categories
  with genuine daily/monthly freshness.
- **NWS/NOAA** — free, no key, public domain, but requires a descriptive `User-Agent`
  header (rejects requests without one) and only covers US locations.

## Extending this

The pattern for adding a new paid endpoint:
1. Check the data source's ToS for redistribution/resale restrictions
2. Verify the actual API request shape against the live API (not just docs — APIs
   change; docs lag) before writing server code
3. Add the route to the `paymentMiddleware` config with `declareDiscoveryExtension()`
   metadata, plus the actual handler
4. Commit, push, let it auto-deploy
5. Test with `buyer.js` against a real payment before considering it done

## Price floor

CDP's facilitator enforces an **undocumented minimum payment amount** somewhere between
$0.0001 and $0.001 (100–1000 atomic USDC units) — payments below it are rejected with
`"error": "amount_too_low"` in the decoded payment-required header (the raw JSON response
body is unhelpfully `{}`; the actual error only shows up if you decode the `payment-required`
header, which `buyer.js` prints). $0.001/call is confirmed to work and is also CDP's own
facilitator fee once you exceed 1,000 free settlements/month, so pricing below that is a
guaranteed loss at volume even before the rejection issue. Don't try to go lower without
re-verifying against a live settlement first.

## Pricing models

Currently using the `exact` scheme (fixed price/call) on every route for simplicity.
x402 also supports `upto` (usage-based pricing) and batch settlement for high-frequency
buyers — worth adopting once real traffic patterns justify it.
