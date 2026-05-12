import { loadLocalEnv } from "../src/env.js";

loadLocalEnv();

const { getStationStoreSummary } = await import("../src/station-data.js");

console.log(JSON.stringify(getStationStoreSummary(), null, 2));
