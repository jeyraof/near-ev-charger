import { loadLocalEnv } from "../src/env.js";

loadLocalEnv();

const serviceKey = (
  process.env.PUBLIC_DATA_SERVICE_KEY ||
  process.env.DATA_GO_KR_SERVICE_KEY ||
  process.env.EV_CHARGER_SERVICE_KEY ||
  ""
).trim();

if (!serviceKey) {
  console.error("PUBLIC_DATA_SERVICE_KEY, DATA_GO_KR_SERVICE_KEY, or EV_CHARGER_SERVICE_KEY is not configured.");
  process.exitCode = 1;
} else {
  const url = publicDataStatusCheckUrl(serviceKey);
  const response = await fetch(url, {
    headers: {
      Accept: "application/xml,text/xml,application/json"
    }
  });
  const text = await response.text();
  const resultCode = valueFromResponse(text, "resultCode");
  const resultMsg = valueFromResponse(text, "resultMsg") || valueFromResponse(text, "returnAuthMsg");

  console.log(
    JSON.stringify(
      {
        key: describeKey(serviceKey),
        request: {
          endpoint: "getChargerStatus",
          pageNo: 1,
          numOfRows: 10,
          period: 1,
          zcode: "11"
        },
        response: {
          httpStatus: response.status,
          resultCode: resultCode || null,
          resultMsg: resultMsg || response.statusText || null
        },
        diagnosis: diagnosis(response.status, resultCode, resultMsg)
      },
      null,
      2
    )
  );

  if (!response.ok || (resultCode && !["00", "NORMAL_SERVICE"].includes(resultCode))) {
    process.exitCode = 1;
  }
}

function publicDataStatusCheckUrl(key) {
  const encodedKey = /%[0-9a-f]{2}/i.test(key) ? key : encodeURIComponent(key);
  return `https://apis.data.go.kr/B552584/EvCharger/getChargerStatus?serviceKey=${encodedKey}&pageNo=1&numOfRows=10&period=1&zcode=11`;
}

function describeKey(key) {
  return {
    configured: true,
    masked: `${key.slice(0, 4)}...${key.slice(-4)}`,
    length: key.length,
    hasPercentEncoding: /%[0-9a-f]{2}/i.test(key),
    hasWhitespace: /\s/.test(key)
  };
}

function valueFromResponse(text, tagName) {
  const xmlMatch = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`).exec(text);
  if (xmlMatch) {
    return xmlMatch[1].trim();
  }

  try {
    const json = JSON.parse(text);
    return json?.response?.header?.[tagName] || json?.[tagName] || "";
  } catch {
    return "";
  }
}

function diagnosis(status, resultCode, resultMsg) {
  if (status === 200 && (!resultCode || ["00", "NORMAL_SERVICE"].includes(resultCode))) {
    return "OK: the key can call this API.";
  }

  if (status === 401) {
    return "Unauthorized: the key is loaded, but data.go.kr rejected it. Check this API's 활용신청 approval, active 일반 인증키 value, key activation delay, or whether the key was regenerated.";
  }

  return `Request failed: ${status}${resultCode ? ` / ${resultCode}` : ""}${resultMsg ? ` / ${resultMsg}` : ""}`;
}
