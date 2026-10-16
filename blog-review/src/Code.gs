/**
 * 블로그 검수 도구 · 서버 (Google Apps Script) — 0단계: 수집 시험
 *
 * 블로그 글쓰기 앱과 **다른** Apps Script 프로젝트와 **다른** 구글 시트에서 돌립니다.
 * (글쓰기 앱 서버·시트는 건드리지 않습니다.)
 *
 * 하는 일(0단계): 네이버 자료를 구글 서버에서 실제로 읽을 수 있는지 6가지를 시험하고
 *                 결과를 시트 "probe" 탭에 한 줄씩 남깁니다.
 *   1) 블로그 RSS          2) 블로그 글 본문(에디터 요소, 지도 장소 번호)
 *   3) 모바일 블로그 검색 화면   4) 플레이스
 *   5) 네이버 블로그 검색 API   6) 네이버 검색광고 키워드 도구 API
 *
 * 설정은 [프로젝트 설정 > 스크립트 속성]에 넣습니다.
 *   SHEET_ID              (선택) 이 도구 전용 구글 시트의 ID. 시트에 붙은 스크립트면 비워 둡니다
 *   ADMIN_PW              (화면 사용 시) 화면에서 시험을 돌릴 때 쓰는 암호
 *   NAVER_CLIENT_ID       (5번 시험) 네이버 개발자센터 애플리케이션 Client ID
 *   NAVER_CLIENT_SECRET   (5번 시험) 같은 애플리케이션 Client Secret
 *   SEARCHAD_API_KEY      (6번 시험) 검색광고 API 액세스라이선스
 *   SEARCHAD_SECRET       (6번 시험) 검색광고 API 비밀키
 *   SEARCHAD_CUSTOMER_ID  (6번 시험) 검색광고 CUSTOMER_ID
 * 키가 없는 시험은 "건너뜀"으로 기록하고 나머지는 그대로 진행합니다.
 */
var TABS = ['probe'];
var MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
var DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** 시험 대상. 업체를 바꿔 시험하려면 여기만 고칩니다. */
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

function route_(req) {
  switch (req.action) {
    case 'ping': return { admin: isAdmin_(req) };
    case 'probe': needAdmin_(req); return runProbe_(req.target || PROBE_TARGET, false);
    default: throw fail_('bad_request', '알 수 없는 요청입니다: ' + req.action);
  }
}

/* ---------- 내려받기 ---------- */
function get_(url, headers) {
  var h = headers || {};
  if (!h['User-Agent']) h['User-Agent'] = MOBILE_UA;
  var r = UrlFetchApp.fetch(url, { method: 'get', headers: h, muteHttpExceptions: true, followRedirects: true });
  return { code: r.getResponseCode(), text: r.getContentText('UTF-8') };
}

/* ---------- 해석 (화면 코드에서 필요한 값만 꺼냄) ---------- */
function unescapeHtml_(s) {
  return String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(+n); })
    .replace(/&amp;/g, '&');
}
function stripTags_(s) { return unescapeHtml_(String(s || '').replace(/<[^>]+>/g, '')).replace(/​/g, '').trim(); }
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

/** 모바일 블로그 글 화면 → 구성 요소, 글자 수, 지도 장소, 링크 */
function parsePost_(html) {
  var title = (/<title>([\s\S]*?)<\/title>/.exec(html) || [])[1] || '';
  title = unescapeHtml_(title).replace(/\s*:\s*네이버 블로그\s*$/, '').trim();
  var comps = {}, re = /class="se-component se-([a-zA-Z]+)/g, m;
  while ((m = re.exec(html))) comps[m[1]] = (comps[m[1]] || 0) + 1;
  var paras = [], pr = /<p class="se-text-paragraph[^"]*"[^>]*>([\s\S]*?)<\/p>/g;
  while ((m = pr.exec(html))) { var t = stripTags_(m[1]); if (t) paras.push(t); }
  // 첫 문단은 제목 영역이므로 본문 글자 수에서 뺍니다.
  var body = paras.slice(1).join(' ');
  var places = [], seen = {}, mr = /data-module='(\{[^']*"type"\s*:\s*"v2_map"[\s\S]*?)'/g;
  while ((m = mr.exec(html))) {
    try {
      var d = JSON.parse(unescapeHtml_(m[1]));
      (d.data && d.data.places || []).forEach(function (p) {
        if (!seen[p.placeId]) { seen[p.placeId] = 1; places.push({ placeId: String(p.placeId), name: p.name, address: p.address }); }
      });
    } catch (e) { /* 해석 못 한 지도는 건너뜀 */ }
  }
  var links = [], lr = /data-linkdata='(\{[^']*\})'/g;
  while ((m = lr.exec(html))) {
    try { var ld = JSON.parse(unescapeHtml_(m[1])); if (ld.link || ld.url) links.push(ld.link || ld.url); } catch (e) { }
  }
  var images = [], ir = /data-lazy-src="([^"]+)"/g;
  while ((m = ir.exec(html))) images.push(m[1]);
  return {
    title: title,
    components: comps,
    paragraphs: paras.length,
    charsNoSpace: body.replace(/\s/g, '').length,
    charsWithSpace: body.length,
    places: places,
    links: links,
    imageCount: images.length,
    firstLines: paras.slice(1, 4),
    lastLines: paras.slice(-3)
  };
}

/** 모바일 플레이스 화면 → 기본 정보 */
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
  function flag(k) { var m = new RegExp('"' + k + '"\\s*:\\s*(true|false)').exec(blk); return m ? m[1] === 'true' : null; }
  return {
    placeId: String(placeId),
    name: str('name'),
    category: str('category'),
    roadAddress: str('roadAddress'),
    address: str('address'),
    road: str('road'),
    phone: str('phone'),
    visitorReviews: num('visitorReviewsTotal'),
    blogCafeReviews: num('cafeBlogReviewsTotal'),
    missing: {
      bizHour: flag('isBizHourMissing'),
      description: flag('isDescriptionMissing'),
      menuImage: flag('isMenuImageMissing'),
      conveniences: flag('isConveniencesMissing')
    }
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

/* ---------- 공식 API ---------- */
function blogSearchApi_(query) {
  var id = prop_('NAVER_CLIENT_ID', ''), sec = prop_('NAVER_CLIENT_SECRET', '');
  if (!id || !sec) return { skipped: '키 없음 (NAVER_CLIENT_ID, NAVER_CLIENT_SECRET)' };
  var r = get_('https://openapi.naver.com/v1/search/blog.json?display=10&sort=sim&query=' + encodeURIComponent(query),
    { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': sec });
  if (r.code !== 200) return { error: 'HTTP ' + r.code + ' ' + r.text.slice(0, 200) };
  var j = JSON.parse(r.text);
  return {
    total: j.total,
    items: (j.items || []).map(function (x, i) {
      return { rank: i + 1, title: stripTags_(x.title), link: x.link, blogger: x.bloggername, date: x.postdate };
    })
  };
}

/** 검색광고 키워드 도구: 최근 30일 PC·모바일 검색 수. 키워드 안의 띄어쓰기는 빼고 보냅니다. */
function searchAdKeywords_(keywords) {
  var key = prop_('SEARCHAD_API_KEY', ''), sec = prop_('SEARCHAD_SECRET', ''), cid = prop_('SEARCHAD_CUSTOMER_ID', '');
  if (!key || !sec || !cid) return { skipped: '키 없음 (SEARCHAD_API_KEY, SEARCHAD_SECRET, SEARCHAD_CUSTOMER_ID)' };
  var uri = '/keywordstool', ts = String(new Date().getTime());
  var sig = Utilities.base64Encode(Utilities.computeHmacSha256Signature(ts + '.GET.' + uri, sec));
  var hints = keywords.map(function (k) { return k.replace(/\s+/g, ''); }).slice(0, 5).join(',');
  var r = get_('https://api.searchad.naver.com' + uri + '?showDetail=1&hintKeywords=' + encodeURIComponent(hints), {
    'X-Timestamp': ts, 'X-API-KEY': key, 'X-Customer': cid, 'X-Signature': sig, 'User-Agent': 'blog-review'
  });
  if (r.code !== 200) return { error: 'HTTP ' + r.code + ' ' + r.text.slice(0, 200) };
  var list = JSON.parse(r.text).keywordList || [], want = {};
  hints.split(',').forEach(function (h) { want[h] = 1; });
  var main = list.filter(function (x) { return want[x.relKeyword]; });
  var related = list.filter(function (x) { return !want[x.relKeyword]; }).slice(0, 10);
  function pick(x) { return { keyword: x.relKeyword, pc: x.monthlyPcQcCnt, mobile: x.monthlyMobileQcCnt }; }
  return { main: main.map(pick), related: related.map(pick) };
}

/* ---------- 시험 실행 ---------- */
/**
 * 편집기에서 이 함수를 골라 [실행]을 누르면 6가지 시험을 하고 "probe" 탭에 기록합니다.
 * 처음 실행할 때 구글이 권한(외부 접속, 시트)을 묻습니다. 허용해 주세요.
 */
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
  function safe(name, fn) {
    try { fn(); } catch (e) { rec(name, false, '', '오류: ' + (e.message || e), {}); }
  }

  var placeInfo = null;
  safe('플레이스', function () {
    // 모바일 주소가 막히면(429 등) 데스크톱 주소로 한 번 더 시도합니다.
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
    placeInfo = p;
    rec('플레이스', !!(p && p.name), code,
      (p ? [p.name, p.category, p.roadAddress, p.phone].join(' / ') : '업체 정보를 찾지 못함') + ' (시도: ' + tried.join(', ') + ')', p);
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
        mapNote = match ? ' / 지도: 업체 플레이스와 일치'
          : ' / 지도: 업체 플레이스와 다름 (' + p.places.map(function (x) { return x.name + ' ' + x.placeId; }).join(', ') + ')';
        p.mapMatchesPlace = match;
      } else mapNote = ' / 지도 없음';
      rec(name, true, r.code,
        '"' + p.title + '" — 사진 ' + (c.image || 0) + ', 소제목 ' + (c.sectionTitle || 0) + ', 인용구 ' + (c.quotation || 0) +
        ', 구분선 ' + (c.horizontalLine || 0) + ', 표 ' + (c.table || 0) + ', 동영상 ' + (c.video || 0) +
        ', 공백 제외 ' + p.charsNoSpace + '자' + mapNote, p);
    });
  });

  (t.keywords || []).slice(0, 2).forEach(function (kw) {
    safe('검색 화면: ' + kw, function () {
      var r = get_('https://m.search.naver.com/search.naver?where=m_blog&query=' + encodeURIComponent(kw));
      var list = r.code === 200 ? parseSearch_(r.text) : [];
      rec('검색 화면: ' + kw, list.length > 0, r.code,
        list.length ? '상위 ' + Math.min(list.length, 5) + '개: ' + list.slice(0, 3).map(function (x) { return x.title; }).join(' | ') : '상위 글을 찾지 못함',
        { items: list.slice(0, 10) });
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
    else rec('검색광고 키워드 도구', true, 200,
      k.main.map(function (x) { return x.keyword + ' PC ' + x.pc + ' / 모바일 ' + x.mobile; }).join(', ') || '결과 없음', k);
  });

  if (write) {
    var sh = sheet_('probe');
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, 6).setValues(rows);
  }
  return { at: at, summary: summary, rows: rows };
}

/* ---------- 구글 시트 ---------- */
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
  }
  return sh;
}

/** 처음 한 번 실행: 시트 탭을 만들고 설정이 들어갔는지 확인합니다. */
function setup() {
  TABS.forEach(function (t) { sheet_(t); });
  var msg = ['시트 탭 준비 완료: ' + TABS.join(', ')];
  msg.push('암호(ADMIN_PW): ' + (prop_('ADMIN_PW', '') ? '설정됨' : '없음'));
  msg.push('블로그 검색 API 키: ' + (prop_('NAVER_CLIENT_ID', '') && prop_('NAVER_CLIENT_SECRET', '') ? '설정됨' : '없음 (5번 시험은 건너뜁니다)'));
  msg.push('검색광고 API 키: ' + (prop_('SEARCHAD_API_KEY', '') && prop_('SEARCHAD_SECRET', '') && prop_('SEARCHAD_CUSTOMER_ID', '') ? '설정됨' : '없음 (6번 시험은 건너뜁니다)'));
  Logger.log(msg.join('\n')); return msg.join('\n');
}
