const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
// Optional browser QA dependency, intentionally not needed by bun test/build.
// npm install --prefix /tmp/harness-browser-qa playwright
// /tmp/harness-browser-qa/node_modules/.bin/playwright install chromium
// NODE_PATH=/tmp/harness-browser-qa/node_modules node scripts/check-extensions.cjs
const baseUrl = process.env.EXTENSION_TEST_URL || 'http://localhost:1420';
const example = name => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'extensions', name), 'utf8'));
(async () => {
 const browser = await chromium.launch({headless:true});
 const page = await browser.newPage();
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto(baseUrl);
 await page.waitForLoadState('networkidle');
 await page.getByRole('button',{name:'설정 · 확장',exact:true}).click();
 const moduleSource = await (await page.request.get(`${baseUrl}/src/App.svelte`)).text();
 const storeUrl = moduleSource.match(/from "([^"]*store\.svelte\.ts[^\"]*)"/)[1];
 const hostUrl = moduleSource.match(/from "([^"]*extensions\/host\.svelte\.ts[^\"]*)"/)[1];
 const file = page.locator('input[type=file][accept="application/json,.json"]');
 async function install(pkg) {
   await file.setInputFiles({name:'extension.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(pkg))});
   await page.getByRole('button',{name:'비활성 상태로 가져오기',exact:true}).click();
   await page.getByRole('button',{name:'설치된 확장 보기',exact:true}).click();
   const card=page.getByRole('article',{name:pkg.manifest.name});
   await card.getByRole('switch',{name:pkg.manifest.name+' 사용',exact:true}).click();
   // Settled = switched on, or an error callout; the spinner is gone either way.
   await card.locator('[role=switch][aria-checked=true], .callout.danger').first().waitFor();
   if(await card.locator('.callout.danger').count()) throw new Error('Activation failed: '+await card.textContent());
   return card;
 }
 await install(example('session-tools.json'));
 const probe={manifest:{id:'test.isolation',name:'Isolation probe',version:'1.0.0',sdkVersion:1,permissions:['status']},code:`
let result = [];
try { await sdk.context.get(); result.push('PERMISSION_FAIL'); } catch { result.push('permission-blocked'); }
try { localStorage.getItem('pipaya.servers'); result.push('STORAGE_FAIL'); } catch { result.push('storage-blocked'); }
try { await fetch('https://example.com'); result.push('NETWORK_FAIL'); } catch { result.push('network-blocked'); }
try { await import('https://example.com/x.js'); result.push('IMPORT_FAIL'); } catch { result.push('import-blocked'); }
result.push(typeof document === 'undefined' ? 'no-dom' : 'DOM_FAIL');
result.push(typeof __TAURI_INTERNALS__ === 'undefined' ? 'no-tauri' : 'TAURI_FAIL');
await sdk.log(result.join('|'));
await sdk.status.set('probe','Isolation passed');
`};
 await install(example('focus.json'));
 const card=await install(probe);
 // Extension logs are not rendered in the manager; read them from the host.
 await page.waitForFunction(async ([url,expected]) => {
   const {extensions}=await import(url);
   return extensions.logs.some(l=>l.owner==='test.isolation'&&l.text===expected);
 },[hostUrl,'permission-blocked|storage-blocked|network-blocked|import-blocked|no-dom|no-tauri'],{timeout:15000});
 await card.getByRole('switch',{name:'Isolation probe 사용',exact:true}).click();
 await card.locator('[role=switch][aria-checked=false]').waitFor();
 const timeout={manifest:{id:'test.timeout',name:'Timeout probe',version:'1.0.0',sdkVersion:1,permissions:[]},code:'await new Promise(() => {});'};
 await file.setInputFiles({name:'extension.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(timeout))});
 await page.getByRole('button',{name:'비활성 상태로 가져오기',exact:true}).click();
   await page.getByRole('button',{name:'설치된 확장 보기',exact:true}).click();
 const timeoutCard=page.getByRole('article',{name:'Timeout probe'});
 await timeoutCard.getByRole('switch',{name:'Timeout probe 사용',exact:true}).click();
 await timeoutCard.getByText('확장 시작 시간 초과',{exact:true}).waitFor({timeout:10000});
 // Exercise integration with the real composer/status UI without a live API server.
 await page.getByRole('button',{name:'닫기',exact:true}).click();
 await page.evaluate(async (url) => {
   const { app } = await import(url);
   app.servers = [{id:'test',name:'Test',baseUrl:'http://localhost:8787',token:''}];
   app.net='online';
 }, storeUrl);
 const composer=page.locator('textarea[placeholder]');
 await composer.fill('/review security');
 await composer.press('Enter');
 await page.waitForFunction(() => document.querySelector('textarea')?.value.includes('security'));
 if(!(await composer.inputValue()).includes('정확성·보안·테스트')) throw new Error('Declarative command did not prefill composer');
 await page.getByRole('button',{name:'요약 초안',exact:true}).click();
 await page.waitForFunction(() => document.querySelector('textarea')?.value.includes('진행 상황'));
 await page.getByText('초안 1회 · 모델 미선택',{exact:true}).waitFor();
 // A loop after startup is detected by heartbeat even without a command timeout.
 await page.evaluate(async (url) => {
   const { extensions } = await import(url);
   const id=extensions.install({manifest:{id:'test.heartbeat',name:'Heartbeat probe',version:'1.0.0',sdkVersion:1,permissions:[]},code:'setTimeout(() => { while (true) {} }, 100);'});
   await extensions.enable(id);
 }, hostUrl);
 await page.waitForFunction(async (url) => {
   const {extensions}=await import(url);
   return extensions.find('test.heartbeat').state==='error';
 },hostUrl,{timeout:16000});
 await page.evaluate(async (url) => { const {app}=await import(url); app.openSettings('extensions'); },storeUrl);
 await page.getByRole('button',{name:'고급'}).click();
 await page.getByRole('switch',{name:'모든 확장 실행 중지',exact:true}).click();
 if(await page.locator('iframe').count()) throw new Error('Orphan sandbox iframe');
 await page.reload();
 await page.getByRole('button',{name:'설정 · 확장',exact:true}).click();
 await page.getByRole('button',{name:'고급'}).click();
 if(await page.getByRole('switch',{name:'모든 확장 실행 중지',exact:true}).getAttribute('aria-checked')!=='true') throw new Error('Safe mode did not persist');
 if(errors.length) throw new Error('Page errors: '+errors.join('\n'));
 await page.setViewportSize({width:390,height:844});
 if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Mobile layout overflows');
 console.log('PASS: management, real Worker SDK, permissions, opaque-origin storage, network/import denial, DOM/Tauri denial, timeout teardown, composer command/action/status integration, heartbeat loop termination, safe mode persistence, no page errors');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
