import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_DB_PATH = fileURLToPath(new URL("../data/stations.sqlite", import.meta.url));
const PUBLIC_DATA_BASE_URL = "https://apis.data.go.kr/B552584/EvCharger";
const KEPCO_COORDINATE_CSV_URL =
  "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003154629&fileDetailSn=1&insertDataPrcus=N";
const DEFAULT_PAGE_SIZE = 9999;
const DEFAULT_RADIUS_METERS = 5000;
const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 500;
const DEFAULT_STATUS_STALE_HOURS = 24;

const CHARGER_FIELD_NAMES = [
  "statNm",
  "statId",
  "chgerId",
  "chgerType",
  "addr",
  "location",
  "lat",
  "lng",
  "useTime",
  "busiId",
  "bnm",
  "busiNm",
  "busiCall",
  "stat",
  "statUpdDt",
  "lastTsdt",
  "lastTedt",
  "nowTsdt",
  "output",
  "method",
  "zcode",
  "zscode",
  "kind",
  "kindDetail",
  "parkingFree",
  "limitYn",
  "limitDetail",
  "trafficYn",
  "delYn",
  "delDetail"
];

let database;

export function getStationDbPath() {
  return resolve(process.env.NEARBY_STATION_DB || DEFAULT_DB_PATH);
}

export function getPublicDataServiceKey() {
  return (
    process.env.PUBLIC_DATA_SERVICE_KEY ||
    process.env.DATA_GO_KR_SERVICE_KEY ||
    process.env.EV_CHARGER_SERVICE_KEY ||
    ""
  ).trim();
}

export function hasPublicDataServiceKey() {
  return getPublicDataServiceKey().length > 0;
}

export function getStationDatabase() {
  if (database) {
    return database;
  }

  const dbPath = getStationDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  database = new DatabaseSync(dbPath);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  ensureSchema(database);
  return database;
}

export function ensureSchema(db = getStationDatabase()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      operator TEXT,
      address TEXT,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      updated_at TEXT,
      use_time TEXT,
      busi_id TEXT,
      busi_call TEXT,
      parking_free TEXT,
      limit_yn TEXT,
      limit_detail TEXT,
      kind TEXT,
      kind_detail TEXT,
      zcode TEXT,
      zscode TEXT,
      raw_json TEXT,
      fetched_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chargers (
      station_id TEXT NOT NULL,
      id TEXT NOT NULL,
      chger_type TEXT,
      speed TEXT NOT NULL,
      kw REAL,
      status TEXT NOT NULL,
      status_code TEXT,
      updated_at TEXT,
      last_started_at TEXT,
      last_ended_at TEXT,
      method TEXT,
      raw_json TEXT,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (station_id, id),
      FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_stations_lat_lng ON stations(lat, lng);
    CREATE INDEX IF NOT EXISTS idx_chargers_status ON chargers(status);
    CREATE INDEX IF NOT EXISTS idx_chargers_speed ON chargers(speed);
  `);
}

export async function refreshStationData(options = {}) {
  const serviceKey = getPublicDataServiceKey();
  if (!serviceKey) {
    throw new Error(
      "PUBLIC_DATA_SERVICE_KEY, DATA_GO_KR_SERVICE_KEY, or EV_CHARGER_SERVICE_KEY is required to fetch public EV charger data."
    );
  }

  const fetchedAt = new Date().toISOString();
  const sourceRows = await fetchPublicChargerRows({
    serviceKey,
    pageSize: options.pageSize,
    maxPages: options.maxPages,
    zcodes: options.zcodes,
    zcode: options.zcode,
    zscode: options.zscode
  });
  const stations = normalizeChargerRows(sourceRows, fetchedAt);

  replaceStationData(stations, {
    fetchedAt,
    sourceRows: sourceRows.length,
    source: "data.go.kr:B552584/EvCharger/getChargerInfo"
  });

  return getStationStoreSummary();
}

export async function refreshKepcoCoordinateData(options = {}) {
  const fetchedAt = new Date().toISOString();
  const csvText = options.path
    ? await readFile(options.path, "utf8")
    : await fetchText(options.url || KEPCO_COORDINATE_CSV_URL);
  const stations = normalizeKepcoCoordinateCsv(csvText, fetchedAt);

  replaceStationData(stations, {
    fetchedAt,
    sourceRows: stations.length,
    source:
      options.source ||
      (options.path
        ? `data.go.kr:15102458/한국전력공사_전기차충전소위경도 cached from ${options.path}`
        : "data.go.kr:15102458/한국전력공사_전기차충전소위경도")
  });

  return getStationStoreSummary();
}

export async function fetchPublicChargerRows(options) {
  const pageSize = clampInteger(
    options.pageSize ?? process.env.NEARBY_DATA_PAGE_SIZE,
    10,
    DEFAULT_PAGE_SIZE,
    DEFAULT_PAGE_SIZE
  );
  const maxPages = positiveInteger(options.maxPages ?? process.env.NEARBY_DATA_MAX_PAGES);
  const zcodes = stationZcodes(options);
  const rows = [];

  for (const zcode of zcodes) {
    let pageNo = 1;
    let totalCount = null;

    while (!maxPages || pageNo <= maxPages) {
      const response = await fetchPublicDataPage("getChargerInfo", {
        serviceKey: options.serviceKey,
        pageNo,
        numOfRows: pageSize,
        zcode,
        zscode: options.zscode ?? process.env.NEARBY_DATA_ZSCODE
      });

      rows.push(...response.items);
      totalCount = response.totalCount ?? totalCount;

      if (response.items.length === 0) {
        break;
      }

      if (totalCount !== null && pageNo * pageSize >= totalCount) {
        break;
      }

      pageNo += 1;
    }
  }

  return dedupeChargerRows(rows);
}

export async function fetchPublicDataPage(operation, options) {
  const url = publicDataUrl(operation, {
    serviceKey: options.serviceKey,
    dataType: "JSON",
    pageNo: options.pageNo,
    numOfRows: options.numOfRows,
    zcode: options.zcode,
    zscode: options.zscode
  });

  const response = await fetch(url, {
    headers: {
      Accept: "application/json, application/xml;q=0.8, text/xml;q=0.8"
    }
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(publicDataHttpErrorMessage(response.status, text));
  }

  const parsed = parsePublicDataResponse(text);
  if (parsed.resultCode && !["00", "NORMAL_SERVICE"].includes(parsed.resultCode)) {
    throw new Error(`Public data request failed: ${parsed.resultCode} ${parsed.resultMsg || ""}`.trim());
  }

  return parsed;
}

export function normalizeChargerRows(rows, fetchedAt = new Date().toISOString()) {
  const stations = new Map();

  for (const row of rows) {
    const stationId = textValue(row.statId);
    const name = textValue(row.statNm);
    const lat = numberValue(row.lat);
    const lng = numberValue(row.lng);

    if (!stationId || !name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }

    const chargerId = textValue(row.chgerId) || "00";
    const updatedAt = parsePublicDataDate(row.statUpdDt);
    const kw = chargerKw(row);
    const station =
      stations.get(stationId) ||
      createStationRecord({
        row,
        stationId,
        name,
        lat,
        lng,
        fetchedAt,
        updatedAt
      });

    station.updatedAt = latestIso(station.updatedAt, updatedAt);
    station.chargers.push({
      id: chargerId,
      chgerType: textValue(row.chgerType),
      speed: chargerSpeed(row, kw),
      kw,
      status: chargerStatus(row.stat, updatedAt),
      statusCode: textValue(row.stat),
      updatedAt,
      lastStartedAt: parsePublicDataDate(row.lastTsdt || row.nowTsdt),
      lastEndedAt: parsePublicDataDate(row.lastTedt),
      method: textValue(row.method),
      raw: row
    });

    stations.set(stationId, station);
  }

  return [...stations.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

export function normalizeKepcoCoordinateCsv(csvText, fetchedAt = new Date().toISOString()) {
  return parseCsv(csvText)
    .map((row) => {
      const id = textValue(row["충전소ID"]);
      const name = textValue(row["충전소명"]);
      const address = textValue(row["충전소주소"]);
      const lat = numberValue(row["위도"]);
      const lng = numberValue(row["경도"]);

      if (!id || !name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
      }

      return {
        id: `kepco-${id}`,
        name,
        operator: "한국전력공사",
        address,
        lat,
        lng,
        updatedAt: "2025-05-31T00:00:00+09:00",
        useTime: null,
        busiId: "KEPCO",
        busiCall: null,
        parkingFree: null,
        limitYn: null,
        limitDetail: null,
        kind: null,
        kindDetail: null,
        zcode: null,
        zscode: null,
        raw: row,
        fetchedAt,
        chargers: [
          {
            id: "01",
            chgerType: null,
            speed: "unknown",
            kw: null,
            status: "unknown",
            statusCode: null,
            updatedAt: null,
            lastStartedAt: null,
            lastEndedAt: null,
            method: null,
            raw: row
          }
        ]
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

export function replaceStationData(stations, options = {}) {
  const db = getStationDatabase();
  const fetchedAt = options.fetchedAt || new Date().toISOString();
  const stationStatement = db.prepare(`
    INSERT INTO stations (
      id, name, operator, address, lat, lng, updated_at, use_time, busi_id, busi_call,
      parking_free, limit_yn, limit_detail, kind, kind_detail, zcode, zscode, raw_json, fetched_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const chargerStatement = db.prepare(`
    INSERT INTO chargers (
      station_id, id, chger_type, speed, kw, status, status_code, updated_at,
      last_started_at, last_ended_at, method, raw_json, fetched_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM chargers");
    db.exec("DELETE FROM stations");

    for (const station of stations) {
      stationStatement.run(
        station.id,
        station.name,
        station.operator,
        station.address,
        station.lat,
        station.lng,
        station.updatedAt,
        station.useTime,
        station.busiId,
        station.busiCall,
        station.parkingFree,
        station.limitYn,
        station.limitDetail,
        station.kind,
        station.kindDetail,
        station.zcode,
        station.zscode,
        JSON.stringify(station.raw),
        fetchedAt
      );

      for (const charger of station.chargers) {
        chargerStatement.run(
          station.id,
          charger.id,
          charger.chgerType,
          charger.speed,
          charger.kw,
          charger.status,
          charger.statusCode,
          charger.updatedAt,
          charger.lastStartedAt,
          charger.lastEndedAt,
          charger.method,
          JSON.stringify(charger.raw),
          fetchedAt
        );
      }
    }

    setMetadata(db, "last_refresh_at", fetchedAt);
    setMetadata(db, "source", options.source || "unknown");
    setMetadata(db, "source_rows", String(options.sourceRows ?? ""));
    setMetadata(db, "station_rows", String(stations.length));
    setMetadata(
      db,
      "charger_rows",
      String(stations.reduce((total, station) => total + station.chargers.length, 0))
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function queryStations(options = {}) {
  const db = getStationDatabase();
  const lat = numberValue(options.lat);
  const lng = numberValue(options.lng);
  const limit = clampInteger(options.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const speed = ["fast", "slow"].includes(options.speed) ? options.speed : "all";
  const availableOnly = options.availableOnly === true || options.availableOnly === "true";
  const stationRows =
    Number.isFinite(lat) && Number.isFinite(lng)
      ? queryNearbyStationRows(db, lat, lng, options.radius, limit, speed, availableOnly)
      : queryRecentStationRows(db, limit, speed, availableOnly);

  if (stationRows.length === 0) {
    return [];
  }

  const chargerRows = queryChargersForStations(
    db,
    stationRows.map((station) => station.id)
  );
  const chargersByStation = groupBy(chargerRows, (charger) => charger.station_id);

  return stationRows
    .map((row) => stationJson(row, chargersByStation.get(row.id) || []))
    .filter((station) => station.chargers.length > 0);
}

export function getStationStoreSummary() {
  const db = getStationDatabase();
  const stationCount = db.prepare("SELECT COUNT(*) AS count FROM stations").get().count;
  const chargerCount = db.prepare("SELECT COUNT(*) AS count FROM chargers").get().count;
  const metadataRows = db.prepare("SELECT key, value FROM metadata").all();
  const metadata = Object.fromEntries(metadataRows.map((row) => [row.key, row.value]));

  return {
    dbPath: getStationDbPath(),
    stationCount,
    chargerCount,
    lastRefreshAt: metadata.last_refresh_at || null,
    source: metadata.source || null,
    sourceRows: integerOrNull(metadata.source_rows),
    storedStationRows: integerOrNull(metadata.station_rows),
    storedChargerRows: integerOrNull(metadata.charger_rows)
  };
}

function queryNearbyStationRows(db, lat, lng, radiusOption, limit, speed, availableOnly) {
  const radius = clampInteger(radiusOption, 100, 50000, DEFAULT_RADIUS_METERS);
  const latDelta = radius / 111320;
  const lngScale = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const lngDelta = radius / (111320 * lngScale);
  const rows = db
    .prepare(
      `
      SELECT DISTINCT stations.*
      FROM stations
      JOIN chargers ON chargers.station_id = stations.id
      WHERE stations.lat BETWEEN ? AND ?
        AND stations.lng BETWEEN ? AND ?
        AND (? = 'all' OR chargers.speed = ?)
        AND (? = 0 OR chargers.status = 'available')
      `
    )
    .all(lat - latDelta, lat + latDelta, lng - lngDelta, lng + lngDelta, speed, speed, availableOnly ? 1 : 0);

  return rows
    .map((row) => ({
      ...row,
      distance: haversineDistance(lat, lng, row.lat, row.lng)
    }))
    .filter((row) => row.distance <= radius)
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name, "ko"))
    .slice(0, limit);
}

function queryRecentStationRows(db, limit, speed, availableOnly) {
  return db
    .prepare(
      `
      SELECT DISTINCT stations.*
      FROM stations
      JOIN chargers ON chargers.station_id = stations.id
      WHERE (? = 'all' OR chargers.speed = ?)
        AND (? = 0 OR chargers.status = 'available')
      ORDER BY COALESCE(stations.updated_at, '') DESC, stations.name ASC
      LIMIT ?
      `
    )
    .all(speed, speed, availableOnly ? 1 : 0, limit);
}

function queryChargersForStations(db, stationIds) {
  const placeholders = stationIds.map(() => "?").join(", ");
  return db
    .prepare(
      `
      SELECT *
      FROM chargers
      WHERE station_id IN (${placeholders})
      ORDER BY station_id, id
      `
    )
    .all(...stationIds);
}

function stationJson(row, chargers) {
  return {
    id: row.id,
    name: row.name,
    operator: row.operator,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
    updatedAt: row.updated_at,
    useTime: row.use_time,
    busiCall: row.busi_call,
    parkingFree: row.parking_free,
    limitYn: row.limit_yn,
    limitDetail: row.limit_detail,
    distance: row.distance ?? null,
    chargers: chargers.map((charger) => ({
      id: charger.id,
      speed: charger.speed,
      kw: charger.kw,
      status: charger.status,
      updatedAt: charger.updated_at,
      type: charger.chger_type,
      method: charger.method
    }))
  };
}

function createStationRecord({ row, stationId, name, lat, lng, fetchedAt, updatedAt }) {
  return {
    id: stationId,
    name,
    operator: textValue(row.busiNm) || textValue(row.bnm) || textValue(row.busiId),
    address: textValue(row.addr),
    lat,
    lng,
    updatedAt,
    useTime: textValue(row.useTime),
    busiId: textValue(row.busiId),
    busiCall: textValue(row.busiCall),
    parkingFree: textValue(row.parkingFree),
    limitYn: textValue(row.limitYn),
    limitDetail: textValue(row.limitDetail),
    kind: textValue(row.kind),
    kindDetail: textValue(row.kindDetail),
    zcode: textValue(row.zcode),
    zscode: textValue(row.zscode),
    raw: row,
    fetchedAt,
    chargers: []
  };
}

function publicDataUrl(operation, options) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (key === "serviceKey" || value === undefined || value === null || value === "") {
      continue;
    }
    params.set(key, String(value));
  }

  const serviceKey = encodeServiceKey(options.serviceKey);
  return `${PUBLIC_DATA_BASE_URL}/${operation}?serviceKey=${serviceKey}&${params.toString()}`;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "text/csv, text/plain;q=0.8"
    }
  });

  if (!response.ok) {
    throw new Error(`CSV request failed with HTTP ${response.status}`);
  }

  return response.text();
}

function encodeServiceKey(serviceKey) {
  const value = String(serviceKey || "").trim();
  return /%[0-9a-f]{2}/i.test(value) ? value : encodeURIComponent(value);
}

function publicDataHttpErrorMessage(status, text) {
  const body = text.replace(/\s+/g, " ").trim().slice(0, 240);

  if (status === 401) {
    return [
      "Public data request failed with HTTP 401 Unauthorized.",
      "The service key was loaded, but data.go.kr rejected it for this API.",
      "Check that 한국환경공단_전기자동차 충전소 정보 is listed as approved under data.go.kr 마이페이지 > 오픈API,",
      "that you are using the currently active 일반 인증키, and that a newly issued key has had time to activate.",
      body ? `Response: ${body}` : ""
    ]
      .filter(Boolean)
      .join(" ");
  }

  return `Public data request failed with HTTP ${status}: ${body}`;
}

function parsePublicDataResponse(text) {
  const trimmed = text.trim();
  const parsed = trimmed.startsWith("{") || trimmed.startsWith("[") ? parseJsonResponse(trimmed) : parseXmlResponse(trimmed);
  const resultCode = textValue(parsed.resultCode).replaceAll(" ", "_");

  return {
    resultCode,
    resultMsg: parsed.resultMsg,
    pageNo: integerOrNull(parsed.pageNo),
    numOfRows: integerOrNull(parsed.numOfRows),
    totalCount: integerOrNull(parsed.totalCount),
    items: parsed.items
  };
}

function parseJsonResponse(text) {
  const data = JSON.parse(text);
  const root = data.response || data;
  const header = root.header || root;
  const body = root.body || root;
  const items = body.items?.item ?? body.items ?? root.items?.item ?? root.items ?? [];

  return {
    resultCode: header.resultCode ?? body.resultCode ?? root.resultCode,
    resultMsg: header.resultMsg ?? body.resultMsg ?? root.resultMsg,
    pageNo: body.pageNo ?? header.pageNo ?? root.pageNo,
    numOfRows: body.numOfRows ?? header.numOfRows ?? root.numOfRows,
    totalCount: body.totalCount ?? header.totalCount ?? root.totalCount,
    items: normalizeItems(items)
  };
}

function parseXmlResponse(text) {
  return {
    resultCode: tagValue(text, "resultCode"),
    resultMsg: tagValue(text, "resultMsg") || tagValue(text, "returnAuthMsg") || tagValue(text, "errMsg"),
    pageNo: tagValue(text, "pageNo"),
    numOfRows: tagValue(text, "numOfRows"),
    totalCount: tagValue(text, "totalCount"),
    items: parseXmlItems(text)
  };
}

function parseXmlItems(text) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(text))) {
    const block = match[1];
    const item = {};
    for (const field of CHARGER_FIELD_NAMES) {
      const value = tagValue(block, field);
      if (value !== "") {
        item[field] = value;
      }
    }
    items.push(item);
  }

  return items;
}

function tagValue(text, tagName) {
  const match = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`).exec(text);
  return match ? decodeXml(match[1].trim()) : "";
}

function decodeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function normalizeItems(items) {
  if (!items) {
    return [];
  }
  return Array.isArray(items) ? items : [items];
}

function parseCsv(text) {
  const rows = [];
  const records = [];
  let current = "";
  let record = [];
  let inQuotes = false;
  const normalized = text.replace(/^\uFEFF/, "");

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      record.push(current);
      current = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      record.push(current);
      records.push(record);
      current = "";
      record = [];
      continue;
    }

    current += char;
  }

  if (current || record.length > 0) {
    record.push(current);
    records.push(record);
  }

  const headers = records.shift()?.map((header) => header.trim()) || [];
  for (const values of records) {
    if (values.every((value) => value.trim() === "")) {
      continue;
    }

    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index]?.trim() || "";
    });
    rows.push(row);
  }

  return rows;
}

function dedupeChargerRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = `${textValue(row.statId)}:${textValue(row.chgerId)}`;
    if (key !== ":") {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

function stationZcodes(options) {
  const values = options.zcodes ?? options.zcode ?? process.env.NEARBY_DATA_ZCODES ?? process.env.NEARBY_DATA_ZCODE;
  if (!values) {
    return [undefined];
  }

  if (Array.isArray(values)) {
    return values.map((value) => textValue(value)).filter(Boolean);
  }

  return String(values)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function chargerKw(row) {
  const output = numberValue(row.output);
  if (Number.isFinite(output) && output > 0) {
    return output;
  }

  const type = textValue(row.chgerType);
  if (["02", "07"].includes(type)) {
    return 7;
  }
  if (type) {
    return 50;
  }
  return null;
}

function chargerSpeed(row, kw) {
  if (Number.isFinite(kw)) {
    return kw >= 40 ? "fast" : "slow";
  }

  return ["02", "07"].includes(textValue(row.chgerType)) ? "slow" : "fast";
}

function chargerStatus(statusCode, updatedAt) {
  const code = textValue(statusCode);
  let status = "unknown";

  if (code === "2") {
    status = "available";
  } else if (code === "3") {
    status = "busy";
  } else if (["1", "4", "5"].includes(code)) {
    status = "offline";
  }

  if (["available", "busy"].includes(status) && isStaleStatus(updatedAt)) {
    return "unknown";
  }

  return status;
}

function isStaleStatus(updatedAt) {
  if (!updatedAt) {
    return true;
  }

  const staleHours = clampInteger(
    process.env.NEARBY_STATUS_STALE_HOURS,
    1,
    24 * 30,
    DEFAULT_STATUS_STALE_HOURS
  );
  return Date.now() - Date.parse(updatedAt) > staleHours * 60 * 60 * 1000;
}

function parsePublicDataDate(value) {
  const text = textValue(value);
  if (!text) {
    return null;
  }

  if (/^\d{14}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}+09:00`;
  }

  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function latestIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function setMetadata(db, key, value) {
  db.prepare(
    `
    INSERT INTO metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `
  ).run(key, value);
}

function groupBy(items, getKey) {
  const groups = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  }
  return groups;
}

function textValue(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function numberValue(value) {
  if (typeof value === "number") {
    return value;
  }
  const number = Number.parseFloat(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? number : NaN;
}

function integerOrNull(value) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const earthRadius = 6371000;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(deltaPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
}
