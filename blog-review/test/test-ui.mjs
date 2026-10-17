// 화면 시험: 가짜 서버를 켜고 브라우저로 들어가기 → 업체 등록 → 링크 검수 → 첨삭지 → 고치기 → 이미지 저장 → 기록.
// 실행: cd blog-review/test && python3 ../src/build.py --test && node test-ui.mjs   (화면 캡처는 shots/에 저장)
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import fs from 'fs';

const srv = spawn('node', ['mock-server.mjs'], { cwd: new URL('.', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(ok => srv.stdout.on('data', d => String(d).includes('mock up') && ok()));
fs.mkdirSync(new URL('./shots/', import.meta.url), { recursive: true });
const shot = n => decodeURIComponent(new URL(`./shots/${n}.png`, import.meta.url).pathname);

let fails = 0;
function check(name, cond) { console.log((cond ? '  통과 ' : '  실패 ') + name); if (!cond) fails++; }
const browser = await chromium.launch(Object.assign({ env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } }, fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}));
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  // 네이버 사진이 이 화면에서 막히는 경우(대표님 브라우저)를 흉내 냅니다 → 서버로 받아 넣어야 합니다.
  await page.route(/pstatic\.net/, r => r.request().resourceType() === 'image' ? r.abort() : r.continue());
  await page.goto('http://localhost:8788/');

  console.log('== 들어가기');
  await page.fill('#pw', 'wrong'); await page.click('#loginBtn');
  await page.waitForSelector('#loginStatus.err'); check('틀린 암호 안내', /맞지 않/.test(await page.textContent('#loginStatus')));
  await page.fill('#pw', 'admin1234'); await page.click('#loginBtn');
  await page.waitForSelector('#tabs:not([hidden])'); check('탭이 보임', true);

  console.log('== 업체 등록');
  await page.click('[data-tab=biz]'); await page.click('#bizNew');
  await page.setInputFiles('#bzCap', { name: 'place.png', mimeType: 'image/png', buffer: fs.readFileSync(new URL('../../blog-writer/test/sample-card.png', import.meta.url)) });
  await page.waitForFunction(() => document.querySelector('#bzPhone').value === '02-595-2252');
  check('플레이스 캡처로 전화·주소 채움', (await page.inputValue('#bzAddr')).includes('신반포로'));
  await page.selectOption('#bzInd', '학원·교육');
  await page.fill('#bzPlace', 'https://map.naver.com/p/search/%EB%B0%98%ED%8F%AC/place/1895531946?c=15');
  await page.fill('#bzBlog', 'https://blog.naver.com/svtcarat99');
  const kws = await page.$$('#kwRows .kw'); await kws[1].fill('반포 수학학원');
  await page.click('#kwAdd'); const kws2 = await page.$$('#kwRows .kw'); await kws2[2].fill('잠원동 수학학원');
  await page.screenshot({ path: shot('1-업체등록'), fullPage: true });
  await page.click('#bzSave'); await page.waitForFunction(() => /저장했습니다/.test(document.querySelector('#bzStatus').textContent));
  check('업체 목록에 표시', (await page.textContent('#bizList')).includes('반포필즈수학'));

  console.log('== 링크 검수');
  await page.click('[data-tab=review]');
  await page.fill('#rvUrl', 'https://blog.naver.com/svtcarat99/224444068379');
  await page.fill('#rvKw', '반포 초등수학'); await page.selectOption('#rvType', '정보성');
  await page.check('input[name=sp][value=no]', { force: true }); await page.check('input[name=ai][value=no]', { force: true });
  await page.click('#rvGo');
  await page.waitForSelector('#sheet', { timeout: 120000 });
  const sheetText = await page.textContent('#sheet');
  check('맨 위 안내 문구', (await page.textContent('#opinion')).startsWith('이 첨삭지는 정답을 정해 드리는 것이 아니라'));
  check('요약: 꼭 고쳐 주실 것', /꼭 고쳐 주실 것 \d+건/.test(sheetText));
  check('핵심 키워드 표', (await page.$$('.kwtable tbody tr')).length === 4);
  check('태그 없음 표시', /태그 없음/.test(sheetText));
  check('체크리스트 ❌ 표시', (await page.$$('.check .st.no')).length >= 1);
  await page.waitForFunction(() => { const f = document.querySelector('.nview'); return f && f.shadowRoot && f.shadowRoot.querySelectorAll('.br-no').length > 0; }, null, { timeout: 30000 }).catch(() => {});
  const boxes = await page.evaluate(() => { const f = document.querySelector('.nview'); return f && f.shadowRoot ? f.shadowRoot.querySelectorAll('.br-no').length : 0; });
  check('네이버 화면 위에 빨간 번호 상자 (' + boxes + '개)', boxes >= 2);
  await page.waitForFunction(() => { const f = document.querySelector('.nview'); return f && [...f.shadowRoot.querySelectorAll('img')].some(i => i.src.startsWith('data:') && i.naturalWidth > 0); }, null, { timeout: 60000 }).catch(() => {});
  const viaSrv = await page.evaluate(() => [...document.querySelector('.nview').shadowRoot.querySelectorAll('img')].filter(i => i.src.startsWith('data:') && i.naturalWidth > 0).length);
  check('막힌 네이버 사진을 서버로 받아 표시 (' + viaSrv + '장)', viaSrv >= 3);
  check('먼저 고칠 것 3개', (await page.$$('.firsts li')).length === 3);
  check('추천 해시태그와 모두 복사', (await page.$$('.chips .chip')).length >= 5 && !!(await page.$('button.copy[data-copy^="#반포필즈수학"]')));
  check('AI 검색 대비 점검', (await page.$$('.aich li')).length === 3);
  check('다음 글 추천', (await page.$$('.nexts li')).length === 2);
  const mapCard = await page.$('.card:has(h4:text("지도에 다른 장소가 연결됨"))');
  check('지도 카드와 근거 링크 2개', !!mapCard && (await mapCard.$$('.evid a')).length === 2);
  check('편집 표시 카드', /편집 표시가 글자로 남음/.test(sheetText));
  check('잘된 점', /잘된 점/.test(sheetText));
  check('고치는 방법 목록', (await page.$$('.card .how li')).length >= 4);
  check('이노브웨이 표시 없음', !/이노브웨이/.test(sheetText));
  const ours = (await page.$$eval('.comment, .sugg, .good li, .opinion', els => els.map(e => e.textContent).join(' ')));
  check('코멘트에 "~하세요" 없음', !/[가-힣]하세요/.test(ours.replace(/안녕하세요/g, '')));
  await page.screenshot({ path: shot('2-첨삭지'), fullPage: true });

  console.log('== 문장 고치기 (끝내면 자동 저장)');
  check('버튼은 PDF 다운로드·문장 고치기 둘', !(await page.$('#pngBtn')) && !(await page.$('#saveBtn')) && !!(await page.$('#pdfBtn')));
  await page.click('#edBtn');
  await page.waitForSelector('.comment[contenteditable=true]');
  await page.evaluate(() => { document.querySelector('#card-1 .comment').innerText = '대표님, 지도를 학원으로 다시 선택해 주세요.'; });
  const lastKeep = (await page.$$('.keep')).pop(); await lastKeep.uncheck();
  await page.click('#edBtn');
  await page.waitForFunction(() => /저장했습니다/.test(document.querySelector('#shStatus').textContent));
  check('고친 코멘트 반영·자동 저장', (await page.textContent('#card-1 .comment')).includes('다시 선택해 주세요'));

  console.log('== PDF');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#pdfBtn')]);
  const dlPath = shot('6-다운로드').replace('.png', '.pdf'); await dl.saveAs(dlPath);
  const dbuf = fs.readFileSync(dlPath), dpages = (dbuf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  check('PDF 바로 다운로드: ' + dl.suggestedFilename() + ' (' + dpages + '쪽, ' + Math.round(dbuf.length / 1024) + 'KB)', /^첨삭지_반포필즈수학_\d{4}-\d{2}-\d{2}\.pdf$/.test(dl.suggestedFilename()) && dpages >= 3 && dbuf.slice(0, 4).toString() === '%PDF');
  const ptxt = (await import('child_process')).execFileSync('pdftotext', [dlPath, '-']).toString();
  check('쪽 번호', ptxt.includes('1 / ' + dpages) && ptxt.includes(dpages + ' / ' + dpages));
  check('다운로드 안내 문구', /다운로드 폴더/.test(await page.textContent('#shStatus')));
  await page.evaluate(() => { document.querySelectorAll('#sheet details').forEach(d => d.open = true); document.body.classList.add('printing'); const v = document.querySelector('.nview'); if (v && v._draw) v._draw(); });
  await page.waitForTimeout(800);
  await page.emulateMedia({ media: 'print' });
  const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '11mm', right: '11mm' } });
  fs.writeFileSync(shot('5-첨삭지').replace('.png', '.pdf'), pdf);
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  check('PDF 여러 쪽 (' + pages + '쪽, ' + Math.round(pdf.length / 1024) + 'KB)', pages >= 3);
  await page.emulateMedia({ media: 'screen' }); await page.evaluate(() => document.body.classList.remove('printing'));

  console.log('== 기록');
  await page.click('[data-tab=history]'); await page.waitForSelector('#hsList button');
  await page.click('#hsList button'); await page.waitForSelector('#sheet');
  check('기록에서 다시 열면 고친 코멘트 유지', (await page.textContent('#card-1 .comment')).includes('다시 선택해 주세요'));

  console.log('== 휴대폰 폭');
  const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await m.goto('http://localhost:8788/'); await m.fill('#pw', 'admin1234'); await m.click('#loginBtn');
  await m.waitForSelector('#tabs:not([hidden])'); await m.click('[data-tab=history]'); await m.waitForSelector('#hsList button'); await m.click('#hsList button'); await m.waitForSelector('#sheet');
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('가로 넘침 없음 (' + overflow + 'px)', overflow <= 1);
  await m.screenshot({ path: shot('4-휴대폰'), fullPage: true });

  console.log('== 원고 검수');
  await page.click('[data-tab=review]'); await page.check('input[name=src][value=text]', { force: true });
  await page.fill('#rvText', '반포 수학학원 고르는 법\n\n안녕하세요. 오늘은 수학학원 이야기입니다.\n[사진]\n합격 보장 수업입니다. 전화 02-1234-5678\n감사합니다.');
  await page.click('#rvGo'); await page.waitForFunction(() => /원고/.test((document.querySelector('#sheet .meta') || {}).textContent || ''), null, { timeout: 120000 });
  const t2 = await page.textContent('#sheet');
  check('원고: 전화번호 다름', /전화번호가 등록 정보와 다름/.test(t2));
  check('원고: 재구성 화면 안내', /재구성 화면/.test(t2) && (await page.$$('.proof .mk')).length >= 1);

  check('화면 오류 없음 ' + JSON.stringify(errors), errors.length === 0);
} finally { await browser.close(); srv.kill(); }
console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
process.exit(fails ? 1 : 0);
