/**
 * 블로그 검수 도구 · 서버 (Google Apps Script) — 1단계
 *
 * 블로그 글쓰기 앱과 **다른** Apps Script 프로젝트("블로그 검수 도구 서버")와
 * **다른** 구글 시트("블로그 검수 저장소")에서 돌립니다. 글쓰기 앱 서버·시트는 건드리지 않습니다.
 *
 * 하는 일
 *   - 업체 정보·핵심 키워드·업체 기준 저장 (biz 탭)
 *   - 글 읽기: 발행 글 링크 / 원고 붙여넣기 / 화면 캡처
 *   - 기계 검사 (AI 없이 규칙으로 판정)
 *   - 당일 키워드 근거 (검색 화면, 블로그 검색 API, 검색광고 API) — 하루 한 번 조회해 keyword_log 탭에 저장
 *   - AI 첨삭 (Gemini) — 원문에서 인용을 찾을 수 없는 지적은 버림
 *   - 검수 결과 저장 (reviews 탭)
 *   - 0단계 수집 시험 runProbe()
 *
 * 스크립트 속성 [프로젝트 설정 > 스크립트 속성]
 *   ADMIN_PW              (필수) 화면에 들어갈 때 쓰는 암호
 *   GEMINI_API_KEY        (필수) AI 첨삭과 캡처 읽기
 *   GEMINI_MODELS         (선택) 쉼표로 구분한 모델 순서
 *   SHEET_ID              (선택) 시트에 붙은 스크립트면 비워 둡니다
 *   NAVER_CLIENT_ID / NAVER_CLIENT_SECRET          (선택) 블로그 검색 API
 *   SEARCHAD_API_KEY / SEARCHAD_SECRET / SEARCHAD_CUSTOMER_ID  (선택) 검색광고 키워드 도구
 * 키가 없는 근거는 "확인 불가"로 표시하고 나머지는 그대로 진행합니다.
 */
var TABS = ['biz', 'reviews', 'keyword_log', 'probe'];
var CHUNK = 45000;
var DEFAULT_MODELS = 'gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite';
var MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
var DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** 0단계 시험 대상. 업체를 바꿔 시험하려면 여기만 고칩니다. */
var PROBE_TARGET = {
  bizName: '반포필즈수학',
  placeId: '1895531946',
  blogId: 'svtcarat99',
  postNos: ['224444068379', '224438209933'],
  keywords: ['반포 수학학원', '잠원동 수학학원']
};

function prop_(k, d) { var v = PropertiesService.getScriptProperties().getProperty(k); return v === null || v === '' ? d : v; }
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function fail_(code, message) { var e = new Error(message || code); e.code = code; return e; }
function nowKst_() { return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss'); }
function todayKst_() { return nowKst_().slice(0, 10); }
function nsp_(s) { return String(s || '').replace(/\s+/g, ''); }
function digits_(s) { return String(s || '').replace(/\D/g, ''); }

function doGet() { return out_({ ok: true, service: 'blog-review', time: new Date().toISOString() }); }

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    return out_({ ok: true, data: route_(req) });
  } catch (err) {
    return out_({ ok: false, code: err.code || 'server_error', message: String(err.message || err) });
  }
}

function isAdmin_(req) { var pw = prop_('ADMIN_PW', ''); return !!pw && req.adminPw === pw; }
function needAdmin_(req) { if (!isAdmin_(req)) throw fail_('not_admin', '암호가 맞지 않습니다.'); }

/* ---------- 요청 나누기 (라엘 1인 사용: 모든 요청에 암호 필요) ---------- */
function route_(req) {
  if (req.action === 'ping') return { admin: isAdmin_(req), gemini: !!prop_('GEMINI_API_KEY', ''), searchApi: !!prop_('NAVER_CLIENT_ID', ''), searchAd: !!prop_('SEARCHAD_API_KEY', '') };
  needAdmin_(req);
  switch (req.action) {
    case 'listBiz': return listRows_('biz').map(function (b) { return { id: b.id, name: b.name, industry: b.industry, blogId: b.blogId, updatedAt: b.updatedAt }; });
    case 'getBiz': return getRow_('biz', req.id);
    case 'saveBiz': {
      var b = req.biz || {}; if (!b.name) throw fail_('bad_request', '업체명을 넣어 주세요.');
      var id = req.id || ('b' + new Date().getTime());
      b.placeId = placeIdFromUrl_(b.placeUrl) || b.placeId || '';
      b.blogId = blogIdFromUrl_(b.blogUrl) || b.blogId || '';
      b.updatedAt = nowKst_(); delete b.id; setRow_('biz', id, b); return id;
    }
    case 'delBiz': delRow_('biz', req.id); return true;
    case 'readPlaceCapture': return readPlaceCapture_(req.images || []);
    case 'review': return runReview_(req);
    case 'listReviews': return listRows_('reviews').filter(function (r) { return !req.bizId || r.bizId === req.bizId; })
      .map(function (r) { return { id: r.id, bizId: r.bizId, createdAt: r.createdAt, title: r.title, source: r.source, url: r.url, summary: r.summary }; })
      .sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
    case 'getReview': return getRow_('reviews', req.id);
    case 'saveReview': {
      var r = getRow_('reviews', req.id); if (!r) throw fail_('not_found', '검수 기록을 찾지 못했습니다.');
      var patch = req.patch || {}; for (var k in patch) r[k] = patch[k];
      delete r.id; setRow_('reviews', req.id, r); return true;
    }
    case 'delReview': delRow_('reviews', req.id); return true;
    case 'imageData': return imageData_(req.urls || []);
    case 'probe': return runProbe_(req.target || PROBE_TARGET, false);
    default: throw fail_('bad_request', '알 수 없는 요청입니다: ' + req.action);
  }
}

/* ---------- 내려받기 ---------- */
function get_(url, headers, noFollow) {
  var h = headers || {};
  if (!h['User-Agent']) h['User-Agent'] = MOBILE_UA;
  var r = UrlFetchApp.fetch(url, { method: 'get', headers: h, muteHttpExceptions: true, followRedirects: !noFollow });
  var hd = {}; try { hd = r.getAllHeaders ? r.getAllHeaders() : {}; } catch (e) { }
  return { code: r.getResponseCode(), text: r.getContentText('UTF-8'), headers: hd };
}

/** 첨삭지를 이미지로 저장할 때 쓸 블로그 사진을 data URL로 바꿉니다(네이버 사진 주소만). */
function imageData_(urls) {
  var out = {};
  urls.slice(0, 12).forEach(function (u) {
    if (!/^https:\/\/[a-z0-9.-]*pstatic\.net\//.test(u)) return;
    try {
      var r = UrlFetchApp.fetch(u.replace(/\?type=\w+$/, '') + '?type=w773', { muteHttpExceptions: true, headers: { Referer: 'https://m.blog.naver.com/' } });
      if (r.getResponseCode() === 200) { var b = r.getBlob(); out[u] = 'data:' + (b.getContentType() || 'image/jpeg') + ';base64,' + Utilities.base64Encode(b.getBytes()); }
    } catch (e) { }
  });
  return out;
}

/* ---------- 주소 해석 ---------- */
function placeIdFromUrl_(u) {
  u = String(u || ''); var m = /place\/(\d{5,})/.exec(u) || /[?&]id=(\d{5,})/.exec(u) || /^(\d{5,})$/.exec(u.trim());
  return m ? m[1] : '';
}
function blogIdFromUrl_(u) {
  u = String(u || '').trim(); var m = /blog\.naver\.com\/([A-Za-z0-9_\-]+)/.exec(u) || /blogId=([A-Za-z0-9_\-]+)/.exec(u);
  if (m && m[1] !== 'PostView.naver' && m[1] !== 'PostList.naver') return m[1];
  return /^[A-Za-z0-9_\-]{3,}$/.test(u) ? u : '';
}
/** 글 주소 → {blogId, logNo}. naver.me 단축 주소는 한 번 따라가 봅니다. */
function postIdFromUrl_(u) {
  u = String(u || '').trim();
  var m = /blog\.naver\.com\/([A-Za-z0-9_\-]+)\/(\d{6,})/.exec(u);
  if (m) return { blogId: m[1], logNo: m[2] };
  var b = /blogId=([A-Za-z0-9_\-]+)/.exec(u), l = /logNo=(\d{6,})/.exec(u);
  if (b && l) return { blogId: b[1], logNo: l[1] };
  if (/naver\.me\//.test(u)) {
    var r = get_(u, null, true), loc = r.headers && (r.headers.Location || r.headers.location);
    if (loc && loc !== u) return postIdFromUrl_(loc);
  }
  return null;
}

/* ---------- 화면 코드 해석 ---------- */
function unescapeHtml_(s) {
  return String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(+n); })
    .replace(/&#x([0-9a-f]+);/gi, function (m, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&(ndash|mdash|hellip|middot|lsquo|rsquo|ldquo|rdquo|bull|times);/g, function (m, n) { return NAMED_ENTITIES[n]; })
    .replace(/&amp;/g, '&');
}
var NAMED_ENTITIES = { ndash: '–', mdash: '—', hellip: '…', middot: '·', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', times: '×' };
function stripTags_(s) { return unescapeHtml_(String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/​/g, '').trim(); }
function cdata_(s) { return String(s || '').replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim(); }

/** RSS → 글 목록 [{no, title, link, date}] */
function parseRss_(xml) {
  var items = [], re = /<item>([\s\S]*?)<\/item>/g, m;
  while ((m = re.exec(xml))) {
    var it = m[1];
    var t = (/<title>([\s\S]*?)<\/title>/.exec(it) || [])[1];
    var l = cdata_((/<link>([\s\S]*?)<\/link>/.exec(it) || [])[1]).replace(/\?.*$/, '');
    var d = (/<pubDate>([\s\S]*?)<\/pubDate>/.exec(it) || [])[1] || '';
    var no = (/\/(\d{9,})$/.exec(l) || [])[1] || '';
    items.push({ no: no, title: unescapeHtml_(cdata_(t)), link: l, date: d.trim() });
  }
  return items;
}

/**
 * 모바일 블로그 글 화면 → 순서대로 된 블록 목록.
 * 블록: {type, text?, src?, placeId?, name?, address?, url?}
 * type: title, text, heading, quote, image, sticker, video, map, link, table, divider, other
 */
function parseBlocks_(html) {
  var blocks = [], parts = String(html).split('<div class="se-component se-');
  for (var i = 1; i < parts.length; i++) {
    var p = parts[i], kind = (/^([a-zA-Z]+)/.exec(p) || [])[1] || 'other', ci = i - 1, n0 = blocks.length;
    var paras = [], pr = /<p class="se-text-paragraph[^"]*"[^>]*>([\s\S]*?)<\/p>/g, m;
    while ((m = pr.exec(p))) { var t = stripTags_(m[1]); if (t) paras.push(t); }
    if (kind === 'documentTitle') {
      var tt = paras.join(' ') || stripTags_((/se-title-text[^>]*>([\s\S]*?)<\/div>/.exec(p) || [])[1]);
      blocks.push({ type: 'title', text: tt });
    } else if (kind === 'text') {
      paras.forEach(function (x, pi) { blocks.push({ type: 'text', text: x, pi: pi }); });
    } else if (kind === 'sectionTitle') {
      blocks.push({ type: 'heading', text: paras.join(' ') });
    } else if (kind === 'quotation') {
      blocks.push({ type: 'quote', text: paras.join(' ') });
    } else if (kind === 'image' || kind === 'imageStrip' || kind === 'imageGroup') {
      var ir = /data-lazy-src="([^"]+)"/g, im, any = false;
      while ((im = ir.exec(p))) { any = true; blocks.push({ type: 'image', src: im[1] }); }
      if (!any) { var s2 = /<img[^>]+src="([^"]+)"/.exec(p); blocks.push({ type: 'image', src: s2 ? s2[1] : '' }); }
      var cap = (/se-image-caption[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/.exec(p) || [])[1];
      if (cap && stripTags_(cap)) blocks[blocks.length - 1].caption = stripTags_(cap);
    } else if (kind === 'sticker') {
      blocks.push({ type: 'sticker' });
    } else if (kind === 'video' || kind === 'oembed') {
      blocks.push({ type: 'video' });
    } else if (kind === 'placesMap') {
      var dm = /data-module='(\{[\s\S]*?\})'/.exec(p), pl = [];
      if (dm) { try { var d = JSON.parse(unescapeHtml_(dm[1])); pl = (d.data && d.data.places) || []; } catch (e) { } }
      if (!pl.length) blocks.push({ type: 'map' });
      pl.forEach(function (x) { blocks.push({ type: 'map', placeId: String(x.placeId || ''), name: x.name || '', address: x.address || '' }); });
    } else if (kind === 'oglink') {
      var lk = (/<a href="([^"]+)"/.exec(p) || [])[1] || '';
      var lt = stripTags_((/se-oglink-title[^>]*>([\s\S]*?)<\/strong>/.exec(p) || [])[1]);
      blocks.push({ type: 'link', url: unescapeHtml_(lk), text: lt });
    } else if (kind === 'table') {
      var cells = [], cr = /<td[^>]*>([\s\S]*?)<\/td>/g, c;
      while ((c = cr.exec(p))) { var ct = stripTags_(c[1]); if (ct) cells.push(ct); }
      blocks.push({ type: 'table', text: cells.join(' | ') });
    } else if (kind === 'horizontalLine') {
      blocks.push({ type: 'divider' });
    } else if (kind === 'formula') {
      blocks.push({ type: 'other', text: '[수식]' });
    } else {
      blocks.push({ type: 'other', text: paras.join(' ') });
    }
    for (var k = n0; k < blocks.length; k++) blocks[k].ci = ci;
  }
  // 본문 속 링크(글자에 건 링크)
  var links = [], lr = /data-linkdata='(\{[^']*\})'/g, lm;
  while ((lm = lr.exec(html))) { try { var ld = JSON.parse(unescapeHtml_(lm[1])); if (ld.link || ld.url) links.push(ld.link || ld.url); } catch (e) { } }
  var hr = /<a[^>]+href="(https?:\/\/(?:naver\.me|m?\.?place\.naver\.com|map\.naver\.com|booking\.naver\.com|talk\.naver\.com)[^"]*)"/g, hm;
  while ((hm = hr.exec(html))) links.push(unescapeHtml_(hm[1]));
  return { blocks: blocks, links: links };
}

/** html의 i 위치에서 시작하는 <div>를 짝이 맞는 </div>까지 잘라 냅니다. */
function extractDiv_(html, i) {
  if (i < 0) return '';
  var re = /<(\/?)div\b/g, d = 0, m; re.lastIndex = i;
  while ((m = re.exec(html))) { d += m[1] ? -1 : 1; if (d === 0) { var e = html.indexOf('>', m.index) + 1; return html.slice(i, e); } }
  return html.slice(i);
}
/**
 * 글 화면을 네이버 모양 그대로 다시 그리기 위한 HTML(제목 + 본문)과 네이버 스타일 주소.
 * 스크립트·이벤트·외부 틀은 지우고, 늦게 불러오는 사진은 바로 보이게 바꿉니다.
 */
function buildView_(html) {
  var title = extractDiv_(html, html.indexOf('<div class="se-component se-documentTitle'));
  var main = extractDiv_(html, html.indexOf('<div class="se-main-container">'));
  if (!main) return null;
  var h = (title ? '<div class="se-documentTitle-wrap">' + title + '</div>' : '') + main;
  h = h.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '').replace(/href\s*=\s*"javascript:[^"]*"/gi, 'href="#"')
    .replace(/<img([^>]*?)\ssrc="[^"]*"([^>]*?)data-lazy-src="([^"]+)"/gi, '<img$1$2src="$3"')
    .replace(/<img([^>]*?)data-lazy-src="([^"]+)"([^>]*?)\ssrc="[^"]*"/gi, '<img$1src="$2"$3')
    .replace(/data-lazy-src="([^"]+)"/gi, 'src="$1"');
  // 제목 영역의 카테고리·날짜·버튼 줄은 뺍니다.
  h = h.replace(/<div class="blog_category"[\s\S]*?<\/div>/, '').replace(/<div class="blog_authorArea"[\s\S]*?<\/div>\s*<\/div>/, '');
  var css = [], cr = /<link[^>]+rel="stylesheet"[^>]+href="(https:\/\/(?:ssl|editor-static)\.pstatic\.net\/[^"]+)"/g, cm;
  while ((cm = cr.exec(html))) if (!/prismplayer/.test(cm[1])) css.push(cm[1]);
  return { html: h.length > 160000 ? '' : h, css: css };
}

/** 글에 붙은 태그 (블로그 화면 바깥 주소에서 따로 읽습니다) */
function fetchTags_(blogId, logNo) {
  try {
    var r = get_('https://blog.naver.com/BlogTagListInfo.naver?blogId=' + encodeURIComponent(blogId) + '&logNoList=' + logNo + '&logType=mylog', { 'User-Agent': DESKTOP_UA });
    if (r.code !== 200) return null;
    var j = JSON.parse(r.text.replace(/\s+/g, ' '));
    var t = (j.taglist || [])[0];
    if (!t) return [];
    return String(t.tagName || '').split(',').map(function (x) { try { return decodeURIComponent(x).trim(); } catch (e) { return x.trim(); } }).filter(String);
  } catch (e) { return null; }
}

/** 네이버 자동완성: 실제로 많이 찾는 이어지는 말 (해시태그 후보) */
function autocomplete_(q) {
  try {
    var r = get_('https://ac.search.naver.com/nx/ac?q=' + encodeURIComponent(q) + '&con=1&frm=nv&ans=2&r_format=json&r_enc=UTF-8&r_unicode=0&t_koreng=1&run=2&rev=4&q_enc=UTF-8&st=100', { 'User-Agent': DESKTOP_UA });
    if (r.code !== 200) return null;
    var j = JSON.parse(r.text), out = [];
    ((j.items || [])[0] || []).forEach(function (it) { if (it && it[0]) out.push(String(it[0])); });
    return out;
  } catch (e) { return null; }
}

/**
 * 추천 해시태그: 상호·핵심 키워드 → 이번 글 키워드 → 자동완성 → AI 제안 순.
 * 검색광고 키가 있으면 최근 30일 검색량을 붙입니다(최대 15개).
 */
function tagSuggest_(biz, ctx, aiTags) {
  var list = [], seen = {};
  function add(t, src) { t = String(t || '').replace(/^#/, '').trim(); var k = nsp_(t); if (!k || seen[k] || k.length > 25) return; seen[k] = 1; list.push({ tag: k, src: src }); }
  (biz.coreKeywords || []).forEach(function (k) { add(k.kw, k.type === '상호' ? '상호' : '핵심 키워드'); });
  (ctx.keywords || []).forEach(function (k) { add(k, '이번 글'); });
  var seeds = (biz.coreKeywords || []).filter(function (k) { return k.type !== '상호'; }).map(function (k) { return k.kw; }).concat(ctx.keywords || []).slice(0, 4);
  var acOk = true;
  seeds.forEach(function (q) { var a = autocomplete_(q); if (a === null) acOk = false; (a || []).slice(1, 6).forEach(function (x) { add(x, '자동완성'); }); });
  (aiTags || []).forEach(function (x) { add(x, 'AI 제안'); });
  list = list.slice(0, 30);
  var volOk = false, volNote = '';
  var want = list.slice(0, 15).map(function (x) { return x.tag; });
  for (var i = 0; i < want.length; i += 5) {
    var k = searchAdKeywords_(want.slice(i, i + 5));
    if (k.skipped) { volNote = '검색광고 API 키를 넣으면 검색량이 표시됩니다'; break; }
    if (k.error) { volNote = '검색량 조회 실패: ' + k.error.slice(0, 60); break; }
    volOk = true;
    k.main.forEach(function (v) { list.forEach(function (x) { if (x.tag === nsp_(v.keyword)) { x.pc = v.pc; x.mobile = v.mobile; } }); });
  }
  return { list: list, at: nowKst_(), volume: volOk, note: volNote, autocomplete: acOk };
}

/** 예전 0단계 요약용 */
function parsePost_(html) {
  var pb = parseBlocks_(html), b = pb.blocks, comps = {};
  var re = /class="se-component se-([a-zA-Z]+)/g, m;
  while ((m = re.exec(html))) comps[m[1]] = (comps[m[1]] || 0) + 1;
  var title = (b.filter(function (x) { return x.type === 'title'; })[0] || {}).text || '';
  var texts = b.filter(function (x) { return x.type === 'text' || x.type === 'heading' || x.type === 'quote'; }).map(function (x) { return x.text; });
  var places = b.filter(function (x) { return x.type === 'map' && x.placeId; }).map(function (x) { return { placeId: x.placeId, name: x.name, address: x.address }; });
  return {
    title: title, components: comps, paragraphs: texts.length,
    charsNoSpace: nsp_(texts.join('')).length, charsWithSpace: texts.join(' ').length,
    places: places, links: pb.links, imageCount: b.filter(function (x) { return x.type === 'image'; }).length,
    firstLines: texts.slice(0, 3), lastLines: texts.slice(-3)
  };
}

/** 모바일 플레이스 화면 → 기본 정보 (구글 서버에서는 막히는 경우가 많음) */
function parsePlace_(html, placeId) {
  var key = '"PlaceDetailBase:' + placeId + '"', i = html.indexOf(key);
  if (i < 0) return null;
  var blk = html.slice(i, i + 15000);
  function str(k) {
    var m = new RegExp('"' + k + '"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|null)').exec(blk);
    if (!m || m[1] === 'null') return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }
  function num(k) { var m = new RegExp('"' + k + '"\\s*:\\s*(\\d+)').exec(blk); return m ? +m[1] : null; }
  return {
    placeId: String(placeId), name: str('name'), category: str('category'), roadAddress: str('roadAddress'),
    address: str('address'), phone: str('phone'), visitorReviews: num('visitorReviewsTotal'), blogCafeReviews: num('cafeBlogReviewsTotal')
  };
}

/** 모바일 블로그 검색 화면 → 상위 글 [{rank, title, link}] */
function parseSearch_(html) {
  var list = [], seen = {}, re = /href="(https:\/\/m\.blog\.naver\.com\/[A-Za-z0-9_\-]+\/\d+)"[^>]*>([\s\S]*?)<\/a>/g, m;
  while ((m = re.exec(html))) {
    var t = stripTags_(m[2]);
    if (t.length > 8 && !seen[m[1]]) { seen[m[1]] = 1; list.push({ rank: list.length + 1, title: t.slice(0, 80), link: m[1] }); }
  }
  return list;
}

/** 붙여 넣은 원고 → 블록. 첫 줄은 제목. [사진], [지도], [인용: ], [구분선], [링크: ] 표시를 인식합니다. */
function parseManuscript_(text, title) {
  var blocks = [], lines = String(text || '').replace(/\r/g, '').split('\n');
  if (title) blocks.push({ type: 'title', text: String(title).trim() });
  var buf = [];
  function flush() { var t = buf.join(' ').trim(); if (t) blocks.push({ type: 'text', text: t }); buf = []; }
  lines.forEach(function (raw) {
    var l = raw.trim(), m;
    if (!l) { flush(); return; }
    if (!blocks.length && !title) { blocks.push({ type: 'title', text: l }); return; }
    if ((m = /^\[(사진|이미지|움짤|GIF)[^\]]*\]$/.exec(l))) { flush(); blocks.push({ type: 'image', planned: true, text: l }); return; }
    if (/^\[(지도|장소|장소 버튼)[^\]]*\]$/.test(l)) { flush(); blocks.push({ type: 'map', planned: true, text: l }); return; }
    if (/^\[구분선\]$/.test(l)) { flush(); blocks.push({ type: 'divider', planned: true }); return; }
    if ((m = /^\[(동영상|영상|클립)[^\]]*\]$/.exec(l))) { flush(); blocks.push({ type: 'video', planned: true, text: l }); return; }
    if ((m = /^\[(인용|말풍선|강조)\s*:\s*([^\]]*)\]$/.exec(l))) { flush(); blocks.push({ type: 'quote', text: m[2].trim() }); return; }
    if ((m = /^\[링크\s*:\s*([^\]]*)\]$/.exec(l))) { flush(); blocks.push({ type: 'link', url: m[1].trim(), planned: true }); return; }
    if ((m = /^(#{1,3})\s+(.+)$/.exec(l)) || (m = /^■\s*(.+)$/.exec(l))) { flush(); blocks.push({ type: 'heading', text: (m[2] || m[1]).trim() }); return; }
    buf.push(l); flush();
  });
  flush();
  return { blocks: blocks, links: blocks.filter(function (b) { return b.type === 'link'; }).map(function (b) { return b.url; }) };
}

/* ---------- 글 읽기 ---------- */
function loadPost_(req) {
  if (req.source === 'link') {
    var id = postIdFromUrl_(req.url);
    if (!id) throw fail_('bad_url', '블로그 글 주소를 알아보지 못했습니다. blog.naver.com/아이디/글번호 형태로 넣어 주세요.');
    var r = get_('https://m.blog.naver.com/' + id.blogId + '/' + id.logNo);
    if (r.code !== 200) throw fail_('fetch_failed', '글을 읽지 못했습니다(HTTP ' + r.code + '). 비공개 글이면 캡처나 원고로 검수해 주세요.');
    var pb = parseBlocks_(r.text);
    if (!pb.blocks.some(function (b) { return b.type === 'text'; })) throw fail_('fetch_failed', '본문을 찾지 못했습니다. 비공개·이웃공개 글이면 캡처나 원고로 검수해 주세요.');
    var v = buildView_(r.text);
    return { blocks: pb.blocks, links: pb.links, url: 'https://blog.naver.com/' + id.blogId + '/' + id.logNo, blogId: id.blogId, logNo: id.logNo,
      view: v && v.html ? '네이버 화면' : '재구성 화면', viewHtml: v ? v.html : '', viewCss: v ? v.css : [], tags: fetchTags_(id.blogId, id.logNo) };
  }
  if (req.source === 'text') {
    var pm = parseManuscript_(req.text, req.title);
    return { blocks: pm.blocks, links: pm.links, view: '재구성 화면' };
  }
  if (req.source === 'capture') return readCapture_(req.images || []);
  throw fail_('bad_request', '검수할 글을 넣어 주세요.');
}

/** 캡처 → 블록(이미지 번호와 위치 좌표 포함). AI가 화면을 읽습니다. */
function readCapture_(images) {
  if (!images.length) throw fail_('bad_request', '캡처 이미지를 올려 주세요.');
  var prompt = [
    '다음 이미지는 네이버 블로그 글 화면을 위에서부터 순서대로 캡처한 것입니다(이미지 ' + images.length + '장).',
    '화면에 보이는 그대로 글을 블록 단위로 옮겨 적으세요. 고치거나 요약하지 않습니다.',
    '블록 type: title(글 제목), heading(소제목), text(문단), quote(인용구), image(사진), map(지도/장소), link(링크 카드), table(표), divider(구분선), sticker(스티커), video(동영상).',
    '각 블록에 img(몇 번째 이미지인지, 0부터)와 box([위y, 왼x, 아래y, 오른x], 그 이미지 안에서 0~1000 비율)를 넣습니다.',
    'map은 지도에 적힌 장소 이름을 name에, image는 사진 내용을 한 줄로 alt에 적습니다.',
    '첫 이미지의 맨 위가 글 제목이 아니거나 마지막 이미지가 글 끝이 아니면 partial을 true로 합니다.',
    'JSON: {"partial":false,"blocks":[{"type":"title","text":"...","img":0,"box":[0,0,100,1000]}]}'
  ].join('\n');
  var res = gemini_(prompt, images, true, 'quick');
  var j = parseJson_(res.text) || {};
  var blocks = (j.blocks || []).map(function (b) {
    var o = { type: b.type || 'text', img: +b.img || 0, box: b.box };
    if (b.text) o.text = String(b.text); if (b.name) o.name = String(b.name); if (b.alt) o.alt = String(b.alt);
    return o;
  });
  return { blocks: blocks, links: [], view: '실제 화면', partial: !!j.partial, images: images.length };
}

/** 플레이스 캡처 → 업체 정보 */
function readPlaceCapture_(images) {
  if (!images.length) throw fail_('bad_request', '플레이스 화면 캡처를 올려 주세요.');
  var prompt = [
    '네이버 플레이스(지도) 화면 캡처에서 업체 정보를 그대로 옮겨 적으세요. 보이지 않는 칸은 빈 문자열로 둡니다. 추측하지 않습니다.',
    'JSON: {"name":"","category":"","address":"","phone":"","hours":"","closed":"","parking":"","booking":"","menuPrice":""}'
  ].join('\n');
  var j = parseJson_(gemini_(prompt, images, true, 'quick').text) || {};
  j.checkedAt = todayKst_(); j.checkedBy = '플레이스 캡처';
  return j;
}

function parseJson_(t) {
  t = String(t || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch (e) { }
  var a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e2) { } }
  return null;
}

/* ---------- 기계 검사 ---------- */
var CAUTION_WORDS = {
  '공통': ['최고', '최초', '유일', '100%', '완벽', '무조건', '보장', '1위', '최저가'],
  '학원·교육': ['합격 보장', '성적 보장', '100% 합격', '무조건 오르', '반드시 오르', '전원 합격'],
  '의료·미용': ['완치', '부작용 없', '부작용이 없', '통증 없', '효과 보장', '영구', '치료'],
  '음식점·식품': ['면역력', '치료', '다이어트 효과', '독소 배출', '항암'],
  '숙박·레저': ['절대 안전', '사고 없']
};
var SPONSOR_RE = /(협찬|원고료|제공받|지원받|광고|체험단|소정의|대가)/;

function textOf_(blocks, types) {
  types = types || ['title', 'text', 'heading', 'quote', 'table'];
  return blocks.filter(function (b) { return types.indexOf(b.type) >= 0 && b.text; }).map(function (b) { return b.text; });
}
function countIn_(hay, needle) { var h = nsp_(hay), n = nsp_(needle); if (!n) return 0; var c = 0, i = 0; while ((i = h.indexOf(n, i)) >= 0) { c++; i += n.length; } return c; }
function firstBlockWith_(blocks, needle) { for (var i = 0; i < blocks.length; i++) if (blocks[i].text && nsp_(blocks[i].text).indexOf(nsp_(needle)) >= 0) return i; return -1; }

/**
 * biz: 업체 정보, doc: {blocks, links, view, url}, ctx: {postType, sponsored, aiImages, keywords, source}
 * 결과: {findings, keywordTable, checklist, stats}
 */
function machineChecks_(biz, doc, ctx, prevImageKeys) {
  biz = biz || {}; ctx = ctx || {};
  var B = doc.blocks || [], F = [], at = nowKst_(), src = ctx.source || 'link';
  var linkSrc = src === 'link', planned = src === 'text';
  var rules = biz.rules || {};
  var titleIdx = -1; for (var t0 = 0; t0 < B.length; t0++) if (B[t0].type === 'title') { titleIdx = t0; break; }
  var title = titleIdx >= 0 ? B[titleIdx].text : '';
  var body = textOf_(B, ['text', 'heading', 'quote', 'table']).join(' ');
  var chars = nsp_(body).length;
  var photos = B.filter(function (b) { return b.type === 'image'; });
  var maps = B.filter(function (b) { return b.type === 'map'; });
  var allText = textOf_(B).join(' ');
  var firstTextIdx = []; for (var i = 0; i < B.length && firstTextIdx.length < 3; i++) if (B[i].type === 'text') firstTextIdx.push(i);
  var lastTexts = []; for (var j = B.length - 1; j >= 0 && lastTexts.length < 3; j--) if (B[j].type === 'text') lastTexts.unshift(j);
  function add(f) { f.id = 'm' + (F.length + 1); f.source = '기계'; F.push(f); return f; }
  function ev(label, value, link) { return { label: label, value: value, at: at, link: link || '' }; }
  var guide = function (k) { return rules[k] && rules[k].level; };

  // 1. 글자 수
  var minChars = (rules.minChars && +rules.minChars.value) || 1500;
  if (chars < minChars) add({
    area: '가이드 준수', status: guide('minChars') === '필수' ? '수정 필요' : '권장', title: '본문 분량',
    blocks: [], comment: '본문이 공백 제외 ' + chars + '자입니다. 검색한 분이 궁금해할 내용을 한두 문단 더 담아 주시면 글이 충분해집니다. ' + (minChars - chars) + '자 정도 보태 주세요.',
    evidence: [ev('측정', '공백 제외 ' + chars + '자 (제목·사진 설명 제외)'), ev('기준', minChars + '자 이상 · ' + (guide('minChars') === '필수' ? '업체 가이드 필수' : '기준표 권장값'))]
  });

  // 2. 사진 수
  var minPhotos = (rules.minPhotos && +rules.minPhotos.value) || 5;
  if (src === 'capture' && doc.partial) {
    add({ area: '가이드 준수', status: '확인 불가', title: '사진 수', blocks: [], comment: '캡처가 글 전체가 아닐 수 있어 사진 수를 확정하지 않았습니다.', evidence: [ev('측정', '캡처에서 ' + photos.length + '장 확인')] });
  } else if (photos.length < minPhotos) add({
    area: '가이드 준수', status: guide('minPhotos') === '필수' ? '수정 필요' : '권장', title: '사진 수',
    blocks: [], comment: '사진이 ' + photos.length + '장' + (planned ? '(원고의 [사진] 표시 기준)' : '') + '입니다. 처음 오시는 분은 사진으로 분위기를 먼저 봅니다. 직접 찍은 사진을 ' + (minPhotos - photos.length) + '장 더 넣어 주세요.',
    evidence: [ev('측정', '본문 사진 ' + photos.length + '장 (스티커 제외)'), ev('기준', minPhotos + '장 이상 · ' + (guide('minPhotos') === '필수' ? '업체 가이드 필수' : '기준표 권장값'))]
  });

  // 3. 지도(장소)
  var placeUrl = biz.placeId ? 'https://m.place.naver.com/place/' + biz.placeId + '/home' : '';
  if (maps.length) {
    var wrong = maps.filter(function (m) { return m.placeId && biz.placeId && m.placeId !== String(biz.placeId); });
    if (wrong.length) {
      var w = wrong[0];
      add({
        area: '업체 정보', status: '수정 필요', title: '지도에 다른 장소가 연결됨', blocks: [B.indexOf(w)],
        comment: '글 아래 지도가 ' + biz.name + '이 아니라 "' + (w.name || '다른 장소') + '"(으)로 연결되어 있습니다. 이 상태에서는 지도를 누른 손님이 다른 장소 정보를 보게 되고, 이 글이 ' + biz.name + ' 플레이스의 블로그 리뷰로 모이지 않습니다. 글 수정에서 지도를 지우고 장소 검색으로 "' + biz.name + '"을 다시 선택해 주세요.',
        suggestion: '장소 첨부: ' + biz.name + (biz.address ? ' (' + biz.address + ')' : ''),
        evidence: [ev('글의 지도', (w.name || '') + ' · 장소 번호 ' + w.placeId, 'https://m.place.naver.com/place/' + w.placeId + '/home'),
          ev('등록한 플레이스', biz.name + ' · 장소 번호 ' + biz.placeId, placeUrl)]
      });
    } else if (maps.some(function (m) { return m.placeId && m.placeId === String(biz.placeId); })) {
      // 충족: 별도 지적 없음
    } else if (!linkSrc && !planned) {
      add({ area: '업체 정보', status: '추가 확인', title: '지도 장소', blocks: [B.indexOf(maps[0])], comment: '캡처로는 지도에 연결된 장소를 확정할 수 없습니다. 지도 이름이 "' + (maps[0].name || '?') + '"로 보입니다. ' + biz.name + '으로 선택되어 있는지 한 번 확인해 주세요.', evidence: [ev('캡처', '지도 이름: ' + (maps[0].name || '읽지 못함'))] });
    }
  } else if (ctx.postType !== '정보성') {
    if (planned) add({ area: '가이드 준수', status: '권장', title: '지도(장소) 첨부', blocks: [], comment: '원고에 [지도] 표시가 없습니다. 발행할 때 글 끝에 장소 검색으로 "' + (biz.name || '업체') + '"을 첨부해 주세요. 지도를 누른 손님이 바로 길찾기와 전화로 이어집니다.', evidence: [ev('원고', '[지도] 표시 없음')] });
    else if (!(src === 'capture' && doc.partial)) add({ area: '가이드 준수', status: guide('requireMap') === '필수' ? '수정 필요' : '권장', title: '지도(장소) 첨부', blocks: [], comment: '글에 지도가 없습니다. 글 끝에 장소 검색으로 "' + (biz.name || '업체') + '"을 첨부해 주세요. 지도를 누른 손님이 바로 길찾기와 전화로 이어지고, 이 글이 플레이스 블로그 리뷰로 모입니다.', evidence: [ev('측정', '지도 0개')] });
  }

  // 4. 상호 키워드 (제목 또는 첫 문단)
  var names = [biz.name].concat((biz.coreKeywords || []).filter(function (k) { return k.type === '상호'; }).map(function (k) { return k.kw; })).filter(String);
  if (names.length) {
    var head = [title].concat(firstTextIdx.slice(0, 2).map(function (x) { return B[x].text; })).join(' ');
    var hit = names.some(function (n) { return nsp_(head).indexOf(nsp_(n)) >= 0; });
    if (!hit) add({
      area: '검색 적합성', status: '수정 필요', title: '상호가 제목·첫 문단에 없음', blocks: [titleIdx].filter(function (x) { return x >= 0; }),
      comment: '제목과 첫 문단에 "' + names[0] + '"이 없습니다. 상호를 검색하신 분이 이 글을 우리 가게 글로 알아보기 어렵습니다. 제목이나 첫 문장에 상호를 한 번 넣어 주세요.',
      quote: title, evidence: [ev('측정', '제목·첫 문단 2개에서 "' + names.join('", "') + '" 0회'), ev('기준', '핵심 키워드(상호): 모든 글 제목 또는 첫 문단에 1회')]
    });
  }

  // 5. 핵심 키워드 현황표 + 과도 반복
  var kws = [], seenKw = {};
  (biz.coreKeywords || []).concat((ctx.keywords || []).map(function (k) { return { kw: k, type: '이번 글' }; })).forEach(function (k) {
    if (k && k.kw && !seenKw[nsp_(k.kw)]) { seenKw[nsp_(k.kw)] = 1; kws.push(k); }
  });
  var keywordTable = kws.map(function (k) {
    var inTitle = nsp_(title).indexOf(nsp_(k.kw)) >= 0, n = countIn_(body, k.kw), fi = firstBlockWith_(B, k.kw);
    return { kw: k.kw, type: k.type, inTitle: inTitle, count: n, firstBlock: fi, where: inTitle ? '제목' + (n ? ' · 본문 ' + n + '회' : '') : n ? '본문 ' + n + '회' : '없음' };
  });
  var maxRepeat = (rules.maxRepeat && +rules.maxRepeat.value) || 10;
  keywordTable.forEach(function (k) {
    if (k.count > maxRepeat) add({
      area: '검색 적합성', status: '권장', title: '같은 키워드 반복', blocks: [],
      comment: '"' + k.kw + '"가 본문에 ' + k.count + '번 나옵니다. 같은 말이 계속 반복되면 읽는 분이 광고처럼 느끼고, 네이버도 과도한 키워드 반복을 검색 제한 사유로 안내합니다. 절반 정도는 다른 표현으로 바꿔 주세요.',
      evidence: [ev('측정', '본문 ' + k.count + '회'), ev('기준', maxRepeat + '회 이하 · 내부 편집 기준', 'https://help.naver.com/service/5626/contents/22928')]
    });
  });

  // 6. 전화번호 대조
  if (biz.phone) {
    var phoneRe = /(0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4})/g, pm, wrongPhones = [];
    textOf_(B).forEach(function (t) { while ((pm = phoneRe.exec(t))) if (digits_(pm[1]) !== digits_(biz.phone)) wrongPhones.push(pm[1]); });
    if (wrongPhones.length) add({
      area: '업체 정보', status: '수정 필요', title: '전화번호가 등록 정보와 다름', blocks: [firstBlockWith_(B, wrongPhones[0])],
      quote: wrongPhones[0], comment: '본문 전화번호 ' + wrongPhones[0] + '가 등록된 번호 ' + biz.phone + '와 다릅니다. 손님이 글을 보고 전화하셨다가 연결이 안 될 수 있어 꼭 맞춰 주셔야 합니다.',
      suggestion: biz.phone, evidence: [ev('등록 정보', biz.phone + (biz.placeCheckedAt ? ' (확인 ' + biz.placeCheckedAt + ')' : ''), placeUrl)]
    });
  }

  // 7. 주의 표현
  var words = (CAUTION_WORDS['공통'] || []).concat(CAUTION_WORDS[biz.industry] || []).concat(biz.cautionWords || []);
  var cautionHits = [];
  B.forEach(function (b, bi) {
    if (!b.text) return;
    words.forEach(function (w) { if (nsp_(b.text).indexOf(nsp_(w)) >= 0 && !cautionHits.some(function (h) { return h.w === w; })) cautionHits.push({ w: w, bi: bi }); });
  });
  cautionHits.slice(0, 5).forEach(function (h) {
    add({
      area: '표시', status: '추가 확인', title: '확인이 필요한 표현 "' + h.w + '"', blocks: [h.bi], quote: h.w,
      comment: '"' + h.w + '"는 사실을 증명하기 어려우면 과장 광고로 보일 수 있는 표현입니다. 근거가 있다면 근거를 함께 적어 주시고, 없다면 경험을 담은 표현으로 바꿔 주세요.',
      evidence: [ev('기준', '표시광고법 거짓·과장 광고 금지, 업종 주의 표현 사전(' + (biz.industry || '공통') + ')')]
    });
  });

  // 8. 대가성 표기
  var headText = [title].concat(firstTextIdx.map(function (x) { return B[x].text; })).join(' ');
  if (ctx.sponsored === 'yes' && !SPONSOR_RE.test(headText)) add({
    area: '표시', status: '수정 필요', title: '협찬·지원 표기 없음', blocks: [titleIdx].filter(function (x) { return x >= 0; }),
    comment: '협찬이나 지원을 받은 글인데 제목이나 첫 부분에 표기가 없습니다. 읽는 분이 처음에 알 수 있도록 첫 문장에 표기해 주셔야 합니다.',
    suggestion: '이 글은 ○○로부터 [제품·서비스]를 제공받아 작성했습니다.',
    evidence: [ev('기준', '공정위 추천·보증 등에 관한 표시·광고 심사지침: 제목 또는 첫 부분 표시')]
  });

  // 9. 생성형 AI 이미지
  if (ctx.aiImages === 'person') {
    if (!/가상\s*인물/.test(headText)) add({
      area: '표시', status: '수정 필요', title: 'AI 가상인물 표시 없음', blocks: [titleIdx].filter(function (x) { return x >= 0; }),
      comment: 'AI로 만든 인물 이미지가 있는데 제목이나 첫 부분에 표시가 없습니다. 2026년 6월부터 가상인물이 추천하는 광고는 표시해야 합니다. 첫 문장과 해당 사진의 인물 옆에 표시해 주셔야 합니다.',
      suggestion: '이 게시물에는 AI로 생성한 가상인물이 포함되어 있습니다.',
      evidence: [ev('기준', '공정위 추천·보증 심사지침 개정(2026.6.1 시행): 제목·첫 부분 + 인물 가까이 "가상인물" 표시')]
    });
  } else if (ctx.aiImages === 'yes') {
    if (!/AI|인공지능|생성\s*이미지/.test(allText + ' ' + photos.map(function (p) { return p.caption || ''; }).join(' '))) add({
      area: '표시', status: '추가 확인', title: 'AI 이미지 안내', blocks: [],
      comment: 'AI로 만든 이미지가 있다고 하셨는데 안내 문구가 보이지 않습니다. 음식·매장·결과 사진처럼 실제로 오해할 수 있는 이미지라면 사진 아래 설명에 안내를 넣어 주세요. 가능하면 실제 사진으로 바꾸시기를 권해 드립니다.',
      suggestion: 'AI로 만든 이미지로, 실제와 다를 수 있습니다.',
      evidence: [ev('기준', '표시광고법(기만 광고 위험), 업체 기준, 네이버 AI 활용 표시(권장)')]
    });
  }

  // 10. 마지막 안내
  var lastText = lastTexts.map(function (x) { return B[x].text; }).join(' ');
  if (lastTexts.length && !/(예약|문의|전화|상담|오시는|위치|찾아오|방문|연락|call|contact|0\d{1,2}-\d{3,4}-\d{4})/i.test(lastText)) add({
    area: '품질', status: '권장', title: '마지막 안내 문장', blocks: lastTexts.slice(-1),
    comment: '글 끝에 예약·문의·찾아오는 방법 안내가 없습니다. 끝까지 읽은 분이 바로 행동할 수 있도록 한두 문장을 더해 주시면 좋겠습니다.',
    suggestion: (biz.name || '') + ' 상담·예약은 ' + (biz.phone || '[전화번호]') + '로 편하게 문의해 주세요.',
    evidence: [ev('측정', '마지막 문단 3개에 예약·문의·위치 안내 없음')]
  });

  // 11. 글 나눔(소제목·인용구·구분선)
  if (linkSrc && chars > 1000 && !B.some(function (b) { return b.type === 'heading' || b.type === 'quote' || b.type === 'divider'; })) add({
    area: '품질', status: '권장', title: '내용 나눔', blocks: [],
    comment: '긴 글이 소제목이나 인용구 없이 이어집니다. 휴대폰으로 보는 분이 원하는 부분을 찾기 쉽도록 내용이 바뀌는 곳에 소제목이나 인용구를 넣어 주세요.',
    evidence: [ev('측정', '소제목 0, 인용구 0, 구분선 0 / 공백 제외 ' + chars + '자')]
  });

  // 12. 플레이스·예약 링크
  var hasPlaceLink = (doc.links || []).some(function (l) { return /naver\.me|place\.naver|booking\.naver|map\.naver|talk\.naver/.test(l); });
  if (linkSrc && !hasPlaceLink && !maps.length) add({
    area: '가이드 준수', status: '권장', title: '플레이스·예약 링크', blocks: [],
    comment: '플레이스나 예약으로 가는 링크가 없습니다. 지도 첨부나 예약 링크를 하나 넣어 주시면 글을 본 손님이 바로 예약·전화로 이어집니다.',
    evidence: [ev('측정', '플레이스·예약·톡톡 링크 0개, 지도 0개')]
  });

  // 13. 제목 공백
  if (/\s{3,}/.test(title)) add({
    area: '품질', status: '권장', title: '제목 안 빈칸', blocks: [titleIdx], quote: title,
    comment: '제목 중간에 빈칸이 길게 들어가 있습니다. 검색 결과와 휴대폰 화면에서 제목이 끊겨 보일 수 있으니 빈칸을 한 칸으로 줄여 주세요.',
    suggestion: title.replace(/\s{2,}/g, ' '), evidence: [ev('측정', '연속 빈칸 ' + (/\s{3,}/.exec(title)[0].length) + '칸')]
  });

  // 14. 글쓰기 표시가 글자로 남음 ([인용구], [표], [사진 1: ...], [확인 필요: ...] 등)
  var leftovers = [];
  B.forEach(function (b, bi) {
    if (b.type !== 'text' && b.type !== 'heading' && b.type !== 'quote') return;
    var m = /\[(인용구?|표|사진[^\]]*|구분선|말풍선[^\]]*|강조[^\]]*|체크리스트[^\]]*|장소 버튼[^\]]*|지도|확인 필요[^\]]*)\]/.exec(b.text || '');
    if (m && !(planned && /^\[(사진|지도|구분선|인용)/.test(m[0]) && m[0] === b.text)) leftovers.push({ bi: bi, t: m[0] });
  });
  if (leftovers.length && !planned) add({
    area: '품질', status: '수정 필요', title: '편집 표시가 글자로 남음', blocks: leftovers.slice(0, 3).map(function (x) { return x.bi; }), quote: leftovers[0].t,
    comment: '본문에 "' + leftovers.map(function (x) { return x.t; }).slice(0, 3).join('", "') + '"' + (leftovers.length > 3 ? ' 등 ' + leftovers.length + '곳' : '') + '이 글자로 그대로 보입니다. 원고를 옮길 때 남은 편집 표시라 읽는 분께는 어색하게 보입니다. 해당 글자를 지우고, 표시한 자리에 실제 인용구나 표를 넣어 주세요.',
    evidence: [ev('측정', '편집 표시 ' + leftovers.length + '곳')]
  });
  if (planned && leftovers.some(function (x) { return /확인 필요/.test(x.t); })) add({
    area: '품질', status: '추가 확인', title: '확인이 필요한 칸', blocks: leftovers.filter(function (x) { return /확인 필요/.test(x.t); }).map(function (x) { return x.bi; }).slice(0, 3),
    quote: leftovers.filter(function (x) { return /확인 필요/.test(x.t); })[0].t,
    comment: '원고에 [확인 필요] 칸이 남아 있습니다. 발행 전에 실제 내용으로 채워 주세요.', evidence: [ev('측정', '[확인 필요] 표시')]
  });

  // 15. 사진 재사용
  var imageKeys = photos.map(function (p) { return String(p.src || '').replace(/\?.*$/, '').replace(/^https?:\/\/[^/]+/, ''); }).filter(String);
  if (prevImageKeys && imageKeys.length) {
    var dup = imageKeys.filter(function (k) { return prevImageKeys[k]; });
    if (dup.length) add({
      area: '품질', status: '권장', title: '다른 글과 같은 사진', blocks: [],
      comment: '사진 ' + dup.length + '장이 이전에 검수한 글에도 쓰였습니다. 같은 사진이 반복되면 새 글의 정보가 적어 보입니다. 이번 글에 맞는 새 사진을 권해 드립니다.',
      evidence: [ev('측정', '같은 사진 파일 ' + dup.length + '장 (이전 검수 기록 기준)')]
    });
  }

  // 16. 태그
  if (linkSrc && doc.tags && doc.tags.length === 0) add({
    area: '검색 적합성', status: '권장', title: '태그 없음', blocks: [],
    comment: '이 글에 태그가 하나도 없습니다. 글 아래 태그는 검색하신 분이 같은 주제의 글을 찾아오는 길이 됩니다. 아래 "추천 해시태그"에서 상호와 핵심 키워드를 중심으로 10개 안팎을 넣어 주시면 좋겠습니다.',
    evidence: [ev('측정', '태그 0개', 'https://blog.naver.com/' + (doc.blogId || '') + '/' + (doc.logNo || ''))]
  });

  // 체크리스트 (앱 확인 결과를 미리 표시)
  function st(cond) { return cond === null ? '확인 불가' : cond ? '✅' : '❌'; }
  var hasMapOk = maps.some(function (m) { return m.placeId && m.placeId === String(biz.placeId); });
  var checklist = [
    { group: '업체 정보', item: '상호명이 플레이스와 같습니다 — ' + (biz.name || ''), who: '앱', state: names.length ? st(nsp_(allText).indexOf(nsp_(biz.name)) >= 0) : '확인 불가' },
    { group: '업체 정보', item: '장소(지도)를 첨부했고, 우리 가게로 선택했습니다', who: '앱', state: planned ? (maps.length ? '✅ (원고 표시)' : '❌') : linkSrc ? st(hasMapOk) : '확인 불가' },
    { group: '업체 정보', item: '플레이스·예약·톡톡 링크를 넣었습니다', who: '앱', state: linkSrc ? st(hasPlaceLink || hasMapOk) : '확인 불가' },
    { group: '업체 정보', item: '전화번호가 플레이스와 같습니다 — ' + (biz.phone || ''), who: '앱', state: biz.phone ? (F.some(function (f) { return f.title === '전화번호가 등록 정보와 다름'; }) ? '❌' : '✅') : '확인 불가' },
    { group: '업체 정보', item: '영업시간·휴무일·라스트오더가 플레이스와 같습니다', who: '대표', state: '☐' },
    { group: '업체 정보', item: '주차와 찾아오는 길을 적었습니다', who: '대표', state: '☐' },
    { group: '업체 정보', item: '가격과 메뉴가 현재 기준입니다', who: '대표', state: '☐' },
    { group: '업체 정보', item: '이벤트·할인은 기간과 조건을 적었습니다', who: '대표', state: '☐' },
    { group: '제목과 본문', item: '제목이나 첫 문단에 상호가 있습니다', who: '앱', state: names.length ? st(!F.some(function (f) { return f.title === '상호가 제목·첫 문단에 없음'; })) : '확인 불가' },
    { group: '제목과 본문', item: '핵심 키워드를 자연스럽게 넣었습니다', who: '앱', state: keywordTable.length ? st(keywordTable.some(function (k) { return k.type !== '상호' && (k.inTitle || k.count); })) : '확인 불가' },
    { group: '제목과 본문', item: '첫 문단만 읽어도 무엇에 대한 글인지 알 수 있습니다', who: '대표', state: '☐' },
    { group: '제목과 본문', item: '소제목이나 인용구로 내용을 나눴습니다', who: '앱', state: st(B.some(function (b) { return b.type === 'heading' || b.type === 'quote' || b.type === 'divider'; })) },
    { group: '제목과 본문', item: '마지막에 예약·문의·찾아오는 방법을 안내했습니다', who: '앱', state: st(!F.some(function (f) { return f.title === '마지막 안내 문장'; })) },
    { group: '사진과 영상', item: '직접 찍은 사진을 썼고, 첫 사진이 글을 잘 보여 줍니다', who: '대표', state: '☐' },
    { group: '사진과 영상', item: '다른 글과 같은 사진을 반복하지 않았습니다', who: '앱', state: linkSrc ? st(!F.some(function (f) { return f.title === '다른 글과 같은 사진'; })) : '확인 불가' },
    { group: '사진과 영상', item: 'AI로 만든 이미지가 있다면 표시했습니다', who: '대표', state: ctx.aiImages === 'no' ? '해당 없음' : ctx.aiImages ? st(!F.some(function (f) { return /AI/.test(f.title); })) : '☐' },
    { group: '사진과 영상', item: '손님 얼굴, 차량 번호 등 다른 사람의 정보가 보이지 않습니다', who: '대표', state: '☐' },
    { group: '표시와 주의 표현', item: '협찬·지원·체험단 글이면 제목이나 첫 부분에 표기했습니다', who: '대표', state: ctx.sponsored === 'no' ? '해당 없음' : ctx.sponsored === 'yes' ? st(SPONSOR_RE.test(headText)) : '☐' },
    { group: '표시와 주의 표현', item: '효과를 장담하는 표현을 쓰지 않았습니다', who: '앱', state: cautionHits.length ? '확인 필요 ' + cautionHits.length + '건' : '✅' },
    { group: '표시와 주의 표현', item: '다른 사람의 사진·글·글꼴을 허락 없이 쓰지 않았습니다', who: '대표', state: '☐' },
    { group: '발행 설정', item: '카테고리를 맞게 골랐습니다', who: '대표', state: '☐' },
    { group: '발행 설정', item: '태그에 상호와 핵심 키워드를 넣었습니다', who: linkSrc && doc.tags ? '앱' : '대표', state: linkSrc && doc.tags ? st(doc.tags.some(function (t) { return names.some(function (n) { return nsp_(t).indexOf(nsp_(n)) >= 0; }); }) || (doc.tags.length > 0 && !names.length)) : '☐' },
    { group: '발행 설정', item: "공개 설정이 '전체공개'입니다", who: '대표', state: linkSrc ? '✅' : '☐' },
    { group: '발행 설정', item: '검색 허용과 외부 보내기 허용이 켜져 있습니다', who: '대표', state: '☐' },
    { group: '발행 설정', item: '네이버 맞춤법 검사를 했습니다', who: '대표', state: '☐' },
    { group: '발행 설정', item: '모바일 미리보기로 사진과 글이 잘 보이는지 확인했습니다', who: '대표', state: '☐' }
  ];
  (INDUSTRY_CHECKS[biz.industry] || []).forEach(function (x) { checklist.push({ group: '업종', item: x, who: '대표', state: '☐' }); });

  return {
    findings: F, keywordTable: keywordTable, checklist: checklist, imageKeys: imageKeys,
    stats: { tags: doc.tags ? doc.tags.length : null, chars: chars, photos: photos.length, maps: maps.length, headings: B.filter(function (b) { return b.type === 'heading'; }).length, quotes: B.filter(function (b) { return b.type === 'quote'; }).length, dividers: B.filter(function (b) { return b.type === 'divider'; }).length, tables: B.filter(function (b) { return b.type === 'table'; }).length, videos: B.filter(function (b) { return b.type === 'video'; }).length }
  };
}
var INDUSTRY_CHECKS = {
  '학원·교육': ['교습비를 쓸 때는 교육청에 신고한 금액과 같게 적었습니다', '합격·성적 실적은 근거(연도, 인원)를 함께 적었습니다', '학생 사진·이름은 보호자 동의를 받았습니다'],
  '음식점·식품': ['원산지·알레르기 안내가 필요한 메뉴는 표시했습니다'],
  '의료·미용': ['시술 전후 사진은 쓰지 않았거나 관련 규정을 확인했습니다'],
  '숙박·레저': ['예약·환불 규정을 적었습니다']
};

/* ---------- 당일 키워드 근거 ---------- */
function keywordEvidence_(kw, postUrl) {
  var day = todayKst_(), id = day + '|' + nsp_(kw), cached = getRow_('keyword_log', id), e;
  if (cached) e = cached;
  else {
    e = { kw: kw, day: day, at: nowKst_(), searchLink: 'https://m.search.naver.com/search.naver?where=m_blog&query=' + encodeURIComponent(kw) };
    try { var sr = get_(e.searchLink); e.screenTop = sr.code === 200 ? parseSearch_(sr.text).slice(0, 10) : null; if (sr.code !== 200) e.screenError = 'HTTP ' + sr.code; }
    catch (x) { e.screenTop = null; e.screenError = String(x.message || x); }
    try { var a = blogSearchApi_(kw); if (a.skipped) e.apiSkipped = a.skipped; else if (a.error) e.apiError = a.error; else { e.apiTotal = a.total; e.apiTop = a.items.slice(0, 10); } }
    catch (x2) { e.apiError = String(x2.message || x2); }
    try { var k = searchAdKeywords_([kw]); if (k.skipped) e.volumeSkipped = k.skipped; else if (k.error) e.volumeError = k.error; else { e.volume = k.main[0] || null; e.related = k.related.slice(0, 5); } }
    catch (x3) { e.volumeError = String(x3.message || x3); }
    var save = JSON.parse(JSON.stringify(e)); setRow_('keyword_log', id, save);
  }
  if (postUrl) {
    var pid = postIdFromUrl_(postUrl), key = pid ? pid.blogId + '/' + pid.logNo : '';
    function found(list) { if (!list) return null; for (var i = 0; i < list.length; i++) if (key && String(list[i].link).indexOf(key) >= 0) return list[i].rank; return 0; }
    e.postRankScreen = found(e.screenTop); e.postRankApi = found(e.apiTop);
  }
  return e;
}

function blogSearchApi_(query) {
  var id = prop_('NAVER_CLIENT_ID', ''), sec = prop_('NAVER_CLIENT_SECRET', '');
  if (!id || !sec) return { skipped: '블로그 검색 API 키 없음' };
  var r = get_('https://openapi.naver.com/v1/search/blog.json?display=10&sort=sim&query=' + encodeURIComponent(query),
    { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': sec });
  if (r.code !== 200) return { error: 'HTTP ' + r.code + ' ' + r.text.slice(0, 200) };
  var j = JSON.parse(r.text);
  return { total: j.total, items: (j.items || []).map(function (x, i) { return { rank: i + 1, title: stripTags_(x.title), link: x.link, blogger: x.bloggername, date: x.postdate }; }) };
}

/** 검색광고 키워드 도구: 최근 30일 PC·모바일 검색 수. 키워드 안의 띄어쓰기는 빼고 보냅니다. */
function searchAdKeywords_(keywords) {
  var key = prop_('SEARCHAD_API_KEY', ''), sec = prop_('SEARCHAD_SECRET', ''), cid = prop_('SEARCHAD_CUSTOMER_ID', '');
  if (!key || !sec || !cid) return { skipped: '검색광고 API 키 없음' };
  var uri = '/keywordstool', ts = String(new Date().getTime());
  var sig = Utilities.base64Encode(Utilities.computeHmacSha256Signature(ts + '.GET.' + uri, sec));
  var hints = keywords.map(function (k) { return nsp_(k); }).slice(0, 5).join(',');
  var r = get_('https://api.searchad.naver.com' + uri + '?showDetail=1&hintKeywords=' + encodeURIComponent(hints), {
    'X-Timestamp': ts, 'X-API-KEY': key, 'X-Customer': cid, 'X-Signature': sig, 'User-Agent': 'blog-review'
  });
  if (r.code !== 200) return { error: 'HTTP ' + r.code + ' ' + r.text.slice(0, 200) };
  var list = JSON.parse(r.text).keywordList || [], want = {};
  hints.split(',').forEach(function (h) { want[h] = 1; });
  function pick(x) { return { keyword: x.relKeyword, pc: x.monthlyPcQcCnt, mobile: x.monthlyMobileQcCnt }; }
  return { main: list.filter(function (x) { return want[x.relKeyword]; }).map(pick), related: list.filter(function (x) { return !want[x.relKeyword]; }).slice(0, 10).map(pick) };
}

/* ---------- AI 첨삭 ---------- */
function aiReview_(biz, doc, ctx, machine) {
  var B = doc.blocks, lines = [];
  B.forEach(function (b, i) {
    var t = b.type === 'image' ? '[사진' + (b.caption ? ' 설명: ' + b.caption : '') + (b.alt ? ' 내용: ' + b.alt : '') + ']'
      : b.type === 'map' ? '[지도: ' + (b.name || '') + ']' : b.type === 'divider' ? '[구분선]' : b.type === 'link' ? '[링크: ' + (b.text || b.url || '') + ']'
        : b.type === 'video' ? '[동영상]' : b.type === 'sticker' ? '[스티커]' : b.text || '';
    lines.push('#' + i + ' (' + b.type + ') ' + t);
  });
  var prompt = [
    '당신은 소상공인 블로그를 검수하는 마케팅 컨설턴트입니다. 아래 글을 업체 대표에게 보낼 첨삭 의견으로 검토합니다.',
    '',
    '[업체] ' + (biz.name || '') + ' / 업종: ' + (biz.industry || '') + ' / 주소: ' + (biz.address || '') + ' / 전화: ' + (biz.phone || ''),
    '[핵심 키워드] ' + (biz.coreKeywords || []).map(function (k) { return k.kw + '(' + k.type + ')'; }).join(', '),
    '[이번 글 목표 키워드] ' + (ctx.keywords || []).join(', '),
    '[글 유형] ' + (ctx.postType || '미지정'),
    '[업체 메모] ' + (biz.guideNote || '없음'),
    '[이미 기계 검사로 찾은 것 — 다시 지적하지 않음] ' + machine.findings.map(function (f) { return f.title; }).join(', '),
    '',
    '[글] 블록 번호, 종류, 내용',
    lines.join('\n'),
    '',
    '검토할 것: 제목과 본문이 맞는지, 검색한 사람의 궁금증에 답하는지, 직접 경험·구체 정보가 있는지, 같은 말 반복, 어색한 문장과 맞춤법, 사진과 본문의 관계, 첫 문단에서 무엇에 대한 글인지 알 수 있는지.',
    '',
    '규칙',
    '- 지적은 최대 6개. 정말 고칠 가치가 있는 것만. 사소한 취향은 넣지 않습니다.',
    '- quote에는 해당 블록 원문을 한 글자도 바꾸지 않고 그대로 복사한 일부(5~60자)를 넣습니다. 원문에 없는 문장은 지적하지 않습니다.',
    '- 받는 사람은 업체 대표입니다. 말투는 정중하되 분명하게. fact(무엇이 어떻게 되어 있는지) → reason(손님 입장의 이유 한 문장) → request(무엇을 해 달라는지) 순서.',
    '- request 끝맺음: level이 "수정 필요"면 "~해 주세요" 또는 "~해 주셔야 합니다", "권장"이면 "~하시면 ~합니다. ~을 권해 드립니다", "추가 확인"이면 "~인지 알려 주시면 ~하겠습니다".',
    '- "~하세요"(지시), "~하는 게 어떨까 싶습니다"(모호), "틀렸습니다·부족합니다"(탓하는 말), "키워드 밀도·체류시간·상위노출" 같은 전문 용어를 쓰지 않습니다.',
    '- suggestion은 대표가 그대로 복사해 쓸 수 있는 고친 문장. 대표가 알려 주지 않은 가격·날짜·효능·경험을 지어내지 않고 필요하면 [확인 필요: 무엇]으로 남깁니다.',
    '- level: 사실 오류·법적 위험이면 "수정 필요", 더 좋아지는 제안이면 "권장", 대표 확인이 필요하면 "추가 확인".',
    '- area: "품질", "검색 적합성", "가이드 준수", "표시" 중 하나.',
    '- good: 실제로 잘된 점 1~2개를 근거(블록 번호)와 함께. 칭찬할 근거가 없으면 빈 배열.',
    '',
    '',
    '추가로 할 것',
    '- aiSearch: 네이버 AI 브리핑·ChatGPT 같은 AI 검색이 이 글을 답변 근거로 가져가기 쉬운지 6가지를 점검합니다. 각 항목 ok(true/false)와 note(한 문장, 대표에게 하는 말, 고칠 점이 있으면 무엇을 넣으면 되는지). 항목: "첫 문단에서 질문에 바로 답함", "질문형 소제목", "자주 묻는 질문(FAQ) 묶음", "업체명·지역·대상이 한 문장에 함께 나옴", "가격·시간·위치 같은 확인 가능한 사실", "직접 경험이나 고유한 정보".',
    '- summaryBox: 글 맨 위에 넣으면 AI 검색과 바쁜 독자에게 도움이 되는 3줄 요약(글에 있는 사실만, 없는 정보는 [확인 필요]).',
    '- faq: 이 글에 덧붙이면 좋은 자주 묻는 질문 3개와 글에 있는 사실만으로 쓴 답(모르면 [확인 필요]).',
    '- nextTopics: 이 글 다음에 이어서 쓰면 좋은 글 3편. title(블로그 제목), keyword(검색할 말), why(한 문장, 검색한 사람 입장의 이유). 업체 업종·지역·핵심 키워드와 맞게.',
    '- tags: 이 글에 붙이면 좋은 해시태그 10개(띄어쓰기 없이, # 없이). 상호와 지역+업종을 먼저.',
    '',
    'JSON만 출력: {"good":[{"block":0,"text":"..."}],"findings":[{"block":0,"quote":"...","area":"품질","level":"권장","title":"짧은 제목","fact":"...","reason":"...","request":"...","suggestion":"..."}],"aiSearch":[{"item":"첫 문단에서 질문에 바로 답함","ok":false,"note":"..."}],"summaryBox":["...","...","..."],"faq":[{"q":"...","a":"..."}],"nextTopics":[{"title":"...","keyword":"...","why":"..."}],"tags":["..."]}'
  ].join('\n');
  var res = gemini_(prompt, [], true, '');
  var j = parseJson_(res.text) || {};
  var findings = [], dropped = 0;
  (j.findings || []).slice(0, 8).forEach(function (f, i) {
    var bi = +f.block, b = B[bi], q = String(f.quote || '').trim();
    var ok = b && b.text && q && nsp_(b.text).indexOf(nsp_(q)) >= 0;
    if (!ok) { // 다른 블록에서 찾아봄
      for (var k = 0; k < B.length && !ok; k++) if (B[k].text && q && nsp_(B[k].text).indexOf(nsp_(q)) >= 0) { bi = k; ok = true; }
    }
    if (!ok) { dropped++; return; }
    var level = ['수정 필요', '권장', '추가 확인'].indexOf(f.level) >= 0 ? f.level : '권장';
    var comment = [f.fact, f.reason, f.request].filter(Boolean).join(' ');
    comment = softenTone_(comment);
    findings.push({
      id: 'a' + (i + 1), source: 'AI', area: f.area || '품질', status: level, title: f.title || '문장 다듬기',
      blocks: [bi], quote: q, comment: comment, suggestion: f.suggestion ? softenTone_(String(f.suggestion)) : '',
      evidence: [{ label: '원문', value: '#' + bi + ' 블록에서 인용 확인', at: nowKst_(), link: '' }]
    });
  });
  var good = (j.good || []).filter(function (g) { return g && g.text; }).slice(0, 2).map(function (g) { return { block: +g.block, text: softenTone_(String(g.text)) }; });
  var aiSearch = (j.aiSearch || []).slice(0, 6).map(function (x) { return { item: String(x.item || ''), ok: !!x.ok, note: softenTone_(String(x.note || '')) }; }).filter(function (x) { return x.item; });
  var nextTopics = (j.nextTopics || []).slice(0, 3).map(function (x) { return { title: String(x.title || ''), keyword: String(x.keyword || ''), why: softenTone_(String(x.why || '')) }; }).filter(function (x) { return x.title; });
  var faq = (j.faq || []).slice(0, 3).map(function (x) { return { q: String(x.q || ''), a: String(x.a || '') }; }).filter(function (x) { return x.q; });
  var summaryBox = (j.summaryBox || []).slice(0, 3).map(String);
  return { findings: findings, good: good, dropped: dropped, model: res.model, aiSearch: aiSearch, nextTopics: nextTopics, faq: faq, summaryBox: summaryBox, tags: (j.tags || []).slice(0, 12).map(String) };
}
/** "~하세요" 지시형을 "~해 주세요"로 바꿉니다. */
function softenTone_(s) {
  return String(s || '').replace(/([가-힣]+)하세요([.!]?)/g, '$1해 주세요$2').replace(/넣으세요/g, '넣어 주세요').replace(/바꾸세요/g, '바꿔 주세요')
    .replace(/고치세요/g, '고쳐 주세요').replace(/쓰세요/g, '써 주세요').replace(/주세요\s*주세요/g, '주세요');
}

/* ---------- 검수 전체 흐름 ---------- */
function runReview_(req) {
  var biz = getRow_('biz', req.bizId); if (!biz) throw fail_('no_biz', '업체를 먼저 등록해 주세요.');
  var ctx = { source: req.source, postType: req.postType || '', sponsored: req.sponsored || '', aiImages: req.aiImages || '', keywords: (req.keywords || []).filter(String).slice(0, 3) };
  var doc = loadPost_(req);
  // 이전 검수의 사진 목록 (사진 재사용 확인)
  var prev = {}, sameUrl = null;
  listRows_('reviews').forEach(function (r) {
    if (r.bizId !== req.bizId) return;
    if (doc.url && r.url === doc.url) { sameUrl = r; return; }
    (r.imageKeys || []).forEach(function (k) { prev[k] = 1; });
  });
  var machine = machineChecks_(biz, doc, ctx, prev);
  // 키워드 근거: 목표 키워드 + 상호 외 핵심 키워드(최대 3개)
  var evKws = ctx.keywords.slice();
  (biz.coreKeywords || []).forEach(function (k) { if (k.type !== '상호' && evKws.length < 3 && evKws.indexOf(k.kw) < 0) evKws.push(k.kw); });
  var evidence = evKws.map(function (k) { try { return keywordEvidence_(k, doc.url); } catch (e) { return { kw: k, error: String(e.message || e) }; } });
  machine.keywordTable.forEach(function (row) { var e = evidence.filter(function (x) { return nsp_(x.kw) === nsp_(row.kw); })[0]; if (e) row.evidence = { volume: e.volume || null, at: e.at, apiTotal: e.apiTotal, link: e.searchLink, rankScreen: e.postRankScreen, rankApi: e.postRankApi }; });
  var ai = { findings: [], good: [], error: '' };
  if (req.skipAi) ai.error = 'AI 첨삭을 건너뛰었습니다.';
  else { try { ai = aiReview_(biz, doc, ctx, machine); } catch (e) { ai.error = e.code === 'quota' ? '오늘 무료 AI 한도를 모두 썼습니다. 기계 검사 결과만 저장했습니다.' : 'AI 첨삭 실패: ' + (e.message || e); } }
  var tags = tagSuggest_(biz, ctx, ai.tags || []);
  // 다음 글 추천 키워드의 검색량 (키가 있을 때만)
  var nt = ai.nextTopics || [];
  if (nt.length) { var kv = searchAdKeywords_(nt.map(function (x) { return x.keyword; })); if (kv.main) nt.forEach(function (x) { kv.main.forEach(function (v) { if (nsp_(v.keyword) === nsp_(x.keyword)) { x.pc = v.pc; x.mobile = v.mobile; } }); }); }
  var findings = machine.findings.concat(ai.findings);
  var order = { '수정 필요': 0, '추가 확인': 1, '권장': 2, '확인 불가': 3 };
  findings.sort(function (a, b) { return (order[a.status] - order[b.status]) || ((a.blocks[0] || 999) - (b.blocks[0] || 999)); });
  findings.forEach(function (f, i) { f.no = i + 1; f.show = f.status !== '확인 불가'; });
  var count = function (s) { return findings.filter(function (f) { return f.status === s; }).length; };
  var summary = { must: count('수정 필요'), check: count('추가 확인') + count('확인 불가'), suggest: count('권장') };
  summary.headline = summary.must ? '꼭 고쳐 주실 것 ' + summary.must + '건' : summary.check ? '확인이 필요한 것 ' + summary.check + '건' : '필수 조건 충족';
  var title = (doc.blocks.filter(function (b) { return b.type === 'title'; })[0] || {}).text || '(제목 없음)';
  var review = {
    bizId: req.bizId, bizName: biz.name, createdAt: nowKst_(), source: req.source, url: doc.url || '', title: title,
    view: doc.view, partial: !!doc.partial, ctx: ctx, blocks: doc.blocks, links: doc.links, stats: machine.stats,
    keywordTable: machine.keywordTable, evidence: evidence, checklist: machine.checklist, findings: findings,
    good: ai.good, aiError: ai.error || '', aiDropped: ai.dropped || 0, summary: summary, imageKeys: machine.imageKeys,
    tags: doc.tags || null, tagSuggest: tags, aiSearch: ai.aiSearch || [], summaryBox: ai.summaryBox || [], faq: ai.faq || [], nextTopics: nt,
    viewHtml: doc.viewHtml || '', viewCss: doc.viewCss || [],
    bizSnapshot: { name: biz.name, phone: biz.phone, address: biz.address, placeId: biz.placeId, placeCheckedAt: biz.placeCheckedAt, coreKeywords: biz.coreKeywords || [] },
    previousReviewId: sameUrl ? sameUrl.id : ''
  };
  var id = 'r' + new Date().getTime();
  var store = JSON.parse(JSON.stringify(review));
  if (req.source === 'capture') store.captureNote = '캡처 이미지는 저장하지 않습니다(화면에서만 사용).';
  setRow_('reviews', id, store);
  review.id = id;
  return review;
}

/* ---------- Gemini ---------- */
function gemini_(prompt, images, wantJson, tier) {
  var key = prop_('GEMINI_API_KEY', ''); if (!key) throw fail_('not_configured', 'GEMINI_API_KEY가 설정되지 않았습니다.');
  var models = prop_('GEMINI_MODELS', DEFAULT_MODELS).split(',').map(function (s) { return s.trim(); }).filter(String);
  if (tier === 'quick' && models.length > 2) models = models.slice(1).concat(models.slice(0, 1));
  var parts = (images || []).map(function (d) { return { inline_data: { mime_type: 'image/jpeg', data: d } }; });
  parts.push({ text: prompt + (wantJson ? '\n\n(설명 없이 JSON만 출력합니다.)' : '') });
  var body = { contents: [{ role: 'user', parts: parts }], generationConfig: { temperature: 0.3, maxOutputTokens: 16000 } };
  if (wantJson) body.generationConfig.responseMimeType = 'application/json';
  var last = '', quota = 0;
  for (var i = 0; i < models.length; i++) {
    var r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(models[i]) + ':generateContent', {
      method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, payload: JSON.stringify(body), muteHttpExceptions: true
    });
    var code = r.getResponseCode(), txt = r.getContentText();
    if (code === 429) { quota++; last = '한도'; continue; }
    if (code === 404 || code === 400 && /not found|not supported|is not available/i.test(txt)) { last = '모델 없음(' + models[i] + ')'; continue; }
    if (code >= 500) { last = '일시 오류'; continue; }
    if (code !== 200) { last = 'HTTP ' + code + ' ' + txt.slice(0, 200); continue; }
    var j; try { j = JSON.parse(txt); } catch (e) { last = '응답 해석 실패'; continue; }
    var c = j.candidates && j.candidates[0], t = '';
    if (c && c.content && c.content.parts) c.content.parts.forEach(function (p) { if (p.text && !p.thought) t += p.text; });
    if (!t.trim()) { last = '빈 응답'; continue; }
    return { text: t, model: models[i] };
  }
  if (quota === models.length) throw fail_('quota', '오늘 무료 AI 한도를 모두 썼습니다.');
  throw fail_('upstream_error', 'AI 응답을 받지 못했습니다. (' + last + ')');
}

/**
 * 편집기에서 실행: 시험 업체(반포필즈수학)를 등록(이미 있으면 갱신)하고 글 한 편을 검수해 reviews 탭에 남깁니다.
 * 화면에 들어가면 [기록] 탭에서 첨삭지를 열 수 있습니다.
 */
function runSample() {
  var name = PROBE_TARGET.bizName, id = '';
  listRows_('biz').forEach(function (b) { if (b.name === name) id = b.id; });
  id = id || ('b' + new Date().getTime());
  var old = getRow_('biz', id) || {};
  var biz = {
    name: name, industry: '학원·교육', placeId: PROBE_TARGET.placeId, placeUrl: 'https://map.naver.com/p/entry/place/' + PROBE_TARGET.placeId,
    blogId: PROBE_TARGET.blogId, blogUrl: 'https://blog.naver.com/' + PROBE_TARGET.blogId,
    address: old.address || '서울 서초구 신반포로 165 반포쇼핑타운 2동 3층', phone: old.phone || '02-595-2252', placeCheckedAt: old.placeCheckedAt || '2026-10-17',
    coreKeywords: old.coreKeywords || [{ kw: '반포필즈수학', type: '상호' }, { kw: '반포 수학학원', type: '지역+업종' }, { kw: '잠원동 수학학원', type: '지역+업종' }],
    rules: old.rules || { minChars: { value: 1500, level: '권장' }, minPhotos: { value: 5, level: '권장' }, requireMap: { value: '', level: '권장' }, maxRepeat: { value: 10, level: '권장' } },
    guideNote: old.guideNote || '원장 1인 운영 수학학원. 초·중·고 수업.', updatedAt: nowKst_()
  };
  setRow_('biz', id, biz);
  var r = runReview_({ bizId: id, source: 'link', url: 'https://blog.naver.com/' + PROBE_TARGET.blogId + '/' + PROBE_TARGET.postNos[0], postType: '정보성', sponsored: 'no', aiImages: 'yes', keywords: ['반포 초등수학'] });
  var msg = [r.title, r.summary.headline + ' / 권장 ' + r.summary.suggest + ' / 확인 ' + r.summary.check, r.aiError || 'AI 첨삭 완료']
    .concat(r.findings.map(function (f) { return f.no + '. [' + f.status + '] ' + f.title; }));
  Logger.log(msg.join('\n')); return msg.join('\n');
}

/* ---------- 0단계 수집 시험 ---------- */
function runProbe() {
  var res = runProbe_(PROBE_TARGET, true);
  Logger.log(res.summary.join('\n'));
  return res.summary.join('\n');
}
function runProbe_(t, write) {
  var at = nowKst_(), rows = [], summary = [];
  function rec(name, ok, http, brief, detail) {
    var status = ok === true ? '성공' : ok === false ? '실패' : '건너뜀';
    rows.push([at, name, status, http || '', brief, JSON.stringify(detail || {}).slice(0, 45000)]);
    summary.push('[' + status + '] ' + name + ' — ' + brief);
  }
  function safe(name, fn) { try { fn(); } catch (e) { rec(name, false, '', '오류: ' + (e.message || e), {}); } }
  safe('플레이스', function () {
    var routes = [
      { name: '모바일', url: 'https://m.place.naver.com/place/' + t.placeId + '/home', ua: MOBILE_UA },
      { name: '데스크톱', url: 'https://pcmap.place.naver.com/place/' + t.placeId + '/home', ua: DESKTOP_UA }
    ];
    var tried = [], p = null, code = '';
    for (var i = 0; i < routes.length && !p; i++) {
      var r = get_(routes[i].url, { 'User-Agent': routes[i].ua });
      code = r.code; tried.push(routes[i].name + ' ' + r.code);
      p = r.code === 200 ? parsePlace_(r.text, t.placeId) : null;
      if (p) p.route = routes[i].name;
    }
    rec('플레이스', !!(p && p.name), code, (p ? [p.name, p.category, p.roadAddress, p.phone].join(' / ') : '업체 정보를 찾지 못함') + ' (시도: ' + tried.join(', ') + ')', p);
  });
  safe('블로그 RSS', function () {
    var r = get_('https://rss.blog.naver.com/' + t.blogId + '.xml');
    var items = r.code === 200 ? parseRss_(r.text) : [];
    rec('블로그 RSS', items.length > 0, r.code, '글 ' + items.length + '개' + (items[0] ? ', 최근: ' + items[0].title : ''), { items: items.slice(0, 20) });
  });
  (t.postNos || []).forEach(function (no) {
    var name = '블로그 글 ' + no;
    safe(name, function () {
      var r = get_('https://m.blog.naver.com/' + t.blogId + '/' + no);
      var p = r.code === 200 ? parsePost_(r.text) : null;
      if (!p || !p.paragraphs) { rec(name, false, r.code, '본문을 찾지 못함', {}); return; }
      var c = p.components, mapNote = '';
      if (p.places.length) {
        var match = p.places.some(function (x) { return x.placeId === String(t.placeId); });
        mapNote = match ? ' / 지도: 업체 플레이스와 일치' : ' / 지도: 업체 플레이스와 다름 (' + p.places.map(function (x) { return x.name + ' ' + x.placeId; }).join(', ') + ')';
        p.mapMatchesPlace = match;
      } else mapNote = ' / 지도 없음';
      rec(name, true, r.code, '"' + p.title + '" — 사진 ' + (c.image || 0) + ', 소제목 ' + (c.sectionTitle || 0) + ', 인용구 ' + (c.quotation || 0) +
        ', 구분선 ' + (c.horizontalLine || 0) + ', 표 ' + (c.table || 0) + ', 동영상 ' + (c.video || 0) + ', 공백 제외 ' + p.charsNoSpace + '자' + mapNote, p);
    });
  });
  (t.keywords || []).slice(0, 2).forEach(function (kw) {
    safe('검색 화면: ' + kw, function () {
      var r = get_('https://m.search.naver.com/search.naver?where=m_blog&query=' + encodeURIComponent(kw));
      var list = r.code === 200 ? parseSearch_(r.text) : [];
      rec('검색 화면: ' + kw, list.length > 0, r.code, list.length ? '상위 ' + Math.min(list.length, 5) + '개: ' + list.slice(0, 3).map(function (x) { return x.title; }).join(' | ') : '상위 글을 찾지 못함', { items: list.slice(0, 10) });
    });
    safe('블로그 검색 API: ' + kw, function () {
      var a = blogSearchApi_(kw);
      if (a.skipped) rec('블로그 검색 API: ' + kw, null, '', a.skipped, {});
      else if (a.error) rec('블로그 검색 API: ' + kw, false, '', a.error, {});
      else rec('블로그 검색 API: ' + kw, true, 200, '전체 ' + a.total + '건, 1위: ' + (a.items[0] ? a.items[0].title : '-'), a);
    });
  });
  safe('검색광고 키워드 도구', function () {
    var k = searchAdKeywords_(t.keywords || []);
    if (k.skipped) rec('검색광고 키워드 도구', null, '', k.skipped, {});
    else if (k.error) rec('검색광고 키워드 도구', false, '', k.error, {});
    else rec('검색광고 키워드 도구', true, 200, k.main.map(function (x) { return x.keyword + ' PC ' + x.pc + ' / 모바일 ' + x.mobile; }).join(', ') || '결과 없음', k);
  });
  if (write) { var sh = sheet_('probe'); sh.getRange(sh.getLastRow() + 1, 1, rows.length, 6).setValues(rows); }
  return { at: at, summary: summary, rows: rows };
}

/* ---------- 구글 시트 저장: 한 줄에 [id, 고친 시각, JSON 조각...] ---------- */
var ss_ = null;
function sheet_(tab) {
  if (!ss_) {
    var sid = prop_('SHEET_ID', '');
    // 시트에 붙은 스크립트(시트 메뉴 확장 프로그램 > Apps Script)로 만들었으면 SHEET_ID 없이 그 시트를 씁니다.
    ss_ = sid ? SpreadsheetApp.openById(sid) : SpreadsheetApp.getActiveSpreadsheet();
    if (!ss_) throw fail_('not_configured', 'SHEET_ID가 설정되지 않았습니다.');
  }
  var sh = ss_.getSheetByName(tab);
  if (!sh) {
    sh = ss_.insertSheet(tab);
    if (tab === 'probe') sh.getRange(1, 1, 1, 6).setValues([['시각', '시험', '결과', 'HTTP', '요약', '자세히(JSON)']]);
    else sh.getRange(1, 1, 1, 3).setValues([['id', 'updatedAt', 'json']]);
  }
  return sh;
}
function findRow_(sh, id) {
  var n = sh.getLastRow(); if (n < 2) return 0;
  var ids = sh.getRange(2, 1, n - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return 0;
}
function parseRow_(row) { var s = ''; for (var i = 2; i < row.length; i++) s += row[i] || ''; if (!s) return null; try { return JSON.parse(s); } catch (e) { return null; } }
function getRow_(tab, id) {
  var sh = sheet_(tab), r = findRow_(sh, id); if (!r) return null;
  var o = parseRow_(sh.getRange(r, 1, 1, Math.max(3, sh.getLastColumn())).getValues()[0]);
  if (o && typeof o === 'object') o.id = String(id); return o;
}
function listRows_(tab) {
  var sh = sheet_(tab), n = sh.getLastRow(); if (n < 2) return [];
  var rows = sh.getRange(2, 1, n - 1, Math.max(3, sh.getLastColumn())).getValues(), out = [];
  for (var i = 0; i < rows.length; i++) { var o = parseRow_(rows[i]); if (o && typeof o === 'object') { o.id = String(rows[i][0]); out.push(o); } }
  return out;
}
function setRow_(tab, id, obj) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var sh = sheet_(tab), s = JSON.stringify(obj), parts = [];
    for (var i = 0; i < s.length; i += CHUNK) parts.push(s.substr(i, CHUNK));
    if (!parts.length) parts.push('');
    var r = findRow_(sh, id); if (!r) r = sh.getLastRow() + 1;
    var width = Math.max(sh.getLastColumn(), parts.length + 2, 3), row = [String(id), new Date().toISOString()].concat(parts);
    while (row.length < width) row.push('');
    if (sh.getMaxColumns() < width) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
    sh.getRange(r, 1, 1, width).setNumberFormat('@').setValues([row]);
  } finally { lock.releaseLock(); }
}
function delRow_(tab, id) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try { var sh = sheet_(tab), r = findRow_(sh, id); if (r) sh.deleteRow(r); } finally { lock.releaseLock(); }
}

/** 처음 한 번 실행: 시트 탭을 만들고 설정이 들어갔는지 확인합니다. */
function setup() {
  TABS.forEach(function (t) { sheet_(t); });
  var msg = ['시트 탭 준비 완료: ' + TABS.join(', ')];
  msg.push('암호(ADMIN_PW): ' + (prop_('ADMIN_PW', '') ? '설정됨' : '없음. 화면에 들어가려면 넣어 주세요.'));
  msg.push('Gemini 키: ' + (prop_('GEMINI_API_KEY', '') ? '설정됨' : '없음. AI 첨삭과 캡처 읽기를 쓰려면 넣어 주세요.'));
  msg.push('블로그 검색 API 키: ' + (prop_('NAVER_CLIENT_ID', '') && prop_('NAVER_CLIENT_SECRET', '') ? '설정됨' : '없음'));
  msg.push('검색광고 API 키: ' + (prop_('SEARCHAD_API_KEY', '') && prop_('SEARCHAD_SECRET', '') && prop_('SEARCHAD_CUSTOMER_ID', '') ? '설정됨' : '없음'));
  Logger.log(msg.join('\n')); return msg.join('\n');
}
