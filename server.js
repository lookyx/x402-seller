import "dotenv/config";
import express from "express";
import axios from "axios";
import { find as findTimezone } from "geo-tz";
import { XMLParser } from "fast-xml-parser";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { facilitator as cdpFacilitatorConfig } from "@coinbase/x402";
import { declareDiscoveryExtension, bazaarResourceServerExtension, withBazaar } from "@x402/extensions/bazaar";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPaymentWrapper } from "@x402/mcp";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

const PORT = process.env.PORT || 4021;
const PAY_TO = process.env.PAY_TO_ADDRESS;
const NETWORK = process.env.NETWORK || "eip155:84532";
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://x402.org/facilitator";
const USING_CDP = Boolean(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);
const LOCATIONIQ_API_KEY = process.env.LOCATIONIQ_API_KEY;
const EIA_API_KEY = process.env.EIA_API_KEY;
const AIRNOW_API_KEY = process.env.AIRNOW_API_KEY;
const NASA_API_KEY = process.env.NASA_API_KEY;
const CENSUS_API_KEY = process.env.CENSUS_API_KEY;

if (!PAY_TO) { console.error("\n❌ Missing PAY_TO_ADDRESS.\n"); process.exit(1); }
if (!LOCATIONIQ_API_KEY) { console.error("\n❌ Missing LOCATIONIQ_API_KEY.\n"); process.exit(1); }
if (!EIA_API_KEY) { console.error("\n❌ Missing EIA_API_KEY.\n"); process.exit(1); }
if (!AIRNOW_API_KEY) { console.error("\n❌ Missing AIRNOW_API_KEY.\n"); process.exit(1); }
if (!NASA_API_KEY) { console.error("\n❌ Missing NASA_API_KEY.\n"); process.exit(1); }
if (!CENSUS_API_KEY) { console.error("\n❌ Missing CENSUS_API_KEY.\n"); process.exit(1); }

const NWS_USER_AGENT = "x402-seller-starter/1.0 (contact: you@example.com)";
const SEC_USER_AGENT = "x402-seller-starter/1.0 (contact: you@example.com)";
const BASE_RPC_URL = "https://mainnet.base.org";
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

const app = express();
app.set("trust proxy", 1);

// Logs every request on completion (not just errors) so Render's free-tier
// Application Logs can substitute for the Pro-gated Request Logs / Path
// filter. One line per request, [REQ]-prefixed for easy grepping. Kept
// permanently (not removed after a single investigation like the July 2026
// 404 diagnostic logger) since it's cheap and has already proven useful for
// diagnosing traffic questions the dashboard's aggregate charts can't answer.
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - startedAt;
    console.log(`[REQ] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms ip=${req.ip} ua="${req.get("user-agent") || ""}" rid=${res.getHeader("x-request-id") || "-"}`);
  });
  next();
});

// Verifiability headers. Lets a buyer, router or index prove which call it made
// and that the bytes it received are the bytes we sent. Deliberately
// header-only: putting these in response bodies would drift from the advertised
// Bazaar/OpenAPI `example` blocks on all 20 routes, which is a real bug class
// (an agent reads the example to decide how to parse us), not a docs nit.
//
// Must stay BEFORE paymentMiddleware: the `PAYMENT-RESPONSE` mirror below works
// by intercepting res.setHeader, and x402 sets that header during settlement
// (@x402/express L341-343) just before it replays the buffered response body
// (L357-364) -- so the alias lands on the wire, but only if we wrapped first.
const REQUEST_ID_MAX = 128;
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]+$/;

// Carries the current request's identity into the x402 payment lifecycle hooks
// registered below. The hooks are invoked from inside paymentMiddleware, i.e.
// still within this request's async context, so an AsyncLocalStorage store set
// here is visible there. This is the only way to tie a [PAY] line back to its
// [REQ] line: the hook contexts carry the payment, not the HTTP request, and
// `transportContext` is the library's own adapter object rather than Express's
// req/res. Node built-in, so no new dependency.
const requestContext = new AsyncLocalStorage();

app.use((req, res, next) => {
  // An inbound header is untrusted input. Node throws on CR/LF in a header
  // value, which would turn a hostile request id into a 500, so validate
  // against a strict allowlist and fall back to a generated id.
  const inbound = req.get("x-request-id");
  const requestId =
    inbound && inbound.length <= REQUEST_ID_MAX && SAFE_REQUEST_ID.test(inbound)
      ? inbound
      : randomUUID();
  res.setHeader("x-request-id", requestId);
  res.setHeader("x-payment-network", NETWORK); // CAIP-2, e.g. eip155:8453

  // @x402/core 2.18 emits the settlement receipt as `PAYMENT-RESPONSE`, but
  // parts of the ecosystem (Agent402's router among them) still read the legacy
  // `X-PAYMENT-RESPONSE` name -- x402's own client checks both. Mirror it so the
  // settle tx is visible either way; without this a buyer reading only the
  // prefixed name concludes we return no receipt at all.
  const setHeaderDirect = res.setHeader.bind(res);
  res.setHeader = function (name, value) {
    const result = setHeaderDirect(name, value);
    if (typeof name === "string" && name.toLowerCase() === "payment-response") {
      setHeaderDirect("X-PAYMENT-RESPONSE", value);
    }
    return result;
  };

  // Everything downstream — including paymentMiddleware and therefore the
  // payment hooks — runs inside this store.
  requestContext.run(
    { requestId, path: req.path, ua: req.get("user-agent") || "" },
    next,
  );
});

const baseFacilitatorClient = USING_CDP
  ? new HTTPFacilitatorClient(cdpFacilitatorConfig)
  : new HTTPFacilitatorClient({ url: FACILITATOR_URL });

const facilitatorClient = withBazaar(baseFacilitatorClient);

const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, new ExactEvmScheme())
  .registerExtension(bazaarResourceServerExtension);

// ---------------------------------------------------------------------------
// Payment funnel logging: the three stages that actually distinguish a buyer
// from a crawler, emitted as `[PAY]` lines alongside the existing `[REQ]` ones.
//
//   verified  -> someone accepted the price and produced a valid authorization
//   canceled  -> they accepted it, but our own handler then returned >= 400
//   settled   -> a completed sale
//
// Why this matters: ~4.3k 402s/day are almost entirely non-paying crawlers and
// tell us nothing, while the handful of requests that reach `verified` are the
// only real intent signal the service produces — and until now it was generated
// and immediately discarded. A 400 from a verified payer and a 400 from a
// crawler previously produced identical log lines.
//
// Two deliberate constraints:
//   - NEVER log the raw X-PAYMENT header. It carries a signed authorization
//     (payer, nonce, amount, signature) and these lines sit in Render's logs
//     for days. Payer address, amount and tx hash only.
//   - A verified payment proves payment CAPABILITY, not organic demand. Our own
//     regression runs are the largest single source of `canceled` events, and
//     third-party settlement verifiers pay with no intent to consume. Filter by
//     payer address (and now by the self-test User-Agent) before reading any of
//     this as a customer.
//
// `transaction` is guaranteed non-optional on SettleResponse, so `settled` lines
// are self-attributing — this replaces correlating a [REQ] timestamp against an
// on-chain settlement a second later, which only ever worked because sales were
// rare enough to sit alone in a quiet window.
// ---------------------------------------------------------------------------
const payLog = (stage, fields) => {
  // Hook failures are caught and logged by the library rather than breaking the
  // request, but a logging bug must never be able to affect a payment at all.
  try {
    const ctx = requestContext.getStore();
    const parts = [
      `[PAY] ${stage}`,
      `route=${ctx?.path ?? "-"}`,
      ...Object.entries(fields)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${k}=${v}`),
      `ua="${ctx?.ua ?? ""}"`,
      `rid=${ctx?.requestId ?? "-"}`,
    ];
    console.log(parts.join(" "));
  } catch {
    /* never let instrumentation break a payment */
  }
};

resourceServer
  .onAfterVerify(async ({ result, requirements }) => {
    payLog("verified", {
      payer: result?.payer,
      amount: requirements?.amount,
      valid: result?.isValid,
      reason: result?.invalidReason,
    });
  })
  .onVerifiedPaymentCanceled(async ({ reason, responseStatus, paymentPayload, requirements }) => {
    // Reached only after a successful verify, so this is a payment-capable
    // client that our own API shape then turned away. `handler_failed` is the
    // path that fires here (runHandler sends a 4xx rather than throwing).
    payLog("canceled", {
      reason,
      status: responseStatus,
      amount: requirements?.amount,
      payer: paymentPayload?.payload?.authorization?.from,
    });
  })
  .onAfterSettle(async ({ result, requirements }) => {
    payLog("settled", {
      payer: result?.payer,
      amount: result?.amount ?? requirements?.amount,
      tx: result?.transaction,
      success: result?.success,
      error: result?.errorReason,
    });
  });

const PRICE_PER_LOOKUP = "$0.001";
const PRICE_SEC_FILINGS_SEARCH = "$0.05";
const PRICE_OIL = "$0.005";
const PRICE_CURRENCY_RATE = "$0.008";
const PRICE_CHAIN_BALANCE = "$0.012";
// Raised from the $0.001 default after this route took the project's first
// organic sale (2026-07-27). $0.01 is the catalog median, so it stays mid-market
// rather than premium. Note the sole known buyer paid $0.001, so this is a
// deliberate bet that demand survives a 10x - watch whether they return.
const PRICE_WEATHER_FORECAST = "$0.01";
// Interpreted-signal route rather than a raw lookup, so it is priced off the
// audited competitor selling the same USGS/NOAA feeds as a flood-risk answer,
// matching the ~$0.31/call they actually settle on-chain rather than this
// project's raw-data default. That is above the catalog's p90 ($0.15), which is
// deliberate: the comparable is what a buyer already pays for this answer, not
// what the median listing (which mostly earns nothing) asks for.
const PRICE_FLOOD_RISK = "$0.31";
// Composite signal across three sources (NIFC incidents + NWS fire weather +
// AirNow smoke), priced above /water/flood-risk to reflect that. Set by the
// owner. Note there is no audited competitor revenue for wildfire specifically -
// unlike SEC EDGAR and flood risk, this price rests on the composite-signal
// argument rather than on an observed comparable.
const PRICE_FIRE_RISK = "$0.39";
// Composite signal across three NOAA SWPC feeds (planetary Kp + GOES X-ray flare
// + active alerts). Set to $0.51 by explicit owner decision on 2026-07-30, making
// it the most expensive route in the catalog, above /fire/risk at $0.39.
//
// Recorded honestly so a future session does not mistake this for evidence-based
// pricing: there is NO audited competitor revenue for space weather. That is the
// same position /fire/risk was in, and /fire/risk has drawn zero organic payers
// at $0.39, while the only thing that has ever actually sold here was a $0.001
// lookup. A $0.02 median-band price was recommended and declined. This rests on
// the composite-signal argument alone.
//
// One constraint it does satisfy: Agent402's router leaderboard caps counted
// calls at maxCallUsd 0.75, so $0.51 still accrues to seller standing there.
// Anything above $0.75 would silently stop counting.
const PRICE_SPACE_WEATHER = "$0.51";
// Composite over three sources (LocationIQ routing + NIFC wildfire incidents +
// NWS active alerts). PLACEHOLDER PENDING OWNER DECISION -- there is no audited
// competitor revenue for route-hazard products, the same evidence position
// /fire/risk and /space/weather are in. Set deliberately mid-catalog (median
// $0.014, p75 $0.05) rather than assuming the premium tier.
const PRICE_ROUTE_HAZARDS = "$0.05";

// Bazaar service metadata (`serviceName` / `tags`), applied to every route below.
// Over half the catalog publishes these and this seller published none, which
// left it unmatchable to any agent filtering the catalog by structured fields
// rather than by description text.
//
// SINGLE SOURCE OF TRUTH: `ROUTE_META` reads its OpenAPI tags from this same map,
// so the catalog tags and the OpenAPI tags cannot drift apart. Defined here rather
// than next to ROUTE_META because the payment middleware compiles route configs
// eagerly at construction (`compiledRoutes` in @x402/core), so anything attached
// after `app.use(paymentMiddleware(...))` would silently never reach the catalog.
//
// Validation enforced upstream by @x402/core (zod) and @x402/extensions/bazaar:
// serviceName 1-32 printable-ASCII chars; at most 5 tags, each 1-32 printable-ASCII,
// de-duplicated case-insensitively. Values violating those are silently dropped, so
// they will NOT throw -- they just quietly fail to appear in the catalog.
// Headroom worth knowing: 5 tags are allowed and most routes here use 1-3.
const SERVICE_NAME = "Data Lookup API";
const ROUTE_TAGS = {
  "/geo/lookup": ["geo"],
  "/geo/reverse": ["geo"],
  "/oil/price": ["energy", "finance"],
  "/gas/price": ["energy", "finance"],
  "/electricity/price": ["energy"],
  "/weather/forecast": ["weather"],
  "/nuclear/outages": ["energy"],
  "/earthquakes/recent": ["geology", "hazards"],
  "/currency/rate": ["finance"],
  "/air/quality": ["environment", "weather"],
  "/space/asteroids": ["space"],
  "/chain/balance": ["blockchain"],
  "/treasury/debt": ["finance", "government"],
  "/ocean/tides": ["ocean", "weather"],
  "/water/streamflow": ["water", "environment"],
  "/water/flood-risk": ["water", "environment", "risk"],
  "/fire/risk": ["fire", "environment", "risk"],
  "/payments/history": ["finance", "transparency"],
  "/census/demographics": ["geo", "government", "demographics"],
  "/sec/filings-search": ["finance", "government"],
  "/space/weather": ["space", "weather", "risk"],
  "/route/hazards": ["geo", "routing", "fire", "weather", "risk"],
};

const PAYMENT_ROUTES = {
      "GET /geo/lookup": {
        accepts: [{ scheme: "exact", price: PRICE_PER_LOOKUP, network: NETWORK, payTo: PAY_TO }],
        description: "Forward geocode a free-text address, place name, or city (e.g. \"Tokyo, Japan\") into geographic coordinates — latitude and longitude — plus its IANA timezone. Use this to convert a location description into coordinates for mapping, distance, or timezone-aware lookups, or as the first step before coordinate-based endpoints like weather forecasts.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { address: "Tokyo, Japan" },
            inputSchema: {
              properties: { address: { type: "string", description: "Address or place name to geocode" } },
              required: ["address"],
            },
            output: {
              example: { query: "Tokyo, Japan", lat: 35.6762, lng: 139.6503, timezone: "Asia/Tokyo", display_name: "Tokyo, Japan" },
              schema: {
                properties: {
                  lat: { type: "number" }, lng: { type: "number" },
                  timezone: { type: "string" }, display_name: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /geo/reverse": {
        accepts: [{ scheme: "exact", price: PRICE_PER_LOOKUP, network: NETWORK, payTo: PAY_TO }],
        description: "Reverse geocode GPS coordinates (latitude/longitude) into a place name/address and IANA timezone.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { lat: "35.6762", lng: "139.6503" },
            inputSchema: {
              properties: {
                lat: { type: "string", description: "Latitude" },
                lng: { type: "string", description: "Longitude" },
              },
              required: ["lat", "lng"],
            },
            output: {
              example: { lat: 35.6762, lng: 139.6503, timezone: "Asia/Tokyo", display_name: "Tokyo, Japan" },
              schema: {
                properties: {
                  lat: { type: "number" }, lng: { type: "number" },
                  timezone: { type: "string" }, display_name: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /oil/price": {
        accepts: [{ scheme: "exact", price: PRICE_OIL, network: NETWORK, payTo: PAY_TO }],
        description: "Current crude oil price in USD per barrel — WTI or Brent spot price from the U.S. Energy Information Administration (EIA). Reflects the latest official daily figure, not live or real-time trading data; lags the market by several business days.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { benchmark: "wti" },
            inputSchema: {
              properties: { benchmark: { type: "string", enum: ["wti", "brent"], description: "Which crude oil benchmark to fetch" } },
              required: [],
            },
            output: {
              example: { commodity: "crude oil", benchmark: "WTI", price: 73.2, unit: "Dollars per Barrel", date: "2026-07-15", source: "U.S. Energy Information Administration (EIA)" },
              schema: {
                properties: {
                  commodity: { type: "string" }, benchmark: { type: "string" }, price: { type: "number" },
                  unit: { type: "string" }, date: { type: "string" }, source: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /gas/price": {
        accepts: [{ scheme: "exact", price: PRICE_PER_LOOKUP, network: NETWORK, payTo: PAY_TO }],
        description: "Latest Henry Hub natural gas spot price (USD/MMBtu), sourced from the U.S. Energy Information Administration. Data lags several business days behind the market; not live trading data.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: {},
            inputSchema: { properties: {}, required: [] },
            output: {
              example: { commodity: "natural gas", benchmark: "Henry Hub", price: 3.12, unit: "Dollars per Million Btu", date: "2026-07-15", source: "U.S. Energy Information Administration (EIA)" },
              schema: {
                properties: {
                  commodity: { type: "string" }, benchmark: { type: "string" }, price: { type: "number" },
                  unit: { type: "string" }, date: { type: "string" }, source: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /electricity/price": {
        accepts: [{ scheme: "exact", price: PRICE_PER_LOOKUP, network: NETWORK, payTo: PAY_TO }],
        description: "Current average U.S. retail price of electricity, in cents per kilowatt-hour (cents/kWh) — e.g. \"what's the electricity price right now\". Reflects the latest monthly data (not real-time), averaged across all sectors combined (not sector-specific), sourced from the U.S. Energy Information Administration (EIA). Optional 'state' param (2-letter code) returns that state's average instead of the national figure.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { state: "US" },
            inputSchema: {
              properties: { state: { type: "string", description: "2-letter US state code, or 'US' for national average" } },
              required: [],
            },
            output: {
              example: { region: "U.S. Total", price: 12.5, unit: "cents per kilowatt-hour", date: "2026-04", source: "U.S. Energy Information Administration (EIA)" },
              schema: {
                properties: {
                  region: { type: "string" }, price: { type: "number" },
                  unit: { type: "string" }, date: { type: "string" }, source: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /weather/forecast": {
        accepts: [{ scheme: "exact", price: PRICE_WEATHER_FORECAST, network: NETWORK, payTo: PAY_TO }],
        description: "Official U.S. National Weather Service (NWS) forecast for the next period — the nearest upcoming forecast window, e.g. today, tonight, or tomorrow — at a given latitude/longitude. US locations only. Use /geo/lookup first if you only have an address.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { lat: "38.8894", lng: "-77.0352" },
            inputSchema: {
              properties: {
                lat: { type: "string", description: "Latitude (US locations only)" },
                lng: { type: "string", description: "Longitude (US locations only)" },
              },
              required: ["lat", "lng"],
            },
            output: {
              example: {
                location: "LWX", period: "Tonight", temperature: 68, temperatureUnit: "F",
                shortForecast: "Partly Cloudy", detailedForecast: "Partly cloudy, with a low around 68.",
                windSpeed: "5 mph", windDirection: "SW", source: "National Weather Service (NOAA)",
              },
              schema: {
                properties: {
                  period: { type: "string" }, temperature: { type: "number" },
                  temperatureUnit: { type: "string" }, shortForecast: { type: "string" },
                  detailedForecast: { type: "string" }, windSpeed: { type: "string" },
                  windDirection: { type: "string" }, source: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /nuclear/outages": {
        accepts: [{ scheme: "exact", price: PRICE_PER_LOOKUP, network: NETWORK, payTo: PAY_TO }],
        description: "Current U.S. nuclear power outage levels, updated daily: nationwide total generating capacity, megawatts offline, and percent outage. Aggregate figure for the whole U.S. reactor fleet, not broken out by individual plant or reactor. Sourced from the U.S. Nuclear Regulatory Commission via EIA.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: {},
            inputSchema: { properties: {}, required: [] },
            output: {
              example: { date: "2026-07-15", capacityMw: 96731, outageMw: 3200, percentOutage: 3.3, source: "U.S. Energy Information Administration (EIA) / Nuclear Regulatory Commission" },
              schema: {
                properties: {
                  date: { type: "string" }, capacityMw: { type: "number" },
                  outageMw: { type: "number" }, percentOutage: { type: "number" }, source: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /earthquakes/recent": {
        accepts: [{ scheme: "exact", price: PRICE_PER_LOOKUP, network: NETWORK, payTo: PAY_TO }],
        description: "Check for recent significant earthquakes, quakes, or seismic activity anywhere in the world, from the past 7 days, sourced from USGS (US Geological Survey). Answers questions like \"was there an earthquake near me\", \"how strong was the recent quake in X\", or \"list major earthquakes this week\". Optional 'minmagnitude' filters by minimum magnitude (default 4.5), and 'limit' caps the number of results (default 10, max 50).",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { minmagnitude: "4.5", limit: "10" },
            inputSchema: {
              properties: {
                minmagnitude: { type: "string", description: "Minimum earthquake magnitude" },
                limit: { type: "string", description: "Max number of results (max 50)" },
              },
              required: [],
            },
            output: {
              example: {
                count: 1,
                earthquakes: [{ place: "12 km ESE of Anza, CA", magnitude: 4.6, time: "2026-07-15T19:00:38.550Z", depthKm: 10.9, lat: 33.494, lng: -116.561, url: "https://earthquake.usgs.gov/earthquakes/eventpage/ci41439016" }],
                source: "U.S. Geological Survey (USGS)",
              },
              schema: { properties: { count: { type: "number" }, earthquakes: { type: "array" }, source: { type: "string" } } },
            },
          }),
        },
      },
      "GET /currency/rate": {
        accepts: [{ scheme: "exact", price: PRICE_CURRENCY_RATE, network: NETWORK, payTo: PAY_TO }],
        description: "Currency exchange rate for converting between any two currencies (forex/FX rate), drawn from a set of 30+ major currencies, sourced from the European Central Bank's official daily reference rates. Updates once per business day (~16:00 CET) — not a live or intraday feed.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { from: "USD", to: "JPY" },
            inputSchema: {
              properties: {
                from: { type: "string", description: "3-letter currency code (default EUR)" },
                to: { type: "string", description: "3-letter currency code (default USD)" },
              },
              required: [],
            },
            output: {
              example: { from: "USD", to: "JPY", rate: 157.23, date: "2026-07-15", source: "European Central Bank (ECB)" },
              schema: {
                properties: {
                  from: { type: "string" }, to: { type: "string" },
                  rate: { type: "number" }, date: { type: "string" }, source: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /air/quality": {
        accepts: [{ scheme: "exact", price: PRICE_PER_LOOKUP, network: NETWORK, payTo: PAY_TO }],
        description: "Current U.S. EPA Air Quality Index (AQI) and pollution levels for a specific location, given latitude/longitude — use to check smog, air pollution, or whether it's safe to be outside. Sourced from the EPA AirNow program (federal/state/local/tribal agencies); covers the US, Canada, and Mexico only. Data is preliminary and unvalidated per EPA data use guidelines — not for regulatory use.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { lat: "37.7749", lng: "-122.4194" },
            inputSchema: {
              properties: {
                lat: { type: "string", description: "Latitude" },
                lng: { type: "string", description: "Longitude" },
              },
              required: ["lat", "lng"],
            },
            output: {
              example: {
                reportingArea: "San Francisco", stateCode: "CA", date: "2026-07-16", hour: 14,
                readings: [{ pollutant: "PM2.5", aqi: 42, category: "Good" }, { pollutant: "O3", aqi: 38, category: "Good" }],
                preliminary: true,
                attribution: "Data owned by federal, state, local, and tribal air quality agencies, distributed via the U.S. EPA AirNow program.",
                source: "U.S. EPA AirNow",
              },
              schema: {
                properties: {
                  reportingArea: { type: "string" }, stateCode: { type: "string" },
                  date: { type: "string" }, hour: { type: "number" },
                  readings: { type: "array" }, preliminary: { type: "boolean" },
                  attribution: { type: "string" }, source: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /space/asteroids": {
        accepts: [{ scheme: "exact", price: PRICE_PER_LOOKUP, network: NETWORK, payTo: PAY_TO }],
        description: "Near-Earth asteroids (NEOs) making their closest approach to Earth on a given date (default: today), sorted by distance -- also called close-approach or flyby data. Includes each asteroid's estimated size, relative velocity, and miss distance. Sourced from NASA JPL's Near Earth Object Web Service (NeoWs).",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { date: "2026-07-16" },
            inputSchema: {
              properties: { date: { type: "string", description: "YYYY-MM-DD, defaults to today" } },
              required: [],
            },
            output: {
              example: {
                date: "2026-07-16",
                count: 1,
                asteroids: [{
                  name: "465633 (2009 JR5)", hazardous: false,
                  diameterKmMin: 0.19, diameterKmMax: 0.43,
                  velocityKph: 28123.5, missDistanceKm: 4576123.9,
                }],
                source: "NASA JPL Near Earth Object Web Service (NeoWs)",
              },
              schema: {
                properties: {
                  date: { type: "string" }, count: { type: "number" },
                  asteroids: { type: "array" }, source: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /chain/balance": {
        accepts: [{ scheme: "exact", price: PRICE_CHAIN_BALANCE, network: NETWORK, payTo: PAY_TO }],
        description: "Check a wallet's live balance on Base mainnet: native ETH (e.g. to confirm it has enough for gas) plus an optional ERC20 token balance (e.g. USDC) when a token contract address is supplied. Sourced from Base's official public RPC.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
            inputSchema: {
              properties: {
                address: { type: "string", description: "Wallet address (0x...)" },
                token: { type: "string", description: "Optional ERC20 token contract address to also check" },
              },
              required: ["address"],
            },
            output: {
              example: {
                address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
                network: "base",
                ethBalance: 1.2345,
                token: null,
                source: "Base mainnet public RPC",
              },
              schema: {
                properties: {
                  address: { type: "string" }, network: { type: "string" },
                  ethBalance: { type: "number" }, token: { type: ["object", "null"] },
                  source: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /route/hazards": {
        accepts: [{ scheme: "exact", price: PRICE_ROUTE_HAZARDS, network: NETWORK, payTo: PAY_TO }],
        description: "Driving route between two US points, cross-checked against live hazards along the way: distance and duration, plus any active NIFC wildfires within a corridor of the route and any National Weather Service alerts in force along it. Returns the fires and alerts actually near the path, with distances, rather than a route and a separate hazard lookup.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { from: "34.0522,-118.2437", to: "32.7157,-117.1611", corridorKm: "25" },
            inputSchema: {
              properties: {
                from: { type: "string", description: "Origin as \"lat,lng\"" },
                to: { type: "string", description: "Destination as \"lat,lng\"" },
                corridorKm: { type: "string", description: "How far either side of the route to look for wildfires, km (1-100, default 25)" },
              },
              required: ["from", "to"],
            },
            output: {
              example: {
                route: {
                  distanceKm: 195.3, durationMinutes: 146.7,
                  from: { lat: 34.0522, lng: -118.2437, nearestRoad: "West 1st Street" },
                  to: { lat: 32.7157, lng: -117.1611, nearestRoad: "Broadway" },
                  samplePoints: 27,
                },
                wildfires: {
                  corridorKm: 25, countNearRoute: 1,
                  nearest: { name: "Border 2", distanceKm: 18.4, bearingFromRoute: "SE", acres: 6625, percentContained: 95, state: "US-CA" },
                  fires: [{ name: "Border 2", distanceKm: 18.4, bearingFromRoute: "SE", acres: 6625, percentContained: 95, state: "US-CA" }],
                },
                weatherAlerts: { sampledPoints: 3, count: 1, alerts: [{ event: "Wind Advisory", headline: "Wind Advisory until 8 PM PDT", severity: "Moderate", expires: "2026-08-02T20:00:00-07:00" }] },
                hazardsFound: true,
                source: "Routing by LocationIQ (data (c) OpenStreetMap contributors, ODbL 1.0); wildfire incidents from NIFC WFIGS; alerts from NOAA National Weather Service",
                attribution: "Data (c) OpenStreetMap contributors, ODbL 1.0. Routing by LocationIQ.com. Wildfire incident data courtesy of the National Interagency Fire Center (WFIGS).",
                disclaimer: "Not for emergency, evacuation or life-safety decisions. Hazard proximity is measured to sampled points along the route, not a continuous corridor.",
              },
              schema: {
                properties: {
                  route: {
                    type: "object",
                    properties: {
                      distanceKm: { type: "number" }, durationMinutes: { type: "number" },
                      from: { type: "object" }, to: { type: "object" }, samplePoints: { type: "number" },
                    },
                  },
                  wildfires: {
                    type: "object",
                    properties: {
                      corridorKm: { type: "number" }, countNearRoute: { type: "number" },
                      nearest: { type: ["object", "null"] }, fires: { type: "array" },
                    },
                  },
                  weatherAlerts: {
                    type: "object",
                    properties: { sampledPoints: { type: "number" }, count: { type: ["number", "null"] }, alerts: { type: "array" } },
                  },
                  hazardsFound: { type: "boolean" },
                  source: { type: "string" }, attribution: { type: "string" }, disclaimer: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /space/weather": {
        accepts: [{ scheme: "exact", price: PRICE_SPACE_WEATHER, network: NETWORK, payTo: PAY_TO }],
        description: "Current space weather conditions from NOAA SWPC in one call: planetary Kp index mapped to the official NOAA G-scale geomagnetic storm level, the latest GOES solar X-ray flare with both its current and peak class, and active SWPC alerts and warnings from the last 24 hours. Useful for satellite operations, GPS accuracy, HF radio, polar aviation routes and power-grid impact monitoring.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { alertWindowHours: "24" },
            inputSchema: {
              properties: { alertWindowHours: { type: "string", description: "How far back to include SWPC alerts, in hours (1-168, default 24)" } },
              required: [],
            },
            output: {
              example: {
                geomagnetic: {
                  kpIndex: 0, estimatedKp: 0, stormLevel: "G0", stormLabel: "None",
                  measuredAt: "2026-07-30T22:13:00Z",
                },
                solarFlare: {
                  currentClass: "C2.1", peakClass: "M1.9", significance: "moderate",
                  beganAt: "2026-07-30T15:53:00Z", peakAt: "2026-07-30T17:00:00Z",
                  endedAt: null, ongoing: true, satellite: 18,
                },
                alerts: [{ productId: "ALTPX1", issuedAt: "2026-07-30T19:03:19Z", code: "ALTPX1", summary: "Proton Event 10MeV Integral Flux exceeded 10pfu" }],
                alertWindowHours: 24, alertsInWindow: 3, alertsExcludedOutsideWindow: 114, alertsAvailable: true,
                source: "NOAA Space Weather Prediction Center (SWPC)",
                attribution: "Space weather data from NOAA SWPC (public domain).",
                disclaimer: "Not an official NOAA product. For authoritative alerts see swpc.noaa.gov.",
              },
              schema: {
                properties: {
                  geomagnetic: {
                    type: "object",
                    properties: {
                      kpIndex: { type: ["number", "null"] }, estimatedKp: { type: ["number", "null"] },
                      stormLevel: { type: ["string", "null"] }, stormLabel: { type: ["string", "null"] },
                      measuredAt: { type: ["string", "null"] },
                    },
                  },
                  // Every field here is nullable in practice: the whole object is null
                  // when SWPC reports no current flare, and `endedAt` is null for an
                  // ongoing one (upstream sends the literal string "Unk", normalised away).
                  solarFlare: {
                    type: ["object", "null"],
                    properties: {
                      currentClass: { type: ["string", "null"] }, peakClass: { type: ["string", "null"] },
                      significance: { type: ["string", "null"] },
                      beganAt: { type: ["string", "null"] }, peakAt: { type: ["string", "null"] },
                      endedAt: { type: ["string", "null"] },
                      ongoing: { type: "boolean" }, satellite: { type: ["number", "null"] },
                    },
                  },
                  alerts: { type: "array" },
                  alertWindowHours: { type: "number" }, alertsInWindow: { type: "number" },
                  alertsExcludedOutsideWindow: { type: "number" }, alertsAvailable: { type: "boolean" },
                  source: { type: "string" }, attribution: { type: "string" }, disclaimer: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /treasury/debt": {
        accepts: [{ scheme: "exact", price: PRICE_PER_LOOKUP, network: NETWORK, payTo: PAY_TO }],
        description: "Current total U.S. national debt outstanding — how much the U.S. government owes right now — from the Treasury's 'Debt to the Penny' data: total public debt outstanding, debt held by the public, and intragovernmental holdings. Updated each business day by the U.S. Treasury.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: {},
            inputSchema: { properties: {}, required: [] },
            output: {
              example: {
                date: "2026-07-17", totalDebt: 39581848442144.38,
                debtHeldByPublic: 31816915417245.04, intragovernmentalHoldings: 7764933024899.34,
                unit: "US dollars", source: "U.S. Department of the Treasury, Fiscal Data (Debt to the Penny)",
              },
              schema: {
                properties: {
                  date: { type: "string" }, totalDebt: { type: "number" },
                  debtHeldByPublic: { type: "number" }, intragovernmentalHoldings: { type: "number" },
                  unit: { type: "string" }, source: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /ocean/tides": {
        accepts: [{ scheme: "exact", price: PRICE_PER_LOOKUP, network: NETWORK, payTo: PAY_TO }],
        description: "U.S. coastal tide data from NOAA — when's the next high or low tide, or what's the water level right now: high/low tide predictions for the next 48 hours (product=predictions, default), or the latest observed water level (product=water_level). Identify the location by NOAA CO-OPS station ID, or just pass lat+lng and the nearest station is used automatically (distanceKm in the response says how far it is). Heights in feet above MLLW datum, times in GMT.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { lat: "37.7749", lng: "-122.4194", product: "predictions" },
            inputSchema: {
              properties: {
                station: { type: "string", description: "NOAA CO-OPS station ID (e.g. 9414290 for San Francisco); omit to resolve by lat/lng instead" },
                lat: { type: "string", description: "Latitude — used with lng to find the nearest NOAA station when no station ID is given" },
                lng: { type: "string", description: "Longitude — used with lat to find the nearest NOAA station when no station ID is given" },
                product: { type: "string", enum: ["predictions", "water_level"], description: "predictions = next 48h high/low tides (default); water_level = latest observed reading" },
              },
              required: [],
            },
            output: {
              example: {
                station: "9414290", stationName: "San Francisco", lat: 37.8063, lng: -122.4659,
                distanceKm: 6.51,
                product: "predictions", datum: "MLLW", units: "feet", timeZone: "GMT",
                tides: [{ time: "2026-07-20 11:43", heightFt: 4.222, type: "H" }],
                source: "NOAA Center for Operational Oceanographic Products and Services (CO-OPS)",
              },
              schema: {
                properties: {
                  station: { type: "string" }, stationName: { type: ["string", "null"] },
                  lat: { type: ["number", "null"] }, lng: { type: ["number", "null"] },
                  distanceKm: { type: "number", description: "Distance from the requested lat/lng to the station used; only present when resolved by lat/lng" },
                  product: { type: "string" }, datum: { type: "string" },
                  units: { type: "string" }, timeZone: { type: "string" },
                  tides: { type: "array", description: "High/low tide predictions for the next 48 hours; present only when product=predictions" },
                  time: { type: "string", description: "Observation time (GMT); present only when product=water_level" },
                  heightFt: { type: "number", description: "Observed water level in feet above MLLW; present only when product=water_level" },
                  preliminary: { type: "boolean", description: "True if the reading is preliminary/unverified; present only when product=water_level" },
                  source: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /water/streamflow": {
        accepts: [{ scheme: "exact", price: PRICE_PER_LOOKUP, network: NETWORK, payTo: PAY_TO }],
        description: "Real-time river and stream conditions at a USGS stream gauge — current streamflow/discharge (cubic feet per second) and gauge height/water level/stage (feet), i.e. how much water is flowing and how high it is right now. Data is provisional and subject to revision. Requires a USGS site number (e.g. 09380000 = Colorado River at Lees Ferry, AZ).",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { site: "09380000" },
            inputSchema: {
              properties: { site: { type: "string", description: "USGS site number (e.g. 09380000)" } },
              required: ["site"],
            },
            output: {
              example: {
                site: "09380000", siteName: "COLORADO RIVER AT LEES FERRY, AZ",
                lat: 36.8643, lng: -111.5879,
                streamflowCfs: 8770, gaugeHeightFt: 9.51, time: "2026-07-20T21:15:00.000-07:00",
                provisional: true,
                attribution: "Provisional data subject to revision. See https://waterdata.usgs.gov/nwis/help/?provisional",
                source: "U.S. Geological Survey (USGS) National Water Information System",
              },
              schema: {
                properties: {
                  site: { type: "string" }, siteName: { type: ["string", "null"] },
                  lat: { type: ["number", "null"] }, lng: { type: ["number", "null"] },
                  streamflowCfs: { type: ["number", "null"] }, gaugeHeightFt: { type: ["number", "null"] },
                  time: { type: ["string", "null"] }, provisional: { type: "boolean" },
                  attribution: { type: "string" }, source: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /water/flood-risk": {
        accepts: [{ scheme: "exact", price: PRICE_FLOOD_RISK, network: NETWORK, payTo: PAY_TO }],
        description: "Flood risk at a US river gauge: current water level measured against the official National Weather Service flood stages (action, minor, moderate, major), how many feet remain before each one is reached, and NOAA's own observed and forecast flood category. Answers \"is this river near flooding\". Takes a USGS site number or an NWS gauge ID. Not every gauge has official flood stages.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { site: "01646500" },
            inputSchema: {
              properties: {
                site: { type: "string", description: "USGS site number (e.g. 01646500)" },
                lid: { type: "string", description: "NWS gauge ID (e.g. BRKM2), as an alternative to site" },
              },
              required: [],
            },
            output: {
              example: {
                site: "01646500",
                gauge: { lid: "BRKM2", name: "Potomac River near Washington DC (Little Falls)", matchedBy: "coordinates", matchDistanceKm: 0.004 },
                observed: { stageFt: 2.89, floodCategory: "no_flooding", time: "2026-07-26T06:45:00Z" },
                forecast: { stageFt: 2.9, floodCategory: "no_flooding", time: "2026-07-26T12:00:00Z" },
                floodStagesFt: { action: 5, minor: 10, moderate: 12, major: 14 },
                feetBelowStage: { action: 2.11, minor: 7.11, moderate: 9.11, major: 11.11 },
                nextThreshold: { name: "action", stageFt: 5, feetAway: 2.11 },
                trend: "rising",
                usgs: { streamflowCfs: 2300, gaugeHeightFt: 2.89 },
                source: "NOAA/NWS National Water Prediction Service; USGS National Water Information System",
              },
              schema: {
                properties: {
                  site: { type: ["string", "null"] },
                  gauge: { type: "object" },
                  observed: { type: "object" }, forecast: { type: "object" },
                  floodStagesFt: { type: "object" }, feetBelowStage: { type: "object" },
                  nextThreshold: { type: ["object", "null"] },
                  trend: { type: ["string", "null"] },
                  usgs: { type: ["object", "null"] },
                  source: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /fire/risk": {
        accepts: [{ scheme: "exact", price: PRICE_FIRE_RISK, network: NETWORK, payTo: PAY_TO }],
        description: "Active US wildfires near a location, with distance, bearing, size in acres and containment percent for the nearest and largest, plus any National Weather Service Red Flag Warning in force and current air quality as a smoke indicator. Answers \"is there a wildfire near this place right now\". Official incident data, not a legal or emergency source.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { lat: "34.0522", lng: "-118.2437" },
            inputSchema: {
              properties: {
                lat: { type: "string", description: "Latitude" },
                lng: { type: "string", description: "Longitude" },
                radiusKm: { type: "string", description: "Search radius in km (default 100, max 500)" },
                minAcres: { type: "string", description: "Ignore fires smaller than this (default 10)" },
              },
              required: ["lat", "lng"],
            },
            output: {
              example: {
                location: { lat: 34.0522, lng: -118.2437, radiusKm: 100, minAcres: 10 },
                activeFireCount: 2,
                countTruncatedUpstream: false,
                nearest: { name: "SUMMIT", distanceKm: 42.1, bearing: "NE", acres: 2690, percentContained: 35, discovered: "2026-07-21T18:04:00.000Z", lastUpdated: "2026-07-26T17:21:56.140Z", state: "US-CA", cause: "Undetermined", complexity: null },
                largest: { name: "SUMMIT", distanceKm: 42.1, bearing: "NE", acres: 2690, percentContained: 35 },
                listTruncated: false,
                fires: [{ name: "SUMMIT", distanceKm: 42.1, bearing: "NE", acres: 2690, percentContained: 35 }],
                belowMinAcresCount: 8,
                nearestBelowMinAcres: { name: "LAC-260688", distanceKm: 21.4, bearing: "E", acres: 0.01, percentContained: null },
                fireWeather: { redFlagWarning: true, alerts: [{ event: "Red Flag Warning", headline: "Red Flag Warning in effect", severity: "Severe", expires: "2026-07-27T03:00:00Z" }] },
                airQuality: { aqi: 55, category: "Moderate", pollutant: "PM2.5", reportingArea: "Los Angeles" },
                criteria: "Wildfire incidents over 10 acres, not fully contained, still open, and updated within 14 days.",
                disclaimer: "Incident data is dynamic, provisional and not a legal document. NIFC gives no warranty as to accuracy or completeness. Not for emergency, evacuation or life-safety decisions.",
                attribution: "Wildfire incident data courtesy of the National Interagency Fire Center (WFIGS), sourced from IRWIN and the interagency wildland fire community.",
                source: "National Interagency Fire Center (WFIGS); National Weather Service (NOAA); U.S. EPA AirNow",
              },
              schema: {
                properties: {
                  location: { type: "object" },
                  activeFireCount: { type: "number" },
                  // True when the upstream itself capped the result, meaning
                  // activeFireCount is a floor rather than an exact count.
                  countTruncatedUpstream: { type: "boolean" },
                  // null when no active fire matched inside the radius.
                  nearest: { type: ["object", "null"] }, largest: { type: ["object", "null"] },
                  // `fires` holds the nearest 20 only; listTruncated says whether
                  // activeFireCount exceeds that, so the two never look contradictory.
                  listTruncated: { type: "boolean" },
                  fires: { type: "array" },
                  // Active fires excluded only for being under minAcres, plus the
                  // closest of them - so "nothing burning" is distinguishable
                  // from "something small was filtered out".
                  belowMinAcresCount: { type: "number" },
                  nearestBelowMinAcres: { type: ["object", "null"] },
                  // Both are best-effort enrichments and are null if the upstream
                  // is unavailable or has no monitor near the point.
                  fireWeather: { type: ["object", "null"] }, airQuality: { type: ["object", "null"] },
                  // States exactly which filters produced activeFireCount.
                  criteria: { type: "string" },
                  disclaimer: { type: "string" }, attribution: { type: "string" }, source: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /payments/history": {
        accepts: [{ scheme: "exact", price: PRICE_PER_LOOKUP, network: NETWORK, payTo: PAY_TO }],
        description: "This seller's own recent USDC settlement history on Base mainnet — every payment received, with transaction hash, payer address, amount, and block number. Use it to confirm whether a specific payment settled, or to audit real payment volume; verifiable on any Base block explorer. Bounded to a recent rolling window (default 24h, max 72h) to keep responses fast. Optional 'address' param filters to one payer wallet.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { hours: "24" },
            inputSchema: {
              properties: {
                hours: { type: "string", description: "Lookback window in hours, default 24, max 72" },
                address: { type: "string", description: "Optional: filter to payments from this one payer wallet (0x...)" },
              },
              required: [],
            },
            output: {
              example: {
                payTo: "0xbd61dfb01f81c91f02b0ccd51b0220e0c8918639",
                windowHours: 24,
                count: 1,
                payments: [{ txHash: "0x2b4e98bfedc3311d02fbf673fc6a62475600aca34db837744e685661478ae001", from: "0x6bae57ad66659cdf660e0874d948226696299c71", amountUsdc: 0.001, block: 48989927 }],
                note: "Settlements to this seller's own wallet on Base mainnet, USDC only, over the last 24 hour(s) (max 72). Independently verifiable on any Base block explorer.",
                source: "Base mainnet public RPC (on-chain USDC Transfer event logs)",
              },
              schema: {
                properties: {
                  payTo: { type: "string" }, windowHours: { type: "number" },
                  filteredByPayer: { type: "string" }, count: { type: "number" },
                  payments: { type: "array" }, note: { type: "string" }, source: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /census/demographics": {
        accepts: [{ scheme: "exact", price: PRICE_PER_LOOKUP, network: NETWORK, payTo: PAY_TO }],
        description: "US Census Bureau American Community Survey (ACS) 5-Year estimates for a ZIP code: total population, median household income, median age, and total housing units. ZIP codes map to Census ZCTAs (Census-drawn approximations); some ZIPs (PO-box-only or very new) have no ZCTA match and return 404. Reflects a rolling 5-year survey window, not real-time.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { zip: "10001" },
            inputSchema: {
              properties: { zip: { type: "string", description: "5-digit US ZIP code" } },
              required: ["zip"],
            },
            output: {
              example: {
                zip: "10001", zcta: "10001", name: "ZCTA5 10001",
                population: 30511, medianHouseholdIncome: 129852, medianAge: 35.8, housingUnits: 18356,
                vintage: "2020-2024", source: "U.S. Census Bureau American Community Survey (ACS) 5-Year Estimates",
              },
              schema: {
                properties: {
                  zip: { type: "string" }, zcta: { type: "string" }, name: { type: ["string", "null"] },
                  population: { type: ["number", "null"] }, medianHouseholdIncome: { type: ["number", "null"] },
                  medianAge: { type: ["number", "null"] }, housingUnits: { type: ["number", "null"] },
                  vintage: { type: "string" }, source: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /sec/filings-search": {
        accepts: [{ scheme: "exact", price: PRICE_SEC_FILINGS_SEARCH, network: NETWORK, payTo: PAY_TO }],
        description: "Full-text search across every SEC EDGAR filing since 2001 (10-K, 10-Q, 8-K, and more) by keyword, company name, or topic. Returns matching filings: company name, ticker (if available), CIK, form type, filing date, accession number, SIC code, and a direct link to the filing. Optional forms filters by comma-separated form type(s); startdt/enddt filter by filing date (YYYY-MM-DD).",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { q: "chip shortage", forms: "10-K" },
            inputSchema: {
              properties: {
                q: { type: "string", description: "Search phrase; quote for an exact phrase match" },
                forms: { type: "string", description: "Comma-separated SEC form types, e.g. '10-K,8-K'" },
                startdt: { type: "string", description: "Filing date range start, YYYY-MM-DD" },
                enddt: { type: "string", description: "Filing date range end, YYYY-MM-DD" },
                limit: { type: "string", description: "Max number of results (default 10, max 50)" },
              },
              required: ["q"],
            },
            output: {
              example: {
                query: "chip shortage", totalMatches: 227, totalMatchesApproximate: false, count: 1,
                filings: [{ company: "STRATTEC SECURITY CORP", ticker: "STRT", cik: 933034, formType: "10-K",
                  filingDate: "2022-09-08", accessionNumber: "0001564590-22-031301", sic: "3714",
                  filingUrl: "https://www.sec.gov/Archives/edgar/data/933034/0001564590-22-031301-index.htm" }],
                source: "U.S. Securities and Exchange Commission (SEC) EDGAR Full-Text Search",
              },
              schema: {
                properties: {
                  query: { type: "string" }, totalMatches: { type: "number" },
                  totalMatchesApproximate: { type: "boolean" }, count: { type: "number" },
                  filings: { type: "array" }, source: { type: "string" },
                },
              },
            },
          }),
        },
      },
};

// Attach the Bazaar service metadata to every paid route. Derived rather than
// hand-written per route so a new endpoint picks it up by adding one ROUTE_TAGS
// entry -- the same reason PAID_PATHS and the boot-log route list are derived.
for (const [key, config] of Object.entries(PAYMENT_ROUTES)) {
  const path = key.split(" ")[1];
  config.serviceName = SERVICE_NAME;
  const tags = ROUTE_TAGS[path];
  if (tags) config.tags = tags;
  else console.warn(`[bazaar] no ROUTE_TAGS entry for ${path} - it will publish without tags`);
}

// Block HEAD on paid routes before the paywall runs. PAYMENT_ROUTES keys are
// method-qualified ("GET /oil/price") and x402 matches them exactly, but
// Express routes HEAD to app.get() handlers by default — so a HEAD skipped the
// paywall entirely and ran the handler for free. No body is returned (HTTP
// strips HEAD bodies), but it still burned upstream API quota on every call and
// leaked an ETag, which is a content hash: polling HEAD revealed the exact
// moment a price changed without paying. 405 rather than 402 because a paid
// HEAD would settle a payment and return no data; clients that HEAD-then-GET
// just fall through to the GET and get a proper 402.
// Paths are normalized (lowercase, no trailing slash) to match Express's own
// case-insensitive, trailing-slash-tolerant routing — otherwise "HEAD /Gas/Price"
// would slip past this guard and still reach the handler.
const normalizeRoutePath = (p) =>
  (p.length > 1 ? p.replace(/\/+$/, "") : p).toLowerCase();

const PAID_PATHS = new Set(
  Object.keys(PAYMENT_ROUTES).map((key) => normalizeRoutePath(key.slice(key.indexOf(" ") + 1)))
);

app.use((req, res, next) => {
  if (req.method === "HEAD" && PAID_PATHS.has(normalizeRoutePath(req.path))) {
    return res.status(405).set("Allow", "GET").end();
  }
  next();
});

app.use(paymentMiddleware(PAYMENT_ROUTES, resourceServer));

app.get("/", (req, res) => {
  res.json({
    name: "Data Lookup API",
    status: "live",
    commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) || "dev",
    paid_endpoints: [
      "GET /geo/lookup?address=...",
      "GET /geo/reverse?lat=...&lng=...",
      "GET /oil/price?benchmark=wti|brent (crude oil spot price)",
      "GET /gas/price (Henry Hub natural gas spot price)",
      "GET /electricity/price?state=US",
      "GET /weather/forecast?lat=...&lng=... (US only)",
      "GET /nuclear/outages",
      "GET /earthquakes/recent?minmagnitude=4.5&limit=10",
      "GET /currency/rate?from=USD&to=JPY",
      "GET /air/quality?lat=...&lng=... (US/CA/MX only)",
      "GET /space/asteroids?date=YYYY-MM-DD",
      "GET /space/weather?alertWindowHours=24 (NOAA SWPC Kp/G-scale, solar flare, active alerts)",
      "GET /route/hazards?from=lat,lng&to=lat,lng (US driving route + wildfires and NWS alerts along it)",
      "GET /chain/balance?address=0x...&token=0x... (optional)",
      "GET /treasury/debt",
      "GET /ocean/tides?station=... or lat=...&lng=... (&product=predictions|water_level, US coastal stations)",
      "GET /water/streamflow?site=09380000 (US stream gauges)",
      "GET /water/flood-risk?site=01646500 (river level vs official NWS flood stages)",
      "GET /fire/risk?lat=34.0522&lng=-118.2437 (active wildfires near a point, with fire weather)",
      "GET /payments/history?hours=24&address=0x... (this seller's own settlement history, max 72h)",
      "GET /census/demographics?zip=10001 (US Census ACS 5-Year population/income/age/housing by ZIP)",
      "GET /sec/filings-search?q=chip+shortage&forms=10-K (full-text search across all SEC EDGAR filings since 2001)",
    ],
    price_per_call: PRICE_PER_LOOKUP,
    protocol: "x402",
    network: NETWORK,
    machine_readable: { openapi: "/openapi.json", x402_manifest: "/.well-known/x402", mcp: "POST /mcp (Streamable HTTP, stateless)" },
    facilitator: USING_CDP ? "CDP (authenticated)" : FACILITATOR_URL,
    attribution: "Data (c) OpenStreetMap contributors, ODbL 1.0. Geocoding and routing by LocationIQ.com. Energy data from EIA. Weather, tide and flood-stage data from NOAA. Earthquake and streamflow data from USGS. Wildfire incident data from the National Interagency Fire Center (WFIGS). Exchange rates from ECB. Air quality from EPA AirNow. Asteroid data from NASA JPL. Space weather data from NOAA Space Weather Prediction Center (SWPC). Chain data from Base public RPC. National debt data from U.S. Treasury Fiscal Data. Demographic data from U.S. Census Bureau. Filing search data from U.S. SEC EDGAR.",
  });
});

app.get("/health", (req, res) => res.json({ ok: true }));

// ---- Machine-readable discovery documents (/openapi.json, /.well-known/x402) ----
// Generated by introspecting PAYMENT_ROUTES so route data stays defined once.
// Consumed by x402 ecosystem crawlers/routers (e.g. Agent402) for search ranking.

const BASE_URL = (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const DEPLOY_VERSION = process.env.RENDER_GIT_COMMIT?.slice(0, 7) || "dev";

// operationId is the search slug in aggregator rankings; summary is the display name.
const ROUTE_META = {
  "/geo/lookup": { operationId: "geoLookup", summary: "Forward geocode an address to coordinates and timezone", tags: ROUTE_TAGS["/geo/lookup"] },
  "/geo/reverse": { operationId: "geoReverse", summary: "Reverse geocode coordinates to a place name and timezone", tags: ROUTE_TAGS["/geo/reverse"] },
  "/oil/price": { operationId: "oilPrice", summary: "Latest WTI or Brent crude oil spot price", tags: ROUTE_TAGS["/oil/price"] },
  "/gas/price": { operationId: "gasPrice", summary: "Latest Henry Hub natural gas spot price", tags: ROUTE_TAGS["/gas/price"] },
  "/electricity/price": { operationId: "electricityPrice", summary: "Latest US retail electricity price", tags: ROUTE_TAGS["/electricity/price"] },
  "/weather/forecast": { operationId: "weatherForecast", summary: "Official US weather forecast by coordinates", tags: ROUTE_TAGS["/weather/forecast"] },
  "/nuclear/outages": { operationId: "nuclearOutages", summary: "Daily US nuclear power plant outage data", tags: ROUTE_TAGS["/nuclear/outages"] },
  "/earthquakes/recent": { operationId: "earthquakesRecent", summary: "Recent significant earthquakes worldwide", tags: ROUTE_TAGS["/earthquakes/recent"] },
  "/currency/rate": { operationId: "currencyRate", summary: "Official daily currency exchange rate", tags: ROUTE_TAGS["/currency/rate"] },
  "/air/quality": { operationId: "airQuality", summary: "Current US air quality index readings", tags: ROUTE_TAGS["/air/quality"] },
  "/space/asteroids": { operationId: "spaceAsteroids", summary: "Near-Earth asteroids by closest approach date", tags: ROUTE_TAGS["/space/asteroids"] },
  "/chain/balance": { operationId: "chainBalance", summary: "Base mainnet wallet ETH and ERC20 balance", tags: ROUTE_TAGS["/chain/balance"] },
  "/treasury/debt": { operationId: "treasuryDebt", summary: "US national debt to the penny", tags: ROUTE_TAGS["/treasury/debt"] },
  "/ocean/tides": { operationId: "oceanTides", summary: "US tide predictions and observed water levels", tags: ROUTE_TAGS["/ocean/tides"] },
  "/water/streamflow": { operationId: "waterStreamflow", summary: "Real-time US river streamflow and gauge height", tags: ROUTE_TAGS["/water/streamflow"] },
  "/water/flood-risk": { operationId: "waterFloodRisk", summary: "US river level vs official NWS flood stages, with flood category and trend", tags: ROUTE_TAGS["/water/flood-risk"] },
  "/fire/risk": { operationId: "fireRisk", summary: "Active US wildfires near a location, with fire weather and smoke", tags: ROUTE_TAGS["/fire/risk"] },
  "/payments/history": { operationId: "paymentsHistory", summary: "This seller's own recent USDC settlement history on Base", tags: ROUTE_TAGS["/payments/history"] },
  "/census/demographics": { operationId: "censusDemographics", summary: "US Census ACS 5-Year demographics by ZIP code", tags: ROUTE_TAGS["/census/demographics"] },
  "/sec/filings-search": { operationId: "secFilingsSearch", summary: "Full-text search across all SEC EDGAR filings since 2001", tags: ROUTE_TAGS["/sec/filings-search"] },
  "/route/hazards": { operationId: "routeHazards", summary: "Driving route with active wildfires and weather alerts along it", tags: ROUTE_TAGS["/route/hazards"] },
  "/space/weather": { operationId: "spaceWeather", summary: "Current geomagnetic storm level, solar flare activity and NOAA space weather alerts", tags: ROUTE_TAGS["/space/weather"] },
};

function routeEntries() {
  return Object.entries(PAYMENT_ROUTES).map(([key, config]) => {
    const [method, path] = key.split(" ");
    return { method, path, config, meta: ROUTE_META[path] || {} };
  });
}

function buildOpenApi() {
  const paths = {};
  for (const { method, path, config, meta } of routeEntries()) {
    const bazaar = config.extensions?.bazaar;
    const qp = bazaar?.schema?.properties?.input?.properties?.queryParams || {};
    const required = qp.required || [];
    const parameters = Object.entries(qp.properties || {}).map(([name, schema]) => ({
      name,
      in: "query",
      required: required.includes(name),
      ...(schema.description ? { description: schema.description } : {}),
      schema: { type: schema.type || "string", ...(schema.enum ? { enum: schema.enum } : {}) },
    }));
    paths[path] = {
      [method.toLowerCase()]: {
        operationId: meta.operationId,
        summary: meta.summary,
        description: config.description,
        tags: meta.tags,
        // Read the route's OWN price, not the default constant. This was hardcoded
        // to PRICE_PER_LOOKUP and so advertised "$0.001" for every route since
        // pricing stopped being uniform -- /fire/risk was published at $0.001 in
        // the OpenAPI doc while actually charging $0.39, a 390x understatement.
        // Agent402's search ranking reads x-price from this document, and an agent
        // budgeting from it would be surprised by the real 402 amount.
        "x-price": config.accepts?.[0]?.price ?? PRICE_PER_LOOKUP,
        "x-payment-info": {
          protocol: "x402", scheme: "exact", network: NETWORK,
          price: config.accepts?.[0]?.price ?? PRICE_PER_LOOKUP, currency: "USDC",
        },
        parameters,
        responses: {
          200: {
            description: "Success",
            content: {
              "application/json": {
                ...(bazaar?.schema?.properties?.output?.properties?.example
                  ? { schema: bazaar.schema.properties.output.properties.example }
                  : {}),
                ...(bazaar?.info?.output?.example ? { example: bazaar.info.output.example } : {}),
              },
            },
          },
          402: { description: "Payment Required — x402 protocol. Retry the request with a signed X-PAYMENT header; payment requirements are in this response's body." },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Data Lookup API (x402-seller)",
      version: DEPLOY_VERSION,
      description: `Pay-per-call data API for AI agents via the x402 protocol. Every endpoint costs ${PRICE_PER_LOOKUP} in USDC on Base — no accounts, no API keys. Call any endpoint, receive a 402 with payment requirements, retry with a signed payment header.`,
    },
    servers: [{ url: BASE_URL }],
    tags: [...new Set(Object.values(ROUTE_META).flatMap((m) => m.tags))].map((t) => ({ name: t })),
    paths,
  };
}

function buildX402Manifest() {
  return {
    spec: "agent402-service-manifest/1",
    version: 1,
    name: "Data Lookup API (x402-seller)",
    summary: "21 pay-per-call data endpoints for AI agents: geocoding, energy prices, weather, tides, streamflow, river flood risk, wildfire risk, earthquakes, air quality, FX rates, US treasury debt, asteroids, on-chain balances, US Census demographics, SEC EDGAR filing search, space weather, and this seller's own settlement history. Sourced from licensed, public-domain, and on-chain providers.",
    homepage: BASE_URL,
    repository: "https://github.com/lookyx/x402-seller",
    resources: routeEntries().map(({ path }) => `${BASE_URL}${path}`),
    payment: {
      protocol: "x402",
      scheme: "exact",
      network: NETWORK,
      currency: "USDC",
      pricePerCall: PRICE_PER_LOOKUP,
      payTo: PAY_TO,
      facilitator: USING_CDP ? "CDP" : FACILITATOR_URL,
    },
    mcp: {
      remoteConnector: `${BASE_URL}/mcp`,
      remoteNote: "Streamable HTTP, stateless, no auth to connect — initialize and tools/list are free; each tool call costs $0.001 in USDC on Base, paid in-band via x402 (_meta[\"x402/payment\"]). x402-aware MCP clients pay automatically; other clients receive the payment requirements as a structured tool result.",
    },
    machineReadable: { openapi: `${BASE_URL}/openapi.json`, mcp: `${BASE_URL}/mcp` },
    attribution: "Data (c) OpenStreetMap contributors, ODbL 1.0. Geocoding and routing by LocationIQ.com. Energy data from EIA. Weather, tide and flood-stage data from NOAA. Earthquake and streamflow data from USGS. Wildfire incident data from the National Interagency Fire Center (WFIGS). Exchange rates from ECB. Air quality from EPA AirNow. Asteroid data from NASA JPL. Space weather data from NOAA Space Weather Prediction Center (SWPC). Chain data from Base public RPC. National debt data from U.S. Treasury Fiscal Data. Demographic data from U.S. Census Bureau. Filing search data from U.S. SEC EDGAR.",
  };
}

const openApiDoc = buildOpenApi();
const x402Manifest = buildX402Manifest();

app.get("/openapi.json", (req, res) => {
  res.set("Cache-Control", "public, max-age=3600");
  res.json(openApiDoc);
});

app.get("/.well-known/x402", (req, res) => {
  res.set("Cache-Control", "public, max-age=3600");
  res.json(x402Manifest);
});

// Handlers are factored into plain logic functions (throwing HttpError on failure)
// so the same code serves both the Express routes and the MCP tools at /mcp.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Serialises once and hashes the exact bytes that go on the wire, so
// `x-response-hash` is verifiable by the caller. Deliberately does NOT use
// res.json(), which would re-serialise and could in principle produce different
// bytes than the ones we hashed (json spaces/replacer settings) -- a hash that
// doesn't match the body is worse than no hash, because it reads as tampering.
function sendJson(res, status, body) {
  const raw = JSON.stringify(body);
  res.setHeader("x-response-hash", `sha256:${createHash("sha256").update(raw).digest("hex")}`);
  return res.status(status).type("json").send(raw);
}

async function runHandler(res, fn) {
  try {
    sendJson(res, 200, await fn());
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err.response?.data || err.message);
    sendJson(res, 500, { error: "Internal error" });
  }
}

async function geoLookupLogic({ address }) {
  if (!address) throw new HttpError(400, "Missing required query param: address");
  try {
    const { data } = await axios.get("https://us1.locationiq.com/v1/search", {
      params: { key: LOCATIONIQ_API_KEY, q: address, format: "json", limit: 1 },
    });
    if (!data || data.length === 0) throw new HttpError(404, "No match found for that address");
    const { lat, lon, display_name } = data[0];
    const tzMatches = findTimezone(parseFloat(lat), parseFloat(lon));
    return { query: address, lat: parseFloat(lat), lng: parseFloat(lon), timezone: tzMatches[0] || null, display_name };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream geocoding lookup failed");
  }
}
app.get("/geo/lookup", (req, res) => runHandler(res, () => geoLookupLogic(req.query)));

async function geoReverseLogic({ lat, lng }) {
  if (!lat || !lng) throw new HttpError(400, "Missing required query params: lat, lng");
  try {
    const { data } = await axios.get("https://us1.locationiq.com/v1/reverse", {
      params: { key: LOCATIONIQ_API_KEY, lat, lon: lng, format: "json" },
    });
    const tzMatches = findTimezone(parseFloat(lat), parseFloat(lng));
    return { lat: parseFloat(lat), lng: parseFloat(lng), timezone: tzMatches[0] || null, display_name: data?.display_name || null };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream reverse geocoding lookup failed");
  }
}
app.get("/geo/reverse", (req, res) => runHandler(res, () => geoReverseLogic(req.query)));

// EIA returns numeric fields as JSON strings ("13.83") even though its own
// schema promises numbers, so every numeric field taken from it must be coerced
// or the route silently violates its published output schema. Returns null
// rather than NaN on junk: JSON.stringify would render NaN as null anyway, so
// being explicit keeps the contract honest instead of accidental.
const eiaNum = (v) => {
  if (v == null) return null;
  // Number("") is 0, which would report a missing field as a real zero price.
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function oilPriceLogic({ benchmark }) {
  const benchmarkParam = (benchmark || "wti").toLowerCase();
  const seriesMap = { wti: { code: "RWTC", label: "WTI" }, brent: { code: "RBRTE", label: "Brent" } };
  const chosen = seriesMap[benchmarkParam];
  if (!chosen) throw new HttpError(400, "benchmark must be 'wti' or 'brent'");
  try {
    const { data } = await axios.get("https://api.eia.gov/v2/petroleum/pri/spt/data", {
      params: {
        api_key: EIA_API_KEY, frequency: "daily", "data[0]": "value",
        "facets[series][]": chosen.code, "sort[0][column]": "period", "sort[0][direction]": "desc", length: 1,
      },
    });
    const points = data?.response?.data || [];
    if (points.length === 0) throw new HttpError(502, "No data returned from EIA");
    const latest = points[0];
    // Same reasoning as /gas/price: "WTI"/"Brent" identify the benchmark but
    // never say crude oil. Fixed together rather than one at a time -- gotcha #24
    // exists because a previous fix covered 2 of 4 EIA routes and the other 2
    // stayed broken for weeks.
    return { commodity: "crude oil", benchmark: chosen.label, price: eiaNum(latest.value), unit: latest.units || "Dollars per Barrel", date: latest.period, source: "U.S. Energy Information Administration (EIA)" };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream EIA lookup failed");
  }
}
app.get("/oil/price", (req, res) => runHandler(res, () => oilPriceLogic(req.query)));

async function gasPriceLogic() {
  try {
    const { data } = await axios.get("https://api.eia.gov/v2/natural-gas/pri/fut/data", {
      params: {
        api_key: EIA_API_KEY, frequency: "daily", "data[0]": "value",
        "facets[series][]": "RNGWHHD", "sort[0][column]": "period", "sort[0][direction]": "desc", length: 1,
      },
    });
    const points = data?.response?.data || [];
    if (points.length === 0) throw new HttpError(502, "No data returned from EIA");
    const latest = points[0];
    // "commodity" is explicit because the route name is not: in US usage "gas"
    // means gasoline, so an agent could reasonably read /gas/price as pump prices
    // and receive a wholesale natural gas figure with no way to detect the
    // mismatch. "Henry Hub" and "Dollars per Million Btu" only imply natural gas
    // to a reader who already knows the domain.
    return { commodity: "natural gas", benchmark: "Henry Hub", price: eiaNum(latest.value), unit: latest.units || "Dollars per Million Btu", date: latest.period, source: "U.S. Energy Information Administration (EIA)" };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream EIA lookup failed");
  }
}
app.get("/gas/price", (req, res) => runHandler(res, () => gasPriceLogic(req.query)));

async function electricityPriceLogic(args) {
  const state = (args.state || "US").toUpperCase();
  try {
    const { data } = await axios.get("https://api.eia.gov/v2/electricity/retail-sales/data", {
      params: {
        api_key: EIA_API_KEY, frequency: "monthly", "data[0]": "price",
        "facets[stateid][]": state, "facets[sectorid][]": "ALL",
        "sort[0][column]": "period", "sort[0][direction]": "desc", length: 1,
      },
    });
    const points = data?.response?.data || [];
    if (points.length === 0) throw new HttpError(404, `No data found for state '${state}'`);
    const latest = points[0];
    return { region: latest.stateDescription || state, price: eiaNum(latest.price), unit: "cents per kilowatt-hour", date: latest.period, source: "U.S. Energy Information Administration (EIA)" };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream EIA lookup failed");
  }
}
app.get("/electricity/price", (req, res) => runHandler(res, () => electricityPriceLogic(req.query)));

async function weatherForecastLogic({ lat, lng }) {
  if (!lat || !lng) throw new HttpError(400, "Missing required query params: lat, lng");
  try {
    const pointsResp = await axios.get(`https://api.weather.gov/points/${lat},${lng}`, {
      headers: { "User-Agent": NWS_USER_AGENT },
    });
    const forecastUrl = pointsResp.data?.properties?.forecast;
    const gridId = pointsResp.data?.properties?.gridId;
    if (!forecastUrl) throw new HttpError(502, "Could not resolve forecast URL for this location");
    const forecastResp = await axios.get(forecastUrl, { headers: { "User-Agent": NWS_USER_AGENT } });
    const period = forecastResp.data?.properties?.periods?.[0];
    if (!period) throw new HttpError(502, "No forecast data available for this location");
    return {
      location: gridId || null, period: period.name, temperature: period.temperature,
      temperatureUnit: period.temperatureUnit, shortForecast: period.shortForecast,
      detailedForecast: period.detailedForecast, windSpeed: period.windSpeed,
      windDirection: period.windDirection, source: "National Weather Service (NOAA)",
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err.response?.status === 404) throw new HttpError(404, "Location outside NWS coverage (US only)");
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream NWS lookup failed");
  }
}
app.get("/weather/forecast", (req, res) => runHandler(res, () => weatherForecastLogic(req.query)));

async function nuclearOutagesLogic() {
  try {
    const { data } = await axios.get("https://api.eia.gov/v2/nuclear-outages/us-nuclear-outages/data", {
      params: {
        api_key: EIA_API_KEY, frequency: "daily",
        "data[0]": "capacity", "data[1]": "outage", "data[2]": "percentOutage",
        "sort[0][column]": "period", "sort[0][direction]": "desc", length: 1,
      },
    });
    const points = data?.response?.data || [];
    if (points.length === 0) throw new HttpError(502, "No data returned from EIA");
    const latest = points[0];
    return {
      date: latest.period, capacityMw: eiaNum(latest.capacity), outageMw: eiaNum(latest.outage),
      percentOutage: eiaNum(latest.percentOutage), source: "U.S. Energy Information Administration (EIA) / Nuclear Regulatory Commission",
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream EIA lookup failed");
  }
}
app.get("/nuclear/outages", (req, res) => runHandler(res, () => nuclearOutagesLogic(req.query)));

async function earthquakesRecentLogic(args) {
  const minmagnitude = args.minmagnitude || "4.5";
  const limit = Math.min(parseInt(args.limit, 10) || 10, 50);
  const endtime = new Date();
  const starttime = new Date(endtime.getTime() - 7 * 24 * 60 * 60 * 1000);
  try {
    const { data } = await axios.get("https://earthquake.usgs.gov/fdsnws/event/1/query", {
      params: { format: "geojson", starttime: starttime.toISOString(), endtime: endtime.toISOString(), minmagnitude, orderby: "time", limit },
    });
    const features = data?.features || [];
    const earthquakes = features.map((f) => ({
      place: f.properties?.place ?? null, magnitude: f.properties?.mag ?? null,
      time: f.properties?.time ? new Date(f.properties.time).toISOString() : null,
      depthKm: f.geometry?.coordinates?.[2] ?? null, lat: f.geometry?.coordinates?.[1] ?? null,
      lng: f.geometry?.coordinates?.[0] ?? null, url: f.properties?.url ?? null,
    }));
    return { count: earthquakes.length, earthquakes, source: "U.S. Geological Survey (USGS)" };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream USGS lookup failed");
  }
}
app.get("/earthquakes/recent", (req, res) => runHandler(res, () => earthquakesRecentLogic(req.query)));

async function currencyRateLogic(args) {
  const from = (args.from || "EUR").toUpperCase();
  const to = (args.to || "USD").toUpperCase();
  try {
    const { data: xml } = await axios.get("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml");
    const parsed = xmlParser.parse(xml);
    const dayCube = parsed["gesmes:Envelope"]?.Cube?.Cube;
    const date = dayCube?.time;
    const rateEntries = dayCube?.Cube;
    const rateList = (Array.isArray(rateEntries) ? rateEntries : [rateEntries]).filter(Boolean);
    const rates = { EUR: 1 };
    for (const entry of rateList) rates[entry.currency] = parseFloat(entry.rate);
    if (!(from in rates)) throw new HttpError(400, `Unknown currency code: ${from}`);
    if (!(to in rates)) throw new HttpError(400, `Unknown currency code: ${to}`);
    const rate = rates[to] / rates[from];
    return { from, to, rate: Number(rate.toFixed(6)), date, source: "European Central Bank (ECB)" };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream ECB lookup failed");
  }
}
app.get("/currency/rate", (req, res) => runHandler(res, () => currencyRateLogic(req.query)));

async function airQualityLogic({ lat, lng }) {
  if (!lat || !lng) throw new HttpError(400, "Missing required query params: lat, lng");
  try {
    const { data } = await axios.get("https://www.airnowapi.org/aq/observation/latLong/current/", {
      params: { format: "application/json", latitude: lat, longitude: lng, distance: 25, API_KEY: AIRNOW_API_KEY },
    });
    if (!Array.isArray(data) || data.length === 0) throw new HttpError(404, "No air quality data available near this location");
    const first = data[0];
    const readings = data.map((r) => ({ pollutant: r.ParameterName, aqi: r.AQI, category: r.Category?.Name }));
    return {
      reportingArea: first.ReportingArea, stateCode: first.StateCode,
      date: first.DateObserved?.trim(), hour: first.HourObserved, readings, preliminary: true,
      attribution: "Data owned by federal, state, local, and tribal air quality agencies, distributed via the U.S. EPA AirNow program. Preliminary, unvalidated data — not for regulatory use.",
      source: "U.S. EPA AirNow",
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream AirNow lookup failed");
  }
}
app.get("/air/quality", (req, res) => runHandler(res, () => airQualityLogic(req.query)));

async function spaceAsteroidsLogic(args) {
  const date = args.date || new Date().toISOString().slice(0, 10);
  try {
    const { data } = await axios.get("https://api.nasa.gov/neo/rest/v1/feed", {
      params: { start_date: date, end_date: date, api_key: NASA_API_KEY },
    });
    const dayList = data?.near_earth_objects?.[date] || [];
    const asteroids = dayList
      .map((neo) => {
        const approach = neo.close_approach_data?.[0];
        return {
          name: neo.name, hazardous: neo.is_potentially_hazardous_asteroid,
          diameterKmMin: neo.estimated_diameter?.kilometers?.estimated_diameter_min ?? null,
          diameterKmMax: neo.estimated_diameter?.kilometers?.estimated_diameter_max ?? null,
          velocityKph: approach?.relative_velocity?.kilometers_per_hour ? parseFloat(approach.relative_velocity.kilometers_per_hour) : null,
          missDistanceKm: approach?.miss_distance?.kilometers ? parseFloat(approach.miss_distance.kilometers) : null,
        };
      })
      .sort((a, b) => (a.missDistanceKm ?? Infinity) - (b.missDistanceKm ?? Infinity));
    return { date, count: asteroids.length, asteroids, source: "NASA JPL Near Earth Object Web Service (NeoWs)" };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream NASA lookup failed");
  }
}
app.get("/space/asteroids", (req, res) => runHandler(res, () => spaceAsteroidsLogic(req.query)));

// --- /space/weather -------------------------------------------------------
// Composite over three NOAA SWPC feeds. Public domain, no API key, same footing
// as the NOAA tide/weather/NWPS feeds already used here.
//
// Deliberately NOT fetched: services.swpc.noaa.gov/json/ovation_aurora_latest.json
// is ~918 KB (a full global grid). That is the same trap as the 12 MB NWPS gauge
// list -- it would dominate latency and bandwidth for one summary field.
const SWPC_BASE = "https://services.swpc.noaa.gov";
const SWPC_UA = "x402-seller-starter/1.0 (contact: you@example.com)";
const SWPC_ALERT_WINDOW_DEFAULT_H = 24;
const SWPC_ALERT_WINDOW_MAX_H = 168;

// NOAA's official G-scale. Kp below 5 is not a storm at all, so it maps to G0
// rather than being reported as a weak storm.
function kpToStorm(kp) {
  if (!Number.isFinite(kp)) return { stormLevel: null, stormLabel: null };
  if (kp >= 9) return { stormLevel: "G5", stormLabel: "Extreme" };
  if (kp >= 8) return { stormLevel: "G4", stormLabel: "Severe" };
  if (kp >= 7) return { stormLevel: "G3", stormLabel: "Strong" };
  if (kp >= 6) return { stormLevel: "G2", stormLabel: "Moderate" };
  if (kp >= 5) return { stormLevel: "G1", stormLabel: "Minor" };
  return { stormLevel: "G0", stormLabel: "None" };
}

// Flare classes are a log scale: A < B < C < M < X. M and X are the ones that
// actually cause radio blackouts, so only those are called out as significant.
function flareSignificance(cls) {
  const letter = typeof cls === "string" ? cls.trim().charAt(0).toUpperCase() : "";
  if (letter === "X") return "strong";
  if (letter === "M") return "moderate";
  if (letter === "C") return "minor";
  if (letter === "A" || letter === "B") return "minimal";
  return null;
}

// SWPC uses THREE different timestamp formats across these three feeds, and one
// of them is the literal string "Unk" for an unfinished event. Normalising to
// ISO-8601-with-Z centrally is what stops "Unk" being published as a date.
function swpcTime(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.toLowerCase() === "unk" || raw.toLowerCase() === "none") return null;
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  const parsed = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// SWPC alert bodies are fixed-format text blocks. Pull the human-meaningful line
// rather than shipping the whole message: 117 raw alerts is ~81 KB.
function summariseAlert(message) {
  const lines = String(message || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const labelled = lines.find((l) => /^(WARNING|ALERT|SUMMARY|WATCH|EXTENDED WARNING|CANCEL WARNING):/i.test(l));
  if (labelled) return labelled.slice(0, 200);
  const skip = /^(Space Weather Message Code|Serial Number|Issue Time|#|NOAA Space Weather Scale)/i;
  return (lines.find((l) => !skip.test(l)) || lines[0] || "").slice(0, 200);
}

async function swpcGet(path) {
  // These feeds intermittently reset the connection under back-to-back requests.
  // One retry converts an observed transient failure into a pass; without it a
  // paid call 502s on a blip, which is the same failure mode that cost a
  // /water/streamflow settlement.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { data } = await axios.get(`${SWPC_BASE}${path}`, {
        headers: { "User-Agent": SWPC_UA },
        timeout: 12_000,
      });
      return data;
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function spaceWeatherLogic(args = {}) {
  let windowH = Number(args.alertWindowHours);
  // Number.isFinite, not `|| default`: alertWindowHours=0 must clamp to the
  // minimum rather than silently becoming 24 (the /fire/risk radiusKm bug).
  if (!Number.isFinite(windowH)) windowH = SWPC_ALERT_WINDOW_DEFAULT_H;
  windowH = Math.min(Math.max(Math.round(windowH), 1), SWPC_ALERT_WINDOW_MAX_H);

  try {
    // Parallel: sequential would stack three round trips into one paid call.
    const [kpSeries, flares, alertsRaw] = await Promise.all([
      swpcGet("/json/planetary_k_index_1m.json"),
      swpcGet("/json/goes/primary/xray-flares-latest.json"),
      bestEffort(swpcGet("/products/alerts.json"), 10_000),
    ]);

    if (!Array.isArray(kpSeries) || kpSeries.length === 0) {
      throw new HttpError(502, "Upstream NOAA SWPC returned no Kp data");
    }
    const latestKp = kpSeries[kpSeries.length - 1] || {};
    const kpIndex = Number(latestKp.kp_index);
    const estimatedKp = Number(latestKp.estimated_kp);
    const storm = kpToStorm(kpIndex);

    // current_class is what the sensor reads right now; max_class is the peak the
    // event actually reached. Reporting only the current value would understate a
    // flare that peaked hours ago -- observed live: current C2.1, peak M1.9.
    const flare = Array.isArray(flares) && flares.length ? flares[0] : null;
    const peakClass = flare?.max_class ?? null;
    const endedAt = swpcTime(flare?.end_time);

    let alerts = [];
    let alertsExcluded = 0;
    if (Array.isArray(alertsRaw)) {
      const cutoff = Date.now() - windowH * 3600_000;
      const mapped = alertsRaw
        .map((a) => ({ productId: a.product_id || null, issuedAt: swpcTime(a.issue_datetime), summary: summariseAlert(a.message) }))
        .filter((a) => a.issuedAt);
      alerts = mapped.filter((a) => Date.parse(a.issuedAt) >= cutoff);
      alertsExcluded = mapped.length - alerts.length;
      alerts.sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt));
    }

    return {
      geomagnetic: {
        kpIndex: Number.isFinite(kpIndex) ? kpIndex : null,
        estimatedKp: Number.isFinite(estimatedKp) ? estimatedKp : null,
        stormLevel: storm.stormLevel,
        stormLabel: storm.stormLabel,
        measuredAt: swpcTime(latestKp.time_tag),
      },
      solarFlare: flare
        ? {
            currentClass: flare.current_class ?? null,
            peakClass,
            significance: flareSignificance(peakClass ?? flare.current_class),
            beganAt: swpcTime(flare.begin_time),
            peakAt: swpcTime(flare.max_time),
            endedAt,
            ongoing: endedAt === null,
            satellite: Number.isFinite(Number(flare.satellite)) ? Number(flare.satellite) : null,
          }
        : null,
      alerts,
      alertWindowHours: windowH,
      alertsInWindow: alerts.length,
      // A default filter that hides data must say what it hid, or "no alerts"
      // is indistinguishable from "alerts exist but are older than the window".
      alertsExcludedOutsideWindow: alertsExcluded,
      alertsAvailable: Array.isArray(alertsRaw),
      source: "NOAA Space Weather Prediction Center (SWPC)",
      attribution: "Space weather data from NOAA SWPC (public domain).",
      disclaimer: "Not an official NOAA product. For authoritative watches, warnings and alerts see swpc.noaa.gov.",
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream NOAA SWPC lookup failed");
  }
}
app.get("/space/weather", (req, res) => runHandler(res, () => spaceWeatherLogic(req.query)));

async function baseRpcCall(method, params, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const { data } = await axios.post(BASE_RPC_URL, {
        jsonrpc: "2.0", id: 1, method, params,
      });
      if (data.error) throw new Error(data.error.message || "RPC error");
      return data.result;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (i + 1)));
    }
  }
}

async function chainBalanceLogic({ address, token }) {
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new HttpError(400, "Missing or invalid 'address' query param (expected 0x... format)");
  }
  if (token && !/^0x[a-fA-F0-9]{40}$/.test(token)) {
    throw new HttpError(400, "Invalid 'token' query param (expected 0x... format)");
  }
  try {
    const ethBalanceHex = await baseRpcCall("eth_getBalance", [address, "latest"]);
    const ethBalance = Number(BigInt(ethBalanceHex)) / 1e18;

    let tokenResult = null;
    if (token) {
      const paddedAddress = address.slice(2).toLowerCase().padStart(64, "0");
      const balanceHex = await baseRpcCall("eth_call", [{ to: token, data: `0x70a08231${paddedAddress}` }, "latest"]);
      const decimalsHex = await baseRpcCall("eth_call", [{ to: token, data: "0x313ce567" }, "latest"]);
      const decimals = parseInt(decimalsHex, 16) || 18;
      const rawBalance = BigInt(balanceHex);
      tokenResult = {
        contract: token,
        decimals,
        balance: Number(rawBalance) / 10 ** decimals,
      };
    }

    return { address, network: "base", ethBalance, token: tokenResult, source: "Base mainnet public RPC" };
  } catch (err) {
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream Base RPC lookup failed");
  }
}
app.get("/chain/balance", (req, res) => runHandler(res, () => chainBalanceLogic(req.query)));

// Self-referential product: this seller's own USDC settlement history, read
// straight from Base mainnet (the same source of truth any buyer could check
// independently on a block explorer). Bounded to a short recent window --
// scanning further back means more eth_getLogs chunks and slower responses,
// the same latency problem that got /world/conflict-news removed earlier.
const USDC_CONTRACT_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BASE_BLOCKS_PER_HOUR = Math.floor(3600 / 2); // ~2s block time
const PAYMENT_HISTORY_DEFAULT_HOURS = 24;
const PAYMENT_HISTORY_MAX_HOURS = 72;

function padTopicAddress(address) {
  return "0x" + address.slice(2).toLowerCase().padStart(64, "0");
}

async function paymentHistoryLogic(args) {
  let hours = parseInt(args.hours, 10);
  if (!Number.isFinite(hours) || hours <= 0) hours = PAYMENT_HISTORY_DEFAULT_HOURS;
  hours = Math.min(hours, PAYMENT_HISTORY_MAX_HOURS);

  let fromAddress = null;
  if (args.address) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(args.address)) {
      throw new HttpError(400, "Invalid 'address' query param (expected 0x... format)");
    }
    fromAddress = args.address.toLowerCase();
  }

  try {
    const latest = parseInt(await baseRpcCall("eth_blockNumber", []), 16);
    const blockSpan = Math.floor(hours * BASE_BLOCKS_PER_HOUR);
    const startBlock = Math.max(0, latest - blockSpan);
    const topics = [ERC20_TRANSFER_TOPIC, fromAddress ? padTopicAddress(fromAddress) : null, padTopicAddress(PAY_TO)];

    let chunk = 10_000;
    let cursor = startBlock;
    const payments = [];
    while (cursor <= latest) {
      const end = Math.min(cursor + chunk - 1, latest);
      try {
        const logs = await baseRpcCall("eth_getLogs", [{
          address: USDC_CONTRACT_BASE, topics,
          fromBlock: "0x" + cursor.toString(16), toBlock: "0x" + end.toString(16),
        }]);
        for (const log of logs) {
          payments.push({
            txHash: log.transactionHash,
            from: "0x" + log.topics[1].slice(26),
            amountUsdc: parseInt(log.data, 16) / 1e6,
            block: parseInt(log.blockNumber, 16),
          });
        }
        cursor = end + 1;
      } catch (err) {
        if (chunk <= 500) throw err;
        chunk = Math.max(500, Math.floor(chunk / 2));
      }
    }
    payments.sort((a, b) => b.block - a.block);

    return {
      payTo: PAY_TO,
      windowHours: hours,
      ...(fromAddress ? { filteredByPayer: fromAddress } : {}),
      count: payments.length,
      payments,
      note: `Settlements to this seller's own wallet on Base mainnet, USDC only, over the last ${hours} hour(s) (max ${PAYMENT_HISTORY_MAX_HOURS}). Independently verifiable on any Base block explorer.`,
      source: "Base mainnet public RPC (on-chain USDC Transfer event logs)",
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream Base RPC lookup failed");
  }
}
app.get("/payments/history", (req, res) => runHandler(res, () => paymentHistoryLogic(req.query)));

async function treasuryDebtLogic() {
  try {
    const { data } = await axios.get(
      "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny",
      { params: { sort: "-record_date", "page[size]": 1 } }
    );
    const latest = data?.data?.[0];
    if (!latest) throw new HttpError(502, "No data returned from Treasury Fiscal Data");
    return {
      date: latest.record_date,
      totalDebt: parseFloat(latest.tot_pub_debt_out_amt),
      debtHeldByPublic: parseFloat(latest.debt_held_public_amt),
      intragovernmentalHoldings: parseFloat(latest.intragov_hold_amt),
      unit: "US dollars",
      source: "U.S. Department of the Treasury, Fiscal Data (Debt to the Penny)",
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream Treasury Fiscal Data lookup failed");
  }
}
app.get("/treasury/debt", (req, res) => runHandler(res, () => treasuryDebtLogic(req.query)));

const NOAA_STATION_TYPE_FOR_PRODUCT = { predictions: "tidepredictions", water_level: "waterlevels" };
const NOAA_STATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const noaaStationCache = {};

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

async function nearestNoaaStation(product, lat, lng) {
  const cached = noaaStationCache[product];
  let stations;
  if (cached && Date.now() - cached.at < NOAA_STATION_CACHE_TTL_MS) {
    stations = cached.stations;
  } else {
    const { data } = await axios.get("https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json", {
      params: { type: NOAA_STATION_TYPE_FOR_PRODUCT[product] },
    });
    stations = (data?.stations || [])
      .filter((s) => s.lat != null && s.lng != null)
      .map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng }));
    noaaStationCache[product] = { at: Date.now(), stations };
  }
  let best = null;
  for (const s of stations) {
    const distanceKm = haversineKm(lat, lng, s.lat, s.lng);
    if (!best || distanceKm < best.distanceKm) best = { ...s, distanceKm };
  }
  return best;
}

async function oceanTidesLogic(args) {
  let { station } = args;
  const product = (args.product || "predictions").toLowerCase();
  if (!["predictions", "water_level"].includes(product)) {
    throw new HttpError(400, "product must be 'predictions' or 'water_level'");
  }
  let resolved = null;
  if (!station) {
    const lat = parseFloat(args.lat);
    const lng = parseFloat(args.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new HttpError(400, "Provide either 'station' (NOAA CO-OPS station ID, e.g. 9414290), or 'lat' and 'lng' to use the nearest station");
    }
    try {
      resolved = await nearestNoaaStation(product, lat, lng);
    } catch (err) {
      console.error(err.response?.data || err.message);
      throw new HttpError(502, "Could not fetch NOAA station list to resolve nearest station");
    }
    if (!resolved) throw new HttpError(404, "No NOAA station found for this product type");
    station = resolved.id;
  }
  const baseParams = { station, datum: "MLLW", time_zone: "gmt", units: "english", format: "json" };
  // NOAA's `range` alone counts BACKWARD from now; begin_date makes it count forward
  const pad = (n) => String(n).padStart(2, "0");
  const now = new Date();
  const beginDate = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`;
  const params = product === "predictions"
    ? { ...baseParams, product: "predictions", interval: "hilo", begin_date: beginDate, range: 48 }
    : { ...baseParams, product: "water_level", date: "latest" };
  try {
    // predictions responses carry no station metadata (water_level does), so fetch it
    // separately — unless nearest-station resolution already gave us the metadata
    const [{ data }, stationMeta] = await Promise.all([
      axios.get("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter", { params }),
      resolved
        ? Promise.resolve(resolved)
        : axios
            .get(`https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/${encodeURIComponent(station)}.json`)
            .then((r) => r.data?.stations?.[0] || null)
            .catch(() => null),
    ]);
    if (data?.error) throw new HttpError(404, data.error.message || "NOAA returned an error for this station");
    const meta = data?.metadata || {};
    const common = {
      station, stationName: meta.name || stationMeta?.name || null,
      lat: meta.lat ? parseFloat(meta.lat) : stationMeta?.lat ?? null,
      lng: meta.lon ? parseFloat(meta.lon) : stationMeta?.lng ?? null,
      ...(resolved ? { distanceKm: Number(resolved.distanceKm.toFixed(2)) } : {}),
      product, datum: "MLLW", units: "feet", timeZone: "GMT",
      source: "NOAA Center for Operational Oceanographic Products and Services (CO-OPS)",
    };
    if (product === "predictions") {
      const tides = (data?.predictions || []).map((p) => ({ time: p.t, heightFt: parseFloat(p.v), type: p.type }));
      if (tides.length === 0) throw new HttpError(404, "No tide predictions available for this station");
      return { ...common, tides };
    }
    const obs = data?.data?.[0];
    if (!obs) throw new HttpError(404, "No water level observation available for this station");
    return { ...common, time: obs.t, heightFt: parseFloat(obs.v), preliminary: obs.q === "p" };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const noaaMessage = err.response?.data?.error?.message;
    if (err.response?.status === 400 && noaaMessage) {
      throw new HttpError(404, noaaMessage.trim());
    }
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream NOAA CO-OPS lookup failed");
  }
}
app.get("/ocean/tides", (req, res) => runHandler(res, () => oceanTidesLogic(req.query)));

async function waterStreamflowLogic({ site }) {
  if (!site) throw new HttpError(400, "Missing required query param: site (USGS site number, e.g. 09380000)");
  try {
    const { data } = await axios.get("https://waterservices.usgs.gov/nwis/iv/", {
      params: { format: "json", sites: site, parameterCd: "00060,00065", siteStatus: "all" },
    });
    const seriesList = data?.value?.timeSeries || [];
    if (seriesList.length === 0) throw new HttpError(404, `No data found for USGS site '${site}'`);
    const result = {
      site, siteName: null, lat: null, lng: null,
      streamflowCfs: null, gaugeHeightFt: null, time: null,
      provisional: false,
      attribution: "Provisional data subject to revision. See https://waterdata.usgs.gov/nwis/help/?provisional",
      source: "U.S. Geological Survey (USGS) National Water Information System",
    };
    for (const series of seriesList) {
      const code = series.variable?.variableCode?.[0]?.value;
      const point = series.values?.[0]?.value?.[0];
      if (!point) continue;
      const numValue = parseFloat(point.value);
      const noData = series.variable?.noDataValue;
      if (noData !== undefined && numValue === noData) continue;
      result.siteName = series.sourceInfo?.siteName || result.siteName;
      const geo = series.sourceInfo?.geoLocation?.geogLocation;
      if (geo) { result.lat = geo.latitude ?? result.lat; result.lng = geo.longitude ?? result.lng; }
      result.time = point.dateTime || result.time;
      if (point.qualifiers?.includes("P")) result.provisional = true;
      if (code === "00060") result.streamflowCfs = numValue;
      if (code === "00065") result.gaugeHeightFt = numValue;
    }
    if (result.streamflowCfs === null && result.gaugeHeightFt === null) {
      throw new HttpError(404, `Site '${site}' exists but reports no current streamflow or gauge height data`);
    }
    return result;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream USGS lookup failed");
  }
}
app.get("/water/streamflow", (req, res) => runHandler(res, () => waterStreamflowLogic(req.query)));

// --- /water/flood-risk -------------------------------------------------------
// NOAA's National Water Prediction Service publishes the official NWS flood
// stages per gauge, plus its own observed/forecast flood category. Public
// domain, no API key - same licensing footing as the NOAA tide and weather
// feeds already used here.
const NWPS_BASE = "https://api.water.noaa.gov/nwps/v1";
// NWPS uses -9999 for an undefined threshold and -999 for a missing reading.
// Passing those through raw would report a river as 9999 ft below flood stage.
const NWPS_SENTINELS = new Set([-9999, -999]);
const nwpsNum = (v) => (typeof v === "number" && !NWPS_SENTINELS.has(v) ? v : null);
const NWPS_MAX_MATCH_KM = 2;

// Distance uses the existing haversineKm() defined above for NOAA tide-station
// matching - same problem, same maths.

// The gauge list carries coordinates but no USGS id; the per-gauge endpoint
// carries the USGS id but needs an lid. So site -> gauge has to be resolved
// spatially. Query a small bounding box around the site rather than the national
// gauge list: that list is a ~12 MB download and NOAA reliably times out on it
// (observed: HTTP 504 after 60s), which would put every lookup at its mercy.
// A quarter-degree box is far wider than the match radius even at high latitude.
const NWPS_BBOX_PAD_DEG = 0.25;

async function findNwpsGaugeNear(lat, lng) {
  const { data } = await axios.get(`${NWPS_BASE}/gauges`, {
    params: {
      srid: "EPSG_4326",
      "bbox.xmin": lng - NWPS_BBOX_PAD_DEG,
      "bbox.ymin": lat - NWPS_BBOX_PAD_DEG,
      "bbox.xmax": lng + NWPS_BBOX_PAD_DEG,
      "bbox.ymax": lat + NWPS_BBOX_PAD_DEG,
    },
    timeout: 20_000,
  });
  let best = null;
  for (const g of data?.gauges || []) {
    if (!g.lid || typeof g.latitude !== "number" || typeof g.longitude !== "number") continue;
    const distance = haversineKm(lat, lng, g.latitude, g.longitude);
    if (!best || distance < best.distance) best = { lid: g.lid, distance };
  }
  return best && best.distance <= NWPS_MAX_MATCH_KM ? best : null;
}

// A gauge does not move, so site -> NWS gauge never needs recomputing. Caching
// it drops the bbox lookup, one of the three upstream calls this route makes,
// and it was the only cacheable one (the USGS reading and the NWPS observation
// must both be live). Negative results are cached too, so sites with no nearby
// gauge don't re-query on every call. Bounded so a stream of distinct site
// params cannot grow it without limit; entries are tiny and eviction is
// oldest-first, which Map's insertion order gives for free.
const NWPS_GAUGE_CACHE_MAX = 500;
const nwpsGaugeCache = new Map();

function rememberGauge(site, value) {
  if (nwpsGaugeCache.size >= NWPS_GAUGE_CACHE_MAX) {
    nwpsGaugeCache.delete(nwpsGaugeCache.keys().next().value);
  }
  nwpsGaugeCache.set(site, value);
}

async function waterFloodRiskLogic({ site, lid }) {
  if (!site && !lid) {
    throw new HttpError(400, "Missing required query param: site (USGS site number, e.g. 01646500) or lid (NWS gauge ID, e.g. BRKM2)");
  }
  try {
    let gaugeId = lid ? String(lid).trim().toUpperCase() : null;
    let matchedBy = gaugeId ? "nws_lid" : null;
    let matchDistanceKm = null;
    let usgsReading = null;

    if (!gaugeId) {
      // Reuse the existing USGS handler: it yields the coordinates needed for the
      // spatial match and the live readings used to cross-check NOAA below.
      usgsReading = await waterStreamflowLogic({ site });
      if (typeof usgsReading.lat !== "number" || typeof usgsReading.lng !== "number") {
        throw new HttpError(404, `USGS site '${site}' has no coordinates, so it cannot be matched to an NWS flood gauge`);
      }
      const cacheKey = String(site);
      let best;
      if (nwpsGaugeCache.has(cacheKey)) {
        best = nwpsGaugeCache.get(cacheKey);
      } else {
        best = await findNwpsGaugeNear(usgsReading.lat, usgsReading.lng);
        rememberGauge(cacheKey, best);
      }
      if (!best) {
        throw new HttpError(404, `No NWS river gauge found within ${NWPS_MAX_MATCH_KM} km of USGS site '${site}'`);
      }
      gaugeId = best.lid;
      matchDistanceKm = Math.round(best.distance * 1000) / 1000;
      matchedBy = "coordinates";
    }

    let detail;
    try {
      detail = await axios.get(`${NWPS_BASE}/gauges/${encodeURIComponent(gaugeId)}`, { timeout: 20_000 });
    } catch (err) {
      // An unknown gauge id is a client error, not an upstream outage - without
      // this it surfaces as a misleading 502 blaming NOAA.
      if (err.response?.status === 404) throw new HttpError(404, `NWS gauge '${gaugeId}' not found`);
      throw err;
    }
    const data = detail.data;
    if (!data?.lid) throw new HttpError(404, `NWS gauge '${gaugeId}' not found`);

    const categories = data.flood?.categories || {};
    const floodStagesFt = {
      action: nwpsNum(categories.action?.stage),
      minor: nwpsNum(categories.minor?.stage),
      moderate: nwpsNum(categories.moderate?.stage),
      major: nwpsNum(categories.major?.stage),
    };
    // Reservoir-controlled and market-only gauges genuinely have no flood stages.
    // Refuse rather than return a body of nulls - a 4xx does not settle payment,
    // so the caller is not charged for an answer we cannot give.
    if (Object.values(floodStagesFt).every((v) => v === null)) {
      throw new HttpError(422, `NWS gauge '${gaugeId}' has no official flood stages defined, so flood risk cannot be assessed. This response is not charged for.`);
    }

    const obs = data.status?.observed || {};
    const fct = data.status?.forecast || {};
    const observedStageFt = nwpsNum(obs.primary);
    const forecastStageFt = nwpsNum(fct.primary);

    const feetBelowStage = {};
    for (const [name, stage] of Object.entries(floodStagesFt)) {
      feetBelowStage[name] =
        stage !== null && observedStageFt !== null ? Math.round((stage - observedStageFt) * 100) / 100 : null;
    }

    let nextThreshold = null;
    if (observedStageFt !== null) {
      const upcoming = Object.entries(floodStagesFt)
        .filter(([, stage]) => stage !== null && stage > observedStageFt)
        .sort((a, b) => a[1] - b[1])[0];
      if (upcoming) {
        nextThreshold = {
          name: upcoming[0],
          stageFt: upcoming[1],
          feetAway: Math.round((upcoming[1] - observedStageFt) * 100) / 100,
        };
      }
    }

    let trend = null;
    if (observedStageFt !== null && forecastStageFt !== null) {
      const delta = forecastStageFt - observedStageFt;
      trend = Math.abs(delta) < 0.05 ? "steady" : delta > 0 ? "rising" : "falling";
    }

    return {
      site: site ? String(site) : null,
      gauge: {
        lid: data.lid,
        name: data.name || null,
        usgsId: data.usgsId || null,
        lat: typeof data.latitude === "number" ? data.latitude : null,
        lng: typeof data.longitude === "number" ? data.longitude : null,
        state: data.state?.abbreviation || null,
        matchedBy,
        matchDistanceKm,
        // With matchedBy "coordinates" the gauge is only confirmed as the same
        // station when NWPS reports the USGS id we asked for.
        usgsIdConfirmed: site ? String(data.usgsId || "") === String(site) : null,
      },
      observed: {
        stageFt: observedStageFt,
        unit: obs.primaryUnit || null,
        floodCategory: obs.floodCategory || null,
        time: obs.validTime || null,
      },
      forecast: {
        stageFt: forecastStageFt,
        floodCategory: fct.floodCategory || null,
        time: fct.validTime || null,
      },
      floodStagesFt,
      feetBelowStage,
      nextThreshold,
      trend,
      usgs: usgsReading
        ? {
            siteName: usgsReading.siteName,
            streamflowCfs: usgsReading.streamflowCfs,
            gaugeHeightFt: usgsReading.gaugeHeightFt,
            time: usgsReading.time,
          }
        : null,
      attribution: "Flood stages and categories from NOAA/NWS. USGS readings are provisional and subject to revision.",
      source: "NOAA/NWS National Water Prediction Service; U.S. Geological Survey (USGS) National Water Information System",
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream NOAA/USGS flood-risk lookup failed");
  }
}
app.get("/water/flood-risk", (req, res) => runHandler(res, () => waterFloodRiskLogic(req.query)));

// --- /fire/risk ---------------------------------------------------------------
// NIFC's Wildland Fire Interagency Geospatial Services (WFIGS) publishes the
// authoritative US wildfire incident feed. US federal interagency data, public
// domain, no API key. Its licence is a liability disclaimer rather than a use
// restriction, but it does require that consumers not present the data as
// authoritative or legal - hence the mandatory disclaimer on every response.
const WFIGS_INCIDENTS =
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query";
const WFIGS_DISCLAIMER =
  "Incident data is dynamic, provisional and not a legal document. NIFC gives no warranty as to accuracy or completeness. Not for emergency, evacuation or life-safety decisions.";
const WFIGS_ATTRIBUTION =
  "Wildfire incident data courtesy of the National Interagency Fire Center (WFIGS), sourced from IRWIN and the interagency wildland fire community.";
// The "Current" layer holds the whole season, so it still contains fires that
// are long contained - Morrill sat in it at 642,029 acres, discovered in March
// and 100% contained. Without these filters the endpoint reports a months-old
// contained fire as a live threat.
const WFIGS_RECENT_DAYS = 14;

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
function bearingFrom(lat1, lng1, lat2, lng2) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLng = rad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(dLng);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

// The two enrichment lookups are best-effort, so they must also be bounded:
// airQualityLogic sets no axios timeout of its own, and AirNow was observed
// hanging ~30s on remote coordinates, which would drag a paid response out with
// it. Losing the race yields null; the abandoned request is simply ignored.
const bestEffort = (promise, ms = 8000) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

// Best-effort: NWS fire-weather alerts for the point. A failure here must not
// sink the whole answer, so it degrades to null rather than throwing.
async function fireWeatherFor(lat, lng) {
  try {
    const { data } = await axios.get("https://api.weather.gov/alerts/active", {
      params: { point: `${lat},${lng}` },
      headers: { "User-Agent": NWS_USER_AGENT },
      timeout: 12_000,
    });
    const alerts = (data?.features || [])
      .map((f) => f.properties || {})
      .filter((p) => /fire|red flag/i.test(p.event || ""))
      .map((p) => ({ event: p.event, headline: p.headline || null, severity: p.severity || null, expires: p.expires || null }));
    return { redFlagWarning: alerts.some((a) => /red flag/i.test(a.event)), alerts };
  } catch {
    return null;
  }
}

// Best-effort smoke proxy, reusing the existing AirNow handler. It legitimately
// 404s where there are no monitors (San Francisco reports none at any radius),
// so absence is normal and must not fail the request.
async function smokeProxyFor(lat, lng) {
  try {
    const aq = await airQualityLogic({ lat, lng });
    const readings = (aq.readings || []).filter((r) => typeof r.aqi === "number");
    if (!readings.length) return null;
    const worst = readings.reduce((a, b) => (b.aqi > a.aqi ? b : a));
    return { aqi: worst.aqi, category: worst.category || null, pollutant: worst.pollutant || null, reportingArea: aq.reportingArea || null };
  } catch {
    return null;
  }
}

async function fireRiskLogic({ lat, lng, radiusKm, minAcres }) {
  if (!lat || !lng) throw new HttpError(400, "Missing required query params: lat, lng");
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) throw new HttpError(400, "lat and lng must be numbers");
  if (latNum < -90 || latNum > 90) throw new HttpError(400, "lat must be between -90 and 90");
  if (lngNum < -180 || lngNum > 180) throw new HttpError(400, "lng must be between -180 and 180");
  // Number.isFinite rather than `||`: radiusKm=0 is falsy and would silently
  // become the 100 km default instead of being clamped to the 1 km minimum.
  const parsedRadius = Number(radiusKm);
  const radius = Number.isFinite(parsedRadius) ? Math.min(Math.max(parsedRadius, 1), 500) : 100;
  // Number(undefined) is NaN and ?? does not catch NaN, so a missing minAcres
  // would build "IncidentSize > NaN" and ArcGIS rejects the whole query.
  const parsedFloor = Number(minAcres);
  const floor = Number.isFinite(parsedFloor) ? Math.max(parsedFloor, 0) : 10;

  try {
    // ArcGIS needs a DATE 'yyyy-mm-dd' literal here; passing epoch millis returns
    // an error object rather than filtering, which reads as an empty result.
    const since = new Date(Date.now() - WFIGS_RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);
    // Deliberately NOT filtered by size upstream. Partitioning client-side costs
    // nothing extra and lets the response report how many fires fell below
    // minAcres - otherwise the default silently hides a closer small fire and the
    // caller has no way to know it should widen. Reporting "0 nearby" when
    // something smaller is burning 48 km away is the kind of confident wrong
    // answer this endpoint must not give.
    const where =
      `IncidentTypeCategory='WF'` +
      ` AND IncidentSize > 0` +
      ` AND (PercentContained < 100 OR PercentContained IS NULL)` +
      ` AND FireOutDateTime IS NULL` +
      ` AND ModifiedOnDateTime_dt > DATE '${since}'`;

    // Every upstream this project uses has been observed failing transiently and
    // recovering seconds later (USGS, EIA, NOAA, AirNow and NIFC all did so in a
    // single night). A lone blip here 502s a paid request, so retry once before
    // giving up. Cheap: the retry only runs on the failure path.
    const fetchIncidents = async () => axios.get(WFIGS_INCIDENTS, {
      params: {
        geometry: JSON.stringify({ x: lngNum, y: latNum, spatialReference: { wkid: 4326 } }),
        geometryType: "esriGeometryPoint",
        inSR: "4326",
        distance: String(radius * 1000),
        units: "esriSRUnit_Meter",
        spatialRel: "esriSpatialRelIntersects",
        where,
        // IncidentSize is the CURRENT size. DiscoveryAcres is size at discovery
        // and reads 0.01 on most records - using it reports a 280,000-acre fire
        // as a hundredth of an acre.
        outFields: "IncidentName,IncidentSize,PercentContained,FireDiscoveryDateTime,ModifiedOnDateTime_dt,POOState,FireCause,IncidentComplexityLevel",
        returnGeometry: "true",
        outSR: "4326",
        f: "json",
        // The layer's maxRecordCount is 2000 and there are only ~200 genuinely
        // active fires nationally, so no radius can overflow this. A 50-record
        // cap silently undercounted (Central Oregon at 300 km has 55 fires, at
        // 500 km it has 81) AND, because the cap selected the LARGEST fires,
        // could drop the closest one - making `nearest` wrong exactly where the
        // endpoint matters most.
        resultRecordCount: "2000",
        // Only a tiebreak if the 2000 ceiling is ever somehow hit; the real
        // ordering is by distance, applied below.
        orderByFields: "IncidentSize DESC",
      },
      timeout: 20_000,
    });

    let data;
    try {
      ({ data } = await fetchIncidents());
    } catch (first) {
      await new Promise((r) => setTimeout(r, 400));
      ({ data } = await fetchIncidents());
    }
    // ArcGIS reports failures as HTTP 200 with an `error` object - the same trap
    // class as Census and SEC EDGAR. A malformed query is deterministic, so it is
    // NOT retried; only transport-level failures above are.
    if (data?.error) throw new HttpError(502, `NIFC query rejected: ${data.error.message || "unknown error"}`);

    const allFires = (data?.features || [])
      .map((f) => {
        const a = f.attributes || {};
        const g = f.geometry || {};
        const hasGeo = typeof g.y === "number" && typeof g.x === "number";
        return {
          name: a.IncidentName || null,
          distanceKm: hasGeo ? Math.round(haversineKm(latNum, lngNum, g.y, g.x) * 10) / 10 : null,
          bearing: hasGeo ? bearingFrom(latNum, lngNum, g.y, g.x) : null,
          // Keep two decimals: rounding to an integer renders a 0.01-acre
          // incipient report as "0 acres", which reads as bad data rather than
          // a very small fire.
          acres: typeof a.IncidentSize === "number" ? Math.round(a.IncidentSize * 100) / 100 : null,
          percentContained: typeof a.PercentContained === "number" ? a.PercentContained : null,
          discovered: a.FireDiscoveryDateTime ? new Date(a.FireDiscoveryDateTime).toISOString() : null,
          lastUpdated: a.ModifiedOnDateTime_dt ? new Date(a.ModifiedOnDateTime_dt).toISOString() : null,
          state: a.POOState || null,
          cause: a.FireCause || null,
          complexity: a.IncidentComplexityLevel || null,
        };
      })
      .filter((f) => f.distanceKm === null || f.distanceKm <= radius)
      .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));

    const fires = allFires.filter((f) => (f.acres ?? 0) >= floor);
    const belowFloor = allFires.filter((f) => (f.acres ?? 0) < floor);
    const nearestBelowFloor = belowFloor[0] || null;

    const [fireWeather, airQuality] = await Promise.all([
      bestEffort(fireWeatherFor(latNum, lngNum)),
      bestEffort(smokeProxyFor(latNum, lngNum)),
    ]);

    const largest = fires.length
      ? fires.reduce((a, b) => ((b.acres ?? -1) > (a.acres ?? -1) ? b : a))
      : null;

    return {
      location: { lat: latNum, lng: lngNum, radiusKm: radius, minAcres: floor },
      activeFireCount: fires.length,
      // True if the upstream itself hit a limit, meaning activeFireCount is a
      // floor rather than an exact count. Should never fire in practice, but
      // reporting a capped number as exact is precisely the bug being fixed.
      countTruncatedUpstream: data?.exceededTransferLimit === true,
      nearest: fires[0] || null,
      largest,
      // `fires` is the nearest 20; activeFireCount above is the full total.
      listTruncated: fires.length > 20,
      fires: fires.slice(0, 20),
      // How many active fires were excluded purely for being under minAcres, and
      // the closest of them. Without this a caller cannot tell "nothing is
      // burning" apart from "something small is burning and we hid it".
      belowMinAcresCount: belowFloor.length,
      nearestBelowMinAcres: nearestBelowFloor,
      fireWeather,
      airQuality,
      // Deliberately no synthesised risk score. NIFC's licence forbids presenting
      // this as authoritative, and an invented severity rating in a life-safety
      // domain invites exactly the reliance the disclaimer warns against. Report
      // verifiable facts and leave the judgement to the caller.
      criteria: `Wildfire incidents over ${floor} acres, not fully contained, still open, and updated within ${WFIGS_RECENT_DAYS} days.`,
      disclaimer: WFIGS_DISCLAIMER,
      attribution: WFIGS_ATTRIBUTION,
      source: "National Interagency Fire Center (WFIGS); National Weather Service (NOAA); U.S. EPA AirNow",
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream NIFC wildfire lookup failed");
  }
}
app.get("/fire/risk", (req, res) => runHandler(res, () => fireRiskLogic(req.query)));

// --- /route/hazards ---------------------------------------------------------
// Fuses LocationIQ routing with the NIFC and NWS feeds this project already
// uses. Deliberately NOT a routing proxy: LocationIQ supplies one of three
// inputs, and the product is the spatial correlation between the route line and
// live hazards, which no upstream sells. A thin relay of LocationIQ would be
// sublicensing their Service and is barred by their terms.
//
// LICENCE: LocationIQ's routing is OpenStreetMap-derived, so ODbL 1.0
// attribution ("Data (c) OpenStreetMap contributors") is mandatory on every
// response, not optional. Serving one route is an ODbL "Produced Work" and does
// not trigger share-alike; accumulating routes into a stored database would, and
// is separately barred by LocationIQ's free-tier collection clause. So this
// route caches NOTHING -- which also keeps it inside the 48-hour free-tier cap.
//
// NO SYNTHESISED RISK SCORE, for the same reason /fire/risk has none: NIFC's
// licence forbids presenting its data as authoritative, and this is life-safety
// adjacent. The endpoint returns measured facts and leaves judgement to the caller.
const ROUTE_MAX_SAMPLE_POINTS = 60;

function parseLatLng(value, label) {
  if (typeof value !== "string" || !value.includes(",")) {
    throw new HttpError(400, `Invalid '${label}' - expected "lat,lng"`);
  }
  const [a, b] = value.split(",", 2);
  const lat = Number(a), lng = Number(b);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new HttpError(400, `'${label}' lat and lng must be numbers`);
  if (lat < -90 || lat > 90) throw new HttpError(400, `'${label}' lat must be between -90 and 90`);
  if (lng < -180 || lng > 180) throw new HttpError(400, `'${label}' lng must be between -180 and 180`);
  return { lat, lng };
}

async function routeHazardsLogic({ from, to, corridorKm }) {
  if (!from || !to) throw new HttpError(400, "Missing required query params: from, to");
  const origin = parseLatLng(from, "from");
  const dest = parseLatLng(to, "to");
  // Number.isFinite, not `||`: corridorKm=0 is falsy and would silently become
  // the default rather than clamping to the 1 km minimum.
  const parsedCorridor = Number(corridorKm);
  const corridor = Number.isFinite(parsedCorridor) ? Math.min(Math.max(parsedCorridor, 1), 100) : 25;

  let route;
  try {
    // geometries=geojson avoids decoding an encoded polyline; overview=simplified
    // keeps the point count small enough to correlate against without pagination.
    const url = `https://us1.locationiq.com/v1/directions/driving/${origin.lng},${origin.lat};${dest.lng},${dest.lat}`;
    const { data } = await axios.get(url, {
      params: { key: LOCATIONIQ_API_KEY, overview: "simplified", steps: "false", geometries: "geojson" },
      timeout: 15_000,
    });
    if (data?.code !== "Ok" || !data?.routes?.length) throw new HttpError(404, "No driving route found between those points");
    route = { r: data.routes[0], waypoints: data.waypoints || [] };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream routing lookup failed");
  }

  const coords = (route.r.geometry?.coordinates || []).filter(
    (c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]));
  if (!coords.length) throw new HttpError(502, "Upstream routing returned no geometry");
  // Thin evenly if the geometry is dense, so hazard correlation stays bounded.
  const step = Math.max(1, Math.ceil(coords.length / ROUTE_MAX_SAMPLE_POINTS));
  const samples = coords.filter((_, i) => i % step === 0 || i === coords.length - 1)
    .map(([lng, lat]) => ({ lat, lng }));

  const lats = samples.map((p) => p.lat), lngs = samples.map((p) => p.lng);
  const pad = corridor / 111; // deg latitude per km, generous for longitude too
  const envelope = {
    xmin: Math.min(...lngs) - pad, ymin: Math.min(...lats) - pad,
    xmax: Math.max(...lngs) + pad, ymax: Math.max(...lats) + pad,
    spatialReference: { wkid: 4326 },
  };

  // One envelope query over the whole route beats a per-point query: 60 sampled
  // points would otherwise mean 60 upstream calls inside one paid request.
  const since = new Date(Date.now() - WFIGS_RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);
  const where =
    `IncidentTypeCategory='WF'` +
    ` AND IncidentSize > 0` +
    ` AND (PercentContained < 100 OR PercentContained IS NULL)` +
    ` AND FireOutDateTime IS NULL` +
    ` AND ModifiedOnDateTime_dt > DATE '${since}'`;

  const fetchIncidents = async () => axios.get(WFIGS_INCIDENTS, {
    params: {
      geometry: JSON.stringify(envelope), geometryType: "esriGeometryEnvelope", inSR: "4326",
      spatialRel: "esriSpatialRelIntersects", where,
      outFields: "IncidentName,IncidentSize,PercentContained,POOState",
      returnGeometry: "true", outSR: "4326", resultRecordCount: "2000", f: "json",
    },
    timeout: 20_000,
  });

  let features = [];
  try {
    let resp;
    try { resp = await fetchIncidents(); }
    catch { await new Promise((r) => setTimeout(r, 500)); resp = await fetchIncidents(); }
    // ArcGIS reports errors as HTTP 200 with an error object, so check explicitly.
    if (resp.data?.error) throw new HttpError(502, "Upstream wildfire lookup failed");
    features = resp.data?.features || [];
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream wildfire lookup failed");
  }

  const fires = [];
  for (const f of features) {
    const g = f.geometry, a = f.attributes || {};
    if (!g || !Number.isFinite(g.x) || !Number.isFinite(g.y)) continue;
    let best = Infinity, bestPt = null;
    for (const p of samples) {
      const d = haversineKm(p.lat, p.lng, g.y, g.x);
      if (d < best) { best = d; bestPt = p; }
    }
    if (best > corridor) continue;
    const acres = Number(a.IncidentSize);
    const contained = Number(a.PercentContained);
    fires.push({
      name: a.IncidentName || null,
      distanceKm: Math.round(best * 10) / 10,
      bearingFromRoute: bestPt ? bearingFrom(bestPt.lat, bestPt.lng, g.y, g.x) : null,
      acres: Number.isFinite(acres) ? acres : null,
      percentContained: Number.isFinite(contained) ? contained : null,
      state: a.POOState || null,
    });
  }
  fires.sort((x, y) => x.distanceKm - y.distanceKm);

  // Best-effort and bounded: alerts must not sink or stall a paid answer.
  // Sampled at three points rather than every one - stated in the response so a
  // caller knows this is not a continuous corridor scan.
  const alertPoints = samples.length >= 3
    ? [samples[0], samples[Math.floor(samples.length / 2)], samples[samples.length - 1]]
    : samples;
  const alertResults = await Promise.all(
    alertPoints.map((p) => bestEffort(fireWeatherFor(p.lat, p.lng), 8000)));
  const anyAlertOk = alertResults.some((r) => r !== null);
  const seen = new Set();
  const alerts = [];
  for (const r of alertResults) {
    for (const al of r?.alerts || []) {
      const key = `${al.event}|${al.expires}`;
      if (seen.has(key)) continue;
      seen.add(key);
      alerts.push(al);
    }
  }

  return {
    route: {
      distanceKm: Math.round((route.r.distance / 1000) * 10) / 10,
      durationMinutes: Math.round((route.r.duration / 60) * 10) / 10,
      from: { lat: origin.lat, lng: origin.lng, nearestRoad: route.waypoints[0]?.name || null },
      to: { lat: dest.lat, lng: dest.lng, nearestRoad: route.waypoints[1]?.name || null },
      samplePoints: samples.length,
    },
    wildfires: {
      corridorKm: corridor,
      countNearRoute: fires.length,
      nearest: fires[0] || null,
      fires: fires.slice(0, 20),
    },
    weatherAlerts: {
      sampledPoints: alertPoints.length,
      // null, not 0: an upstream failure must not read as "no alerts".
      count: anyAlertOk ? alerts.length : null,
      alerts,
    },
    hazardsFound: fires.length > 0 || alerts.length > 0,
    source: "Routing by LocationIQ (data (c) OpenStreetMap contributors, ODbL 1.0); wildfire incidents from NIFC WFIGS; alerts from NOAA National Weather Service",
    attribution: `Data (c) OpenStreetMap contributors, ODbL 1.0. Routing by LocationIQ.com. ${WFIGS_ATTRIBUTION}`,
    disclaimer: `${WFIGS_DISCLAIMER} Hazard proximity is measured to sampled points along the route, not a continuous corridor.`,
  };
}
app.get("/route/hazards", (req, res) => runHandler(res, () => routeHazardsLogic(req.query)));

// Vintage year = the API path segment and the end-year of the 5-year window.
// Census releases a new 5-year ACS vintage annually (usually late January);
// bump this one constant each year.
const CENSUS_ACS_VINTAGE_YEAR = 2024; // 2020-2024 5-Year Estimates (released 2026-01-29)

async function censusDemographicsLogic({ zip }) {
  if (!zip || !/^\d{5}(-\d{4})?$/.test(zip)) {
    throw new HttpError(400, "Missing or invalid 'zip' query param (expected 5-digit US ZIP code)");
  }
  const zip5 = zip.slice(0, 5);
  try {
    const { data, status } = await axios.get(`https://api.census.gov/data/${CENSUS_ACS_VINTAGE_YEAR}/acs/acs5`, {
      params: {
        get: "NAME,B01003_001E,B19013_001E,B01002_001E,B25001_001E",
        for: `zip code tabulation area:${zip5}`,
        key: CENSUS_API_KEY,
      },
    });
    // Confirmed empirically: a ZIP with no matching ZCTA (PO-box-only, very
    // new) returns 204 No Content with an empty body, not a 4xx error.
    if (status === 204) {
      throw new HttpError(404, `No Census ZCTA data found for ZIP ${zip5} (this ZIP code may have no matching ZCTA)`);
    }
    // A missing/invalid key makes Census respond 200 with an HTML error page
    // instead of the expected JSON array — confirmed empirically, axios
    // never throws for this since it's a 2xx status.
    if (!Array.isArray(data) || data.length < 2) {
      throw new HttpError(502, "Unexpected response from Census API (missing/invalid CENSUS_API_KEY, or upstream format change)");
    }
    const [header, row] = data;
    const rec = Object.fromEntries(header.map((h, i) => [h, row[i]]));
    // ACS suppresses low-reliability estimates with sentinel negative codes
    // (e.g. -666666666) instead of omitting the field.
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    return {
      zip: zip5,
      zcta: rec["zip code tabulation area"] || zip5,
      name: rec.NAME || null,
      population: num(rec.B01003_001E),
      medianHouseholdIncome: num(rec.B19013_001E),
      medianAge: num(rec.B01002_001E),
      housingUnits: num(rec.B25001_001E),
      vintage: `${CENSUS_ACS_VINTAGE_YEAR - 4}-${CENSUS_ACS_VINTAGE_YEAR}`,
      attribution: "This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau.",
      source: "U.S. Census Bureau American Community Survey (ACS) 5-Year Estimates",
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream Census API lookup failed");
  }
}
app.get("/census/demographics", (req, res) => runHandler(res, () => censusDemographicsLogic(req.query)));

async function secFilingsSearchLogic(args) {
  const { q, forms, startdt, enddt } = args;
  if (!q) throw new HttpError(400, "Missing required query param: q");
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (startdt && !dateRe.test(startdt)) throw new HttpError(400, "startdt must be in YYYY-MM-DD format");
  if (enddt && !dateRe.test(enddt)) throw new HttpError(400, "enddt must be in YYYY-MM-DD format");
  const limit = Math.min(parseInt(args.limit, 10) || 10, 50);
  try {
    const { data } = await axios.get("https://efts.sec.gov/LATEST/search-index", {
      headers: { "User-Agent": SEC_USER_AGENT },
      params: { q, ...(forms ? { forms } : {}), ...(startdt ? { startdt } : {}), ...(enddt ? { enddt } : {}) },
    });
    // A blank/invalid query returns HTTP 200 with an error field instead of
    // a 4xx -- axios never throws for this, the body must be inspected.
    if (data.error || data.errorMessage) {
      console.error(data.error || data.errorMessage);
      throw new HttpError(400, "Invalid search parameters (check query syntax and date format)");
    }
    const total = data.hits?.total?.value ?? 0;
    const totalIsApprox = data.hits?.total?.relation === "gte";
    // The upstream `size` param is silently ignored -- every page is capped
    // at 100 hits regardless, so slice to our own limit client-side.
    const filings = (data.hits?.hits || []).slice(0, limit).map((hit) => {
      const src = hit._source || {};
      const cik = src.ciks?.[0] ? Number(src.ciks[0]) : null;
      const nameMatch = (src.display_names?.[0] || "").match(/^(.*?)\s*(?:\(([A-Z.\-]+)\)\s*)?\(CIK \d+\)$/);
      return {
        company: nameMatch ? nameMatch[1].trim() : (src.display_names?.[0] || null),
        ticker: nameMatch?.[2] || null,
        cik,
        formType: src.form || null,
        filingDate: src.file_date || null,
        accessionNumber: src.adsh || null,
        sic: src.sics?.[0] || null,
        filingUrl: cik && src.adsh ? `https://www.sec.gov/Archives/edgar/data/${cik}/${src.adsh}-index.htm` : null,
      };
    });
    return {
      query: q, totalMatches: total, totalMatchesApproximate: totalIsApprox,
      count: filings.length, filings,
      source: "U.S. Securities and Exchange Commission (SEC) EDGAR Full-Text Search",
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err.response?.data || err.message);
    throw new HttpError(502, "Upstream SEC EDGAR lookup failed");
  }
}
app.get("/sec/filings-search", (req, res) => runHandler(res, () => secFilingsSearchLogic(req.query)));

// ---- MCP endpoint (POST /mcp) — the same 18 tools, payable in-band via x402 ----
// Stateless Streamable HTTP: initialize and tools/list are free; each tools/call is
// wrapped by @x402/mcp — unpaid calls get the payment requirements as a structured
// result, x402-aware clients retry with _meta["x402/payment"] and get data + receipt.

const MCP_TOOL_DEFS = [
  { path: "/geo/lookup", logic: geoLookupLogic },
  { path: "/geo/reverse", logic: geoReverseLogic },
  { path: "/oil/price", logic: oilPriceLogic },
  { path: "/gas/price", logic: gasPriceLogic },
  { path: "/electricity/price", logic: electricityPriceLogic },
  { path: "/weather/forecast", logic: weatherForecastLogic },
  { path: "/nuclear/outages", logic: nuclearOutagesLogic },
  { path: "/earthquakes/recent", logic: earthquakesRecentLogic },
  { path: "/currency/rate", logic: currencyRateLogic },
  { path: "/air/quality", logic: airQualityLogic },
  { path: "/space/asteroids", logic: spaceAsteroidsLogic },
  { path: "/space/weather", logic: spaceWeatherLogic },
  { path: "/route/hazards", logic: routeHazardsLogic },
  { path: "/chain/balance", logic: chainBalanceLogic },
  { path: "/treasury/debt", logic: treasuryDebtLogic },
  { path: "/ocean/tides", logic: oceanTidesLogic },
  { path: "/water/streamflow", logic: waterStreamflowLogic },
  { path: "/water/flood-risk", logic: waterFloodRiskLogic },
  { path: "/fire/risk", logic: fireRiskLogic },
  { path: "/payments/history", logic: paymentHistoryLogic },
  { path: "/sec/filings-search", logic: secFilingsSearchLogic },
  { path: "/census/demographics", logic: censusDemographicsLogic },
];

const toSnakeCase = (s) => s.replace(/([A-Z])/g, "_$1").toLowerCase();

function mcpQuerySchema(path) {
  return PAYMENT_ROUTES[`GET ${path}`]?.extensions?.bazaar?.schema?.properties?.input?.properties?.queryParams || {};
}

// The MCP SDK requires zod schemas; derive them from the same bazaar JSON schemas
// that feed the payment middleware and OpenAPI doc so tool inputs cannot drift.
// Two normalizations vs. a literal translation of the JSON schema:
// - numeric-looking params accept a JSON number too (MCP callers naturally send
//   {lat: 38.8} rather than {lat: "38.8"}) and are coerced to the string the
//   logic functions expect, since HTTP query params are always strings
// - enum values are lowercased before validation so MCP callers aren't held to
//   a stricter case convention than the HTTP query-string routes
function zodShapeFor(path) {
  const qp = mcpQuerySchema(path);
  const required = qp.required || [];
  const shape = {};
  for (const [name, schema] of Object.entries(qp.properties || {})) {
    let s = schema.enum
      ? z.preprocess((v) => (typeof v === "string" ? v.toLowerCase() : v), z.enum(schema.enum))
      : z.union([z.string(), z.number()]).transform((v) => String(v));
    if (schema.description) s = s.describe(schema.description);
    if (!required.includes(name)) s = s.optional();
    shape[name] = s;
  }
  return shape;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let mcpTools = null;
// Runs in the background — deliberately NOT awaited before app.listen() below.
// paymentMiddleware() (see its call further up) already triggers this same
// resourceServer's facilitator initialization on first use; calling it again
// here is redundant but harmless (initialize() just repopulates its internal
// maps from a fresh /supported fetch — no shared mutable state gets corrupted
// by two calls in flight). What matters is that neither call is allowed to
// block the HTTP server from binding its port: a facilitator that's merely
// slow (not just erroring) must only leave mcpTools null (/mcp returns 503),
// never delay or prevent the 16 already-working paid HTTP routes from serving.
(async () => {
  try {
    await withTimeout(resourceServer.initialize(), 10_000, "resourceServer.initialize()");
    const mcpAccepts = await withTimeout(
      resourceServer.buildPaymentRequirements({ scheme: "exact", network: NETWORK, payTo: PAY_TO, price: PRICE_PER_LOOKUP }),
      10_000,
      "buildPaymentRequirements()"
    );
    mcpTools = MCP_TOOL_DEFS.map(({ path, logic }) => {
      const name = toSnakeCase(ROUTE_META[path].operationId);
      const description = `${PAYMENT_ROUTES[`GET ${path}`].description} Costs ${PRICE_PER_LOOKUP} per call, paid via x402 (USDC on Base).`;
      // No bazaar extension here: @x402/mcp's own toolName-extraction requires
      // resource.url to be a synthetic "mcp://tool/<name>" URI (it strips that
      // literal prefix to get the name), but CDP's Bazaar rejects any resource
      // URL — including MCP ones — that isn't https://, logging "MCP server
      // URL must use HTTPS" on every settlement. The two requirements conflict;
      // MCP discovery is instead handled correctly via the mcp.remoteConnector
      // field in /.well-known/x402 (a real https URL), which is what Agent402's
      // crawler actually reads.
      const paid = createPaymentWrapper(resourceServer, {
        accepts: mcpAccepts,
        resource: { url: `mcp://tool/${name}`, description, mimeType: "application/json", serviceName: "Data Lookup API (x402-seller)" },
      });
      const callback = paid(async (args) => {
        try {
          const data = await logic(args || {});
          return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
        } catch (err) {
          const message = err instanceof HttpError ? err.message : "Internal error";
          if (!(err instanceof HttpError)) console.error(err.response?.data || err.message);
          // isError results cancel settlement — buyers are not charged for failed lookups
          return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
        }
      });
      return { name, description, inputSchema: zodShapeFor(path), callback };
    });
    console.log(`   MCP: ${mcpTools.length} paid tools available at POST /mcp`);
  } catch (err) {
    console.error("MCP payment setup failed — /mcp disabled:", err.message);
  }
})();

// Stateless mode requires a fresh server per request (shared instances collide)
function buildMcpServer() {
  const mcp = new McpServer({ name: "x402-seller-data-api", version: DEPLOY_VERSION });
  for (const t of mcpTools) {
    mcp.registerTool(t.name, { description: t.description, inputSchema: t.inputSchema }, t.callback);
  }
  return mcp;
}

// Unauthenticated public endpoint — cheap per-IP rate limit.
// Express's trust-proxy-derived req.ip picks the RIGHTMOST X-Forwarded-For
// entry, which is attacker-controlled if the client sends its own XFF header
// and Render's edge only appends (rather than replaces) that header. Render
// places the real client IP FIRST, so read that entry directly instead.
function mcpClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

const mcpRateWindow = new Map();
function mcpRateLimited(ip) {
  const now = Date.now();
  const entry = mcpRateWindow.get(ip);
  if (!entry || now - entry.start > 60_000) {
    if (mcpRateWindow.size > 10_000) mcpRateWindow.clear();
    mcpRateWindow.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > 120;
}

app.use("/mcp", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.post("/mcp", express.json(), async (req, res) => {
  if (!mcpTools) {
    return res.status(503).json({ jsonrpc: "2.0", error: { code: -32000, message: "MCP endpoint unavailable: payment setup failed at boot" }, id: null });
  }
  if (mcpRateLimited(mcpClientIp(req))) {
    return res.status(429).json({ jsonrpc: "2.0", error: { code: -32000, message: "Rate limit exceeded" }, id: null });
  }
  const mcp = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { try { transport.close(); mcp.close(); } catch {} });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

const mcpStatelessHint = (req, res) => res.status(405).set("Allow", "POST").json({
  jsonrpc: "2.0", error: { code: -32000, message: "This MCP endpoint is stateless: POST JSON-RPC messages to /mcp." }, id: null,
});
app.get("/mcp", mcpStatelessHint);
app.delete("/mcp", mcpStatelessHint);

app.use((req, res) => {
  res.status(404).json({ error: "Not found. GET / lists all available endpoints." });
});

app.listen(PORT, () => {
  console.log(`\n🚀 x402 seller server running at http://localhost:${PORT}`);
  // Derived from PAYMENT_ROUTES, not hand-listed. The previous hardcoded string
  // had silently gone stale and was omitting /water/flood-risk and /fire/risk,
  // so the boot log under-reported the paid surface by two routes.
  console.log(`   Paid routes (${Object.keys(PAYMENT_ROUTES).length}): ${Object.keys(PAYMENT_ROUTES).join(", ")}`);
  console.log(`   Network: ${NETWORK}  |  Facilitator: ${USING_CDP ? "CDP (authenticated)" : FACILITATOR_URL}`);
  console.log(`   Pay-to address: ${PAY_TO}\n`);
});
