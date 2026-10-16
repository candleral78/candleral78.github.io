// 사용: (blog-writer/test 폴더에서) npm install → python3 ../src/build.py --test → node mock-server.mjs & → node <이 파일>
import {chromium} from 'playwright'; import fs from 'fs';
process.chdir(new URL('.',import.meta.url).pathname);
const b=await chromium.launch({executablePath:process.env.CHROMIUM||undefined});
const map={'qrcode.min.js':'node_modules/qrcode-generator/qrcode.js','pdf.min.js':'node_modules/pdfjs-dist/build/pdf.min.js','pdf.worker.min.js':'node_modules/pdfjs-dist/build/pdf.worker.min.js','html2canvas.min.js':'node_modules/html2canvas/dist/html2canvas.min.js','jspdf.umd.min.js':'node_modules/jspdf/dist/jspdf.umd.min.js'};
const J=x=>console.log(JSON.stringify(x));
async function open(ctx,path='/'){ const p=await ctx.newPage(); await p.route('https://cdnjs.cloudflare.com/**',r=>{const k=r.request().url().split('/').pop();r.fulfill({body:fs.readFileSync(map[k]),contentType:'text/javascript'})});
  p.on('pageerror',e=>console.log('ERR',e.message)); await p.goto('http://localhost:8787'+path); await p.waitForTimeout(700); return p }
// 업체 등록, 코드 6자리, 5회 오류 잠금, 컨설턴트 코드 다시 정하기
// ---- 대표님 A: 새 업체 등록 ----
const c1=await b.newContext({viewport:{width:420,height:900},acceptDownloads:true}); const p=await open(c1);
J(['start',await p.evaluate(()=>[document.title,document.getElementById('ai-off').hidden,document.getElementById('saved-wrap').hidden])]);
await p.fill('#place-url','https://naver.me/AbCd1234'); await p.click('#btn-lookup'); await p.waitForTimeout(500);
J(['new',await p.textContent('#s1-status'),await p.evaluate(()=>[document.getElementById('biz-form').hidden,document.getElementById('f-code-wrap').hidden])]);
await p.setInputFiles('#cap-file','sample-card.png'); await p.click('#btn-cap'); await p.waitForFunction(()=>!document.getElementById('btn-cap').disabled); 
J(['cap',await p.inputValue('#f-name'),await p.textContent('#cap-status')]);
await p.click('#btn-card-make'); await p.waitForTimeout(700);
await p.fill('#f-code','4321'); await p.click('#btn-biz-save'); await p.waitForTimeout(400); J(['short',await p.textContent('#save-status')]);
await p.fill('#f-code','654321'); await p.click('#btn-biz-save'); await p.waitForTimeout(900);
J(['saved',await p.evaluate(()=>document.getElementById('s2').hidden)]);
const c2=await b.newContext({viewport:{width:420,height:900}}); const q=await open(c2);
await q.fill('#place-url','https://naver.me/AbCd1234'); await q.click('#btn-lookup'); await q.waitForTimeout(500);
for(let i=1;i<=5;i++){ await q.fill('#code-in','00000'+i); await q.click('#btn-code'); await q.waitForTimeout(400); J(['wrong'+i,await q.textContent('#s1-status')]); }
await q.fill('#code-in','654321'); await q.click('#btn-code'); await q.waitForTimeout(400); J(['right-while-locked',await q.textContent('#s1-status')]);
const c3=await b.newContext({viewport:{width:900,height:1000}}); const a=await open(c3,'/?c');
await a.click('#tab-cons'); await a.fill('#admin-pw','admin1234'); await a.click('#btn-admin'); await a.waitForTimeout(1200);
await a.click('#tab-admin'); await a.waitForTimeout(600);
J(['admin',await a.evaluate(()=>[document.getElementById('code-reset').hidden,[...document.getElementById('c-biz').options].map(o=>o.text)])]);
await a.evaluate(()=>{const s=document.getElementById('c-biz');s.value=[...s.options].find(o=>o.value&&o.value!=='example').value;s.dispatchEvent(new Event('change'))}); await a.waitForTimeout(500);
await a.fill('#reset-code','123'); await a.click('#btn-reset-code'); await a.waitForTimeout(300); J(['r-short',await a.textContent('#reset-status')]);
await a.fill('#reset-code','777888'); await a.click('#btn-reset-code'); await a.waitForTimeout(600); J(['reset',await a.textContent('#reset-status')]);
await q.fill('#code-in','654321'); await q.click('#btn-code'); await q.waitForTimeout(400); J(['old',await q.textContent('#s1-status')]);
await q.fill('#code-in','777888'); await q.click('#btn-code'); await q.waitForTimeout(700); J(['new ok',await q.evaluate(()=>[document.getElementById('biz-confirm').hidden,document.getElementById('code-box').hidden])]);
await b.close();
