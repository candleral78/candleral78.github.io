/**
 * 대표님 블로그 글쓰기 · 서버 (Google Apps Script)
 *
 * 하는 일: AI 호출(무료 AI 사이 자동 전환), 구글 시트 저장, 업체 접근 코드 확인,
 *          컨설턴트 화면 잠금, 업체별 글쓰기 횟수 제한.
 *
 * 설정은 [프로젝트 설정 > 스크립트 속성]에 넣습니다.
 *   GEMINI_API_KEY   (필수) Google AI Studio에서 발급한 키
 *   SHEET_ID         (필수) 저장용 구글 시트의 ID
 *   ADMIN_PW         (필수) 컨설턴트 화면 암호
 *   GEMINI_MODELS    (선택) 쉼표로 구분한 모델 순서. 앞에서부터 쓰고 한도에 닿으면 다음으로 넘어갑니다.
 *   DAILY_LIMIT      (선택) 업체당 하루 글쓰기 횟수. 기본 3
 *   MONTHLY_LIMIT    (선택) 업체당 한 달 글쓰기 횟수. 기본 20
 *   OPEN_DAILY_LIMIT (선택) 업체 등록 전 자료 읽기의 하루 전체 횟수. 기본 40
 *   OWNER_IMAGES     (선택) 대표님 화면에서 사진을 AI에 보낼지. "no"면 보내지 않음. 기본 yes
 *   ANTHROPIC_API_KEY(선택) 넣으면 컨설턴트 화면만 Claude로 처리
 *   CLAUDE_MODEL     (선택) 기본 claude-sonnet-5-5
 */
var DEFAULT_MODELS = 'gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite';
var TABS = ['biz', 'cards', 'posts', 'voices', 'reports', 'usage'];
var CHUNK = 45000;
var MAX_FAILS = 5, LOCK_MIN = 30;

function prop_(k, d) { var v = PropertiesService.getScriptProperties().getProperty(k); return v === null || v === '' ? d : v; }
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function fail_(code, message) { var e = new Error(message || code); e.code = code; return e; }

function doGet() { return out_({ ok: true, service: 'blog-writer', time: new Date().toISOString() }); }

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    return out_({ ok: true, data: route_(req) });
  } catch (err) {
    return out_({ ok: false, code: err.code || 'server_error', message: String(err.message || err) });
  }
}

/* ---------- 권한 ---------- */
function isAdmin_(req) { var pw = prop_('ADMIN_PW', ''); return !!pw && req.adminPw === pw; }
function needAdmin_(req) { if (!isAdmin_(req)) throw fail_('not_admin', '컨설턴트 암호가 맞지 않습니다.'); }
function hash_(s) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'bw:' + s, Utilities.Charset.UTF_8);
  return raw.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}
/** 업체 기록을 읽거나 고칠 수 있는지: 컨설턴트이거나 업체 코드가 맞아야 합니다. */
function needBiz_(req, id) {
  if (!id) throw fail_('bad_request', '업체가 지정되지 않았습니다.');
  if (id === 'example') return null;
  if (isAdmin_(req)) return getRow_('biz', id);
  var b = getRow_('biz', id);
  if (!b) throw fail_('no_biz', '등록되지 않은 업체입니다.');
  var now = new Date().getTime();
  if (b.lockUntil && b.lockUntil > now) throw fail_('locked', '코드를 여러 번 틀려 잠겼습니다. ' + Math.ceil((b.lockUntil - now) / 60000) + '분 뒤에 다시 넣거나 컨설턴트에게 문의해 주세요.');
  if (!b.codeHash || b.codeHash !== hash_(String(req.code || ''))) {
    if (!req.code) throw fail_('bad_code', '업체 코드를 넣어 주세요.');
    var n = (b.fails || 0) + 1, left = MAX_FAILS - n;
    b.fails = left <= 0 ? 0 : n; if (left <= 0) b.lockUntil = now + LOCK_MIN * 60000;
    var save = JSON.parse(JSON.stringify(b)); delete save.id; setRow_('biz', id, save);
    if (left <= 0) throw fail_('locked', '코드를 ' + MAX_FAILS + '번 틀려 ' + LOCK_MIN + '분 동안 잠겼습니다. 컨설턴트에게 문의해 주세요.');
    throw fail_('bad_code', '업체 코드가 맞지 않습니다. (' + left + '번 더 틀리면 ' + LOCK_MIN + '분 동안 잠깁니다.)');
  }
  if (b.fails || b.lockUntil) { delete b.fails; delete b.lockUntil; var ok = JSON.parse(JSON.stringify(b)); delete ok.id; setRow_('biz', id, ok); }
  return b;
}
function pub_(b) { if (!b) return null; var c = JSON.parse(JSON.stringify(b)); delete c.codeHash; delete c.fails; delete c.lockUntil; return c; }

/* ---------- 요청 나누기 ---------- */
function route_(req) {
  var a = req.action, id = req.id;
  switch (a) {
    case 'ping': return { admin: isAdmin_(req), ownerImages: prop_('OWNER_IMAGES', 'yes') !== 'no' };
    case 'checkAdmin': needAdmin_(req); return true;

    case 'lookupBiz': { var b = getRow_('biz', id); return { exists: !!b, name: b ? b.name : '' }; }
    case 'getBiz': return pub_(needBiz_(req, id));
    case 'listBiz': needAdmin_(req); return listRows_('biz').map(pub_);
    case 'saveBiz': {
      var old = getRow_('biz', id), b2 = req.biz || {};
      if (old) { needBiz_(req, id); b2.codeHash = old.codeHash; }
      else { if (!/^\d{6,8}$/.test(String(req.code || ''))) throw fail_('bad_code', '업체 코드는 숫자 6~8자리로 정해 주세요.'); b2.codeHash = hash_(String(req.code)); }
      delete b2.id; setRow_('biz', id, b2); return true;
    }
    case 'resetCode': {
      needAdmin_(req); var rb = getRow_('biz', id); if (!rb) throw fail_('no_biz', '등록되지 않은 업체입니다.');
      if (!/^\d{6,8}$/.test(String(req.code || ''))) throw fail_('bad_code', '업체 코드는 숫자 6~8자리로 정해 주세요.');
      rb.codeHash = hash_(String(req.code)); delete rb.fails; delete rb.lockUntil; delete rb.id; setRow_('biz', id, rb); return true;
    }
    case 'getCard': needBiz_(req, id); { var c = getRow_('cards', id); return c ? c.img || '' : ''; }
    case 'saveCard': needBiz_(req, id); if (req.img) setRow_('cards', id, { img: req.img }); else delRow_('cards', id); return true;

    case 'addPost': { needBiz_(req, req.post && req.post.bizId); var pid = 'p' + new Date().getTime() + Math.floor(Math.random() * 1000); setRow_('posts', pid, req.post); return pid; }
    case 'updatePost': { var p = getRow_('posts', id); if (!p) throw fail_('not_found', '글을 찾지 못했습니다.'); needBiz_(req, p.bizId); var patch = req.patch || {}; for (var k in patch) p[k] = patch[k]; setRow_('posts', id, p); return true; }
    case 'listPosts': {
      if (isAdmin_(req)) return listRows_('posts');
      needBiz_(req, req.bizId); return listRows_('posts').filter(function (x) { return x.bizId === req.bizId; });
    }

    case 'getVoice': needBiz_(req, id); return getRow_('voices', id);
    case 'saveVoice': needAdmin_(req); setRow_('voices', id, req.voice); return true;
    case 'delVoice': needAdmin_(req); delRow_('voices', id); return true;
    case 'getReport': needBiz_(req, id); return getRow_('reports', id);
    case 'saveReport': needAdmin_(req); setRow_('reports', id, req.report); return true;

    case 'ai': return ai_(req);
    default: throw fail_('bad_request', '알 수 없는 요청입니다: ' + a);
  }
}

/* ---------- 구글 시트 저장: 한 줄에 [id, 고친 시각, JSON 조각...] ---------- */
var ss_ = null;
function sheet_(tab) {
  if (!ss_) { var sid = prop_('SHEET_ID', ''); if (!sid) throw fail_('not_configured', 'SHEET_ID가 설정되지 않았습니다.'); ss_ = SpreadsheetApp.openById(sid); }
  var sh = ss_.getSheetByName(tab);
  if (!sh) { sh = ss_.insertSheet(tab); sh.getRange(1, 1, 1, 3).setValues([['id', 'updatedAt', 'json']]); }
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

/* ---------- 업체별 글쓰기 횟수 ---------- */
function dayKey_() { return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd'); }
function usage_(bizId) {
  var u = getRow_('usage', bizId) || { days: {} }, day = dayKey_(), month = day.slice(0, 7), m = 0;
  for (var d in u.days) { if (d.slice(0, 7) === month) m += u.days[d]; else if (d < month) delete u.days[d]; }
  return { u: u, day: day, today: u.days[day] || 0, month: m };
}
function checkQuota_(bizId) {
  var q = usage_(bizId), dl = +prop_('DAILY_LIMIT', 3), ml = +prop_('MONTHLY_LIMIT', 20);
  if (q.today >= dl) throw fail_('biz_daily_limit', '오늘 쓸 수 있는 글 횟수(' + dl + '편)를 모두 썼습니다.');
  if (q.month >= ml) throw fail_('biz_monthly_limit', '이번 달 쓸 수 있는 글 횟수(' + ml + '편)를 모두 썼습니다.');
  return q;
}
function addUsage_(q, bizId) { q.u.days[q.day] = (q.u.days[q.day] || 0) + 1; delete q.u.id; setRow_('usage', bizId, q.u); }

/* ---------- AI ---------- */
function ai_(req) {
  var admin = isAdmin_(req), prompt = String(req.prompt || ''), images = req.images || [], wantJson = req.kind === 'json';
  if (!prompt) throw fail_('bad_request', '보낼 내용이 없습니다.');
  if (prompt.length > 120000) throw fail_('prompt_too_large', '보내는 내용이 너무 깁니다.');
  var q = null;
  var openQ = null;
  if (!admin) {
    if (req.purpose === 'biz') {
      // 업체를 처음 등록할 때 자료를 읽는 호출: 아직 업체 코드가 없으므로 하루 전체 횟수만 제한합니다.
      openQ = usage_('_open'); if (openQ.today >= +prop_('OPEN_DAILY_LIMIT', 40)) throw fail_('quota', '오늘 자료 읽기 횟수를 모두 썼습니다. 정보를 직접 적어 주세요.');
    } else needBiz_(req, req.bizId);
    if (req.bizId !== 'example' && req.purpose === 'body') q = checkQuota_(req.bizId);
    if (prop_('OWNER_IMAGES', 'yes') === 'no' && req.purpose !== 'biz') images = [];
    images = images.slice(0, 5);
  }
  var res;
  if (admin && prop_('ANTHROPIC_API_KEY', '')) {
    try { res = claude_(prompt, images, wantJson); } catch (e) { res = gemini_(prompt, images, wantJson, req.tier); }
  } else res = gemini_(prompt, images, wantJson, req.tier);
  if (q) addUsage_(q, req.bizId);
  if (openQ) addUsage_(openQ, '_open');
  return res;
}

function gemini_(prompt, images, wantJson, tier) {
  var key = prop_('GEMINI_API_KEY', ''); if (!key) throw fail_('not_configured', 'GEMINI_API_KEY가 설정되지 않았습니다.');
  var models = prop_('GEMINI_MODELS', DEFAULT_MODELS).split(',').map(function (s) { return s.trim(); }).filter(String);
  if (tier === 'quick' && models.length > 2) models = models.slice(2).concat(models.slice(0, 2));
  var parts = images.map(function (d) { return { inline_data: { mime_type: 'image/jpeg', data: d } }; });
  parts.push({ text: prompt + (wantJson ? '\n\n(설명 없이 JSON만 출력합니다.)' : '') });
  var body = { contents: [{ role: 'user', parts: parts }], generationConfig: { temperature: 0.7, maxOutputTokens: 16000 } };
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
    if (j.promptFeedback && j.promptFeedback.blockReason) throw fail_('refused', '이 내용으로는 글을 만들 수 없습니다.');
    var c = j.candidates && j.candidates[0], t = '';
    if (c && c.content && c.content.parts) c.content.parts.forEach(function (p) { if (p.text && !p.thought) t += p.text; });
    if (!t.trim()) { last = '빈 응답'; continue; }
    return { text: t, truncated: c.finishReason === 'MAX_TOKENS', model: models[i] };
  }
  if (quota === models.length) throw fail_('quota', '오늘 무료 AI 한도를 모두 썼습니다.');
  throw fail_('upstream_error', 'AI 응답을 받지 못했습니다. (' + last + ')');
}

function claude_(prompt, images, wantJson) {
  var content = images.map(function (d) { return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: d } }; });
  content.push({ type: 'text', text: prompt + (wantJson ? '\n\n(설명 없이 JSON만 출력합니다.)' : '') });
  var model = prop_('CLAUDE_MODEL', 'claude-sonnet-5-5');
  var r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': prop_('ANTHROPIC_API_KEY', ''), 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({ model: model, max_tokens: 8000, messages: [{ role: 'user', content: content }] })
  });
  if (r.getResponseCode() !== 200) throw fail_('upstream_error', 'Claude 응답 오류 ' + r.getResponseCode());
  var j = JSON.parse(r.getContentText()), t = '';
  (j.content || []).forEach(function (b) { if (b.type === 'text') t += b.text; });
  if (!t.trim()) throw fail_('upstream_error', 'Claude 응답이 비어 있습니다.');
  return { text: t, truncated: j.stop_reason === 'max_tokens', model: model };
}

/** 처음 한 번 실행: 시트 탭을 만들고, 설정이 들어갔는지와 AI 연결을 확인합니다. */
function setup() {
  TABS.forEach(function (t) { sheet_(t); });
  var msg = ['시트 탭 준비 완료: ' + TABS.join(', ')];
  msg.push('컨설턴트 암호: ' + (prop_('ADMIN_PW', '') ? '설정됨' : '없음. ADMIN_PW를 넣어 주세요.'));
  try { var r = gemini_('"연결 확인"이라고만 답하세요.', [], false); msg.push('AI 연결 확인: ' + r.model + ' → ' + r.text.trim().slice(0, 30)); }
  catch (e) { msg.push('AI 연결 실패: ' + e.message); }
  Logger.log(msg.join('\n')); return msg.join('\n');
}
