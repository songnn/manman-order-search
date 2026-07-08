# Google Apps Script 카톡 CSV 원본 업로드 연동 패치

핵심 원칙은 하나입니다.

Google Apps Script는 카카오 CSV/TXT 원본 파일과 최소 메타데이터만 Vercel API로 전송합니다. 입장/퇴장 추출, 주문 메시지 파싱, Raw 주문행 매칭, 실제 주문시간 계산, 전환율 계산은 모두 Vercel 주문조회 프로젝트가 처리합니다.

## 0. 설정값

먼저 Supabase SQL Editor에서 이 파일을 실행해 분석 테이블을 만듭니다.

```text
docs/supabase-kakao-csv-schema.sql
```

Apps Script 프로젝트 설정 > 스크립트 속성에 아래 값을 추가합니다.

```text
MANMAN_API_BASE_URL=https://orders.manmanmarket.store
MANMAN_INGEST_TOKEN=리모트와_같은_토큰
```

Vercel 환경변수에는 같은 토큰을 넣습니다.

```text
KAKAO_CSV_INGEST_TOKEN=리모트와_같은_토큰
```

`KAKAO_CSV_INGEST_TOKEN`이 없으면 `ADMIN_DASHBOARD_TOKEN`을 fallback으로 사용합니다. 둘 다 없으면 업로드 API는 401로 닫힙니다.

## 1. 기존 잘못된 연동 제거

이전에 붙인 코드가 있다면 `Code.gs`와 `Index.html`에서 아래 항목은 모두 제거하세요.

```text
extractKakaoMemberEvents_
syncOrderMatchesToManman_
makeKakaoCsvUploadId_
phase: 'csv_events'
phase: 'order_matches'
joinCount
leaveCount
rawRowNumber
csvUploadId를 writeFinalRows로 넘기는 코드
```

Apps Script에서는 입장/퇴장 이벤트를 추출하지 않고, 최종 주문행과 CSV를 매칭하지 않습니다. Raw 시트 행 번호도 영구 식별자로 보내지 않습니다.

## 2. Code.gs 수정

### 2-1. CONFIG에 업로드 경로 추가

`CONFIG` 안의 마지막 부분을 아래처럼 바꿉니다.

```js
  OPENAI_ENDPOINT: 'https://api.openai.com/v1/responses',
  DEFAULT_MODEL: 'gpt-4o',

  MANMAN_CSV_UPLOAD_PATH: '/api/kakao-csv-uploads'
```

### 2-2. Code.gs 맨 아래에 helper 추가

아래 코드를 `Code.gs` 맨 아래에 그대로 붙입니다.

```js
function uploadKakaoCsvOriginal(payload) {
  try {
    if (!payload) return { ok: false, error: '업로드 데이터가 비어 있습니다.' };

    const dateStr = String(payload.dateStr || '').trim();
    const startTime = String(payload.startTime || CONFIG.DEFAULT_START_TIME || '').trim();
    const endDateStr = String(payload.endDateStr || '').trim();
    const endTime = String(payload.endTime || '').trim();

    const startAt = dateStr && startTime
      ? formatManmanDateTime_(makeDateTime_(dateStr, startTime))
      : '';
    const endAt = endDateStr && endTime
      ? formatManmanDateTime_(makeDateTime_(endDateStr, endTime))
      : '';

    return postManmanKakaoCsvUpload_({
      fileContent: String(payload.fileContent || ''),
      fileName: String(payload.fileName || '').trim(),
      fileSize: payload.fileSize || '',
      mimeType: String(payload.mimeType || '').trim(),
      storeName: String(payload.storeName || '잠원메이플자이점').trim(),
      orderDate: dateStr,
      startAt,
      endAt,
      uploadedAt: formatManmanDateTime_(new Date()),
      source: 'google_apps_script'
    });
  } catch (err) {
    console.warn('카톡 CSV 원본 업로드 준비 실패: ' + err.message);
    return { ok: false, error: err.message };
  }
}

function postManmanKakaoCsvUpload_(body) {
  const baseUrl = getManmanApiBaseUrl_();
  const token = getManmanIngestToken_();

  if (!baseUrl || !token) {
    return { ok: false, skipped: true, error: 'MANMAN_API_BASE_URL 또는 MANMAN_INGEST_TOKEN 없음' };
  }

  if (!body.fileContent) {
    return { ok: false, error: 'fileContent 없음' };
  }

  try {
    const response = UrlFetchApp.fetch(baseUrl + CONFIG.MANMAN_CSV_UPLOAD_PATH, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-kakao-csv-token': token
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });

    const status = response.getResponseCode();
    const text = response.getContentText() || '{}';
    let data = {};
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = { raw: text.slice(0, 500) };
    }

    if (status < 200 || status >= 300 || data.ok === false) {
      console.warn('카톡 CSV 원본 업로드 실패: ' + status + ' / ' + text.slice(0, 500));
      return { ok: false, status, error: data.error || text.slice(0, 300) };
    }

    return {
      ok: true,
      uploadId: data.uploadId || '',
      fileHash: data.fileHash || '',
      messageCount: data.messageCount || 0,
      matchedOrderCount: data.matchedOrderCount || 0,
      data
    };
  } catch (err) {
    console.warn('카톡 CSV 원본 업로드 예외: ' + err.message);
    return { ok: false, error: err.message };
  }
}

function getManmanApiBaseUrl_() {
  return String(PropertiesService.getScriptProperties().getProperty('MANMAN_API_BASE_URL') || '').trim().replace(/\/+$/, '');
}

function getManmanIngestToken_() {
  return String(PropertiesService.getScriptProperties().getProperty('MANMAN_INGEST_TOKEN') || '').trim();
}

function formatManmanDateTime_(date) {
  if (!date || Number.isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
}
```

이 helper는 CSV 내용을 분석하지 않습니다. 파일 원문과 메타데이터만 `/api/kakao-csv-uploads`로 보냅니다.

## 3. Index.html 수정

### 3-1. 전역 변수 추가

스크립트 상단 변수 모음 근처에 아래 변수를 추가합니다.

```js
  let lastKakaoCsvUpload = null;
  let lastKakaoCsvUploadKey = '';
  let lastKakaoCsvUploadPromise = null;
```

### 3-2. CSV 파일 선택 즉시 원본 업로드 실행

`window.addEventListener('load', () => { ... })` 안에서 `csvFile` input에 `change` 이벤트를 추가합니다.
이미 `dateEl`, `holidayStartEl`, `holidayEndEl`을 잡는 두 번째 `window.addEventListener('load', ...)` 블록이 있으니 그 안에 넣는 것을 추천합니다.

```js
    const csvFileEl = document.getElementById('csvFile');

    csvFileEl.addEventListener('change', () => {
      lastKakaoCsvUpload = null;
      lastKakaoCsvUploadKey = '';
      lastKakaoCsvUploadPromise = null;
      uploadSelectedKakaoCsvOriginal();
    });

    ['dateInput', 'timeInput', 'endDateInput', 'endTimeInput', 'encodingInput'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        if (!csvFileEl.files[0]) return;
        lastKakaoCsvUpload = null;
        lastKakaoCsvUploadKey = '';
        lastKakaoCsvUploadPromise = null;
        uploadSelectedKakaoCsvOriginal();
      });
    });
```

그리고 `readFileAsText` 함수 근처에 아래 함수를 추가합니다.

```js
  function getKakaoCsvUploadKey(file, encoding, dateStr, startTime, endDateStr, endTime) {
    return [
      file?.name || '',
      file?.size || '',
      file?.lastModified || '',
      encoding || '',
      dateStr || '',
      startTime || '',
      endDateStr || '',
      endTime || ''
    ].join('|');
  }

  async function uploadSelectedKakaoCsvOriginal() {
    const file = document.getElementById('csvFile').files[0];
    if (!file) return null;

    const dateStr = document.getElementById('dateInput').value;
    const startTime = document.getElementById('timeInput').value || '08:00';
    const endDateStr = document.getElementById('endDateInput')?.value || '';
    const endTime = document.getElementById('endTimeInput')?.value || '';
    const encoding = document.getElementById('encodingInput').value;

    if (!dateStr) {
      log('카톡 CSV 원본 업로드 대기: 공구날짜를 먼저 선택해주세요.');
      return null;
    }

    const uploadKey = getKakaoCsvUploadKey(file, encoding, dateStr, startTime, endDateStr, endTime);

    if (lastKakaoCsvUpload && lastKakaoCsvUploadKey === uploadKey) {
      return lastKakaoCsvUpload;
    }

    if (lastKakaoCsvUploadPromise && lastKakaoCsvUploadKey === uploadKey) {
      return lastKakaoCsvUploadPromise;
    }

    lastKakaoCsvUploadKey = uploadKey;
    lastKakaoCsvUpload = null;

    lastKakaoCsvUploadPromise = (async () => {
      try {
        log(`카톡 CSV 원본 업로드 시작: ${file.name}`);
        const csvText = await readFileAsText(file, encoding);
        const uploadRes = await gasRun('uploadKakaoCsvOriginal', {
          fileContent: csvText,
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type || '',
          storeName: '잠원메이플자이점',
          dateStr,
          startTime,
          endDateStr,
          endTime
        });

        if (uploadRes && uploadRes.ok) {
          lastKakaoCsvUpload = uploadRes;
          log(`카톡 CSV 원본 업로드 완료: ${uploadRes.uploadId}`);
        } else {
          log(`카톡 CSV 원본 업로드 실패 또는 건너뜀: ${(uploadRes && uploadRes.error) || '알 수 없음'}`);
        }

        return uploadRes;
      } catch (uploadErr) {
        log(`카톡 CSV 원본 업로드 실패, 주문수집은 계속 진행: ${uploadErr.message}`);
        return { ok: false, error: uploadErr.message };
      } finally {
        lastKakaoCsvUploadPromise = null;
      }
    })();

    return lastKakaoCsvUploadPromise;
  }
```

중요: 이 함수는 CSV 파일을 선택하는 즉시 실행됩니다. 최종 주문입력 버튼과 연결하지 마세요.

### 3-3. runProcess()에서는 업로드를 다시 하지 않음

`runProcess()` 안의 파일 읽기 부분은 기존처럼 유지합니다.

```js
      const csvText = await readFileAsText(file, encoding);
      log(`파일 읽기 완료: ${file.name}`);
      log(`AI 처리 묶음 수: ${chunkSize}개`);
      log('1단계: CSV와 상품리스트를 준비합니다.');
```

다만 사용자가 파일을 선택하자마자 바로 분석 시작 버튼을 눌러 업로드가 아직 진행 중일 수 있으니, `const csvText = await readFileAsText(file, encoding);` 바로 다음 줄에 아래 정도만 추가해도 됩니다.

```js
      if (lastKakaoCsvUploadPromise) {
        log('카톡 CSV 원본 업로드 진행 중 · 주문수집은 계속 진행합니다.');
      } else if (!lastKakaoCsvUpload) {
        uploadSelectedKakaoCsvOriginal();
      }
```

이 코드는 업로드를 기다리지 않습니다. 원본 업로드 실패나 지연이 기존 주문수집 흐름을 막으면 안 되기 때문입니다.

### 3-4. 결과 객체에 업로드 ID만 보관

`const result = { ... }` 안에 아래 정도만 선택적으로 추가합니다.

```js
        kakaoCsvUploadId: lastKakaoCsvUpload?.uploadId || '',
```

이 값은 화면 상태 보관용입니다. `writeFinalRows`로 넘기지 마세요.

## 4. Vercel 서버 처리

Vercel 주문조회 프로젝트는 아래 단일 API를 사용합니다.

```text
POST /api/kakao-csv-uploads
```

Apps Script가 보내는 값:

```text
fileContent
fileName
fileSize
mimeType
storeName
orderDate
startAt
endAt
uploadedAt
source = google_apps_script
```

응답:

```json
{
  "ok": true,
  "uploadId": "서버가 생성한 업로드 ID"
}
```

서버는 원본 파일 해시, 점포, 공구날짜, 수집기간을 기준으로 업로드 ID를 생성합니다. 같은 파일을 다시 올리면 같은 업로드 ID를 사용해 기존 분석 결과를 교체합니다.

분석 결과는 Google Sheet 보조 탭이 아니라 Supabase에 저장합니다.

```text
kakao_csv_uploads
kakao_csv_messages
kakao_member_events
order_message_matches
```

주문시간 매칭은 기존 주문 캐시 테이블인 `order_cache`를 읽어 계산하고, 결과는 `order_message_matches`에 저장합니다. `source_row_number`는 디버깅 참고값일 뿐 영구 식별자로 쓰지 않습니다.

## 5. 적용 후 확인

1. Apps Script 저장 후 웹앱을 새 배포합니다.
2. CSV/TXT를 업로드합니다.
3. 로그에 `카톡 CSV 원본 업로드 완료: ...`가 뜨는지 확인합니다.
4. Supabase Table Editor에서 아래 테이블에 데이터가 들어왔는지 확인합니다.
   - `kakao_csv_uploads`
   - `kakao_csv_messages`
   - `kakao_member_events`
   - `order_message_matches`
5. 관리자 대시보드에서 입장/퇴장, 주문시간 매칭, 미매칭 CSV/Raw, 시간대별 실제 주문수를 확인합니다.
