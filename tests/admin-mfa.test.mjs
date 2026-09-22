import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const require=createRequire(import.meta.url),wr=createRequire(require.resolve('wrangler/package.json'));
test('TOTP matches all RFC 6238 SHA-1 test vectors, including times beyond 2038',async()=>{
  await mkdir('.wrangler/mfa-tests',{recursive:true});
  await wr('esbuild').build({entryPoints:['lib/admin-mfa.ts'],bundle:true,outfile:'.wrangler/mfa-tests/totp.mjs',format:'esm',platform:'node',external:['node:*']});
  const {base32,totp}=await import(pathToFileURL(resolve('.wrangler/mfa-tests/totp.mjs')));
  const secret=base32(new TextEncoder().encode('12345678901234567890'));
  for(const [time,code] of [[59,'94287082'],[1111111109,'07081804'],[1111111111,'14050471'],[1234567890,'89005924'],[2000000000,'69279037'],[20000000000,'65353130']])assert.equal(await totp(secret,Math.floor(time/30),8),code);
});
test('admin MFA screens offer enrollment or a required authenticator challenge without secrets in initial HTML',async()=>{
  await mkdir('.wrangler/mfa-tests',{recursive:true});
  await wr('esbuild').build({entryPoints:['app/admin/mfa/mfa-form.tsx'],bundle:true,outfile:'.wrangler/mfa-tests/form.mjs',format:'esm',platform:'node',packages:'external',alias:{'next/link':'next/link.js'},jsx:'automatic'});
  const {default:Form}=await import(pathToFileURL(resolve('.wrangler/mfa-tests/form.mjs')));
  const enrollment=renderToStaticMarkup(React.createElement(Form,{enrolled:false}));
  assert.match(enrollment,/Set up authenticator/);assert.doesNotMatch(enrollment,/otpauth:|Recovery codes|secret=/);
  const challenge=renderToStaticMarkup(React.createElement(Form,{enrolled:true}));
  assert.match(challenge,/Authenticator code/);assert.match(challenge,/pattern="\[0-9\]\{6\}"/);assert.match(challenge,/Use a recovery code/);assert.doesNotMatch(challenge,/Set up authenticator/);
});
