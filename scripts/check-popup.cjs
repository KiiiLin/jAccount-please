const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../extension');
const output = path.resolve(__dirname, '../dist/preview');
fs.mkdirSync(output, { recursive: true });
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome'
  });
  try {
    async function mount(enabled, url) {
      const page = await browser.newPage({ viewport: { width: 300, height: 220 }, deviceScaleFactor: 2 });
      await page.setContent(read('popup.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, ''));
      await page.addStyleTag({ content: read('popup.css') });
      await page.evaluate(({ enabled, url }) => {
        let config = { enabled, retentionDays: 30 };
        window.chrome = {
          runtime: { async sendMessage(message) {
            if (message.type === 'status') return { ok: true, result: { config } };
            if (message.type === 'configure') {
              config = message.config;
              return { ok: true, result: { converted: 0, failed: 0, skipped: 0 } };
            }
          } },
          tabs: { async query() { return [{ url }]; } }
        };
      }, { enabled, url });
      await page.addScriptTag({ content: read('policy.js') });
      await page.addScriptTag({ content: read('popup.js') });
      await page.waitForFunction(() => !document.querySelector('#toggle').disabled);
      return page;
    }

    const page = await mount(true, 'https://mail.sjtu.edu.cn/');
    assert.equal(await page.locator('button, input, select, a').count(), 1);
    assert.equal(await page.locator('#status').textContent(), '当前网页已生效');
    assert.equal(await page.locator('#toggle').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('.power').evaluate(e => getComputedStyle(e, '::before').animationName), 'breathe');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(output, 'enabled.png') });
    await page.locator('#toggle').click();
    await page.waitForFunction(() => !document.querySelector('#toggle').disabled);
    assert.equal(await page.locator('#toggle').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#status').textContent(), '当前网页未启用');
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(output, 'disabled.png') });
    await page.locator('#toggle').click();
    await page.waitForFunction(() => !document.querySelector('#toggle').disabled);
    assert.equal(await page.locator('#status').textContent(), '当前网页已生效');

    const other = await mount(true, 'https://example.com/');
    assert.equal(await other.locator('#status').textContent(), '当前网页未生效');
    const unknown = await mount(true, undefined);
    assert.equal(await unknown.locator('#status').textContent(), '当前网页未生效');
    console.log(JSON.stringify({ result: 'passed', checks: ['single control', 'on/off toggle', 'current school page', 'other page', 'missing URL', 'animation', 'no overflow'], previews: output }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
