# 실제 충전소 데이터 수급 계획

## 0. 현재 구현 상태

- 서버 API `/api/stations`를 추가해 브라우저가 공공데이터 서비스키를 직접 다루지 않도록 했습니다.
- 충전소 캐시는 `data/stations.sqlite`에 보존합니다.
- 서비스키 없이 확보 가능한 bootstrap 데이터로 공공데이터포털 `한국전력공사_전기차충전소위경도_20250531` CSV를 SQLite에 적재했습니다.
- 이 bootstrap 데이터는 충전소 좌표 중심 자료이므로 충전기 속도와 실시간 상태는 `unknown`으로 저장합니다.
- 환경공단 OpenAPI 서비스키가 있으면 `npm run data:refresh`로 아래 1차 데이터 소스의 충전기 상세와 상태를 SQLite에 덮어쓸 수 있습니다.
- 배포 환경은 서버 환경변수를 사용합니다. 로컬 개발은 `.env`와 `.env.local`을 자동 로드하며, 템플릿은 `.env.example`에 둡니다.

## 1. 1차 데이터 소스

- 공공데이터포털 `한국환경공단_전기자동차 충전소 정보` OpenAPI를 1차 소스로 사용합니다.
- 이 API는 충전소 위치, 운영기관, 충전기 타입, 충전용량, 이용 가능 시간, 충전기 상태, 상태 갱신 시각 등을 제공합니다.
- 2026-05-11 확인 기준 데이터 포맷은 XML, 업데이트 주기는 실시간, 개발계정 트래픽은 1,000건입니다.
- 후보 API:
  - 상태 중심: `getChargerStatus`
  - 위치/상세 중심: 같은 서비스의 충전소 정보 조회 기능

Source: https://www.data.go.kr/data/15076352/openapi.do

## 2. 운영 아키텍처

브라우저에서 공공데이터 API를 직접 호출하지 않고, 작은 서버 API를 둡니다.

1. 서버가 공공데이터포털 서비스키를 보관합니다.
2. 서버가 사용자 좌표와 필터를 받아 가까운 후보를 반환합니다.
3. 서버는 시도/지역 코드, 반경, 상태 갱신 기간을 이용해 API 호출량을 줄입니다.
4. 응답은 1-3분 캐시하고, 상태 데이터는 더 짧게 캐시합니다.
5. 브라우저에는 정규화된 JSON만 전달합니다.

## 3. 정규화 모델

현재 샘플 파일과 같은 형태로 API 응답을 매핑합니다.

```json
{
  "id": "statId",
  "name": "statNm",
  "operator": "busiNm",
  "address": "addr",
  "lat": 37.0,
  "lng": 127.0,
  "updatedAt": "statUpdDt",
  "chargers": [
    {
      "id": "chgerId",
      "speed": "fast",
      "kw": 100,
      "status": "available"
    }
  ]
}
```

`speed`는 충전용량 또는 충전기 타입 기준으로 `fast`와 `slow`로 변환합니다. `status`는 공공데이터 상태 코드를 앱 내부 상태인 `available`, `busy`, `offline`으로 변환합니다.

## 4. API 품질 보강

- 좌표가 없는 레코드는 제외합니다.
- 상태 갱신 시각이 오래된 충전기는 `offline` 또는 `unknown`으로 분리합니다.
- 같은 충전소의 여러 충전기는 `statId` 기준으로 묶습니다.
- 운영기관, 이용자 제한, 주차요금, 이용시간은 UI 확장 필드로 보관합니다.
- 공공데이터 장애 또는 쿼터 초과 시 마지막 정상 캐시를 반환합니다.

## 5. 지도/내비게이션 연동

- 지도 표시는 네이버 Maps JavaScript API v3 Web Dynamic Map으로 이관합니다.
- 네이버 지도 SDK는 `ncpKeyId`와 Dynamic Map 활성화가 필요합니다.
- 길 안내는 충전소 카드에서 사용자가 네이버지도, 카카오맵, 티맵 중 선택합니다.
- 네이버지도는 URL Scheme의 `/navigation` 액션을 사용하고, Android는 Intent URL을 사용합니다.
- 카카오맵은 공식 지도 URL의 `/link/by/car` 또는 `/link/to` 패턴을 사용합니다.
- 티맵은 TMAP 앱 연동 URL을 사용하고, 미설치 환경은 앱 스토어로 안내합니다.

Sources:

- NAVER Maps URL Scheme: https://guide.ncloud-docs.com/docs/en/maps-url-scheme
- NAVER Maps JavaScript API v3: https://navermaps.github.io/maps.js.ncp/docs/tutorial-2-Getting-Started.html
- Kakao 지도 URL: https://apis.map.kakao.com/web/guide/

## 6. 배포 체크리스트

- HTTPS 배포: 모바일 브라우저의 위치 권한은 보안 컨텍스트가 필요합니다.
- 공공데이터포털 운영계정 신청 및 호출량 확인
- 서비스키 서버 환경변수화: `PUBLIC_DATA_SERVICE_KEY` 또는 동등 alias 사용
- 로컬 개발용 `.env`는 커밋하지 않고 `.env.example`만 유지
- 좌표 기반 검색 반경과 최대 결과 수 결정
- API 응답 캐시, 장애 fallback, 로그 수집
- 개인정보 최소화: 사용자 좌표는 요청 처리에만 사용하고 저장하지 않습니다.
