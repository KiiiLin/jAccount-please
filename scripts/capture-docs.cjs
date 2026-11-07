const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const extension = path.resolve(__dirname, '../extension');
const docs = path.resolve(__dirname, '../docs');

async function note(page, box, text, side) {
  await page.evaluate(({ box: b, text, side }) => {
    const layer = document.createElement('div');
    layer.style.cssText = 'pointer-events:none;position:fixed;inset:0;z-index:2147483647';
    const ring = document.createElement('div');
    ring.style.cssText = `position:absolute;left:${b.x-4}px;top:${b.y-4}px;width:${b.width+8}px;height:${b.height+8}px;box-sizing:border-box;border:2px solid #00865b;border-radius:9px`;
    const label = document.createElement('div');
    label.textContent = text;
    label.style.cssText = 'position:absolute;background:#075c45;color:white;font:600 14px/22px "Microsoft YaHei",sans-serif;padding:4px 10px;border-radius:6px;white-space:nowrap;';
    label.style.top = (b.y + b.height + (side === 'right' ? 54 : 22)) + 'px';
    if (side === 'right') label.style.right = Math.max(12, innerWidth - b.x - b.width) + 'px';
    else label.style.left = Math.max(8,b.x-4) + 'px';
    const line = document.createElement('div');
    line.style.cssText = `position:absolute;background:#00865b;width:2px;left:${b.x+b.width/2}px;top:${b.y+b.height+4}px;height:${side==='right'?51:19}px`;
    layer.append(ring, line, label);
    document.documentElement.append(layer);
  }, { box, text, side });
}

(async () => {
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chrome',
    headless: true, locale: 'zh-CN', viewport: { width: 1080, height: 680 }, deviceScaleFactor: 1.5,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--lang=zh-CN', '--disable-sync']
  });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('chrome://extensions/');
    const toolbar = page.locator('extensions-toolbar');
    const mode = toolbar.locator('#devMode');
    await mode.waitFor();
    if (await mode.getAttribute('aria-pressed') !== 'true' && await mode.getAttribute('aria-checked') !== 'true') {
      await mode.click();
    }
    const load = toolbar.locator('#loadUnpacked');
    await load.waitFor();
    await load.scrollIntoViewIfNeeded();
    await page.waitForTimeout(450);
    const modeBox = await mode.boundingBox(), loadBox = await load.boundingBox();
    await page.evaluate(y => {
      const clean = document.createElement('div');
      clean.style.cssText = 'position:fixed;left:0;right:0;bottom:0;background:#fff;z-index:2147483646;top:'+y+'px';
      document.documentElement.append(clean);
    }, Math.ceil((await toolbar.boundingBox()).height));
    await note(page, modeBox, '① 开启开发者模式', 'right');
    await note(page, loadBox, '② 点击此处，选择解压后的插件文件夹', 'left');
    await page.screenshot({path:path.join(docs,'install.png'), clip:{x:0,y:0,width:1080,height:Math.ceil(Math.max(loadBox.y+loadBox.height+93,modeBox.y+modeBox.height+112,220))}});
    console.log('Captured native chrome://extensions controls.');
  } finally { await ctx.close(); }
  const edge = await chromium.launchPersistentContext('', {
    channel: 'msedge',
    headless:true, locale:'zh-CN', deviceScaleFactor:2,
    ignoreDefaultArgs:['--disable-extensions'],
    args:['--load-extension='+extension, '--disable-extensions-except='+extension, '--disable-sync']
  });
  try {
    const worker = edge.serviceWorkers()[0] || await edge.waitForEvent('serviceworker',{timeout:8000});
    const id = new URL(worker.url()).hostname;
    const popup = await edge.newPage();
    await popup.goto('chrome-extension://'+id+'/popup.html');
    const campus = await edge.newPage();
    // Only the tab origin is needed for the popup's on-page indicator.
    await campus.route('https://mail.sjtu.edu.cn/**', r => r.fulfill({contentType:'text/html',body:'<title>SJTU</title>'}));
    await campus.goto('https://mail.sjtu.edu.cn/');
    await campus.bringToFront();
    await popup.reload();
    await popup.waitForFunction(() => document.querySelector('#status').textContent === '当前网页已生效');
    await popup.waitForTimeout(500);
    await popup.locator('main').screenshot({path:path.join(docs,'popup.png')});
    console.log('Captured the installed extension popup with its live status.');
  } finally { await edge.close(); }
})().catch(e => { console.error(e.message); process.exitCode=1; });
