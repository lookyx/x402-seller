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

if (!PAY_TO) { console.error("\n❌ Missing PAY_TO_ADDRESS.\n"); process.exit(1); }
if (!LOCATIONIQ_API_KEY) { console.error("\n❌ Missing LOCATIONIQ_API_KEY.\n"); process.exit(1); }
if (!EIA_API_KEY) { console.error("\n❌ Missing EIA_API_KEY.\n"); process.exit(1); }
if (!AIRNOW_API_KEY) { console.error("\n❌ Missing AIRNOW_API_KEY.\n"); process.exit(1); }
if (!NASA_API_KEY) { console.error("\n❌ Missing NASA_API_KEY.\n"); process.exit(1); }

const NWS_USER_AGENT = "x402-seller-starter/1.0 (contact: you@example.com)";
const BASE_RPC_URL = "https://mainnet.base.org";
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

const app = express();
app.set("trust proxy", 1);

const baseFacilitatorClient = USING_CDP
  ? new HTTPFacilitatorClient(cdpFacilitatorConfig)
  : new HTTPFacilitatorClient({ url: FACILITATOR_URL });

const facilitatorClient = withBazaar(baseFacilitatorClient);

const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, new ExactEvmScheme())
  .registerExtension(bazaarResourceServerExtension);

const PRICE_PER_LOOKUP = "$0.001";

const PAYMENT_ROUTES = {
      "GET /geo/lookup": {
        accepts: [{ scheme: "exact", price: PRICE_PER_LOOKUP, network: NETWORK, payTo: PAY_TO }],
        description: "Forward geocode a free-text address into latitude, longitude, and IANA timezone.",
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
        description: "Reverse geocode latitude/longitude coordinates into a place name and IANA timezone.",
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
        accepts: [{ scheme: "exact", price: PRICE_PER_LOOKUP, network: NETWORK, payTo: PAY_TO }],
        description: "Latest official daily spot price for WTI or Brent crude oil (USD/barrel), sourced from the U.S. Energy Information Administration. Data lags several business days behind the market; not live trading data.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { benchmark: "wti" },
            inputSchema: {
              properties: { benchmark: { type: "string", enum: ["wti", "brent"], description: "Which crude oil benchmark to fetch" } },
              required: [],
            },
            output: {
              example: { benchmark: "WTI", price: 73.2, unit: "Dollars per Barrel", date: "2026-07-15", source: "U.S. Energy Information Administration (EIA)" },
              schema: {
                properties: {
                  benchmark: { type: "string" }, price: { type: "number" },
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
              example: { benchmark: "Henry Hub", price: 3.12, unit: "Dollars per Million Btu", date: "2026-07-15", source: "U.S. Energy Information Administration (EIA)" },
              schema: {
                properties: {
                  benchmark: { type: "string" }, price: { type: "number" },
                  unit: { type: "string" }, date: { type: "string" }, source: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /electricity/price": {
        accepts: [{ scheme: "exact", price: PRICE_PER_LOOKUP, network: NETWORK, payTo: PAY_TO }],
        description: "Latest average U.S. retail electricity price (cents/kWh), monthly data across all sectors, sourced from the U.S. Energy Information Administration. Optional 'state' param (2-letter code) for a specific state instead of the national average.",
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
        accepts: [{ scheme: "exact", price: PRICE_PER_LOOKUP, network: NETWORK, payTo: PAY_TO }],
        description: "Official U.S. National Weather Service forecast (next period) for given coordinates. US locations only. Use /geo/lookup first if you only have an address.",
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
        description: "Latest daily U.S. nuclear power plant outage data: total capacity, megawatts offline, and percent outage nationwide. Sourced from the U.S. Nuclear Regulatory Commission via EIA.",
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
        description: "Recent significant earthquakes worldwide from the past 7 days, sourced from USGS. Optional 'minmagnitude' (default 4.5) and 'limit' (default 10, max 50).",
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
        accepts: [{ scheme: "exact", price: PRICE_PER_LOOKUP, network: NETWORK, payTo: PAY_TO }],
        description: "Official daily currency exchange rate between any two currencies (30+ major currencies), sourced from the European Central Bank. Updates once per business day (~16:00 CET), not live/intraday.",
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
        description: "Current U.S. air quality index (AQI) readings near given coordinates, sourced from the EPA AirNow program (federal/state/local/tribal agencies). Data is preliminary and unvalidated per EPA data use guidelines — not for regulatory use. US/Canada/Mexico coverage only.",
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
        description: "Near-Earth asteroids making their closest approach on a given date (default today), sorted by distance. Includes size, velocity, and miss distance. Sourced from NASA JPL's Near Earth Object Web Service.",
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
      "GET /world/conflict-news": {
        accepts: [{ scheme: "exact", price: PRICE_PER_LOOKUP, network: NETWORK, payTo: PAY_TO }],
        description: "Recent global news coverage matching a conflict/security-related search query (e.g. a country, region, or conflict name), aggregated from worldwide news monitoring. Returns article metadata (title, source, date, link) only — not full article text. Sourced from the GDELT Project. Neutral aggregation of mainstream reporting; does not editorialize.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { query: "Ukraine", limit: "10" },
            inputSchema: {
              properties: {
                query: { type: "string", description: "Search keywords (e.g. a country, region, or conflict name)" },
                limit: { type: "string", description: "Max number of results (max 25)" },
              },
              required: ["query"],
            },
            output: {
              example: {
                query: "Ukraine",
                count: 1,
                articles: [{
                  title: "Example headline about the topic",
                  url: "https://example.com/article",
                  domain: "example.com",
                  sourceCountry: "United States",
                  publishedDate: "2026-07-16T14:30:00Z",
                }],
                source: "GDELT Project (global news monitoring)",
              },
              schema: {
                properties: {
                  query: { type: "string" }, count: { type: "number" },
                  articles: { type: "array" }, source: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "GET /chain/balance": {
        accepts: [{ scheme: "exact", price: PRICE_PER_LOOKUP, network: NETWORK, payTo: PAY_TO }],
        description: "Live wallet balance on Base mainnet: native ETH plus an optional ERC20 token balance. Sourced from Base's official public RPC.",
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
      "GET /treasury/debt": {
        accepts: [{ scheme: "exact", price: PRICE_PER_LOOKUP, network: NETWORK, payTo: PAY_TO }],
        description: "Latest total U.S. national debt outstanding ('Debt to the Penny'): total public debt, debt held by the public, and intragovernmental holdings. Updated each business day by the U.S. Treasury.",
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
        description: "U.S. coastal tide data from NOAA: high/low tide predictions for the next 48 hours (product=predictions, default) or the latest observed water level (product=water_level). Identify the location by NOAA CO-OPS station ID, or just pass lat+lng and the nearest station is used automatically (distanceKm in the response says how far it is). Heights in feet above MLLW datum, times in GMT.",
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
        description: "Latest real-time river conditions at a USGS stream gauge: streamflow (cubic feet per second) and gauge height (feet). Data is provisional and subject to revision. Requires a USGS site number (e.g. 09380000 = Colorado River at Lees Ferry, AZ).",
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
};

app.use(paymentMiddleware(PAYMENT_ROUTES, resourceServer));

app.get("/", (req, res) => {
  res.json({
    name: "Data Lookup API",
    status: "live",
    commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) || "dev",
    paid_endpoints: [
      "GET /geo/lookup?address=...",
      "GET /geo/reverse?lat=...&lng=...",
      "GET /oil/price?benchmark=wti|brent",
      "GET /gas/price",
      "GET /electricity/price?state=US",
      "GET /weather/forecast?lat=...&lng=... (US only)",
      "GET /nuclear/outages",
      "GET /earthquakes/recent?minmagnitude=4.5&limit=10",
      "GET /currency/rate?from=USD&to=JPY",
      "GET /air/quality?lat=...&lng=... (US/CA/MX only)",
      "GET /space/asteroids?date=YYYY-MM-DD",
      "GET /world/conflict-news?query=...&limit=10",
      "GET /chain/balance?address=0x...&token=0x... (optional)",
      "GET /treasury/debt",
      "GET /ocean/tides?station=... or lat=...&lng=... (&product=predictions|water_level, US coastal stations)",
      "GET /water/streamflow?site=09380000 (US stream gauges)",
    ],
    price_per_call: PRICE_PER_LOOKUP,
    protocol: "x402",
    network: NETWORK,
    machine_readable: { openapi: "/openapi.json", x402_manifest: "/.well-known/x402", mcp: "POST /mcp (Streamable HTTP, stateless)" },
    facilitator: USING_CDP ? "CDP (authenticated)" : FACILITATOR_URL,
    attribution: "Geocoding by LocationIQ.com. Energy data from EIA. Weather and tide data from NOAA. Earthquake and streamflow data from USGS. Exchange rates from ECB. Air quality from EPA AirNow. Asteroid data from NASA JPL. News data from the GDELT Project. Chain data from Base public RPC. National debt data from U.S. Treasury Fiscal Data.",
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
  "/geo/lookup": { operationId: "geoLookup", summary: "Forward geocode an address to coordinates and timezone", tags: ["geo"] },
  "/geo/reverse": { operationId: "geoReverse", summary: "Reverse geocode coordinates to a place name and timezone", tags: ["geo"] },
  "/oil/price": { operationId: "oilPrice", summary: "Latest WTI or Brent crude oil spot price", tags: ["energy", "finance"] },
  "/gas/price": { operationId: "gasPrice", summary: "Latest Henry Hub natural gas spot price", tags: ["energy", "finance"] },
  "/electricity/price": { operationId: "electricityPrice", summary: "Latest US retail electricity price", tags: ["energy"] },
  "/weather/forecast": { operationId: "weatherForecast", summary: "Official US weather forecast by coordinates", tags: ["weather"] },
  "/nuclear/outages": { operationId: "nuclearOutages", summary: "Daily US nuclear power plant outage data", tags: ["energy"] },
  "/earthquakes/recent": { operationId: "earthquakesRecent", summary: "Recent significant earthquakes worldwide", tags: ["geology", "hazards"] },
  "/currency/rate": { operationId: "currencyRate", summary: "Official daily currency exchange rate", tags: ["finance"] },
  "/air/quality": { operationId: "airQuality", summary: "Current US air quality index readings", tags: ["environment", "weather"] },
  "/space/asteroids": { operationId: "spaceAsteroids", summary: "Near-Earth asteroids by closest approach date", tags: ["space"] },
  "/world/conflict-news": { operationId: "worldConflictNews", summary: "Global conflict news metadata search", tags: ["news"] },
  "/chain/balance": { operationId: "chainBalance", summary: "Base mainnet wallet ETH and ERC20 balance", tags: ["blockchain"] },
  "/treasury/debt": { operationId: "treasuryDebt", summary: "US national debt to the penny", tags: ["finance", "government"] },
  "/ocean/tides": { operationId: "oceanTides", summary: "US tide predictions and observed water levels", tags: ["ocean", "weather"] },
  "/water/streamflow": { operationId: "waterStreamflow", summary: "Real-time US river streamflow and gauge height", tags: ["water", "environment"] },
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
        "x-price": PRICE_PER_LOOKUP,
        "x-payment-info": { protocol: "x402", scheme: "exact", network: NETWORK, price: PRICE_PER_LOOKUP, currency: "USDC" },
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
    summary: "16 pay-per-call data endpoints for AI agents: geocoding, energy prices, weather, tides, streamflow, earthquakes, air quality, FX rates, US treasury debt, asteroids, news metadata, and on-chain balances. Sourced from licensed and public-domain providers.",
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
    attribution: "Geocoding by LocationIQ.com. Energy data from EIA. Weather and tide data from NOAA. Earthquake and streamflow data from USGS. Exchange rates from ECB. Air quality from EPA AirNow. Asteroid data from NASA JPL. News data from the GDELT Project. Chain data from Base public RPC. National debt data from U.S. Treasury Fiscal Data.",
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

async function runHandler(res, fn) {
  try {
    res.json(await fn());
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Internal error" });
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
    return { benchmark: chosen.label, price: latest.value != null ? parseFloat(latest.value) : null, unit: latest.units || "Dollars per Barrel", date: latest.period, source: "U.S. Energy Information Administration (EIA)" };
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
    return { benchmark: "Henry Hub", price: latest.value != null ? parseFloat(latest.value) : null, unit: latest.units || "Dollars per Million Btu", date: latest.period, source: "U.S. Energy Information Administration (EIA)" };
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
    return { region: latest.stateDescription || state, price: latest.price, unit: "cents per kilowatt-hour", date: latest.period, source: "U.S. Energy Information Administration (EIA)" };
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
      date: latest.period, capacityMw: latest.capacity, outageMw: latest.outage,
      percentOutage: latest.percentOutage, source: "U.S. Energy Information Administration (EIA) / Nuclear Regulatory Commission",
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

async function fetchGdeltWithRetry(params, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const { data } = await axios.get("https://api.gdeltproject.org/api/v2/doc/doc", {
      params,
      responseType: "text",
      transformResponse: [(d) => d],
    });
    if (typeof data === "string" && data.trim().startsWith("Please limit requests")) {
      if (i === attempts - 1) throw new Error("GDELT rate limit not cleared after retries");
      await new Promise((resolve) => setTimeout(resolve, 3000 * (i + 1)));
      continue;
    }
    return JSON.parse(data);
  }
}

async function worldConflictNewsLogic(args) {
  const query = args.query;
  if (!query) throw new HttpError(400, "Missing required query param: query");
  const limit = Math.min(parseInt(args.limit, 10) || 10, 25);
  try {
    const data = await fetchGdeltWithRetry({
      query, mode: "ArtList", format: "json", maxrecords: limit, sort: "datedesc", timespan: "3d",
    });
    const articles = (data?.articles || []).map((a) => ({
      title: a.title, url: a.url, domain: a.domain, sourceCountry: a.sourcecountry, publishedDate: a.seendate,
    }));
    return { query, count: articles.length, articles, source: "GDELT Project (global news monitoring)" };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err.response?.data || err.message);
    throw new HttpError(503, "GDELT is currently rate-limiting this server. Please try again shortly.");
  }
}
app.get("/world/conflict-news", (req, res) => runHandler(res, () => worldConflictNewsLogic(req.query)));

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

// ---- MCP endpoint (POST /mcp) — the same 16 tools, payable in-band via x402 ----
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
  { path: "/world/conflict-news", logic: worldConflictNewsLogic },
  { path: "/chain/balance", logic: chainBalanceLogic },
  { path: "/treasury/debt", logic: treasuryDebtLogic },
  { path: "/ocean/tides", logic: oceanTidesLogic },
  { path: "/water/streamflow", logic: waterStreamflowLogic },
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
      const qp = mcpQuerySchema(path);
      const paid = createPaymentWrapper(resourceServer, {
        accepts: mcpAccepts,
        resource: { url: `mcp://tool/${name}`, description, mimeType: "application/json", serviceName: "Data Lookup API (x402-seller)" },
        extensions: {
          ...declareDiscoveryExtension({
            toolName: name,
            description,
            transport: "streamable-http",
            inputSchema: { type: "object", properties: qp.properties || {}, required: qp.required || [] },
          }),
        },
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
  console.log(`   Paid routes: GET /geo/lookup, GET /geo/reverse, GET /oil/price, GET /gas/price, GET /electricity/price, GET /weather/forecast, GET /nuclear/outages, GET /earthquakes/recent, GET /currency/rate, GET /air/quality, GET /space/asteroids, GET /world/conflict-news, GET /chain/balance, GET /treasury/debt, GET /ocean/tides, GET /water/streamflow`);
  console.log(`   Network: ${NETWORK}  |  Facilitator: ${USING_CDP ? "CDP (authenticated)" : FACILITATOR_URL}`);
  console.log(`   Pay-to address: ${PAY_TO}\n`);
});
