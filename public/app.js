const MIN_ZOOM = 11;
const MAX_ZOOM = 18;
const NAVER_MAPS_CALLBACK = "__nearbyNaverMapsReady";
const NAVER_MAPS_LOAD_TIMEOUT_MS = 10000;

const config = window.NEARBY_CONFIG || {};

const state = {
  stations: [],
  rows: [],
  location: null,
  speed: "all",
  availableOnly: false,
  selectedStationId: null,
  sheetOpen: false,
  mapZoom: 14,
  map: null,
  naverReady: false,
  mapUnavailableReason: "",
  stationMarkers: [],
  userMarker: null,
  toastTimer: null
};

const els = {
  refreshLocation: document.querySelector("#refresh-location"),
  locationSummary: document.querySelector("#location-summary"),
  locationAccuracy: document.querySelector("#location-accuracy"),
  availableOnly: document.querySelector("#available-only"),
  segments: [...document.querySelectorAll("[data-speed]")],
  mapCanvas: document.querySelector("#map-canvas"),
  mapRoot: document.querySelector("#naver-map"),
  mapState: document.querySelector("#map-state"),
  zoomIn: document.querySelector("#zoom-in"),
  zoomOut: document.querySelector("#zoom-out"),
  bottomSheet: document.querySelector("#bottom-sheet"),
  sheetToggle: document.querySelector("#sheet-toggle"),
  list: document.querySelector("#station-list"),
  resultCount: document.querySelector("#result-count"),
  dataState: document.querySelector("#data-state"),
  toast: document.querySelector("#toast")
};

const statusLabel = {
  available: "충전 가능",
  busy: "사용 중",
  offline: "점검",
  unknown: "상태 미확인"
};

const speedLabel = {
  fast: "급속",
  slow: "완속",
  unknown: "속도 미상"
};

const routeProviderLabel = {
  naver: "네이버지도",
  kakao: "카카오맵",
  tmap: "티맵"
};

init();

async function init() {
  bindEvents();
  await loadStations();
  await initNaverMap();
  requestLocation();
  render();
}

function bindEvents() {
  els.refreshLocation.addEventListener("click", requestLocation);
  els.zoomIn.addEventListener("click", () => setMapZoom(state.mapZoom + 1));
  els.zoomOut.addEventListener("click", () => setMapZoom(state.mapZoom - 1));
  els.sheetToggle.addEventListener("click", toggleSheet);

  els.availableOnly.addEventListener("change", (event) => {
    state.availableOnly = event.target.checked;
    state.selectedStationId = null;
    render();
  });

  for (const button of els.segments) {
    button.addEventListener("click", () => {
      state.speed = button.dataset.speed;
      state.selectedStationId = null;
      for (const segment of els.segments) {
        const active = segment === button;
        segment.classList.toggle("is-active", active);
        segment.setAttribute("aria-pressed", String(active));
      }
      render();
    });
  }
}

async function initNaverMap() {
  const ncpKeyId = config.NAVER_MAP_NCP_KEY_ID?.trim();

  if (!ncpKeyId) {
    state.mapUnavailableReason = "NAVER_MAP_NCP_KEY_ID 환경변수를 설정하면 네이버 지도가 표시됩니다.";
    els.mapState.textContent = state.mapUnavailableReason;
    return;
  }

  try {
    await loadNaverMapsSdk(ncpKeyId);
    const center = mapCenter();
    state.map = new naver.maps.Map(els.mapRoot, {
      center: new naver.maps.LatLng(center.lat, center.lng),
      zoom: state.mapZoom,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      zoomControl: false,
      mapDataControl: false,
      scaleControl: false
    });
    state.naverReady = true;
    state.mapUnavailableReason = "";
    els.mapCanvas.classList.add("is-ready");
    els.mapState.textContent = "";

    window.requestAnimationFrame(() => {
      if (!state.map) return;
      state.map.refresh(true);
      state.map.setCenter(new naver.maps.LatLng(center.lat, center.lng));
    });
  } catch (error) {
    state.mapUnavailableReason = naverMapLoadErrorMessage(error);
    els.mapState.textContent = state.mapUnavailableReason;
    console.warn(error);
  }
}

function loadNaverMapsSdk(ncpKeyId) {
  if (window.naver?.maps) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      settle(reject, new Error("NAVER Maps SDK load timeout"));
    }, NAVER_MAPS_LOAD_TIMEOUT_MS);

    function settle(callback, value) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      callback(value);
    }

    window[NAVER_MAPS_CALLBACK] = () => settle(resolve);
    window.navermap_authFailure = () => settle(reject, new Error("NAVER Maps authentication failed"));

    const script = document.createElement("script");
    script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(ncpKeyId)}&callback=${NAVER_MAPS_CALLBACK}`;
    script.async = true;
    script.onerror = () => settle(reject, new Error("NAVER Maps script failed"));
    document.head.append(script);
  });
}

function naverMapLoadErrorMessage(error) {
  if (error?.message === "NAVER Maps authentication failed") {
    return "네이버 지도 인증에 실패했습니다. Dynamic Map 활성화와 Web Service URL 등록값을 확인하세요. 로컬은 http://localhost처럼 포트와 경로를 제외해 등록합니다.";
  }

  if (error?.message === "NAVER Maps SDK load timeout") {
    return "네이버 지도 SDK 응답이 지연되고 있습니다. 네트워크 상태를 확인한 뒤 새로고침하세요.";
  }

  return "네이버 지도 SDK를 불러오지 못했습니다. 키, 네트워크, 등록 도메인을 확인하세요.";
}

async function loadStations() {
  try {
    els.dataState.textContent = state.location ? "주변 데이터 조회 중" : "실제 데이터 조회 중";
    const params = new URLSearchParams({
      limit: "120"
    });

    if (state.location) {
      params.set("lat", state.location.lat);
      params.set("lng", state.location.lng);
      params.set("radius", "8000");
    }

    const response = await fetch(`/api/stations?${params.toString()}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Station data request failed: ${response.status}`);
    }

    const payload = await response.json();
    const stations = Array.isArray(payload) ? payload : payload.stations;
    if (!Array.isArray(stations) || stations.length === 0) {
      throw new Error("No cached station data");
    }

    state.stations = stations;
    els.dataState.textContent = stationDataLabel(payload.meta);
  } catch (error) {
    console.warn(error);
    await loadSampleStations();
    showToast("실제 충전소 캐시가 없어 샘플 데이터를 표시합니다.");
  }
}

async function loadSampleStations() {
  try {
    const response = await fetch("./data/stations.sample.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Sample data request failed: ${response.status}`);
    }
    state.stations = await response.json();
    els.dataState.textContent = "샘플 데이터";
  } catch {
    state.stations = [];
    els.dataState.textContent = "데이터 없음";
    showToast("충전소 데이터를 불러오지 못했습니다.");
  }
}

function requestLocation() {
  if (!("geolocation" in navigator)) {
    els.locationSummary.textContent = "이 브라우저는 위치 확인을 지원하지 않습니다";
    els.locationAccuracy.textContent = "-";
    showToast("위치 기능을 사용할 수 없어 거리를 계산하지 못했습니다.");
    render();
    return;
  }

  els.locationSummary.textContent = "위치 확인 중";
  els.locationAccuracy.textContent = "-";

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      state.location = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
        timestamp: position.timestamp
      };

      els.locationSummary.textContent = "현재 위치 사용 중";
      els.locationAccuracy.textContent = `오차 약 ${formatMeters(position.coords.accuracy)}`;
      state.mapZoom = Math.max(state.mapZoom, 15);
      await loadStations();
      render();
    },
    (error) => {
      state.location = null;
      els.locationSummary.textContent = locationErrorMessage(error);
      els.locationAccuracy.textContent = "-";
      showToast("위치 권한을 허용하면 가까운 순서로 정렬됩니다.");
      render();
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 60000
    }
  );
}

function render() {
  state.rows = sortedStationRows();
  els.resultCount.textContent = `${state.rows.length}곳`;

  renderMap();
  renderSheet();
}

function sortedStationRows() {
  const rows = filteredStations().map((station) => {
    const distance = state.location
      ? haversineDistance(state.location.lat, state.location.lng, station.lat, station.lng)
      : null;

    return { station, distance };
  });

  rows.sort((a, b) => {
    if (a.distance === null && b.distance === null) {
      return a.station.name.localeCompare(b.station.name, "ko");
    }
    if (a.distance === null) return 1;
    if (b.distance === null) return -1;
    return a.distance - b.distance;
  });

  return rows;
}

function filteredStations() {
  return state.stations.filter((station) => matchingChargers(station).length > 0);
}

function matchingChargers(station) {
  return station.chargers.filter((charger) => {
    const speedMatch = state.speed === "all" || charger.speed === state.speed;
    const availabilityMatch = !state.availableOnly || charger.status === "available";
    return speedMatch && availabilityMatch;
  });
}

function renderMap() {
  if (!state.naverReady || !state.map) {
    els.mapState.textContent = state.mapUnavailableReason || "네이버 지도를 준비 중입니다.";
    return;
  }

  els.mapState.textContent = "";
  const center = mapCenter();
  state.map.setCenter(new naver.maps.LatLng(center.lat, center.lng));
  state.map.setZoom(state.mapZoom);

  clearMapMarkers();

  if (state.location) {
    state.userMarker = new naver.maps.Marker({
      position: new naver.maps.LatLng(state.location.lat, state.location.lng),
      map: state.map,
      title: "현재 위치",
      icon: {
        content: `<div class="naver-user-marker" aria-label="현재 위치"></div>`,
        anchor: new naver.maps.Point(11, 11)
      }
    });
  }

  for (const { station, distance } of state.rows) {
    const selected = station.id === state.selectedStationId;
    const available = matchingChargers(station).some((charger) => charger.status === "available");
    const marker = new naver.maps.Marker({
      position: new naver.maps.LatLng(station.lat, station.lng),
      map: state.map,
      title: station.name,
      icon: {
        content: naverMarkerContent(station, distance, selected, available),
        anchor: new naver.maps.Point(78, 54)
      }
    });

    naver.maps.Event.addListener(marker, "click", () => selectStation(station.id));
    state.stationMarkers.push(marker);
  }

  if (state.rows.length === 0) {
    els.mapState.textContent = "조건에 맞는 충전소가 없습니다.";
  }
}

function clearMapMarkers() {
  for (const marker of state.stationMarkers) {
    marker.setMap(null);
  }
  state.stationMarkers = [];

  if (state.userMarker) {
    state.userMarker.setMap(null);
    state.userMarker = null;
  }
}

function naverMarkerContent(station, distance, selected, available) {
  return `
    <div class="naver-marker${selected ? " is-selected" : ""}${available ? " is-available" : ""}">
      <span class="marker-pin" aria-hidden="true"></span>
      <span class="marker-label">
        <strong>${escapeHtml(station.name)}</strong>
        <span>${distance === null ? "거리 계산 전" : formatDistance(distance)}</span>
      </span>
    </div>
  `;
}

function renderSheet() {
  els.bottomSheet.classList.toggle("is-open", state.sheetOpen);
  els.sheetToggle.setAttribute("aria-expanded", String(state.sheetOpen));

  if (state.rows.length === 0) {
    els.list.innerHTML = `<div class="empty">조건에 맞는 충전소가 없습니다.</div>`;
    return;
  }

  els.list.replaceChildren(
    ...state.rows.map(({ station, distance }) => stationCard(station, distance))
  );
}

function stationCard(station, distance) {
  const article = document.createElement("article");
  article.className = `station-card${station.id === state.selectedStationId ? " is-selected" : ""}`;
  article.tabIndex = 0;
  article.setAttribute("role", "button");
  article.setAttribute("aria-label", `${station.name} 지도에서 선택`);
  article.addEventListener("click", () => selectStation(station.id));
  article.addEventListener("keydown", (event) => {
    if (event.target.closest?.(".route-option")) {
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectStation(station.id);
    }
  });

  const filteredChargers = matchingChargers(station);
  const available = filteredChargers.filter((charger) => charger.status === "available").length;
  const busy = filteredChargers.filter((charger) => charger.status === "busy").length;
  const offline = filteredChargers.filter((charger) => charger.status === "offline").length;
  const unknown = filteredChargers.filter((charger) => charger.status === "unknown").length;
  const hasFast = filteredChargers.some((charger) => charger.speed === "fast");
  const hasSlow = filteredChargers.some((charger) => charger.speed === "slow");
  const kwValues = filteredChargers.map((charger) => Number(charger.kw)).filter(Number.isFinite);
  const maxKw = kwValues.length ? Math.max(...kwValues) : null;

  article.innerHTML = `
    <div class="station-main">
      <div class="station-name">${escapeHtml(station.name)}</div>
      <div class="station-address">${escapeHtml(station.address || "주소 정보 없음")}</div>
      <div class="station-meta">
        ${available ? `<span class="pill available">${statusLabel.available} ${available}</span>` : ""}
        ${busy ? `<span class="pill busy">${statusLabel.busy} ${busy}</span>` : ""}
        ${offline ? `<span class="pill offline">${statusLabel.offline} ${offline}</span>` : ""}
        ${unknown ? `<span class="pill">${statusLabel.unknown} ${unknown}</span>` : ""}
        ${chargerSpeedPill(hasFast, hasSlow)}
        ${maxKw ? `<span class="pill">최대 ${maxKw}kW</span>` : ""}
        <span class="pill">${escapeHtml(station.operator || "운영기관 미상")}</span>
      </div>
    </div>
    <div class="station-side">
      <span class="distance">${distance === null ? "-" : formatDistance(distance)}</span>
      <div class="route-actions" aria-label="길 안내 앱 선택">
        ${routeButton("naver", "N")}
        ${routeButton("kakao", "K")}
        ${routeButton("tmap", "T")}
      </div>
    </div>
  `;

  for (const button of article.querySelectorAll(".route-option")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openNavigation(button.dataset.provider, station);
    });
  }

  return article;
}

function routeButton(provider, glyph) {
  const label = routeProviderLabel[provider];
  return `
    <button class="route-option ${provider}" data-provider="${provider}" type="button" aria-label="${label}로 길 안내" title="${label}">
      <span aria-hidden="true">${glyph}</span>
    </button>
  `;
}

function chargerSpeedPill(hasFast, hasSlow) {
  if (hasFast) {
    return `<span class="pill fast">${speedLabel.fast}</span>`;
  }

  if (hasSlow) {
    return `<span class="pill">${speedLabel.slow}</span>`;
  }

  return `<span class="pill">${speedLabel.unknown}</span>`;
}

function selectStation(stationId) {
  state.selectedStationId = stationId;
  state.sheetOpen = true;
  render();

  const selectedCard = els.list.querySelector(".station-card.is-selected");
  selectedCard?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function toggleSheet() {
  state.sheetOpen = !state.sheetOpen;
  renderSheet();
}

function setMapZoom(zoom) {
  state.mapZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  renderMap();
}

function mapCenter() {
  const selected = state.rows.find(({ station }) => station.id === state.selectedStationId)?.station;
  if (selected) {
    return { lat: selected.lat, lng: selected.lng };
  }

  if (state.location) {
    return state.location;
  }

  if (state.rows.length > 0) {
    const total = state.rows.reduce(
      (acc, { station }) => ({
        lat: acc.lat + station.lat,
        lng: acc.lng + station.lng
      }),
      { lat: 0, lng: 0 }
    );
    return {
      lat: total.lat / state.rows.length,
      lng: total.lng / state.rows.length
    };
  }

  return { lat: 37.5665, lng: 126.978 };
}

function openNavigation(provider, station) {
  const label = routeProviderLabel[provider] || "지도 앱";
  showToast(`${label}로 ${station.name} 길 안내를 엽니다.`);

  if (provider === "naver") {
    launchAppUrl(naverNavigationUrl(station), naverMapFallbackUrl(station), {
      androidIntentUrl: naverAndroidIntentUrl(station)
    });
    return;
  }

  if (provider === "kakao") {
    openExternalUrl(kakaoRouteUrl(station));
    return;
  }

  if (provider === "tmap") {
    launchAppUrl(tmapRouteUrl(station), tmapFallbackUrl(), {
      androidIntentUrl: tmapAndroidIntentUrl(station)
    });
  }
}

function launchAppUrl(appUrl, fallbackUrl, options = {}) {
  if (/Android/i.test(navigator.userAgent) && options.androidIntentUrl) {
    window.location.href = options.androidIntentUrl;
    return;
  }

  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    const startedAt = Date.now();
    window.location.href = appUrl;
    window.setTimeout(() => {
      if (Date.now() - startedAt < 1800 && document.visibilityState === "visible") {
        window.location.href = fallbackUrl;
      }
    }, 1200);
    return;
  }

  openExternalUrl(fallbackUrl);
}

function openExternalUrl(url) {
  if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    window.location.href = url;
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

function naverNavigationUrl(station) {
  const params = new URLSearchParams({
    dlat: station.lat,
    dlng: station.lng,
    dname: station.name,
    appname: location.host || "nearby.local"
  });

  if (state.location) {
    params.set("slat", state.location.lat);
    params.set("slng", state.location.lng);
    params.set("sname", "현재 위치");
  }

  return `nmap://navigation?${params.toString()}`;
}

function naverAndroidIntentUrl(station) {
  const [, query = ""] = naverNavigationUrl(station).split("?");
  return `intent://navigation?${query}#Intent;scheme=nmap;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;package=com.nhn.android.nmap;S.browser_fallback_url=${encodeURIComponent(naverMapFallbackUrl(station))};end`;
}

function naverMapFallbackUrl(station) {
  return `https://map.naver.com/p/search/${encodeURIComponent(station.name)}`;
}

function kakaoRouteUrl(station) {
  const destination = routePoint(station.name, station.lat, station.lng);

  if (!state.location) {
    return `https://map.kakao.com/link/to/${destination}`;
  }

  const origin = routePoint("현재 위치", state.location.lat, state.location.lng);
  return `https://map.kakao.com/link/by/car/${origin}/${destination}`;
}

function tmapRouteUrl(station) {
  const params = new URLSearchParams({
    rGoName: station.name,
    rGoX: station.lng,
    rGoY: station.lat
  });
  return `tmap://route?${params.toString()}`;
}

function tmapAndroidIntentUrl(station) {
  const [, query = ""] = tmapRouteUrl(station).split("?");
  return `intent://route?${query}#Intent;scheme=tmap;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;package=com.skt.tmap.ku;S.browser_fallback_url=${encodeURIComponent(tmapFallbackUrl())};end`;
}

function tmapFallbackUrl() {
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    return "https://apps.apple.com/kr/app/%ED%8B%B0%EB%A7%B5-%EB%8C%80%EC%A4%91%EA%B5%90%ED%86%B5-%EB%8C%80%EB%A6%AC%EC%9A%B4%EC%A0%84-%EC%A3%BC%EC%B0%A8-%EB%A0%8C%ED%84%B0%EC%B9%B4-%EA%B3%B5%ED%95%AD%EB%B2%84%EC%8A%A4/id431589174";
  }

  return "https://play.google.com/store/apps/details?id=com.skt.tmap.ku";
}

function routePoint(name, lat, lng) {
  return `${encodeURIComponent(name)},${lat},${lng}`;
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const earthRadius = 6371000;
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const deltaPhi = toRadians(lat2 - lat1);
  const deltaLambda = toRadians(lng2 - lng1);
  const a =
    Math.sin(deltaPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function formatDistance(meters) {
  if (meters < 1000) {
    return `${Math.round(meters)}m`;
  }
  return `${(meters / 1000).toFixed(1)}km`;
}

function formatMeters(meters) {
  if (!Number.isFinite(meters)) {
    return "-";
  }
  return meters < 1000 ? `${Math.round(meters)}m` : `${(meters / 1000).toFixed(1)}km`;
}

function stationDataLabel(meta) {
  if (!meta || meta.source !== "sqlite") {
    return "실제 데이터";
  }

  const count = Number(meta.totalStations);
  const prefix = Number.isFinite(count) ? `실제 데이터 ${count.toLocaleString("ko-KR")}곳` : "실제 데이터";
  if (!meta.lastRefreshAt) {
    return prefix;
  }

  return `${prefix} · ${formatUpdatedAt(meta.lastRefreshAt)}`;
}

function formatUpdatedAt(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "갱신 시각 미상";
  }

  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function locationErrorMessage(error) {
  if (error.code === error.PERMISSION_DENIED) {
    return "위치 권한이 필요합니다";
  }
  if (error.code === error.TIMEOUT) {
    return "위치 확인 시간이 초과됐습니다";
  }
  return "위치를 확인하지 못했습니다";
}

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  state.toastTimer = window.setTimeout(() => {
    els.toast.classList.remove("is-visible");
  }, 2600);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
