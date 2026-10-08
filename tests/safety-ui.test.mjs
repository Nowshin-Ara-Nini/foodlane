import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('account deletion and moderation screens explain irreversible actions without exposing credentials',async()=>{
  const require=createRequire(import.meta.url),wr=createRequire(require.resolve('wrangler/package.json'));
  await mkdir('.wrangler/safety-ui',{recursive:true});
  for(const [name,entry] of [['account','app/account/settings.tsx'],['moderation','app/admin/moderation-panel.tsx']]){
    const output=`.wrangler/safety-ui/${name}.mjs`;
    await wr('esbuild').build({entryPoints:[entry],bundle:true,outfile:output,format:'esm',platform:'node',packages:'external',jsx:'automatic',alias:{'next/link':'next/link.js'}});
    const {default:Component}=await import(pathToFileURL(resolve(output)));
    const html=renderToStaticMarkup(React.createElement(Component,name==='account'?{name:'Sample User',phone:'+8801712345678',email:'sample@example.com',image:null}:{onChange:()=>{}}));
    assert.doesNotMatch(html,/localStorage|session_token|digest|object_key/);
    if(name==='account'){assert.match(html,/Edit your profile/);assert.match(html,/Mobile number/);assert.match(html,/Change profile photo/);assert.match(html,/Type DELETE to confirm permanent account deletion/);assert.match(html,/Why are you deleting your account/);assert.match(html,/Minimal audit records remain/);assert.match(html,/nowshinaranini@gmail.com/);assert.doesNotMatch(html,/confirmation code|10 minutes/i);}
    else{assert.match(html,/Reports &amp; suspensions/);assert.match(html,/Report text is private to admins/);}
  }
});
