import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Real Chromium interaction with production components; API responses are test doubles.
// Server authorization and deletion semantics are separately covered by roles.test.mjs.
test('account deletion and moderation browser interactions handle failures and pending cleanup', { timeout: 600000 }, async (t) => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.wrangler/pw-browsers');
  const { chromium, expect } = await import('@playwright/test');
  const require = createRequire(import.meta.url);
  const wr = createRequire(require.resolve('wrangler/package.json'));
  await mkdir('.wrangler/safety-browser', { recursive: true });
  const outfile = resolve('.wrangler/safety-browser/components.js');
  await wr('esbuild').build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import Account from './app/account/settings'; import Moderation from './app/admin/moderation-panel'; import Accounts from './app/admin/accounts-panel';
      createRoot(document.getElementById('root')).render(location.pathname==='/account'
        ? <Account name='Test User' phone='+880 1712 345678' email='test@example.com' image={null}/> : location.pathname==='/admin/accounts' ? <Accounts onChange={()=>{}}/> : <Moderation onChange={()=>{}}/>);`, resolveDir: process.cwd(), loader: 'tsx' },
    outfile, bundle: true, platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'test-link', setup(build) {
      build.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'test-link' }));
      build.onLoad({ filter: /.*/, namespace: 'test-link' }, () => ({
        contents: 'import React from "react"; export default function Link(props){return React.createElement("a",props)}',
        resolveDir: process.cwd(),
      }));
    } }],
  });
  const script = await readFile(outfile, 'utf8');
  t.diagnostic('Production components bundled for browser checks.');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    t.diagnostic('Chromium page ready.');
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let deleteAttempts = 0, decisions = 0, accountDecisions=0;
    await page.route('http://foodlane.test/**', async route => {
      const url = new URL(route.request().url());
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/components.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname === '/api/account/delete') {
        assert.deepEqual(route.request().postDataJSON(), { confirmation: 'DELETE', reason: 'privacy' });
        deleteAttempts++;
        return json({ filesPending: 2 }, 202);
      }
      if(url.pathname==='/api/admin/accounts')return json({accounts:[{id:'buyer-test',name:'Test buyer',email:'buyer@example.test',role:'buyer',account_status:'active',ban_reason:null}],page:1,total:1,hasMore:false});
      if(url.pathname==='/api/admin/cleanup')return json({health:null,accounts:{pending:0,retrying:0},files:{pending:0,retrying:0}});
      if(url.pathname==='/api/admin/accounts/decision'){
        const body=route.request().postDataJSON();assert.equal(body.userId,'buyer-test');accountDecisions++;
        if(body.action==='ban')return json({error:'Account status changed. Refresh and try again.'},409);
        assert.equal(body.action,'delete');assert.equal(body.confirmation,'DELETE buyer-test');return json({dataDeleted:false,deletionPending:true,filesPending:null},202);
      }
      if (url.pathname === '/api/admin/reports') return json({
        reports: [{ id: 'report-test', seller_id: 'seller-test', seller_name: 'Test seller', reason: 'Test abuse report content', created: '2026-01-01T00:00:00Z' }],
        suspensions: [], hasMore: false,
      });
      if (url.pathname === '/api/admin/reports/decision') {
        assert.deepEqual(route.request().postDataJSON(), { id: 'report-test', action: 'suspend', reason: 'Confirmed test report reason' });
        decisions++;
        return json({ error: 'Report already resolved or unavailable.' }, 409);
      }
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script src="/components.js"></script></body></html>' });
    });
    await page.goto('http://foodlane.test/account');
    await expect(page.getByLabel('Email confirmation code')).toHaveCount(0);
    await page.getByLabel('Why are you deleting your account? (optional)').selectOption('privacy');
    await page.getByLabel('Type DELETE to confirm permanent account deletion').fill('DELETE');
    await page.getByRole('button', { name: 'Permanently delete my account' }).click();
    await expect(page.getByRole('status')).toContainText('2 file deletion job(s) are still pending');
    await expect(page.getByRole('button', { name: 'Permanently delete my account' })).toHaveCount(0);
    assert.equal(deleteAttempts,1);
    await page.goto('http://foodlane.test/admin');
    await expect(page.getByText('Test abuse report content')).toBeVisible();
    await page.getByLabel('Decision reason').fill('Confirmed test report reason');
    await page.getByRole('button', { name: 'Suspend seller' }).click();
    await expect(page.getByRole('alert')).toContainText('Report already resolved');
    await expect(page.getByRole('button', { name: 'Suspend seller' })).toBeEnabled();
    assert.equal(decisions, 1);
    await page.goto('http://foodlane.test/admin/accounts');
    await expect(page.getByText('Test buyer',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Ban account',exact:true}).click();
    await page.getByLabel('Moderation reason').fill('Repeated violation of Foodlane rules');
    await page.getByRole('button',{name:'Confirm ban',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('Account status changed');
    await expect(page.getByRole('button',{name:'Confirm ban',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'Cancel action'}).click();
    await page.getByRole('button',{name:'Delete account',exact:true}).click();
    await page.getByLabel('Moderation reason').fill('Repeated violation of Foodlane rules');
    await expect(page.getByRole('button',{name:'Confirm permanent deletion'})).toBeDisabled();
    await page.getByLabel('Type DELETE buyer-test to confirm').fill('DELETE buyer-test');
    await page.getByRole('button',{name:'Confirm permanent deletion'}).click();
    await expect(page.getByRole('status').filter({hasText:'Account access is disabled'})).toContainText('Permanent deletion is queued');assert.equal(accountDecisions,2);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
