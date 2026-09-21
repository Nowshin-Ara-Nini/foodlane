import { HttpError } from './permissions';

const MAX_BYTES = 5 * 1024 * 1024;
const signature = [137, 80, 78, 71, 13, 10, 26, 10];
function invalid(): never { throw new HttpError(400, 'Upload a valid JPEG or PNG, up to 5 MiB and 16 megapixels (maximum side 8192).'); }
function dimensions(width: number, height: number) {
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16_000_000) invalid();
}
function sourceDimensions(bytes: Uint8Array, type: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === 'image/png') {
    if (bytes.length < 33 || !signature.every((b, i) => bytes[i] === b) || view.getUint32(8) !== 13 || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') invalid();
    dimensions(view.getUint32(16), view.getUint32(20)); return;
  }
  if (type !== 'image/jpeg' || bytes[0] !== 255 || bytes[1] !== 216) invalid();
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 255) invalid();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (offset + 2 > bytes.length) invalid();
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) invalid();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) invalid();
      dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3)); return;
    }
    offset += length;
  }
  invalid();
}
function crc(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const b of bytes) { value ^= b; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
function normalizeOrientation(bytes: Uint8Array, type: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let orientation = 1, found = false;
  function tiff(start: number, end: number) {
    if (start + 8 > end) invalid();
    const order = view.getUint16(start), little = order === 0x4949;
    if (!little && order !== 0x4d4d) invalid();
    if (view.getUint16(start + 2,little) !== 42) invalid();
    const ifd = start + view.getUint32(start + 4,little);
    if (ifd < start + 8 || ifd + 2 > end) invalid();
    const count = view.getUint16(ifd,little);
    if (ifd + 2 + count * 12 > end) invalid();
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      if (view.getUint16(entry,little) !== 0x112) continue;
      if (found || view.getUint16(entry+2,little) !== 3 || view.getUint32(entry+4,little) !== 1) invalid();
      orientation = view.getUint16(entry+8,little); found = true;
      if (orientation < 1 || orientation > 8) invalid();
      // Normalize the tag so the decoder cannot auto-orient a second time.
      view.setUint16(entry+8,1,little);
    }
  }
  if (type === 'image/png') {
    for (let p = 8; p + 12 <= bytes.length;) {
      const length = view.getUint32(p), next = p + length + 12;
      if (next > bytes.length) invalid();
      if (String.fromCharCode(...bytes.subarray(p+4,p+8)) === 'eXIf') {
        if (crc(bytes.subarray(p+4,next-4)) !== view.getUint32(next-4)) invalid();
        tiff(p+8,next-4); view.setUint32(next-4,crc(bytes.subarray(p+4,next-4)));
      }
      p = next;
    }
  } else {
    for (let p = 2; p + 4 <= bytes.length;) {
      if (bytes[p++] !== 255) invalid(); while (bytes[p] === 255) p++;
      const marker = bytes[p++]; if (marker === 0xda || marker === 0xd9) break;
      const length = view.getUint16(p), next = p + length;
      if (length < 2 || next > bytes.length) invalid();
      if (marker === 0xe1 && String.fromCharCode(...bytes.subarray(p+2,p+8)) === 'Exif\0\0') tiff(p+8,next);
      p = next;
    }
  }
  return orientation;
}
// Only pixel/colour-table/transparency chunks survive. EXIF, GPS, ICC, text,
// timestamps and all other ancillary chunks are removed, even if the codec kept them.
export function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  sourceDimensions(bytes, 'image/png');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [bytes.slice(0, 8)]; let offset = 8, image = false, end = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset), next = offset + length + 12;
    if (next > bytes.length) invalid();
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    if (crc(bytes.subarray(offset + 4, next - 4)) !== view.getUint32(next - 4)) invalid();
    if (offset === 8 && type !== 'IHDR') invalid();
    if (offset !== 8 && type === 'IHDR') invalid();
    if (!['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS'].includes(type) && (bytes[offset + 4] & 32) === 0) invalid();
    if (type === 'IDAT') image = true;
    if (['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS'].includes(type)) chunks.push(bytes.slice(offset, next));
    offset = next;
    if (type === 'IEND') { if (length !== 0 || offset !== bytes.length) invalid(); end = true; break; }
  }
  if (!image || !end) invalid();
  const result = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let position = 0;
  for (const chunk of chunks) { result.set(chunk, position); position += chunk.length; }
  return result;
}
export async function sanitizeImage(file: File, images?: ImagesBinding) {
  if (!(file instanceof File) || !file.size || file.size > MAX_BYTES || !['image/jpeg', 'image/png'].includes(file.type)) invalid();
  const bytes = new Uint8Array(await file.arrayBuffer());
  sourceDimensions(bytes, file.type);
  if (file.type === 'image/png') stripPngMetadata(bytes); // Validate every source chunk CRC too.
  const orientation = normalizeOrientation(bytes,file.type);
  if (!images) throw new HttpError(503, 'Image processing is unavailable. Please try again later.');
  try {
    const info = await images.info(new Blob([bytes]).stream());
    if (!('width' in info) || info.format !== file.type) invalid();
    dimensions(info.width, info.height);
    // Apply orientation explicitly after normalizing EXIF to 1, then re-encode.
    let pipeline = images.input(new Blob([bytes]).stream());
    if ([2,4,5,7].includes(orientation)) pipeline = pipeline.transform({ flip: 'h' });
    const rotate = ({ 3:180, 4:180, 5:270, 6:90, 7:90, 8:270 } as const)[orientation as 3|4|5|6|7|8];
    if (rotate) pipeline = pipeline.transform({ rotate });
    const result = await pipeline.output({ format: 'image/png', anim: false });
    const response = result.response();
    const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length; if (size > MAX_BYTES) { await reader.cancel(); invalid(); }
      chunks.push(part.value);
    }
    const encoded = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { encoded.set(chunk, offset); offset += chunk.length; }
    const clean = stripPngMetadata(encoded);
    const checked = await images.info(new Blob([new Uint8Array(clean)]).stream());
    if (!('width' in checked) || checked.format !== 'image/png') invalid();
    dimensions(checked.width, checked.height);
    return clean;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'This image could not be decoded safely. Choose another JPEG or PNG.');
  }
}
