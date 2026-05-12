# Nearby EV Chargers

모바일에서 현재 위치를 받아 가까운 전기차 충전소를 거리순으로 보여주고, 충전소를 누르면 내비게이션 앱으로 길 안내를 여는 정적 웹앱입니다.

## 실행과 종료

개발 서버를 켭니다.

```bash
mise exec -- npm run dev
```

기본 주소는 `http://localhost:5173`입니다. 같은 네트워크의 휴대폰에서 테스트할 때는 서버 로그에 출력되는 `LAN: http://...:5173` 주소를 사용합니다.

다른 포트로 켜야 할 때는 `PORT`를 지정합니다.

```bash
PORT=5174 mise exec -- npm run dev
```

터미널에서 실행 중인 서버는 `Ctrl+C`로 끕니다. 터미널을 잃어버렸다면 포트를 점유한 프로세스를 확인한 뒤 종료합니다.

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN
kill <PID>
```

## 환경변수 설정

배포 환경에서는 플랫폼의 환경변수 설정에 값을 넣습니다. 로컬 개발에서는 프로젝트 루트의 `.env` 또는 `.env.local`을 자동으로 읽습니다. 실제 프로세스 환경변수가 `.env`보다 우선하고, `.env.local`은 `.env` 위에 덮어씁니다.

필요한 키는 [.env.example](.env.example)에 정리했습니다. `.env`와 `.env.local`은 `.gitignore`에 포함되어 있으므로 서비스키를 소스 파일에 넣지 않아도 됩니다.

```dotenv
PUBLIC_DATA_SERVICE_KEY=공공데이터포털_서비스키
NAVER_MAP_NCP_KEY_ID=네이버지도_ncpKeyId
NEARBY_STATION_DB=data/stations.sqlite
NEARBY_AUTO_REFRESH=1
```

현재 읽힌 환경변수를 확인합니다. 서비스키 값은 마스킹되어 출력됩니다.

```bash
npm run env:status
```

`.env` 로딩을 끄려면 `NEARBY_LOAD_DOTENV=0`을 지정합니다. 다른 env 파일을 테스트하려면 `NEARBY_ENV_FILE=/path/to/.env`를 지정합니다.

## 지도 설정

지도 표시는 NAVER Maps JavaScript API v3로 이관했습니다. 네이버 지도 표시에는 `ncpKeyId`가 필요합니다.

1. Naver Cloud Console에서 Maps 애플리케이션을 만듭니다.
2. `Dynamic Map`을 활성화합니다.
3. 웹 서비스 URL 또는 배포 도메인을 등록합니다. 포트와 경로는 제외하고 호스트만 등록해야 합니다.
4. `NAVER_MAP_NCP_KEY_ID` 환경변수에 발급받은 값을 넣습니다.

```dotenv
NAVER_MAP_NCP_KEY_ID=발급받은_ncpKeyId
```

키가 비어 있거나 등록 도메인이 맞지 않으면 지도 대신 설정 안내 메시지가 표시됩니다.

로컬 개발 중에는 네이버 콘솔의 Web Service URL에 아래 값을 등록합니다.

- PC 브라우저: `http://localhost`
- 휴대폰 LAN 테스트: 서버 로그에 표시된 LAN 주소에서 포트를 뺀 값, 예: `http://192.168.1.216`
- 잘못된 예: `http://localhost:5173`, `http://localhost:5173/`, `http://localhost:5173/index.html`

## 구현된 기능

- 브라우저 Geolocation API로 현재 위치 요청
- 헤더 아래 영역을 지도 중심 화면으로 구성
- 네이버 지도 SDK 기반 충전소 마커와 현재 위치 마커 표시
- 서버 API와 SQLite 캐시 기반 실제 충전소 데이터 조회
- Haversine 거리 계산 후 가까운 순 정렬
- 바텀시트에서 충전소 리스트 표시
- `전체`, `급속`, `완속` 필터
- `충전 가능` 충전기만 보는 필터
- 충전소별 네이버지도, 카카오맵, 티맵 길 안내 선택 아이콘
- 실제 캐시가 비어 있을 때 UX 확인용 샘플 데이터 fallback

## 길 안내 앱 연동

충전소 카드의 `N`, `K`, `T` 아이콘으로 길 안내 앱을 선택합니다.

- `N`: 네이버지도 URL Scheme으로 길 안내를 열고, 실패 시 네이버 지도 검색으로 이동합니다.
- `K`: 카카오맵 공식 지도 URL의 자동차 길찾기 링크를 엽니다.
- `T`: 티맵 앱 연동 URL을 열고, 미설치 환경에서는 앱 스토어로 이동합니다.

모바일 앱 실행 방식은 브라우저와 OS 정책 영향을 받습니다. 데스크톱에서는 앱 Scheme 대신 웹 fallback URL이 열립니다.

## 데이터

앱은 서버의 `/api/stations`를 통해 [data/stations.sqlite](data/stations.sqlite)에 보존된 충전소 캐시를 읽습니다. 캐시가 비어 있거나 서버 API를 사용할 수 없을 때만 [public/data/stations.sample.json](public/data/stations.sample.json)을 표시합니다.

현재 캐시에는 공공데이터포털의 `한국전력공사_전기차충전소위경도_20250531` CSV에서 가져온 실제 충전소 좌표 데이터가 들어 있습니다. 이 파일은 충전소 위치 중심 자료라서 충전기 속도와 실시간 상태는 `속도 미상`, `상태 미확인`으로 표시합니다.

캐시 상태를 확인합니다.

```bash
npm run data:status
```

로그인이나 서비스키 없이 공개 CSV를 다시 받아 SQLite에 저장합니다.

```bash
npm run data:bootstrap
```

이미 받아 둔 CSV 파일을 사용하려면 경로를 지정합니다.

```bash
NEARBY_KEPCO_CSV_PATH=/path/to/kepco.csv npm run data:bootstrap
```

[docs/DATA_PLAN.md](docs/DATA_PLAN.md)의 1차 소스인 `한국환경공단_전기자동차 충전소 정보` OpenAPI로 실시간 상태와 충전기 상세를 갱신하려면 공공데이터포털 서비스키를 서버 환경변수로 설정한 뒤 refresh를 실행합니다.

서비스키가 해당 API에 유효한지 먼저 1회 요청으로 확인합니다.

```bash
npm run data:check-key
```

`HTTP 401 Unauthorized`가 나오면 `.env` 로딩 문제보다는 공공데이터포털 쪽 인증 상태 문제일 가능성이 큽니다. `data.go.kr > 마이페이지 > 오픈API`에서 `한국환경공단_전기자동차 충전소 정보` 활용신청이 승인되어 있는지, 현재 활성화된 `일반 인증키`를 넣었는지, 재발급으로 이전 키가 폐기되지 않았는지 확인하세요. 새 키는 발급 직후 바로 통과하지 않을 수 있으니 잠시 뒤 다시 확인합니다.

```bash
npm run data:refresh
```

주요 환경변수:

- `PUBLIC_DATA_SERVICE_KEY`, `DATA_GO_KR_SERVICE_KEY`, `EV_CHARGER_SERVICE_KEY`: 환경공단 OpenAPI 서비스키
- `NAVER_MAP_NCP_KEY_ID`, `NEARBY_PUBLIC_NAVER_MAP_NCP_KEY_ID`: 브라우저에 전달할 네이버 지도 `ncpKeyId`
- `NEARBY_STATION_DB`: SQLite 파일 경로, 기본값 `data/stations.sqlite`
- `NEARBY_DATA_ZCODE`, `NEARBY_DATA_ZCODES`, `NEARBY_DATA_ZSCODE`: 환경공단 API 지역 제한
- `NEARBY_AUTO_REFRESH=1`: 서버 요청 시 오래된 캐시를 자동 갱신
- `NEARBY_RESPONSE_CACHE_MS`: `/api/stations` 응답 메모리 캐시 TTL

## 운영 메모

- 휴대폰에서 위치 권한을 쓰려면 운영 환경은 HTTPS로 배포해야 합니다.
- 개발 중 실기기 테스트는 HTTPS 터널 또는 신뢰된 로컬 인증서를 사용하세요.
- 운영 데이터는 공공데이터포털 `한국환경공단_전기자동차 충전소 정보` OpenAPI를 서버에서 호출하고 SQLite에 보존합니다.
- `PUBLIC_DATA_SERVICE_KEY`는 브라우저에 노출하지 말고 서버 환경변수로만 관리해야 합니다. `/config.js`는 네이버 지도처럼 공개되어도 되는 브라우저 설정만 전달합니다.
