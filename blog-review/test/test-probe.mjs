// 0단계 시험: Code.gs를 그대로 실행하되, UrlFetchApp은 실제 인터넷(curl)으로, 시트는 가짜로 돌립니다.
// 실행: node blog-review/test/test-probe.mjs
// 키가 없으면 API 2종은 "건너뜀"으로 나옵니다(정상).
import fs from 'fs'; import vm from 'vm'; import crypto from 'crypto'; import { execFileSync } from 'child_process';

// SHEET_ID 없이(시트에 붙은 스크립트처럼) 실행해 봅니다.
const props = { ADMIN_PW: 'admin1234' };
const sheets = {};
const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = new Sheet()) };
class Sheet {
  constructor() { this.rows = []; }
  getLastRow() { return this.rows.length; }
  getRange(r, c, nr, nc) { const sh = this; return { setValues(v) { for (let i = 0; i < nr; i++) sh.rows[r - 1 + i] = v[i].slice(0, nc); return this; } }; }
}
function fetchSync(url, o) {
  const args = ['-sSL', '-m', '25', '-w', '\n__HTTP__%{http_code}'];
  for (const [k, v] of Object.entries((o && o.headers) || {})) args.push('-H', `${k}: ${v}`);
  args.push(url);
  let raw;
  try { raw = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { raw = '\n__HTTP__0'; }
  const i = raw.lastIndexOf('\n__HTTP__');
  const body = raw.slice(0, i), code = +raw.slice(i + 9);
  return { getResponseCode: () => code, getContentText: () => body };
}
const ctx = {
  console, JSON, Math, Date, String, Number, Error, RegExp, encodeURIComponent,
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null) }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ setMimeType() { return this; }, text: t }) },
  SpreadsheetApp: { openById: () => ss, getActiveSpreadsheet: () => ss },
  Utilities: {
    formatDate: d => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(d),
    base64Encode: b => Buffer.from(b).toString('base64'),
    computeHmacSha256Signature: (v, k) => [...crypto.createHmac('sha256', k).update(v).digest()]
  },
  UrlFetchApp: { fetch: fetchSync },
  Logger: { log: console.log }
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../src/Code.gs', import.meta.url), 'utf8'), ctx);

let fails = 0;
function check(name, cond) { console.log((cond ? '  통과 ' : '  실패 ') + name); if (!cond) fails++; }

console.log('== setup');
console.log(ctx.setup());
console.log('== runProbe');
const res = ctx.runProbe_(ctx.PROBE_TARGET, true);
res.summary.forEach(s => console.log(s));

console.log('== 확인');
const rows = sheets.probe.rows;
check('probe 탭 머리글', rows[0][1] === '시험');
check('기록 줄 수 = 요약 줄 수', rows.length - 1 === res.summary.length);
const byName = n => res.rows.find(r => r[1] === n);
const place = byName('플레이스');
check('플레이스 업체명 읽힘', place && place[2] === '성공' && JSON.parse(place[5]).name === '반포필즈수학');
const rss = byName('블로그 RSS');
check('RSS 글 목록 읽힘', rss && rss[2] === '성공');
const post = byName('블로그 글 224444068379');
const pd = post && JSON.parse(post[5]);
check('글 본문과 사진 수 읽힘', pd && pd.components && pd.components.image > 0 && pd.charsNoSpace > 500);
check('지도 장소가 업체 플레이스와 다름을 잡아냄', pd && pd.mapMatchesPlace === false && pd.places[0].placeId === '18760310');
const api = byName('블로그 검색 API: 반포 수학학원');
check('키 없는 API는 건너뜀', api && api[2] === '건너뜀');
check('doPost 암호 없으면 거절', JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ action: 'probe' }) } }).text).code === 'not_admin');

console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
process.exit(fails ? 1 : 0);
