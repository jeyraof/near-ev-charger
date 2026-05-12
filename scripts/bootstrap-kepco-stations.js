import { loadLocalEnv } from "../src/env.js";

loadLocalEnv();

const { getStationStoreSummary, refreshKepcoCoordinateData } = await import("../src/station-data.js");

try {
  const summary = await refreshKepcoCoordinateData({
    path: process.env.NEARBY_KEPCO_CSV_PATH || undefined
  });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(error.message);
  console.error(JSON.stringify(getStationStoreSummary(), null, 2));
  process.exitCode = 1;
}
