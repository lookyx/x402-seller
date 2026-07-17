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

const PORT = process.env.PORT || 4021;
const PAY_TO = process.env.PAY_TO_ADDRESS;
const NETWORK = process.env.NETWORK || "eip155:84532";
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://x402.org/facilitator";
const USING_CDP = Boolean(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);
const LOCATIONIQ_API_KEY = process.env.LOCATIONIQ_API_KEY;
const EIA_API_KEY = process.env.EIA_API_KEY;

if (!PAY_TO) { console.error("\n❌ Missing PAY_TO_ADDRESS.\n"); process.exit(1); }
if (!LOCATIONIQ_API_KEY) { console.error("\n❌ Missing LOCATIONIQ_API_KEY.\n"); process.exit(1); }
if (!EIA_API_KEY) { console.error("\n❌ Missing EIA_API_KEY.\n"); process.exit(1); }

const NWS_USER_AGENT = "x402-seller-starter/1.0 (contact: you@example.com)";
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

app.use(
  paymentMiddleware(
    {
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
        description: "Latest official daily spot price for WTI or Brent crude oil (USD/barrel), sourced from the U.S. Energy Information Administration. ~1 business day lag, not live trading data.",
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
        description: "Latest Henry Hub natural gas spot price (USD/MMBtu), sourced from the U.S. Energy Information Administration. ~1 business day lag, not live trading data.",
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
    },
    resourceServer
  )
);

app.get("/", (req, res) => {
  res.json({
    name: "Data Lookup API",
    status: "live",
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
    ],
    price_per_call: PRICE_PER_LOOKUP,
    protocol: "x402",
    network: NETWORK,
    facilitator: USING_CDP ? "CDP (authenticated)" : FACILITATOR_URL,
    attribution: "Geocoding by LocationIQ.com. Energy data from EIA. Weather from NOAA. Earthquake data from USGS. Exchange rates from ECB.",
  });
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/geo/lookup", async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: "Missing required query param: address" });
  try {
    const { data } = await axios.get("https://us1.locationiq.com/v1/search", {
      params: { key: LOCATIONIQ_API_KEY, q: address, format: "json", limit: 1 },
    });
    if (!data || data.length === 0) return res.status(404).json({ error: "No match found for that address" });
    const { lat, lon, display_name } = data[0];
    const tzMatches = findTimezone(parseFloat(lat), parseFloat(lon));
    res.json({ query: address, lat: parseFloat(lat), lng: parseFloat(lon), timezone: tzMatches[0] || null, display_name });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(502).json({ error: "Upstream geocoding lookup failed" });
  }
});

app.get("/geo/reverse", async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "Missing required query params: lat, lng" });
  try {
    const { data } = await axios.get("https://us1.locationiq.com/v1/reverse", {
      params: { key: LOCATIONIQ_API_KEY, lat, lon: lng, format: "json" },
    });
    const tzMatches = findTimezone(parseFloat(lat), parseFloat(lng));
    res.json({ lat: parseFloat(lat), lng: parseFloat(lng), timezone: tzMatches[0] || null, display_name: data?.display_name || null });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(502).json({ error: "Upstream reverse geocoding lookup failed" });
  }
});

app.get("/oil/price", async (req, res) => {
  const benchmarkParam = (req.query.benchmark || "wti").toLowerCase();
  const seriesMap = { wti: { code: "RWTC", label: "WTI" }, brent: { code: "RBRTE", label: "Brent" } };
  const chosen = seriesMap[benchmarkParam];
  if (!chosen) return res.status(400).json({ error: "benchmark must be 'wti' or 'brent'" });
  try {
    const { data } = await axios.get("https://api.eia.gov/v2/petroleum/pri/spt/data", {
      params: {
        api_key: EIA_API_KEY, frequency: "daily", "data[0]": "value",
        "facets[series][]": chosen.code, "sort[0][column]": "period", "sort[0][direction]": "desc", length: 1,
      },
    });
    const points = data?.response?.data || [];
    if (points.length === 0) return res.status(502).json({ error: "No data returned from EIA" });
    const latest = points[0];
    res.json({ benchmark: chosen.label, price: latest.value, unit: latest.units || "Dollars per Barrel", date: latest.period, source: "U.S. Energy Information Administration (EIA)" });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(502).json({ error: "Upstream EIA lookup failed" });
  }
});

app.get("/gas/price", async (req, res) => {
  try {
    const { data } = await axios.get("https://api.eia.gov/v2/natural-gas/pri/fut/data", {
      params: {
        api_key: EIA_API_KEY, frequency: "daily", "data[0]": "value",
        "facets[series][]": "RNGWHHD", "sort[0][column]": "period", "sort[0][direction]": "desc", length: 1,
      },
    });
    const points = data?.response?.data || [];
    if (points.length === 0) return res.status(502).json({ error: "No data returned from EIA" });
    const latest = points[0];
    res.json({ benchmark: "Henry Hub", price: latest.value, unit: latest.units || "Dollars per Million Btu", date: latest.period, source: "U.S. Energy Information Administration (EIA)" });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(502).json({ error: "Upstream EIA lookup failed" });
  }
});

app.get("/electricity/price", async (req, res) => {
  const state = (req.query.state || "US").toUpperCase();
  try {
    const { data } = await axios.get("https://api.eia.gov/v2/electricity/retail-sales/data", {
      params: {
        api_key: EIA_API_KEY, frequency: "monthly", "data[0]": "price",
        "facets[stateid][]": state, "facets[sectorid][]": "ALL",
        "sort[0][column]": "period", "sort[0][direction]": "desc", length: 1,
      },
    });
    const points = data?.response?.data || [];
    if (points.length === 0) return res.status(404).json({ error: `No data found for state '${state}'` });
    const latest = points[0];
    res.json({ region: latest.stateDescription || state, price: latest.price, unit: "cents per kilowatt-hour", date: latest.period, source: "U.S. Energy Information Administration (EIA)" });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(502).json({ error: "Upstream EIA lookup failed" });
  }
});

app.get("/weather/forecast", async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "Missing required query params: lat, lng" });
  try {
    const pointsResp = await axios.get(`https://api.weather.gov/points/${lat},${lng}`, {
      headers: { "User-Agent": NWS_USER_AGENT },
    });
    const forecastUrl = pointsResp.data?.properties?.forecast;
    const gridId = pointsResp.data?.properties?.gridId;
    if (!forecastUrl) return res.status(502).json({ error: "Could not resolve forecast URL for this location" });
    const forecastResp = await axios.get(forecastUrl, { headers: { "User-Agent": NWS_USER_AGENT } });
    const period = forecastResp.data?.properties?.periods?.[0];
    if (!period) return res.status(502).json({ error: "No forecast data available for this location" });
    res.json({
      location: gridId || null, period: period.name, temperature: period.temperature,
      temperatureUnit: period.temperatureUnit, shortForecast: period.shortForecast,
      detailedForecast: period.detailedForecast, windSpeed: period.windSpeed,
      windDirection: period.windDirection, source: "National Weather Service (NOAA)",
    });
  } catch (err) {
    if (err.response?.status === 404) return res.status(404).json({ error: "Location outside NWS coverage (US only)" });
    console.error(err.response?.data || err.message);
    res.status(502).json({ error: "Upstream NWS lookup failed" });
  }
});

app.get("/nuclear/outages", async (req, res) => {
  try {
    const { data } = await axios.get("https://api.eia.gov/v2/nuclear-outages/us-nuclear-outages/data", {
      params: {
        api_key: EIA_API_KEY, frequency: "daily",
        "data[0]": "capacity", "data[1]": "outage", "data[2]": "percentOutage",
        "sort[0][column]": "period", "sort[0][direction]": "desc", length: 1,
      },
    });
    const points = data?.response?.data || [];
    if (points.length === 0) return res.status(502).json({ error: "No data returned from EIA" });
    const latest = points[0];
    res.json({
      date: latest.period, capacityMw: latest.capacity, outageMw: latest.outage,
      percentOutage: latest.percentOutage, source: "U.S. Energy Information Administration (EIA) / Nuclear Regulatory Commission",
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(502).json({ error: "Upstream EIA lookup failed" });
  }
});

app.get("/earthquakes/recent", async (req, res) => {
  const minmagnitude = req.query.minmagnitude || "4.5";
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
  const endtime = new Date();
  const starttime = new Date(endtime.getTime() - 7 * 24 * 60 * 60 * 1000);
  try {
    const { data } = await axios.get("https://earthquake.usgs.gov/fdsnws/event/1/query", {
      params: { format: "geojson", starttime: starttime.toISOString(), endtime: endtime.toISOString(), minmagnitude, orderby: "time", limit },
    });
    const features = data?.features || [];
    const earthquakes = features.map((f) => ({
      place: f.properties.place, magnitude: f.properties.mag, time: new Date(f.properties.time).toISOString(),
      depthKm: f.geometry?.coordinates?.[2] ?? null, lat: f.geometry?.coordinates?.[1] ?? null,
      lng: f.geometry?.coordinates?.[0] ?? null, url: f.properties.url,
    }));
    res.json({ count: earthquakes.length, earthquakes, source: "U.S. Geological Survey (USGS)" });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(502).json({ error: "Upstream USGS lookup failed" });
  }
});

app.get("/currency/rate", async (req, res) => {
  const from = (req.query.from || "EUR").toUpperCase();
  const to = (req.query.to || "USD").toUpperCase();

  try {
    const { data: xml } = await axios.get("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml");
    const parsed = xmlParser.parse(xml);

    const dayCube = parsed["gesmes:Envelope"]?.Cube?.Cube;
    const date = dayCube?.time;
    const rateEntries = dayCube?.Cube;
    const rateList = Array.isArray(rateEntries) ? rateEntries : [rateEntries];

    const rates = { EUR: 1 };
    for (const entry of rateList) {
      rates[entry.currency] = parseFloat(entry.rate);
    }

    if (!(from in rates)) return res.status(400).json({ error: `Unknown currency code: ${from}` });
    if (!(to in rates)) return res.status(400).json({ error: `Unknown currency code: ${to}` });

    const rate = rates[to] / rates[from];

    res.json({ from, to, rate: Number(rate.toFixed(6)), date, source: "European Central Bank (ECB)" });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(502).json({ error: "Upstream ECB lookup failed" });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 x402 seller server running at http://localhost:${PORT}`);
  console.log(`   Paid routes: GET /geo/lookup, GET /geo/reverse, GET /oil/price, GET /gas/price, GET /electricity/price, GET /weather/forecast, GET /nuclear/outages, GET /earthquakes/recent, GET /currency/rate`);
  console.log(`   Network: ${NETWORK}  |  Facilitator: ${USING_CDP ? "CDP (authenticated)" : FACILITATOR_URL}`);
  console.log(`   Pay-to address: ${PAY_TO}\n`);
});
