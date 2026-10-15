// Optional browser QA: NODE_PATH=/tmp/pipaya-extension-browser/node_modules node scripts/check-session-context.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const baseUrl = process.env.CONTEXT_TEST_URL || 'http://localhost:1420';
const snapshot = {
 cwd:'/workspace/project', state:'applied', capturedAt:1000,
 systemPrompt:'Base prompt', effectiveSystemPrompt:'Base prompt',
 instructions:[
  {path:'/home/me/.agents/AGENTS.md',scope:'global',content:'Global rule.',bytes:12},
  {path:'/workspace/project/AGENTS.md',scope:'cwd',content:'Keep tests green.\n<script>window.contextXss = true</script>',bytes:67},
 ],
 warnings:[{path:'/AGENTS.md',message:'File exceeds the instruction limit; skipped.'}],
 tools:['read','bash'], readFiles:[],
};
(async()=>{
 const browser = await chromium.launch({headless:true});
 try {
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  let mode='applied', calls=0, releaseSlow, slowStarted;
  const slowRequest = new Promise(resolve => slowStarted=resolve);
  await page.route('**/sessions/test-session/context',async route=>{
   calls++;
   if(mode==='slow'){ const hold=new Promise(r=>releaseSlow=r); slowStarted(); await hold; }
   if(mode==='error') return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:{code:'not_found',message:'route not found'}})});
   await route.fulfill({json:mode==='preview'?{...snapshot,state:'preview',capturedAt:null,instructions:[],warnings:[]}:snapshot});
  });
  await page.goto(baseUrl);
  const source = await (await page.request.get(`${baseUrl}/src/App.svelte`)).text();
  const storeUrl = source.match(/from "([^"]*store\.svelte\.ts[^\"]*)"/)[1];
  await page.evaluate(async url=>{
   const {app} = await import(url);
   const {Api} = await import('/src/lib/api.ts');
   const {ChatState} = await import('/src/lib/chat.svelte.ts');
   app.servers=[{id:'context-test',name:'Context test',baseUrl:location.origin,token:'test'}];
   app.serverId='context-test'; app.net='online';
   app.api=new Api({baseUrl:location.origin,token:'test'});
   app.sessions=[{id:'test-session',title:'Context test',cwd:'/workspace/project',provider:'test',model:'test',thinkingLevel:'medium',systemPrompt:'Base prompt',tools:['read','bash'],approval:'ask',parentId:null,closed:false,createdAt:1000,updatedAt:1000}];
   app.activeId='test-session';
   const chat = new ChatState('test-session', app.api);
   chat.ready = true;
   app.chats = {'test-session': chat};
  },storeUrl);
  const opener=page.getByRole('button',{name:/context files/});
  // Footer shows the number of entries (system prompt + 2 AGENTS.md), not a navbar icon.
  await opener.waitFor();
  assert.equal((await opener.innerText()).replace(/\s+/g,' ').trim(),'3');
  assert.equal(await opener.getAttribute('aria-label'),'context files 3개');
  assert.equal(await page.getByRole('button',{name:'적용된 컨텍스트 보기'}).count(),0,'navbar file icon should be gone');
  await opener.click();
  const dialog=page.getByRole('dialog',{name:'적용된 컨텍스트',exact:true});
  await dialog.getByText('이 세션에 적용 중',{exact:true}).waitFor();
  // Everything applied is listed (system prompt + each AGENTS.md); tools and read trace are not.
  for (const removed of ['활성 도구','읽은 파일','SESSION CONTEXT']) assert.equal(await dialog.getByText(removed).count(),0,`${removed} should be removed`);
  assert.equal(await dialog.locator('details').count(),3,'system prompt + one collapsed entry per AGENTS.md');
  await dialog.getByText('시스템 프롬프트',{exact:true}).click();
  await dialog.locator('pre').filter({hasText:'Base prompt'}).waitFor();
  await dialog.getByText('시스템 프롬프트',{exact:true}).click();
  assert.equal(await dialog.locator('details[open]').count(),0,'entries start collapsed');
  await dialog.getByText('/home/me/.agents/AGENTS.md',{exact:true}).waitFor();
  await dialog.getByText('전역 AGENTS.md · 12 B',{exact:true}).waitFor();
  await dialog.getByText('프로젝트 AGENTS.md · 67 B',{exact:true}).waitFor();
  await dialog.getByText('File exceeds the instruction limit; skipped.').waitFor();
  await page.evaluate(async url=>{const {app}=await import(url);app.bindings.newChat='Mod+N';},storeUrl);
  await page.keyboard.press('Control+n');
  assert.equal(await page.evaluate(async url=>{const {app}=await import(url);return app.activeId;},storeUrl),'test-session','background shortcut switched session');
  // Clicking an entry reveals its content as plain text (never executed as HTML).
  await dialog.getByText('/workspace/project/AGENTS.md',{exact:true}).click();
  await dialog.locator('pre').filter({hasText:'window.contextXss'}).waitFor();
  assert.equal(await page.evaluate(()=>window.contextXss),undefined,'instruction content executed as HTML');
  const textRect=await dialog.locator('pre').filter({hasText:'window.contextXss'}).boundingBox();
  await page.mouse.move(textRect.x+12,textRect.y+12);
  await page.mouse.down();
  await page.mouse.move(5,textRect.y+12,{steps:8});
  await page.mouse.up();
  assert(await dialog.isVisible(),'drag selecting text dismissed dialog');
  // Dark mode uses the same token-based styling as the rest of the application.
  await page.evaluate(async url=>{const {app}=await import(url);app.setTheme('dark');},storeUrl);
  assert(await dialog.evaluate(el=>getComputedStyle(el).backgroundColor!=='rgb(255, 255, 255)'),'dark dialog stayed white');
  await page.screenshot({path:'/tmp/pipaya-session-context-dark.png'});
  await page.evaluate(async url=>{const {app}=await import(url);app.setTheme('light');},storeUrl);
  const box=await dialog.boundingBox();
  assert(Math.abs(box.x+box.width/2-640)<2,'desktop dialog is not horizontally centered');
  assert(box.y>=0 && box.y+box.height<=900,'desktop dialog is clipped vertically');
  await page.screenshot({path:'/tmp/pipaya-session-context-desktop.png'});
  // Modal focus cannot escape to the background, and Escape restores the opener.
  for(let i=0;i<10;i++){
   await page.keyboard.press('Tab');
   assert(await dialog.evaluate(el=>el.contains(document.activeElement)),'focus escaped dialog');
  }
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'hidden'});
  assert(await opener.evaluate(el=>el===document.activeElement),'focus was not restored');
  await opener.click();
  await dialog.getByText('이 세션에 적용 중',{exact:true}).waitFor();
  await page.mouse.click(5,10);
  await dialog.waitFor({state:'hidden'});
  mode='preview';
  await page.setViewportSize({width:390,height:844});
  await opener.click();
  await dialog.getByText('아직 적용 전 · 다음 메시지부터 적용돼요',{exact:true}).waitFor();
  await dialog.getByText('적용된 AGENTS.md가 없습니다.',{exact:false}).waitFor();
  assert(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),'mobile dialog overflow');
  await page.screenshot({path:'/tmp/pipaya-session-context-mobile.png'});
  mode='error';
  await dialog.getByRole('button',{name:'새로고침',exact:true}).click();
  await dialog.getByRole('alert').filter({hasText:'서버가 이 기능을 지원하지 않습니다'}).waitFor();
  mode='applied';
  await dialog.getByRole('button',{name:'다시 시도',exact:true}).click();
  await dialog.getByText('이 세션에 적용 중',{exact:true}).waitFor();
  // Late responses from a closed session must not reopen or update the old panel.
  mode='slow';
  await dialog.getByRole('button',{name:'새로고침',exact:true}).click();
  await slowRequest;
  await page.evaluate(async url=>{const {app}=await import(url);app.activeId=null;},storeUrl);
  await dialog.waitFor({state:'hidden'});
  releaseSlow();
  assert.equal(await opener.count(),0,'footer item remains on a new chat');
  assert.deepEqual(errors,[]);
  assert(calls>=4);
  console.log('PASS: simplified AGENTS.md list (global/cwd entries, collapsed, click to view), removed sections gone, warnings, preview/applied, plain-text escaping, refresh/error/retry, session switch, modal focus/Escape/restoration, centered desktop + mobile, no runtime errors');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
