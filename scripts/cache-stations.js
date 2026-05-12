import { loadLocalEnv } from "../src/env.js";

loadLocalEnv();

const { getStationStoreSummary, refreshStationData } = await import("../src/station-data.js");

try {
  const summary = await refreshStationData();
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(error.message);
  console.error(JSON.stringify(getStationStoreSummary(), null, 2));
  process.exitCode = 1;
}
