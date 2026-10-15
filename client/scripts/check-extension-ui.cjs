const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const baseUrl = process.env.EXTENSION_TEST_URL || 'http://localhost:1420';
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseUrl);
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: '설정 · 확장', exact: true }).click();
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples/extensions/ui-workbench.json'), 'utf8'));
    await page.locator('input[type=file][accept="application/json,.json"]').setInputFiles({ name: 'workbench.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pkg)) });
    await page.getByRole('button', { name: '비활성 상태로 가져오기', exact: true }).click();
    await page.getByRole('button', { name: '설치된 확장 보기', exact: true }).click();
    const card = page.getByRole('article', { name: pkg.manifest.name });
    await card.getByRole('switch', { name: `${pkg.manifest.name} 사용`, exact: true }).click();
    await card.locator('[role=switch][aria-checked=true], .callout.danger').first().waitFor();
    if (await card.locator('.callout.danger').count()) throw new Error(await card.textContent());
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    const initialSource = await (await page.request.get(`${baseUrl}/src/App.svelte`)).text();
    const hostUrl = initialSource.match(/from "([^"]*extensions\/host\.svelte\.ts[^\"]*)"/)[1];
    // Opening during async startup must survive the renderer's active-state filter.
    await page.evaluate(async url => {
      const { extensions } = await import(url);
      const id = extensions.install({ manifest: { id: 'test.ui-start', name: 'Startup panel', version: '1.0.0', sdkVersion: 1, permissions: ['ui'] }, code: `await sdk.ui.registerPanel({id:'startup',title:'Startup panel',view:{type:'stack',id:'probe',children:[{type:'text',id:'ready',text:'Startup open preserved'},{type:'button',id:'fail',label:'실패 재시도 검증'},{type:'form',id:'hidden-form',submitLabel:'숨은 필드 검증',children:[{type:'tabs',id:'hidden-tabs',items:[{id:'visible-tab',label:'기본',children:[{type:'text',id:'visible-text',text:'기본 화면'}]},{id:'required-tab',label:'추가',children:[{type:'input',id:'hidden-required',label:'숨은 필수값',required:true}]}]}]}]}},async()=>{throw new Error('의도한 처리 오류');}); await sdk.ui.open('startup'); await new Promise(r=>setTimeout(r,100));` });
      await extensions.enable(id);
    }, hostUrl);
    await page.getByRole('dialog').getByText('Startup open preserved', { exact: true }).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: '실패 재시도 검증', exact: true }).click();
    await page.getByRole('dialog').getByText('의도한 처리 오류', { exact: true }).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: '실패 재시도 검증', exact: true }).click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('dialog button')).some(button => button.textContent === '실패 재시도 검증' && !button.disabled));
    await page.getByRole('dialog').getByRole('button', { name: '숨은 필드 검증', exact: true }).click();
    await page.getByRole('dialog').getByRole('textbox', { name: '숨은 필수값', exact: true }).waitFor();
    if (!(await page.getByRole('dialog').getByRole('textbox', { name: '숨은 필수값', exact: true }).evaluate(el => el === document.activeElement))) throw new Error('Invalid hidden field did not receive focus');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: /확장 화면/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: /초안 워크벤치/ }).click();
    const dialog = page.getByRole('dialog');
    const fieldBounds = await dialog.getByRole('textbox', { name: '작업 목표' }).evaluate(input => ({ field: input.parentElement.getBoundingClientRect().height, control: input.getBoundingClientRect().height, font: getComputedStyle(input).fontSize }));
    if (fieldBounds.field <= fieldBounds.control || Number.parseFloat(fieldBounds.font) < 16) throw new Error('Field layout collision or mobile-zoom font regression');
    await dialog.getByRole('textbox', { name: '작업 목표' }).fill('접근성 개선');
    await dialog.getByRole('textbox', { name: '추가 제약 및 참고' }).fill('키보드 지원과 오류 표시');
    await dialog.getByRole('textbox', { name: '추가 제약 및 참고' }).press('Tab');
    await dialog.getByRole('tab', { name: '검토 체크리스트' }).click();
    await dialog.getByRole('table', { name: '확장 권한의 경계' }).waitFor();
    await dialog.getByRole('tab', { name: '검토 체크리스트' }).press('ArrowLeft');
    await dialog.getByRole('textbox', { name: '작업 목표' }).waitFor();
    if (await dialog.getByRole('textbox', { name: '작업 목표' }).inputValue() !== '접근성 개선') throw new Error('Tab switch lost draft');
    await dialog.getByRole('button', { name: '입력창에 초안 넣기', exact: true }).click();
    await dialog.getByText('초안을 입력창에 넣었습니다. 전송 전에 내용을 확인하세요.', { exact: true }).waitFor();
    // Update kept the panel and selected tab mounted, with authored values.
    if (await dialog.getByRole('textbox', { name: '작업 목표' }).inputValue() !== '접근성 개선') throw new Error('UI update lost draft');
    await dialog.getByRole('button', { name: '저장 초안 초기화', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('dialog input')?.value === '');
    await dialog.getByRole('button', { name: '입력창에 초안 넣기', exact: true }).click();
    await dialog.getByText('필수 항목입니다.', { exact: true }).waitFor();
    if (!(await dialog.getByRole('textbox', { name: '작업 목표' }).getAttribute('aria-invalid'))) throw new Error('Invalid field lacks aria-invalid');
    // Native modal focus trap and Escape return focus to the launcher.
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      if (!(await page.evaluate(() => !!document.activeElement?.closest('dialog')))) throw new Error('Focus escaped dialog');
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    // Composer widgets mount only when the ordinary client composer is available.
    const source = await (await page.request.get(`${baseUrl}/src/App.svelte`)).text();
    const storeUrl = source.match(/from "([^"]*store\.svelte\.ts[^\"]*)"/)[1];
    await page.evaluate(async url => {
      const { app } = await import(url);
      app.servers = [{ id: 'qa', name: 'QA', baseUrl: 'http://localhost:8787', token: '' }];
      app.net = 'online';
    }, storeUrl);
    await page.getByText('빠른 요청 메모', { exact: true }).click();
    await page.getByRole('textbox', { name: '요청 메모', exact: true }).fill('작업 진행을 요약해 주세요.');
    await page.getByRole('button', { name: '초안으로 사용', exact: true }).click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('textarea')).some(el => el.value === '작업 진행을 요약해 주세요.' && !el.closest('details')), undefined, { timeout: 5000 }).catch(async cause => {
      console.error(await page.evaluate(() => ({ textareas: Array.from(document.querySelectorAll('textarea')).map(el => ({value:el.value, details:!!el.closest('details')})), body:document.body.innerText.slice(-3000) })));
      throw cause;
    });
    await page.getByRole('button', { name: /확장 화면/ }).click();
    if (process.env.EXTENSION_TEST_SCREENSHOTS) {
      fs.mkdirSync(process.env.EXTENSION_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.EXTENSION_TEST_SCREENSHOTS, 'extension-desktop.png') });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Mobile page overflow');
    const bounds = await dialog.boundingBox();
    if (!bounds || bounds.x < 0 || bounds.x + bounds.width > 390 || bounds.height > 844) throw new Error('Mobile dialog overflow');
    if (process.env.EXTENSION_TEST_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.EXTENSION_TEST_SCREENSHOTS, 'extension-mobile.png') });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('tab', { name: /^확장/ }).click();
    await page.getByRole('button', { name: '고급' }).click();
    await page.getByRole('switch', { name: '모든 확장 실행 중지', exact: true }).click({ timeout: 5000 }).catch(async cause => { console.error((await page.locator('body').innerText()).slice(-5000)); throw cause; });
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    if (await page.getByRole('button', { name: /확장 화면/ }).count()) throw new Error('Safe mode retained panel launcher');
    if (await page.locator('iframe').count()) throw new Error('Orphan Worker sandbox');
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('PASS: UI activation/startup open, real Worker events, error/retry, tabs/draft/update/reset, required field errors, modal keyboard/focus, composer widget, mobile bounds, safe-mode teardown');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
