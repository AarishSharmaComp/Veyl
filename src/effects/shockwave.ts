export function drawShockwave(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  radius: number,
  opacity: number,
  intensity: number
): void {
  if (opacity <= 0) return;
  context.save();
  context.globalAlpha = opacity * 0.42;
  context.strokeStyle = '#d6bbff';
  context.lineWidth = Math.max(1, 2.5 * intensity);
  context.shadowColor = '#a879ff';
  context.shadowBlur = 10 * intensity;
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.stroke();
  context.restore();
}
