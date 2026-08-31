// --- convert detection-map pixels -> targetSize -> original bitmap coords
function pixelsToBox(pixels, mapWidth, mapHeight, scale, padX, padY, targetSize = 480) {
  if (pixels.length === 0) return null;

  let minX = mapWidth, maxX = 0;
  let minY = mapHeight, maxY = 0;

  for (const [x, y] of pixels) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  // Map map coords to targetSize coords (detection map -> 480 px space)
  const scaleX = targetSize / mapWidth;
  const scaleY = targetSize / mapHeight;

  const tMinX = minX * scaleX;
  const tMinY = minY * scaleY;
  const tMaxX = (maxX + 1) * scaleX; // +1 to include pixel
  const tMaxY = (maxY + 1) * scaleY;

  // Map back to original bitmap space using pad and scale produced in preprocessing
  const boxX = (tMinX - padX) / scale;
  const boxY = (tMinY - padY) / scale;
  const boxW = (tMaxX - tMinX) / scale;
  const boxH = (tMaxY - tMinY) / scale;

  return {
    x: Math.max(0, boxX),
    y: Math.max(0, boxY),
    width: Math.max(0, boxW),
    height: Math.max(0, boxH)
  };
}