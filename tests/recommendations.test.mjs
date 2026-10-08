import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
let rankings, Feedback;
before(async()=>{
  const require=createRequire(import.meta.url), wr=createRequire(require.resolve('wrangler/package.json'));
  await mkdir('.wrangler/recommendation-tests',{recursive:true});
  for(const [name,entry] of [['ranking','lib/discovery-ranking.ts'],['feedback','app/seller-feedback.tsx']]){
    const output='.wrangler/recommendation-tests/'+name+'.mjs';
    await wr('esbuild').build({entryPoints:[entry],bundle:true,outfile:output,format:'esm',platform:'node',packages:'external',jsx:'automatic',alias:{'next/link':'next/link.js'}});
    const compiled=await import(pathToFileURL(resolve(output)));
    if(name==='ranking')rankings=compiled;else Feedback=compiled.default;
  }
});
test('discovery ranks recommendations and interest independently, excluding samples and zero signals',()=>{
  const shops=[
    {seller_id:'liked',recommendation_count:7,interest_count:1,review_count:1},
    {seller_id:'noticed',recommendation_count:1,interest_count:9,review_count:50},
    {seller_id:'reviewed',recommendation_count:0,interest_count:0,review_count:100},
    {seller_id:'demo',recommendation_count:100,interest_count:100,demo:true},
  ];
  assert.deepEqual(rankings.mostRecommended(shops).map(s=>s.seller_id),['liked','noticed']);
  assert.deepEqual(rankings.mostInterested(shops).map(s=>s.seller_id),['noticed','liked']);
  assert.equal(shops[0].seller_id,'liked');
});
test('dish feedback is visible for samples and signed-out visitors with honest publishing restrictions',()=>{
  const sample=renderToStaticMarkup(React.createElement(Feedback,{sellerId:'sample',sample:true,role:'buyer'}));
  assert.match(sample,/Customer feedback/);assert.match(sample,/Recommend/);assert.match(sample,/Write your review/);
  assert.match(sample,/fieldset disabled/);assert.match(sample,/sample listing/);
  const guest=renderToStaticMarkup(React.createElement(Feedback,{sellerId:'real',role:'',returnTo:'/discover'}));
  assert.match(guest,/Sign in as a customer/);assert.match(guest,/returnTo=%2Fdiscover/);assert.match(guest,/Customer reviews/);
});
