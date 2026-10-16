// 사용: (blog-writer/test 폴더에서) npm install → python3 ../src/build.py --test → node mock-server.mjs & → node <이 파일>
import {chromium} from 'playwright'; import fs from 'fs';
process.chdir(new URL('.',import.meta.url).pathname);
const b=await chromium.launch({executablePath:process.env.CHROMIUM||undefined});
const map={'qrcode.min.js':'node_modules/qrcode-generator/qrcode.js','pdf.min.js':'node_modules/pdfjs-dist/build/pdf.min.js','pdf.worker.min.js':'node_modules/pdfjs-dist/build/pdf.worker.min.js','html2canvas.min.js':'node_modules/html2canvas/dist/html2canvas.min.js','jspdf.umd.min.js':'node_modules/jspdf/dist/jspdf.umd.min.js'};
const J=x=>console.log(JSON.stringify(x));
async function open(ctx,path='/'){ const p=await ctx.newPage(); await p.route('https://cdnjs.cloudflare.com/**',r=>{const k=r.request().url().split('/').pop();r.fulfill({body:fs.readFileSync(map[k]),contentType:'text/javascript'})});
  p.on('pageerror',e=>console.log('ERR',e.message)); await p.goto('http://localhost:8787'+path); await p.waitForTimeout(700); return p }
// 명함 자동 생성: 등록 시, 다른 기기, 예시 업체
const c1=await b.newContext({viewport:{width:420,height:900}}); const p=await open(c1);
await p.fill('#place-url','https://naver.me/Card7777'); await p.click('#btn-lookup'); await p.waitForTimeout(600);
await p.fill('#f-name','이로운제과'); await p.fill('#f-address','서울 광진구 뚝섬로32길 29'); await p.fill('#f-contact','0507-1354-5692'); await p.fill('#f-code','123456');
await p.click('#btn-biz-save'); await p.waitForTimeout(1500);
J(['saved',await p.evaluate(()=>[!document.getElementById('s2').hidden, !document.getElementById('card-prev-wrap').hidden])]);
await p.fill('#q-topic','비건쿠키'); await p.click('#btn-qs'); await p.waitForTimeout(700); await p.click('#btn-titles'); await p.waitForTimeout(700); await p.click('#btn-to-photo'); await p.click('#btn-write'); await p.waitForTimeout(3000);
J(['result',await p.evaluate(()=>[document.getElementById('card-box').hidden, !!document.getElementById('o-card').src, document.body.innerText.includes('명함 이미지 자리')])]);
// 다른 기기에서 코드로 열 때 명함이 서버에서 불러와지는지
const c2=await b.newContext({viewport:{width:420,height:900}}); const q=await open(c2);
await q.fill('#place-url','https://naver.me/Card7777'); await q.click('#btn-lookup'); await q.waitForTimeout(600); await q.fill('#code-in','123456'); await q.click('#btn-code'); await q.waitForTimeout(900);
J(['other device',await q.evaluate(()=>!document.getElementById('card-prev-wrap').hidden)]);
// 예시 업체도 자동
const c3=await b.newContext({viewport:{width:420,height:900}}); const e=await open(c3);
await e.click('#btn-example'); await e.waitForTimeout(500); await e.click('#btn-biz-yes'); await e.waitForTimeout(1200); J(['example',await e.evaluate(()=>document.getElementById('card-prev').getAttribute('src')?true:false)]);
await b.close();
