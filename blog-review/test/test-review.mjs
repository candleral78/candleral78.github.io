// 1단계 서버 시험: 업체 등록 → 링크 검수 → 원고 검수 → 캡처 검수 → 저장·목록.
// 실행: node blog-review/test/test-review.mjs   (네이버는 실제 인터넷으로 읽습니다)
import { makeServer } from './mock-server.mjs';

let fails = 0;
function check(name, cond, extra) { console.log((cond ? '  통과 ' : '  실패 ') + name + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra).slice(0, 300))); if (!cond) fails++; }
const s = makeServer();
function call(action, payload) { const out = JSON.parse(s.doPost({ postData: { contents: JSON.stringify(Object.assign({ action, adminPw: 'admin1234' }, payload || {})) } }).text); return out; }

console.log('== 암호');
check('암호 없으면 거절', JSON.parse(s.doPost({ postData: { contents: JSON.stringify({ action: 'listBiz' }) } }).text).code === 'not_admin');
check('ping은 열림', call('ping').data.admin === true);

console.log('== 업체 등록');
const place = call('readPlaceCapture', { images: ['AAAA'] }).data;
check('플레이스 캡처 읽기', place.phone === '02-595-2252' && place.checkedAt);
const bizId = call('saveBiz', { biz: {
  name: '반포필즈수학', industry: '학원·교육', placeUrl: 'https://map.naver.com/p/search/x/place/1895531946?c=1', blogUrl: 'https://blog.naver.com/svtcarat99',
  address: place.address, phone: place.phone, placeCheckedAt: place.checkedAt,
  coreKeywords: [{ kw: '반포필즈수학', type: '상호' }, { kw: '반포 수학학원', type: '지역+업종' }, { kw: '잠원동 수학학원', type: '지역+업종' }],
  rules: { minChars: { value: 1500, level: '권장' }, minPhotos: { value: 5, level: '권장' } }
} }).data;
const biz = call('getBiz', { id: bizId }).data;
check('플레이스 번호를 주소에서 뽑음', biz.placeId === '1895531946', biz.placeId);
check('블로그 아이디를 주소에서 뽑음', biz.blogId === 'svtcarat99', biz.blogId);

console.log('== 링크 검수 (초등편)');
const r1 = call('review', { bizId, source: 'link', url: 'https://blog.naver.com/svtcarat99/224444068379', postType: '정보성', sponsored: 'no', aiImages: 'no', keywords: ['반포 초등수학'] });
check('검수 성공', r1.ok, r1);
const R = r1.data;
check('블록을 순서대로 읽음 (제목 첫 칸)', R.blocks[0].type === 'title' && R.blocks.some(b => b.type === 'table') && R.blocks.some(b => b.type === 'map'));
const mapF = R.findings.find(f => f.title === '지도에 다른 장소가 연결됨');
check('지도 다른 장소 → 수정 필요', mapF && mapF.status === '수정 필요' && mapF.evidence.length === 2, R.findings.map(f => f.title));
check('수정 필요가 맨 앞', R.findings[0].status === '수정 필요');
check('AI 지적: 원문에 있는 인용만 남음', R.findings.filter(f => f.source === 'AI').length === 1 && R.aiDropped === 1, R.findings.filter(f => f.source === 'AI'));
check('AI 말투: "~하세요"를 "~해 주세요"로', R.findings.filter(f => f.source === 'AI').every(f => !/하세요/.test(f.comment)), R.findings.filter(f => f.source === 'AI').map(f => f.comment));
check('잘된 점 1개', R.good.length === 1);
check('핵심 키워드 표 4줄 (핵심 3 + 이번 글 1)', R.keywordTable.length === 4, R.keywordTable.map(k => k.kw));
check('키워드 근거: 당일 검색 화면 상위 글', R.evidence.every(e => Array.isArray(e.screenTop)) && R.evidence[0].at, R.evidence.map(e => e.screenError));
check('키워드 근거: 키 없는 API는 건너뜀 표시', R.evidence.every(e => e.apiSkipped && e.volumeSkipped));
check('체크리스트: 지도 항목 ❌', R.checklist.find(c => c.item.startsWith('장소(지도)')).state === '❌');
check('학원 업종 체크 항목 추가', R.checklist.some(c => c.group === '업종'));
check('요약: 꼭 고쳐 주실 것', R.summary.must >= 1 && /꼭 고쳐/.test(R.summary.headline));
check('편집 표시 [인용구]·[표] 남음 → 수정 필요', R.findings.some(f => f.title === '편집 표시가 글자로 남음' && /인용구/.test(f.comment)), R.findings.map(f => f.title));
check('네이버 화면 HTML (스크립트 없음)', R.view === '네이버 화면' && R.viewHtml.length > 10000 && !/<script/i.test(R.viewHtml) && R.viewCss.length >= 2);
check('블록에 화면 위치(ci) 기록', R.blocks.filter(b => b.type === 'text').every(b => typeof b.ci === 'number' && typeof b.pi === 'number'));
check('글 태그 읽음(0개) → 태그 없음 권장', Array.isArray(R.tags) && R.tags.length === 0 && R.findings.some(f => f.title === '태그 없음'));
check('추천 해시태그: 상호 먼저, 자동완성 포함, 30개 이하', R.tagSuggest.list[0].tag === '반포필즈수학' && R.tagSuggest.list.some(t => t.src === '자동완성') && R.tagSuggest.list.length <= 30, R.tagSuggest);
check('검색량 키 없음 안내', /키를 넣으면/.test(R.tagSuggest.note));
check('AI 검색 점검 항목', R.aiSearch.length === 3 && R.aiSearch.every(a => !/하세요/.test(a.note)), R.aiSearch);
check('다음 글 추천 2편', R.nextTopics.length === 2 && R.nextTopics[0].keyword);
check('요약 3줄·FAQ', R.summaryBox.length === 3 && R.faq.length === 1);
check('저장됨', call('getReview', { id: R.id }).data.title === R.title);
check('keyword_log 탭에 하루 1회 저장', s.__sheets.keyword_log.rows.length - 1 === R.evidence.length);

console.log('== 링크 검수 (원장 소개) — 제목 빈칸, 같은 키워드 근거 재사용');
const before = s.__sheets.keyword_log.rows.length;
const r2 = call('review', { bizId, source: 'link', url: 'https://m.blog.naver.com/svtcarat99/224438209933', postType: '업체 소개', keywords: ['반포 수학학원'] }).data;
check('제목 안 빈칸 지적', r2.findings.some(f => f.title === '제목 안 빈칸'), r2.findings.map(f => f.title));
check('같은 날 같은 키워드는 다시 조회하지 않음', s.__sheets.keyword_log.rows.length === before, s.__sheets.keyword_log.rows.length);

console.log('== 원고 검수');
const text = ['반포 수학학원 고르는 법', '', '안녕하세요. 오늘은 수학학원 이야기입니다.', '[사진]', '우리 학원은 합격 보장 수업을 합니다. 전화는 02-1234-5678로 주세요.', '감사합니다.'].join('\n');
const r3 = call('review', { bizId, source: 'text', text, sponsored: 'yes', aiImages: 'person', postType: '업체 소개' }).data;
const t3 = r3.findings.map(f => f.title);
check('상호 없음 → 수정 필요', t3.includes('상호가 제목·첫 문단에 없음'), t3);
check('전화번호 다름 → 수정 필요', t3.includes('전화번호가 등록 정보와 다름'), t3);
check('주의 표현 "합격 보장"', t3.some(x => x.includes('합격 보장')), t3);
check('협찬 표기 없음', t3.includes('협찬·지원 표기 없음'), t3);
check('AI 가상인물 표시 없음', t3.includes('AI 가상인물 표시 없음'), t3);
check('원고에 [지도] 없음 → 권장', r3.findings.some(f => f.title === '지도(장소) 첨부' && f.status === '권장'));
check('사진 수는 원고 표시 기준', r3.findings.some(f => f.title === '사진 수' && /원고/.test(f.comment)));

console.log('== 캡처 검수');
const r4 = call('review', { bizId, source: 'capture', images: ['AAAA', 'BBBB'] }).data;
check('캡처 블록에 이미지 번호·좌표', r4.blocks.every(b => typeof b.img === 'number' && Array.isArray(b.box)));
check('캡처 지도 이름 → 추가 확인', r4.findings.some(f => f.title === '지도 장소' && f.status === '추가 확인'), r4.findings.map(f => f.title));
check('캡처 화면 표시', r4.view === '실제 화면');

console.log('== 목록·수정');
const list = call('listReviews', { bizId }).data;
check('검수 목록 4개', list.length === 4, list.length);
check('코멘트 수정 저장', call('saveReview', { id: R.id, patch: { note: '확인함' } }).ok && call('getReview', { id: R.id }).data.note === '확인함');

console.log('== AI 한도');
const q = makeServer({ quota: true });
const qr = JSON.parse(q.doPost({ postData: { contents: JSON.stringify({ action: 'saveBiz', adminPw: 'admin1234', biz: { name: '반포필즈수학', placeUrl: '1895531946', phone: '02-595-2252' } }) } }).text).data;
const qq = JSON.parse(q.doPost({ postData: { contents: JSON.stringify({ action: 'review', adminPw: 'admin1234', bizId: qr, source: 'link', url: 'https://blog.naver.com/svtcarat99/224444068379' }) } }).text);
check('AI 한도여도 기계 검사 결과는 저장', qq.ok && /한도/.test(qq.data.aiError) && qq.data.findings.length > 0, qq);

console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
process.exit(fails ? 1 : 0);
