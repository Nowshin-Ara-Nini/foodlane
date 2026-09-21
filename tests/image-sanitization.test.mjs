import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const wr = createRequire(require.resolve('wrangler/package.json'));
const sharp = createRequire(wr.resolve('miniflare'))('sharp');
let sanitizeImage;
// Full Images-contract adapter for orientation coverage: the pinned Miniflare
// emulator implements rotation but ignores flip. Integration tests separately
// exercise its actual Images binding in workerd; this is not a remote-service test.
const images = {
  async info(stream) {
    const m=await sharp(Buffer.from(await new Response(stream).arrayBuffer())).metadata();
    return {format:`image/${m.format}`,width:m.width,height:m.height};
  },
  input(stream) {
    const transforms=[];
    return {
      transform(value){transforms.push(value);return this},
      async output(){
        let bytes=Buffer.from(await new Response(stream).arrayBuffer());
        for(const transform of transforms){
          let decoder=sharp(bytes);
          if(transform.flip==='h')decoder=decoder.flop();
          if(transform.rotate)decoder=decoder.rotate(transform.rotate);
          bytes=await decoder.png().toBuffer();
        }
        bytes=await sharp(bytes).png().toBuffer();
        return {response:()=>new Response(bytes)};
      },
    };
  },
};
before(async()=>{
  await mkdir('.wrangler/image-tests',{recursive:true});
  await wr('esbuild').build({entryPoints:['lib/image-sanitization.ts'],bundle:true,outfile:'.wrangler/image-tests/sanitize.mjs',format:'esm',platform:'node',external:['node:*']});
  ({sanitizeImage}=await import(pathToFileURL(resolve('.wrangler/image-tests/sanitize.mjs'))));
});
test('all eight EXIF orientations preserve the displayed pixels and discard metadata',async()=>{
  const raw=Buffer.from(Array.from({length:6*4*3},(_,i)=>(i*17)%256));
  for(let orientation=1;orientation<=8;orientation++){
    const input=await sharp(raw,{raw:{width:6,height:4,channels:3}}).withMetadata({orientation}).jpeg({quality:100}).toBuffer();
    const expected=await sharp(input).autoOrient().raw().toBuffer({resolveWithObject:true});
    const clean=await sanitizeImage(new File([input],'source.jpg',{type:'image/jpeg'}),images);
    const actual=await sharp(Buffer.from(clean)).raw().toBuffer({resolveWithObject:true});
    assert.equal(actual.info.width,expected.info.width,`orientation ${orientation}`);
    assert.equal(actual.info.height,expected.info.height,`orientation ${orientation}`);
    assert.deepEqual(actual.data,expected.data,`orientation ${orientation}`);
    const metadata=await sharp(Buffer.from(clean)).metadata();
    assert.equal(metadata.exif,undefined);assert.equal(metadata.icc,undefined);assert.equal(metadata.orientation,undefined);
  }
});
test('missing image processing fails closed without saving the source',async()=>{
  const png=await sharp({create:{width:2,height:2,channels:3,background:'#123456'}}).png().toBuffer();
  await assert.rejects(()=>sanitizeImage(new File([png],'source.png',{type:'image/png'})),e=>e.status===503);
});
