// PNG export (AFD-25): the host writes the SVG and the webview draws it on a canvas, because only a
// browser lays out its text. Twice the size for sharp text, less when the canvas would be too big.
const MAX_SIDE = 16_000;
const MAX_AREA = 120_000_000;

export async function svgToPng(svg: string, width: number, height: number): Promise<string> {
  const scale = Math.max(
    0.25,
    Math.min(2, MAX_SIDE / Math.max(width, height), Math.sqrt(MAX_AREA / (width * height))),
  );
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2D canvas');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'),
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
