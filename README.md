# x402 Seller — Multi-Product Data API

A live, working example of selling data to AI agents via the [x402 protocol](https://x402.org).
Agents pay per call in USDC on Base, no accounts, no API keys on their end, no subscriptions.

**Live at:** `https://x402-seller.onrender.com`

## What's for sale

| Endpoint | Sells | Price |
|---|---|---|
| `GET /geo/lookup?address=...` | Address → lat/lng + IANA timezone (LocationIQ) | $0.001 |
| `GET /geo/reverse?lat=...&lng=...` | Coordinates → place name + timezone (LocationIQ) | $0.001 |
| `GET /oil/price?benchmark=wti\|brent` | Latest daily WTI/Brent spot price (EIA) | $0.005 |
| `GET /gas/price` | Latest Henry Hub natural gas spot price (EIA) | $0.001 |
| `GET /electricity/price?state=US` | Latest US retail electricity price, national or by state (EIA) | $0.001 |
| `GET /weather/forecast?place=...` or `?lat=...&lng=...` | Worldwide weather: current conditions, next 24 hours and 7-day outlook in local time, plus active alerts for US locations (MET Norway, NWS; `&units=imperial`) | $0.01 |
| `GET /nuclear/outages` | Daily US nuclear plant outage data (NRC via EIA) | $0.001 |
| `GET /earthquakes/recent?lat=...&lng=...&radiusKm=...` or `?minmagnitude=...` | Earthquakes in the past 7 days near a point, with distance and direction, or worldwide (USGS) | $0.001 |
| `GET /currency/rate?from=...&to=...` | Official daily FX rate between 30+ currencies (ECB) | $0.008 |
| `GET /air/quality?lat=...&lng=...` | Current air quality index readings from the nearest monitors (EPA AirNow; US, Canada, Mexico) | $0.001 |
| `GET /space/asteroids?date=...` | Near-Earth asteroids by closest approach date (NASA JPL) | $0.001 |
| `GET /space/weather?alertWindowHours=24` | Geomagnetic storm level, latest solar flare and active alerts (NOAA SWPC) | $0.05 |
| `GET /route/hazards?from=lat,lng&to=lat,lng` | US driving route with active wildfires and NWS alerts along it (LocationIQ, NIFC, NWS) | $0.05 |
| `GET /chain/balance?address=...&token=...` | Live ETH + ERC20 balance on Base mainnet (Base RPC) | $0.012 |
| `GET /treasury/debt` | Latest total US national debt "to the penny" (US Treasury) | $0.001 |
| `GET /ocean/tides?station=...` or `?lat=...&lng=...` | Tide predictions (next 48h) or latest water level at US coastal stations, nearest-station lookup by coordinates (NOAA CO-OPS) | $0.001 |
| `GET /water/streamflow?site=...` | Real-time river streamflow + gauge height at US stream gauges (USGS) | $0.001 |
| `GET /water/flood-risk?site=...` | River level against official NWS flood stages, with flood category and trend (USGS, NOAA) | $0.05 |
| `GET /fire/risk?lat=...&lng=...` | Active US wildfires near a point, with fire weather and smoke (NIFC, NWS, AirNow) | $0.05 |
| `GET /payments/history?hours=24&address=...` | This seller's own recent USDC settlement history on Base (self-referential, max 72h window) | $0.001 |
| `GET /census/demographics?zip=...` | US Census ACS 5-Year population, median income, median age, and housing units by ZIP code (Census Bureau) | $0.001 |
| `GET /sec/filings-search?q=...&forms=10-K` | Full-text search across all SEC EDGAR filings since 2001, by keyword/company/topic (SEC EDGAR) | $0.05 |
| `GET /sentiment?text=...` | Financial sentiment of a headline, tweet or market post: negative, neutral or positive, with all three scores. English, up to 1,000 characters (model run on this server; see "The /sentiment model") | $0.002 |

Every endpoint is also an MCP tool at `POST /mcp`, at the same price as its HTTP route.
The prices above are set by the `PRICE_*` constants in `server.js`; the root page, the
`/.well-known/x402` manifest, the OpenAPI document and the MCP tools all read them from
there, so this table is the only copy that has to be updated by hand after a reprice.

All data sources are either explicitly licensed for commercial resale (LocationIQ),
openly licensed with attribution (MET Norway, CC BY 4.0), or official public-domain
government data with no redistribution restriction (EIA, NWS).
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
- `CENSUS_API_KEY` — free at api.census.gov/data/key_signup.html (mandatory on every call since a May 2026 policy change; official US government data)
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

`buyer.js` is checked in as a reusable scratch script — edit the URL inline each time you
test a different route, it's meant to be edited, not left clean. It wraps `fetch` with
automatic 402-handling and prints the response + settlement status:

```bash
node buyer.js
```

Look for `Payment status: settled` and a transaction hash to confirm it worked.

To pay for one route without editing anything, use `buyer-one.js`. It takes the route as
an argument (the default is the `/sentiment` example, $0.002), uses the same self-test
User-Agent as `buyer-all.js`, and prints the response, the settlement status with a Basescan
link, the header checks, and the reason when a payment is refused (low balance, amount too
low), which otherwise only shows up in the encoded `payment-required` header:

```bash
node buyer-one.js
node buyer-one.js "/currency/rate?from=USD&to=JPY"
```

`buyer-all.js` pays every route once (about $0.30 at current prices); use it after a
reprice, or to sweep everything.

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
- **EIA is slow to answer a query it has not served lately** — measured 2026-11-15 with
  the production queries: electricity for Texas took 48.3 seconds and the identical
  request straight after took 0.07; New York 62.6, then 0.07. A sweep of every route the
  evening before lost 4 of its 12 EIA calls to the 12-second limit. Buyers of these
  routes arrive days apart, so they are the ones who meet the slow start, and three
  4-second tries in place of one 12-second wait rescued only 1 failing call in 4. So
  `/oil/price`, `/gas/price`, `/electricity/price` and `/nuclear/outages` answer from
  memory: the server fetches five queries on its own clock (prices every 30 minutes,
  nuclear hourly, electricity for all states in one request every 6 hours), a buyer is
  answered at once, and every answer carries `retrievedAt`. A copy older than 6 hours
  (48 for the monthly electricity figures) is never served; then the buyer waits on EIA
  for up to 12 seconds as before. An unknown state code is now a 404 in a millisecond.
- **`/water/streamflow` retries** — `upstreamGet` tries twice (8 seconds each) when USGS
  gives no answer or a 5xx, never on a 4xx; one brief USGS 503 used to fail the call.
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
- **MET Norway (`api.met.no`)** — worldwide forecasts, no key, CC BY 4.0, commercial use
  allowed. It replaced NWS as the forecast source for `/weather/forecast` (NWS is US-only
  and now supplies only the alerts). Open-Meteo was ruled out: its free tier is
  non-commercial. MET Norway's [terms](https://api.met.no/doc/TermsOfService) are
  enforced by blocking, so the handler builds each one in: an identifying `User-Agent`
  with a contact (the repository URL), coordinates cut to 4 decimals, no repeat request
  before the response's `Expires` time and `If-Modified-Since` after it (a small
  in-memory cache), attribution with the licence link and a note of what was derived,
  and nothing that presents the service as MET Norway's, Yr's or NRK's. The terms also
  ask that a human accept them when the calling code is AI-written.
- **`/earthquakes/recent` near a point** passes `lat`/`lng`/`radiusKm` to USGS's own radius
  search (`latitude`, `longitude`, `maxradiuskm`) and adds each quake's distance and compass
  direction from the point. Near a point the default minimum magnitude is 2.5, the level
  USGS's own feeds treat as felt; at 4.5 most places would get an empty answer. Worldwide
  stays at 4.5, so a call without a location returns exactly what it did before. Outside
  the US the USGS catalogue is only complete from about M4.5, so smaller quakes there
  are mostly missing whatever the threshold.
- **Time zone names** come from `geo-tz/all`, not the package default. The default merges
  zones that have kept the same clock since 1970 and reports Oslo as `Europe/Berlin` and
  Bangkok as `Asia/Jakarta`.
- **LocationIQ's per-second limit** — the free tier takes two requests a second and refuses
  the next with `{"error":"Rate Limited Second"}`. An agent asking about several places at
  once triggers it, so every LocationIQ call goes through `locationIqGet`, which starts
  calls 600 ms apart and retries a refusal on a later turn. The per-minute and per-day
  limits are not retried; a queue longer than 8 seconds is answered with an unbilled `503`.
- **LocationIQ's search drops a trailing "City" or "Town"** — it reads the word as a kind
  of place and matches the rest: "Kansas City" came back as the state of Kansas, "Mexico
  City" as the country, "Jersey City" as Jersey County, Illinois, "Cape Town" as Cape
  Verde (49 of 60 such names tried). Its structured `city=` search and `source=v1n` do the
  same; its autocomplete endpoint does not. So when the search answer to such a name is
  not named what was asked for, `geoLookupLogic` asks autocomplete for a place of exactly
  that name, then, if the search answer was a whole county, state or country, for a city
  (`layers=city`) named without the suffix ("Quebec City" is "Quebec" on the map). A
  suggestion is used only if it is a place rather than a business or airport, has exactly
  the wanted name, and agrees with the text after the comma ("Panama City, Panama" is not
  Panama City, Florida); otherwise the search answer stands. This serves `/geo/lookup` and
  place names in `/weather/forecast`. Autocomplete is documented as a typeahead service,
  so it is only this fallback, never the first call.
- A place name resolved for `/weather/forecast` is LocationIQ (OpenStreetMap) data, so
  that response carries the ODbL credit as well as MET Norway's.
- **EPA AirNow** — free with a key, but endpoints get retired: `/aq/observation/latLong/current/`
  was switched off on 2026-09-30 and has returned `410` since, so `/air/quality` (and the
  smoke reading in `/fire/risk`) failed on every call from 2026-10-01 until the move in
  mid-November. The replacement is `/aq/observation/current/ziplatlong/` (same key). It
  returns one record per pollutant from the closest monitor, has no state code and no
  `distance` input, and signals "nothing nearby" with `HTTP 200` and a `WebServiceError`
  body rather than an empty array — the handler has to inspect the body, as with Census
  and SEC below.
- **Base public RPCs** — `mainnet.base.org` still serves balances but now refuses every
  `eth_getLogs` with `429`, so `/payments/history` reads logs from
  `base-rpc.publicnode.com` (50,000-block ranges) with `base.gateway.tenderly.co`
  (1,000-block ranges) as a slow fallback. Base's block time also changed (2 s to 0.2 s
  in early November 2026), so the handler finds its start block by timestamp instead of
  assuming a fixed number of blocks per hour.
- **US Census Bureau (ACS 5-Year)** — public domain, no resale restriction, but a
  May 2026 policy change now requires an API key on *every* call (previously ~500/day
  were free without one). A missing/invalid key doesn't error — it 302-redirects to an
  HTML page that axios follows silently, resolving as a 200 with an HTML body instead
  of the expected JSON array, so the handler must explicitly check `Array.isArray(data)`
  rather than trusting a non-error response. A ZIP with no matching Census ZCTA
  (PO-box-only or very new) returns `204 No Content`, not a 4xx — both confirmed by
  live testing, not assumed from docs. Single-ZCTA queries for the 2020+ vintage must
  omit the `in=state:XX` qualifier entirely (adding it causes a 400 "unsupported
  geography hierarchy" — the opposite of what older/pre-2020 vintages required).
- **SEC EDGAR Full-Text Search (`efts.sec.gov`)** — public domain, no key, but a
  blank/invalid query returns `HTTP 200` with an `error`/`errorMessage` field in the
  body instead of a 4xx — axios never throws, the handler must inspect the body (same
  trap as the Census 302-that-resolves-as-200 gotcha). The `size` query param is
  silently ignored server-side — every page is capped at 100 hits regardless of what
  you ask for; only `from` (offset) actually paginates. `dateRange=custom` is a
  web-UI-only param, not needed — `startdt`/`enddt` filter correctly without it.
  `hits.total.relation` flips to `"gte"` (an approximate floor, not an exact count)
  once the true match count exceeds ~10,000. Filing URL is
  `https://www.sec.gov/Archives/edgar/data/{CIK-no-leading-zeros}/{accession-with-dashes}-index.htm`,
  confirmed against SEC's own webmaster FAQ and a live 200 fetch.

## The /sentiment model

`/sentiment` is the one route with no upstream API: it runs a small model on this server.

- **Which model:** `finbert-minilm-sentiment` by Nagizaaz Shaik (MiniLM, 33M parameters,
  fine-tuned for financial sentiment), MIT License. It is served from the owner's own copy,
  [`looky/finbert-minilm-sentiment`](https://huggingface.co/looky/finbert-minilm-sentiment),
  duplicated on 2026-11-25 from `9mark9/finbert-minilm-sentiment` so the build does not
  depend on a third party keeping their repo up. `sentiment-model.js` pins the commit and
  the SHA-256 of every file; it is the only place to edit to change models.
- **How it gets onto the server:** `npm install` (Render's build command) runs
  `scripts/fetch-sentiment-model.js` as `postinstall`. It downloads the 35 MB of files
  into `models/` (gitignored), checks every hash, and fails the build if it can't, so
  Render keeps the previous deploy live instead of shipping a broken route. The server
  loads the files from disk at boot with remote loading switched off, so it never calls
  Hugging Face at runtime. If Hugging Face is down and something else has to ship, set
  `SKIP_SENTIMENT_MODEL=1` in Render's environment: the build passes and `/sentiment`
  answers 503 (not billed) until a build with the model goes out.
- **Boot and failure behavior:** the model loads in the background, like the MCP setup,
  so it can never delay or block the other routes. If it fails to load, `/sentiment`
  answers 503 and the other routes are unaffected.
- **What it costs to run:** about 150 MB of extra memory (Transformers.js ~55 MB, model
  ~100 MB) and ~4 ms of CPU per call on one core. Measured 2026-11-25 on a local copy of
  the server: 246-275 MB in total, inside Starter's 512 MB. `npm install` pulls ~745 MB
  of ONNX Runtime binaries, so the first build after this change is slower.
- **How good it is (tested 2026-11-25 against three alternatives):** 87% on 2,388 finance
  tweets (`zeroshot/twitter-financial-news-sentiment` validation; the model was trained on
  that set's training split, so this flatters it) and 75% on 933 news headlines no model
  had seen (SEntFiN), tied with a model twice its size. Top scores are often only 0.5-0.7,
  which is why all three are returned. English only: other languages tend to come back
  neutral.
- **License caveat:** the model is MIT, but its training data includes Financial
  PhraseBank, which is licensed CC BY-NC-SA 3.0 (non-commercial). Whether that restriction
  carries over to a trained model is legally unsettled. Many financial sentiment models
  share this, since PhraseBank is the standard training set. The most downloaded one,
  ProsusAI/finbert, is licensed non-commercial outright, which is why it was not used.

## Extending this

The pattern for adding a new paid endpoint:
1. Check the data source's ToS for redistribution/resale restrictions
2. Verify the actual API request shape against the live API (not just docs — APIs
   change; docs lag) before writing server code
3. Add the route to the `paymentMiddleware` config with `declareDiscoveryExtension()`
   metadata, plus the actual handler
4. Commit, push, let it auto-deploy
5. Test with `buyer-one.js` against a real payment before considering it done, and add
   the route to `buyer-all.js`

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

Every route uses the `exact` scheme (fixed price/call) — no usage-based pricing yet.
Price is no longer uniform across routes, though: most endpoints default to `$0.001`
(`PRICE_PER_LOOKUP`), but a few have their own named price constant set higher based on
real evidence (a competitor's actual on-chain settlement volume at that price, checked
directly via `eth_getLogs` against their payout wallet — not just their listed price,
which turned out to be a weak signal on its own). See `PRICE_SEC_FILINGS_SEARCH`,
`PRICE_OIL`, `PRICE_CURRENCY_RATE`, and `PRICE_CHAIN_BALANCE` in `server.js`. Two of
those bets were later reversed on this project's own sales data: the three composite
routes came down from $0.31–$0.51 to $0.05 after no outside buyer ever paid the higher
prices, and `/oil/price` went back from $0.05 to $0.005 after its sales fell from nine
a month to one.

x402 also supports `upto` (usage-based pricing) and batch settlement for high-frequency
buyers — worth adopting once real traffic patterns justify it.
