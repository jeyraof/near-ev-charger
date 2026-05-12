import { loadLocalEnv } from "../src/env.js";

const loadedFiles = loadLocalEnv();
const variables = [
  "PORT",
  "HOST",
  "PUBLIC_DATA_SERVICE_KEY",
  "DATA_GO_KR_SERVICE_KEY",
  "EV_CHARGER_SERVICE_KEY",
  "NAVER_MAP_NCP_KEY_ID",
  "NEARBY_PUBLIC_NAVER_MAP_NCP_KEY_ID",
  "NEARBY_STATION_DB",
  "NEARBY_AUTO_REFRESH",
  "NEARBY_AUTO_REFRESH_INTERVAL_MS",
  "NEARBY_RESPONSE_CACHE_MS",
  "NEARBY_DATA_ZCODE",
  "NEARBY_DATA_ZCODES",
  "NEARBY_DATA_ZSCODE",
  "NEARBY_DATA_PAGE_SIZE",
  "NEARBY_DATA_MAX_PAGES",
  "NEARBY_STATUS_STALE_HOURS",
  "NEARBY_KEPCO_CSV_PATH"
];

console.log(
  JSON.stringify(
    {
      loadedEnvFiles: loadedFiles,
      variables: Object.fromEntries(
        variables.map((name) => [
          name,
          {
            configured: Boolean(process.env[name]),
            value: safeValue(name, process.env[name])
          }
        ])
      )
    },
    null,
    2
  )
);

function safeValue(name, value) {
  if (!value) {
    return null;
  }

  if (name.includes("KEY")) {
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }

  return value;
}
