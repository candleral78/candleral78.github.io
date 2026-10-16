import fs from 'fs'; import vm from 'vm'; import http from 'http'; import crypto from 'crypto';
const props={GEMINI_API_KEY:'k',SHEET_ID:'s',ADMIN_PW:'admin1234',DAILY_LIMIT:'2'};
class Sheet{ constructor(){this.rows=[];this.maxCols=26}
  getLastRow(){return this.rows.length} getLastColumn(){return this.rows.reduce((a,r)=>Math.max(a,r.length),0)} getMaxColumns(){return this.maxCols}
  insertColumnsAfter(a,n){this.maxCols+=n} deleteRow(r){this.rows.splice(r-1,1)}
  getRange(r,c,nr,nc){ const sh=this; return { setNumberFormat(){return this}, getValues(){ const o=[]; for(let i=0;i<nr;i++){ const row=sh.rows[r-1+i]||[]; const x=[]; for(let j=0;j<nc;j++) x.push(row[c-1+j]===undefined?'':row[c-1+j]); o.push(x)} return o },
    setValues(v){ for(let i=0;i<nr;i++){ sh.rows[r-1+i]=sh.rows[r-1+i]||[]; for(let j=0;j<nc;j++){ const val=v[i][j]; if(String(val).length>50000) throw new Error('cell over 50000'); sh.rows[r-1+i][c-1+j]=val } } return this } } } }
const sheets={}; const calls=[]; let quotaAll=false;
const BODY=["의정부 피부관리를 찾는 분께 먼저 답드리면, 진정 관리는 한 번으로도 당김이 줄지만 다온 피부관리실에서는 2주 간격 세 번을 권합니다.","## 민감성 피부관리, 한 번만 받아도 될까요?","한 번으로도 당김은 줄어듭니다. 다만 유지 기간이 짧습니다. 저희는 상담 때 피부 상태를 먼저 봅니다. 예민한 분은 간격을 넓힙니다. 예약은 네이버 예약으로 받습니다.","## 진정 관리 비용과 시간은요?","| 항목 | 내용 |","| 진정 관리 | 60분, 70,000원 |","순서는 상담 뒤 진행합니다. 클렌징을 합니다. 진정팩을 올립니다. 마무리합니다. 궁금한 점은 물어봐 주세요.","## 어디로 가면 되나요?","의정부역에서 걸어서 7분입니다. 건물 2층입니다. 화요일부터 토요일까지 엽니다. 네이버 예약이 편합니다. 주차는 문의해 주세요.","작성일: 2026년 10월 11일"].join("\n");
function fakeAI(prompt){ const J=o=>'```json\n'+JSON.stringify(o)+'\n```';
  if(prompt.includes('제목 3개')) return J({keyword:"의정부 피부관리",subs:["민감성 피부관리","진정 관리 비용"],card:{why:"문의가 늘어서",basis:"대표의 답",questions:["한 번만 받아도 되나요?"],diff:"",need:[]},titles:[{type:"질문형",title:"의정부 피부관리, 진정 관리 한 번만 받아도 될까요?",query:"진정 관리"},{type:"키워드형",title:"의정부 피부관리 진정 관리 안내",query:"의정부 피부관리"}]});
  if(prompt.includes('물어볼 질문')) return J([{q:"진정 관리는 어떤 순서인가요?",ph:"예: ..",prefill:""}]);
  if(prompt.includes('hashtags')) return J({hashtags:Array.from({length:30},(_,i)=>"태그"+i),priority:12,related:[]});
  if(prompt.includes('고객의 목소리가 담긴 자료')) return J({kind:"플레이스 리뷰",count:5,facts:["주차 1대"],liked:["친절"],concerns:["주차 부족"],notable:[],questions:["예약 없이 가도 되나요?"],aspects:[{k:"친절",n:4}],words:[{k:"민감성피부",n:3}]});
  if(prompt.includes('topQuestions')) return J({conflicts:[],topQuestions:["예약 없이 가도 되나요?"],ideas:[{type:"이용 안내형",title:"처음 오시는 분께 예약과 주차 안내",why:"문의 반복"}]});
  if(prompt.includes('이미지를 만들기 위한')) return J([{use:"절차",type:"인포그래픽",place:"둘째 소제목",prompt:"3단...",note:"확인"}]);
  if(prompt.includes('플레이스 화면 캡처이거나')) return J({name:"다온 피부관리실",category:"피부관리실",address:"경기 의정부시 예시로 12",hours:"",contact:"",menu:"",area:"",type:"store"});
  if(prompt.includes('주제 5개')) return J(["주제A","주제B"]);
  return BODY; }
const ctx={ console, JSON, Math, Date, String, Number, Error, encodeURIComponent,
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>k in props?props[k]:null})},
  ContentService:{MimeType:{JSON:'json'},createTextOutput:t=>({setMimeType(){return this},text:t})},
  SpreadsheetApp:{openById:()=>({getSheetByName:n=>sheets[n]||null,insertSheet:n=>(sheets[n]=new Sheet())})},
  LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})},
  Utilities:{DigestAlgorithm:{SHA_256:1},Charset:{UTF_8:1},computeDigest:(a,s)=>[...crypto.createHash('sha256').update(s,'utf8').digest()].map(b=>b>127?b-256:b),formatDate:(d)=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(d)},
  UrlFetchApp:{fetch:(url,o)=>{ const model=decodeURIComponent(url.split('/models/')[1].split(':')[0]); const body=JSON.parse(o.payload); const parts=body.contents[0].parts; const prompt=parts[parts.length-1].text; calls.push(model+':'+(parts.length-1)+'img');
    if(quotaAll||model==='gemini-3.8-flash') return {getResponseCode:()=>429,getContentText:()=>'{}'};
    return {getResponseCode:()=>200,getContentText:()=>JSON.stringify({candidates:[{content:{parts:[{text:fakeAI(prompt)}]},finishReason:'STOP'}]})} }},
  Logger:{log:console.log} };
vm.createContext(ctx); vm.runInContext(fs.readFileSync(new URL('../src/Code.gs',import.meta.url),'utf8'),ctx);
http.createServer((req,res)=>{ let b=''; req.on('data',d=>b+=d); req.on('end',()=>{ res.setHeader('Access-Control-Allow-Origin','*');
  if(req.url==='/__calls'){ res.end(JSON.stringify({calls,tabs:Object.fromEntries(Object.entries(sheets).map(([k,v])=>[k,v.rows.length-1]))})); return }
  if(req.url==='/'||req.url.startsWith('/?')){ res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(fs.readFileSync(new URL('./app-test.html',import.meta.url))); return }
  if(req.url==='/__quota'){ quotaAll=true; res.end('ok'); return }
  const out=req.method==='POST'?ctx.doPost({postData:{contents:b}}):ctx.doGet(); res.setHeader('Content-Type','application/json'); res.end(out.text) }) }).listen(8787,()=>console.log('mock up'));
