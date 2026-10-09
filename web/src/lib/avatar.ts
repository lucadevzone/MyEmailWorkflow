/** Ritaglio quadrato al centro e ridimensionamento a 256 px, in JPEG: la foto pesa pochi KB. */
export async function prepareAvatar(file: File, side = 256): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const crop = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, (bitmap.width - crop) / 2, (bitmap.height - crop) / 2, crop, crop, 0, 0, side, side);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Conversione immagine fallita'))), 'image/jpeg', 0.88),
  );
}
