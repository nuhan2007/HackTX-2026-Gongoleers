// Decoding a picture that arrives as a data URL, without a network request or an <img>: a page's strict security policy (Khan Academy's,
// for one) can block both, but decoding bytes in memory is never blocked.

/** The bytes of a `data:` URL. */
export function bytesOfDataUrl(dataUrl: string): { bytes: Uint8Array; type: string } {
  const comma = dataUrl.indexOf(',');
  const head = dataUrl.slice(5, comma);
  const type = head.split(';')[0] || 'application/octet-stream';
  const body = dataUrl.slice(comma + 1);
  if (!/;base64$/.test(head)) return { bytes: new TextEncoder().encode(decodeURIComponent(body)), type };
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, type };
}

/** Decodes an image data URL into a bitmap. The caller closes it when done. */
export async function bitmapOfDataUrl(dataUrl: string): Promise<ImageBitmap> {
  const { bytes, type } = bytesOfDataUrl(dataUrl);
  return createImageBitmap(new Blob([bytes as BlobPart], { type }));
}
