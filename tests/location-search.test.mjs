import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
let helpers, Explore, GoogleMap;
before(async()=>{
  const require=createRequire(import.meta.url), wr=createRequire(require.resolve('wrangler/package.json'));
  await mkdir('.wrangler/location-tests',{recursive:true});
  for(const [name,entry] of [['helpers','lib/location-search.ts'],['explore','app/explore-sellers.tsx'],['map','app/google-location-map.tsx']]){
    const output='.wrangler/location-tests/'+name+'.mjs';
    await wr('esbuild').build({entryPoints:[entry],bundle:true,outfile:output,format:'esm',platform:'node',packages:'external',jsx:'automatic',alias:{'next/link':'next/link.js'}});
    const compiled=await import(pathToFileURL(resolve(output)));
    if(name==='helpers')helpers=compiled;else if(name==='explore')Explore=compiled.default;else GoogleMap=compiled.default;
  }
});
test('address labels avoid duplicate city/district names and Google links encode locations safely',()=>{
  assert.equal(helpers.locationLabel({road:' Road 12 ',area:'Gulshan 1',city:'Dhaka',district:' dhaka '}),'Road 12, Gulshan 1, Dhaka');
  assert.deepEqual(helpers.locationTerms(' Gulshan 1, Dhaka , Dhaka '),['Gulshan 1','Dhaka']);
  const query='Road 12, Gulshan 1, Dhaka & market';
  const maps=new URL(helpers.googleMapsSearchUrl(query));assert.equal(maps.origin,'https://www.google.com');
  assert.equal(maps.searchParams.get('query'),query);assert.equal(maps.searchParams.get('api'),'1');
  const directions=new URL(helpers.googleMapsDirectionsUrl(23.78,90.41));
  assert.equal(directions.searchParams.get('destination'),'23.78,90.41');
});
test('Explore map shows address fields and Google Maps while the seller directory keeps its name search',()=>{
  const html=renderToStaticMarkup(React.createElement(Explore));
  for(const label of ['Road, house or landmark','Area / neighborhood','City','District','Find food here','Near me'])assert.ok(html.includes(label),label);
  assert.doesNotMatch(html,/Latitude|Longitude|OpenStreetMap/);
  assert.match(html,/title="Google Maps: Dhaka, Bangladesh"/);assert.match(html,/maps.google.com\/maps\?/);
  const directory=renderToStaticMarkup(React.createElement(Explore,{directoryOnly:true}));
  assert.match(directory,/Search seller name or neighborhood/);assert.doesNotMatch(directory,/<iframe/);
  const map=renderToStaticMarkup(React.createElement(GoogleMap,{query:'Gulshan 1, Dhaka',label:'Gulshan 1, Dhaka'}));
  assert.match(map,/output=embed/);assert.match(map,/Open Google Maps/);
});
