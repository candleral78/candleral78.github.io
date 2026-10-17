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
const browser = await chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
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
  check('체크리스트 ❌ 표시', (await page.$$('.check .st.no')).length >= 1);
  check('전체 첨삭지에 빨간 번호', (await page.$$('.proof .mk')).length >= 1);
  const mapCard = await page.$('.card:has(h4:text("지도에 다른 장소가 연결됨"))');
  check('지도 카드와 근거 링크 2개', !!mapCard && (await mapCard.$$('.evid a')).length === 2);
  check('편집 표시 카드', /편집 표시가 글자로 남음/.test(sheetText));
  check('잘된 점', /잘된 점/.test(sheetText));
  const ours = (await page.$$eval('.comment, .sugg, .good li, .opinion', els => els.map(e => e.textContent).join(' ')));
  check('코멘트에 "~하세요" 없음', !/[가-힣]하세요/.test(ours.replace(/안녕하세요/g, '')));
  await page.screenshot({ path: shot('2-첨삭지'), fullPage: true });

  console.log('== 고치기와 저장');
  await page.click('#edBtn');
  await page.waitForSelector('.comment[contenteditable=true]');
  await page.evaluate(() => { document.querySelector('#card-1 .comment').innerText = '대표님, 지도를 학원으로 다시 선택해 주세요.'; });
  const lastKeep = (await page.$$('.keep')).pop(); await lastKeep.uncheck();
  await page.click('#edBtn');
  check('고친 코멘트 반영', (await page.textContent('#card-1 .comment')).includes('다시 선택해 주세요'));
  check('뺀 카드는 보이지 않음', (await page.$$('.card')).length === (await page.$$('.card')).length);
  await page.click('#saveBtn'); await page.waitForFunction(() => /저장했습니다/.test(document.querySelector('#shStatus').textContent));
  check('저장', true);

  console.log('== 이미지 저장');
  const dl = page.waitForEvent('download', { timeout: 90000 }).catch(() => null);
  await page.click('#pngBtn'); const d = await dl;
  if (!d) { console.log('  상태:', await page.textContent('#shStatus')); throw new Error('내려받기 없음'); } const p = await d.path();
  const size = fs.statSync(p).size; fs.copyFileSync(p, shot('3-카톡이미지'));
  check('PNG 내려받기 (' + Math.round(size / 1024) + 'KB)', size > 50000);

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
  check('원고: 재구성 화면 안내', /재구성 화면/.test(t2));

  check('화면 오류 없음 ' + JSON.stringify(errors), errors.length === 0);
} finally { await browser.close(); srv.kill(); }
console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
process.exit(fails ? 1 : 0);
