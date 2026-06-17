#!/usr/bin/env node

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { getSheetsClient, getSpreadsheetId } from '../lib/googleSheetsClient.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const SHEET_NAME = '할인상품';
const INDEX_SHEET_NAME = '발주요청(Index)';
const START_ROW = 200;
const TIMEZONE = 'Asia/Seoul';
const DEFAULT_START_DATE = dayjs().tz(TIMEZONE).format('YYYY-MM-DD');
const DEFAULT_END_DATE = DEFAULT_START_DATE;
const START_DATE = process.env.TIMESALE_START_DATE || DEFAULT_START_DATE;
const END_DATE = process.env.TIMESALE_END_DATE || DEFAULT_END_DATE;

const PRODUCTS = [
  {
    title: '한입가득 치즈스틱 30개입 / 26년 11월',
    storage: '냉동',
    stock: 55,
    category: '냉동식품',
    description: '쭉 늘어나는 치즈, 간편 튀김간식',
    discountRate: 45
  },
  {
    title: '쪄옴 구워먹는 쑥떡 800g',
    storage: '냉동',
    stock: 8,
    category: '냉동식품',
    description: '구워먹는 쑥떡, 든든한 간식',
    discountRate: 38
  },
  {
    title: '윤형빈의 직화황금 단백질 주먹밥 110g 3종 (불닭갈비/갈릭닭불고기/차돌김치치즈)',
    storage: '냉동',
    stock: 1,
    category: '냉동식품',
    description: '단백질 주먹밥, 3가지 맛',
    discountRate: 52
  },
  {
    title: '애슐리 버터갈릭 회오리감자 270g (5개입 + 시즈닝 1개)',
    storage: '냉동',
    stock: 85,
    category: '냉동식품',
    description: '버터갈릭 감자, 시즈닝 포함',
    discountRate: 47
  },
  {
    title: '보양옥 올갱이해장국 600g',
    storage: '냉동',
    stock: 2,
    category: '냉동식품',
    description: '올갱이 해장국, 구수한 국물',
    discountRate: 41
  },
  {
    title: '호텔컬렉션 에센셜 우차돌짬뽕탕 450g',
    storage: '냉동',
    stock: 10,
    category: '냉동식품',
    description: '우차돌 짬뽕탕, 얼큰한 국물',
    discountRate: 49
  },
  {
    title: '호텔컬렉션 에센셜 우차돌마라탕 450g',
    storage: '냉동',
    stock: 10,
    category: '냉동식품',
    description: '우차돌 마라탕, 진한 향신료',
    discountRate: 55
  },
  {
    title: '조선미락 직화 마늘 무뼈닭발 200g (100%국산닭발)',
    storage: '냉동',
    stock: 4,
    category: '냉동식품',
    description: '직화 마늘 닭발, 야식 특가',
    discountRate: 43
  },
  {
    title: '문형기명인 구워먹는 치즈떡 1kg',
    storage: '냉동',
    stock: 80,
    category: '냉동식품',
    description: '구워먹는 치즈떡, 넉넉한 1kg',
    discountRate: 37
  },
  {
    title: '[임박특가] [김호윤키친]고기듬뿍 가지라자냐 400g (소비기한: 26년 7월 17일)',
    storage: '냉동',
    stock: 30,
    category: '냉동식품',
    description: '고기듬뿍 라자냐, 임박 특가',
    discountRate: 58
  },
  {
    title: '낭만시리즈 숯불양념치킨 순한맛 350g',
    storage: '냉동',
    stock: 45,
    category: '냉동식품',
    description: '숯불양념치킨, 순한맛',
    discountRate: 46
  },
  {
    title: '하루야채 뽀로로 유기농 포도비트 140ml x 6개입',
    storage: '상온',
    stock: 28,
    category: '음료/간식',
    description: '유기농 키즈음료, 포도비트',
    discountRate: 35
  },
  {
    title: '하루야채 뽀로로 유기농 사과당근 140ml x 6개입',
    storage: '상온',
    stock: 28,
    category: '음료/간식',
    description: '유기농 키즈음료, 사과당근',
    discountRate: 36
  },
  {
    title: '튼튼 니트릴 고무장갑 S',
    storage: '상온',
    stock: 20,
    category: '생활용품',
    description: '니트릴 고무장갑, S 사이즈',
    discountRate: 40
  },
  {
    title: '튼튼 니트릴 고무장갑 M',
    storage: '상온',
    stock: 35,
    category: '생활용품',
    description: '니트릴 고무장갑, M 사이즈',
    discountRate: 42
  },
  {
    title: '쿵딘소고기쌀국수 70g 4개입',
    storage: '상온',
    stock: 110,
    category: '상온식품',
    description: '간편 쌀국수, 소고기맛',
    discountRate: 53
  },
  {
    title: '쿵딘돼지고기쌀국수 70g 4개입',
    storage: '상온',
    stock: 110,
    category: '상온식품',
    description: '간편 쌀국수, 돼지고기맛',
    discountRate: 51
  },
  {
    title: '오아 큐브 멀티탭 PD35 고용량 4000W 콘센트 USB C타입 멀티 3구 어댑터',
    storage: '상온',
    stock: 13,
    category: '생활가전',
    description: 'PD35 충전, 3구 멀티탭',
    discountRate: 48,
    manualGroupPrice: 32900,
    manualImageUrl: 'https://oa-mall.co.kr/web/product/big/202507/c241ad4925da5ca10977dba1b08ea14e.jpg'
  },
  {
    title: '실리콘 조리도구 7종세트 (거치대 포함)',
    storage: '상온',
    stock: 8,
    category: '주방용품',
    description: '실리콘 조리도구, 거치대 포함',
    discountRate: 44
  },
  {
    title: '슈퍼 초임계 알티지 오메가3 플러스 (30캡슐 1박스)',
    storage: '상온',
    stock: 42,
    category: '건강식품',
    description: '초임계 rTG 오메가3, 30캡슐',
    discountRate: 39
  },
  {
    title: '베베쿡 더 맛있는 빼빼롱펑 블루베리 40g',
    storage: '상온',
    stock: 35,
    category: '음료/간식',
    description: '아이 간식, 블루베리맛',
    discountRate: 35
  },
  {
    title: '베베쿡 더 맛있는 빼빼롱펑 구운옥수수 40g',
    storage: '상온',
    stock: 23,
    category: '음료/간식',
    description: '아이 간식, 구운옥수수맛',
    discountRate: 36
  },
  {
    title: '문라이트 UV쉴드 자외선 차단 골프패치 5회분',
    storage: '상온',
    stock: 8,
    category: '뷰티케어',
    description: '자외선 차단, 골프패치 5회분',
    discountRate: 57
  },
  {
    title: '락앤락 이지그립IH프라이팬 2종 (24cm+28cm)',
    storage: '상온',
    stock: 4,
    category: '주방용품',
    description: 'IH 프라이팬, 24cm+28cm',
    discountRate: 50
  },
  {
    title: '락앤락 스마트킵프레쉬 직사각 3P (330ml 2개, 760ml 1개)',
    storage: '상온',
    stock: 5,
    category: '주방용품',
    description: '보관용기 3P, 직사각 구성',
    discountRate: 43
  },
  {
    title: '락앤락 바로한끼 글라스 밥용기 4P (355ml x 2EA, 450ml x 2EA) 색상 랜덤',
    storage: '상온',
    stock: 5,
    category: '주방용품',
    description: '글라스 밥용기, 4P 구성',
    discountRate: 45
  },
  {
    title: '디어쿠페아 헤어컬러샴푸 딥브라운 15mlx3입',
    storage: '상온',
    stock: 3,
    category: '뷰티케어',
    description: '헤어컬러샴푸, 딥브라운',
    discountRate: 60
  },
  {
    title: '디어쿠페아 헤어컬러샴푸 다크브라운 15mlx3입',
    storage: '상온',
    stock: 19,
    category: '뷰티케어',
    description: '헤어컬러샴푸, 다크브라운',
    discountRate: 59
  },
  {
    title: '디어쿠페아 헤어컬러샴푸 네츄럴브라운 15mlx3입',
    storage: '상온',
    stock: 14,
    category: '뷰티케어',
    description: '헤어컬러샴푸, 네츄럴브라운',
    discountRate: 58
  },
  {
    title: '디어쿠페아 풋브러쉬',
    storage: '상온',
    stock: 16,
    category: '생활용품',
    description: '발 관리용 풋브러쉬',
    discountRate: 37
  },
  {
    title: '디어쿠페아 각질제거기 블랙 1개',
    storage: '상온',
    stock: 14,
    category: '생활용품',
    description: '각질제거기, 블랙 1개',
    discountRate: 41
  },
  {
    title: '국내생산 아워랩스 옷걸이형 제습제 150g x 5입',
    storage: '상온',
    stock: 24,
    category: '생활용품',
    description: '옷걸이형 제습제, 5입',
    discountRate: 46
  },
  {
    title: '국내산 정가네 찰보리 누룽지 500g',
    storage: '상온',
    stock: 30,
    category: '상온식품',
    description: '찰보리 누룽지, 국내산',
    discountRate: 35
  },
  {
    title: '77년전통 사자표 거장 짜장소스 200g (2인분)',
    storage: '상온',
    stock: 20,
    category: '상온식품',
    description: '짜장소스, 2인분 간편식',
    discountRate: 38
  },
  {
    title: '프라텔리 롱고바디 토마토홀 400g',
    storage: '상온',
    stock: 1,
    category: '상온식품',
    description: '토마토홀, 파스타·스튜용',
    discountRate: 52
  },
  {
    title: '티나는 스물넷 14포',
    storage: '상온',
    stock: 10,
    category: '건강식품',
    description: '하루 한 포, 간편 건강 루틴',
    discountRate: 40
  },
  {
    title: '켈로그 콘푸로스트 1.5kg',
    storage: '상온',
    stock: 3,
    category: '음료/간식',
    description: '대용량 시리얼, 1.5kg',
    discountRate: 42
  },
  {
    title: '참 스지 도가니탕 500g',
    storage: '상온',
    stock: 44,
    category: '상온식품',
    description: '스지 도가니탕, 든든한 한끼',
    discountRate: 49
  },
  {
    title: '오아 반디팬 초경량 무선핸디팬',
    storage: '상온',
    stock: 30,
    category: '생활가전',
    description: '초경량 무선 핸디팬',
    discountRate: 44
  },
  {
    title: '아스터 곰팡이 제거 젤 200g x 3개 묶음',
    storage: '상온',
    stock: 160,
    category: '생활용품',
    description: '곰팡이 제거 젤, 3개 묶음',
    discountRate: 62
  },
  {
    title: '스와니브 24K 골드 스네일 5종세트',
    storage: '상온',
    stock: 4,
    category: '뷰티케어',
    description: '스네일 케어, 5종 세트',
    discountRate: 56
  },
  {
    title: '살림백서 뽀드득 프레쉬 풋샴푸 400ml',
    storage: '상온',
    stock: 18,
    category: '생활용품',
    description: '프레쉬 풋샴푸, 400ml',
    discountRate: 45
  },
  {
    title: '브리츠 블루투스 스피커',
    storage: '상온',
    stock: 16,
    category: '생활가전',
    description: '블루투스 스피커, 실내외 활용',
    discountRate: 47
  },
  {
    title: '메드비 알로에베라 미스트 150ml',
    storage: '상온',
    stock: 30,
    category: '뷰티케어',
    description: '알로에베라 미스트, 150ml',
    discountRate: 39
  },
  {
    title: '도브 포밍 핸드워시 240ml 딥모이스처',
    storage: '상온',
    stock: 144,
    category: '생활용품',
    description: '포밍 핸드워시, 딥모이스처',
    discountRate: 35
  },
  {
    title: '닥터비알 리포좀 비타민C',
    storage: '상온',
    stock: 4,
    category: '건강식품',
    description: '리포좀 비타민C, 데일리 케어',
    discountRate: 54
  },
  {
    title: '국내제조 고보습 저자극 핸드워시 510ml',
    storage: '상온',
    stock: 10,
    category: '생활용품',
    description: '고보습 저자극 핸드워시',
    discountRate: 37
  },
  {
    title: '고려은단 트리플비타민C 1000 드링크 (100ml x 10병)',
    storage: '상온',
    stock: 110,
    category: '건강식품',
    description: '비타민C 드링크, 10병 구성',
    discountRate: 46
  },
  {
    title: 'HLB제약 파로효소 알파 (1g x 14포)',
    storage: '상온',
    stock: 3,
    category: '건강식품',
    description: '파로효소 알파, 14포',
    discountRate: 61
  },
  {
    title: 'HLB제약 지속성비타민C 1000 (1,000mg x 20캡슐)',
    storage: '상온',
    stock: 3,
    category: '건강식품',
    description: '지속성 비타민C, 20캡슐',
    discountRate: 52
  },
  {
    title: 'HLB제약 심플 슬립 아쉬아간다 (132mg x 30정)',
    storage: '상온',
    stock: 3,
    category: '건강식품',
    description: '슬립 케어, 30정',
    discountRate: 58
  }
];

function parsePrice(value) {
  const number = Number(String(value || '').replace(/[,\s원]/g, ''));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function roundToTen(value) {
  return Math.round(value / 10) * 10;
}

function roundUpToHundred(value) {
  return Math.ceil(value / 100) * 100;
}

function buildFormula(rowNumber, targetColumn) {
  return `=ifna(xlookup(C${rowNumber},'${INDEX_SHEET_NAME}'!D:D,'${INDEX_SHEET_NAME}'!${targetColumn}:${targetColumn}),"")`;
}

function buildOnlineLowestPrice(salePrice, discountRate) {
  const comparePrice = salePrice / (1 - discountRate / 100);
  return roundUpToHundred(comparePrice);
}

async function main() {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const indexResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${INDEX_SHEET_NAME}'!D:H`,
    valueRenderOption: 'FORMATTED_VALUE'
  });
  const priceByTitle = new Map(
    (indexResponse.data.values || [])
      .filter(row => String(row?.[0] || '').trim())
      .map(row => [String(row[0]).trim(), parsePrice(row[3])])
  );

  const rows = PRODUCTS.map((product, index) => {
    const sheetRow = START_ROW + index;
    const groupPrice = product.manualGroupPrice || priceByTitle.get(product.title);

    if (!groupPrice) {
      throw new Error(`기존 공구가를 찾지 못했습니다: ${product.title}`);
    }

    const salePrice = roundToTen(groupPrice * 0.9);
    const onlineLowestPrice = buildOnlineLowestPrice(salePrice, product.discountRate);

    return [
      START_DATE,
      END_DATE,
      product.title,
      product.manualImageUrl || buildFormula(sheetRow, 'H'),
      salePrice,
      product.manualGroupPrice || buildFormula(sheetRow, 'G'),
      onlineLowestPrice,
      product.description,
      '',
      '',
      product.storage,
      product.stock,
      product.category
    ];
  });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        {
          range: `'${SHEET_NAME}'!M1`,
          values: [['카테고리']]
        },
        {
          range: `'${SHEET_NAME}'!A${START_ROW}:M${START_ROW + rows.length - 1}`,
          values: rows
        }
      ]
    }
  });

  console.log(JSON.stringify({
    ok: true,
    sheetName: SHEET_NAME,
    startRow: START_ROW,
    endRow: START_ROW + rows.length - 1,
    productCount: rows.length,
    startDate: START_DATE,
    endDate: END_DATE,
    lowStockCount: PRODUCTS.filter(product => product.stock < 10).length,
    categories: [...new Set(PRODUCTS.map(product => product.category))]
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
