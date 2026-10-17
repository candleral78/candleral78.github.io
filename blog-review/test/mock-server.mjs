// 가짜 서버: Code.gs를 그대로 실행합니다. 시트는 가짜, Gemini는 가짜, 네이버는 실제 인터넷(curl, 한 번 읽은 주소는 기억).
// 실행: node blog-review/test/mock-server.mjs   (http://localhost:8788)
import fs from 'fs'; import vm from 'vm'; import http from 'http'; import crypto from 'crypto'; import { execFileSync } from 'child_process';

export function makeServer(opts = {}) {
  const props = Object.assign({ ADMIN_PW: 'admin1234', GEMINI_API_KEY: 'k' }, opts.props || {});
  const sheets = {};
  class Sheet {
    constructor() { this.rows = []; this.maxCols = 26; }
    getLastRow() { return this.rows.length; }
    getLastColumn() { return this.rows.reduce((a, r) => Math.max(a, r.length), 0); }
    getMaxColumns() { return this.maxCols; }
    insertColumnsAfter(a, n) { this.maxCols += n; }
    deleteRow(r) { this.rows.splice(r - 1, 1); }
    getRange(r, c, nr, nc) {
      const sh = this;
      return {
        setNumberFormat() { return this; },
        getValues() { const o = []; for (let i = 0; i < nr; i++) { const row = sh.rows[r - 1 + i] || []; const x = []; for (let j = 0; j < nc; j++) x.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]); o.push(x); } return o; },
        setValues(v) { for (let i = 0; i < nr; i++) { sh.rows[r - 1 + i] = sh.rows[r - 1 + i] || []; for (let j = 0; j < nc; j++) { const val = v[i][j]; if (String(val).length > 50000) throw new Error('cell over 50000'); sh.rows[r - 1 + i][c - 1 + j] = val; } } return this; }
      };
    }
  }
  const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = new Sheet()) };
  const cache = new Map(); const calls = [];
  function curl(url, headers) {
    const key = url + JSON.stringify(headers || {});
    if (cache.has(key)) return cache.get(key);
    const args = ['-sSL', '-m', '25', '-w', '\n__HTTP__%{http_code}'];
    for (const [k, v] of Object.entries(headers || {})) args.push('-H', `${k}: ${v}`);
    args.push(url);
    let raw; try { raw = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch (e) { raw = '\n__HTTP__0'; }
    const i = raw.lastIndexOf('\n__HTTP__'); const res = { body: raw.slice(0, i), code: +raw.slice(i + 9) };
    cache.set(key, res); return res;
  }
  function fakeGemini(prompt, nImages) {
    calls.push('gemini:' + (prompt.includes('첨삭 의견') ? 'review' : prompt.includes('플레이스(지도) 화면') ? 'place' : prompt.includes('캡처한 것') ? 'capture' : 'other') + ':' + nImages);
    if (opts.quota) return { code: 429, text: '{}' };
    const J = o => JSON.stringify(o);
    if (prompt.includes('플레이스(지도) 화면')) return { code: 200, text: J({ name: '반포필즈수학', category: '수학교육', address: '서울 서초구 신반포로 165 반포쇼핑타운 2동 3층', phone: '02-595-2252', hours: '', closed: '', parking: '', booking: '', menuPrice: '' }) };
    if (prompt.includes('캡처한 것')) return { code: 200, text: J({ partial: false, blocks: [
      { type: 'title', text: '반포 수학학원 상담 후기', img: 0, box: [20, 40, 90, 960] },
      { type: 'text', text: '안녕하세요. 이번에 아이 수학 상담을 받고 왔습니다. 최고의 선생님이라 하세요.', img: 0, box: [110, 40, 300, 960] },
      { type: 'image', alt: '교실 사진', img: 0, box: [320, 40, 700, 960] },
      { type: 'map', name: '반포쇼핑타운2동', img: 0, box: [720, 40, 900, 960] }] }) };
    if (prompt.includes('첨삭 의견')) {
      const lines = prompt.split('\n').filter(l => /^#\d+ \(text\) /.test(l));
      const pick = lines[Math.min(1, lines.length - 1)] || '#0 (text) 없음';
      const bi = +pick.match(/^#(\d+)/)[1]; const txt = pick.replace(/^#\d+ \(text\) /, '');
      return { code: 200, text: J({
        good: [{ block: bi, text: '첫 부분에서 학부모님이 자주 묻는 질문으로 시작해 글의 목적이 바로 보입니다.' }],
        findings: [
          { block: bi, quote: txt.slice(0, 12), area: '품질', level: '권장', title: '첫 문단 결론', fact: '첫 문단이 인사로 시작합니다.', reason: '검색한 분은 첫 화면에서 답을 찾습니다.', request: '첫 문장에 결론을 먼저 쓰세요.', suggestion: txt.slice(0, 30) + ' [확인 필요: 결론 문장]' },
          { block: 1, quote: '원문에 없는 문장입니다', area: '품질', level: '수정 필요', title: '가짜 지적', fact: 'x', reason: 'y', request: 'z', suggestion: '' }
        ] }) };
    }
    return { code: 200, text: '{}' };
  }
  const ctx = {
    console, JSON, Math, Date, String, Number, Error, RegExp, encodeURIComponent,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null) }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ setMimeType() { return this; }, text: t }) },
    SpreadsheetApp: { openById: () => ss, getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() { }, releaseLock() { } }) },
    Utilities: {
      formatDate: (d, tz, f) => { const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d); return p.replace('T', ' '); },
      base64Encode: b => Buffer.from(b).toString('base64'),
      computeHmacSha256Signature: (v, k) => [...crypto.createHmac('sha256', k).update(v).digest()]
    },
    UrlFetchApp: {
      fetch: (url, o) => {
        if (url.includes('generativelanguage.googleapis.com')) {
          const body = JSON.parse(o.payload); const parts = body.contents[0].parts; const prompt = parts[parts.length - 1].text;
          const r = fakeGemini(prompt, parts.length - 1);
          return { getResponseCode: () => r.code, getContentText: () => r.code === 200 ? JSON.stringify({ candidates: [{ content: { parts: [{ text: r.text }] }, finishReason: 'STOP' }] }) : r.text, getAllHeaders: () => ({}) };
        }
        const r = curl(url, o && o.headers);
        return { getResponseCode: () => r.code, getContentText: () => r.body, getAllHeaders: () => ({}) };
      }
    },
    Logger: { log: () => { } }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../src/Code.gs', import.meta.url), 'utf8'), ctx);
  ctx.__sheets = sheets; ctx.__calls = calls;
  return ctx;
}

if (process.argv[1] && process.argv[1].endsWith('mock-server.mjs')) {
  const ctx = makeServer();
  const port = +(process.env.PORT || 8788);
  http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.url === '/__calls') { res.end(JSON.stringify({ calls: ctx.__calls, tabs: Object.fromEntries(Object.entries(ctx.__sheets).map(([k, v]) => [k, v.rows.length - 1])) })); return; }
      if (req.url === '/' || req.url.startsWith('/?')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fs.readFileSync(new URL('./app-test.html', import.meta.url))); return; }
      const out = req.method === 'POST' ? ctx.doPost({ postData: { contents: b } }) : ctx.doGet();
      res.setHeader('Content-Type', 'application/json'); res.end(out.text);
    });
  }).listen(port, () => console.log('mock up ' + port));
}
