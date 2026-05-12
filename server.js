import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { loadLocalEnv } from "./src/env.js";

loadLocalEnv();

const {
  getStationStoreSummary,
  hasPublicDataServiceKey,
  queryStations,
  refreshStationData
} = await import("./src/station-data.js");

const root = fileURLToPath(new URL("./public", import.meta.url));
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "0.0.0.0";
const stationResponseCacheMs = Number(process.env.NEARBY_RESPONSE_CACHE_MS || 120000);
const stationAutoRefreshMs = Number(process.env.NEARBY_AUTO_REFRESH_INTERVAL_MS || 6 * 60 * 60 * 1000);
const stationResponseCache = new Map();
let warmupPromise = null;

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json; charset=utf-8"]
]);

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const candidate = decoded === "/" ? "/index.html" : decoded;
  const normalized = normalize(candidate).replace(/^(\.\.(\/|\\|$))+/, "");
  return join(root, normalized);
}

function localAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => `http://${entry.address}:${port}`)
    .sort();
}

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (requestUrl.pathname === "/api/stations") {
      await handleStationsApi(req, res, requestUrl);
      return;
    }

    if (requestUrl.pathname === "/config.js" && hasEnvPublicConfig()) {
      sendPublicConfig(res);
      return;
    }

    const filePath = safePath(req.url || "/");
    const data = await readFile(filePath);
    const contentType = mime.get(extname(filePath)) || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store"
    });
    res.end(data);
  } catch (error) {
    if (error.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Internal server error");
  }
});

async function handleStationsApi(req, res, requestUrl) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const cacheKey = requestUrl.searchParams.toString();
  const cached = stationResponseCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < stationResponseCacheMs) {
    sendJson(res, 200, {
      ...cached.payload,
      meta: {
        ...cached.payload.meta,
        responseCache: "hit"
      }
    });
    return;
  }

  let refreshError = null;
  try {
    await warmStationStoreIfNeeded();
  } catch (error) {
    refreshError = error;
    console.warn(error);
  }

  const stations = queryStations({
    lat: requestUrl.searchParams.get("lat"),
    lng: requestUrl.searchParams.get("lng"),
    radius: requestUrl.searchParams.get("radius"),
    limit: requestUrl.searchParams.get("limit"),
    speed: requestUrl.searchParams.get("speed"),
    availableOnly: requestUrl.searchParams.get("availableOnly")
  });
  const summary = getStationStoreSummary();
  const payload = {
    stations,
    meta: {
      source: summary.stationCount > 0 ? "sqlite" : "empty",
      dbPath: summary.dbPath,
      totalStations: summary.stationCount,
      totalChargers: summary.chargerCount,
      lastRefreshAt: summary.lastRefreshAt,
      generatedAt: new Date().toISOString(),
      responseCache: "miss",
      refreshError: refreshError ? refreshError.message : null
    }
  };

  stationResponseCache.set(cacheKey, {
    createdAt: Date.now(),
    payload
  });
  sendJson(res, 200, payload);
}

async function warmStationStoreIfNeeded() {
  const summary = getStationStoreSummary();
  const autoRefresh = process.env.NEARBY_AUTO_REFRESH === "1";
  const lastRefreshMs = summary.lastRefreshAt ? Date.parse(summary.lastRefreshAt) : 0;
  const refreshDue =
    summary.stationCount === 0 ||
    (autoRefresh && (!lastRefreshMs || Date.now() - lastRefreshMs > stationAutoRefreshMs));

  if (!refreshDue || !hasPublicDataServiceKey()) {
    return summary;
  }

  if (warmupPromise) {
    return warmupPromise;
  }

  warmupPromise = refreshStationData().finally(() => {
    warmupPromise = null;
    stationResponseCache.clear();
  });
  return warmupPromise;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function hasEnvPublicConfig() {
  return Boolean(getNaverMapNcpKeyId());
}

function sendPublicConfig(res) {
  const script = `window.NEARBY_CONFIG = ${JSON.stringify({
    NAVER_MAP_NCP_KEY_ID: getNaverMapNcpKeyId()
  })};\n`;

  res.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(script);
}

function getNaverMapNcpKeyId() {
  return (
    process.env.NAVER_MAP_NCP_KEY_ID ||
    process.env.NEARBY_PUBLIC_NAVER_MAP_NCP_KEY_ID ||
    ""
  ).trim();
}

server.listen(port, host, () => {
  console.log(`EV charger web app is running at http://localhost:${port}`);
  for (const address of localAddresses()) {
    console.log(`LAN: ${address}`);
  }
});
