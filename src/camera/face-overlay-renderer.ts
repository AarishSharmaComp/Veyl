import type { FacePose } from './face-landmarker';

export const FACE_OVERLAY_HOLD_MS = 120;
export const FACE_OVERLAY_FADE_MS = 220;

export class FaceOverlayRenderer {
  private pose: FacePose | null = null;
  private lastResultAt = -Infinity;
  private missingSince = Infinity;

  reset(): void {
    this.pose = null;
    this.lastResultAt = -Infinity;
    this.missingSince = Infinity;
  }

  update(pose: FacePose | null, timestamp: number): void {
    if (!Number.isFinite(timestamp) || timestamp <= this.lastResultAt) return;
    this.lastResultAt = timestamp;
    if (!pose || !validPose(pose)) {
      this.markMissingAt(timestamp);
      return;
    }
    this.pose = this.pose && this.missingSince === Infinity
      ? smoothPose(this.pose, pose, 0.36)
      : this.pose && timestamp - this.missingSince <= FACE_OVERLAY_HOLD_MS + FACE_OVERLAY_FADE_MS
        ? smoothPose(this.pose, pose, 0.58)
        : pose;
    this.missingSince = Infinity;
  }

  markMissing(timestamp: number): void {
    if (!Number.isFinite(timestamp)) return;
    this.lastResultAt = Math.max(this.lastResultAt, timestamp);
    this.markMissingAt(timestamp);
  }

  render(context: CanvasRenderingContext2D, width: number, height: number, timestamp: number, visible = true): boolean {
    if (!visible || !this.pose || width <= 0 || height <= 0 || !Number.isFinite(timestamp)) return false;
    const missingFor = this.missingSince === Infinity ? 0 : Math.max(0, timestamp - this.missingSince);
    if (missingFor > FACE_OVERLAY_HOLD_MS + FACE_OVERLAY_FADE_MS) {
      this.pose = null;
      return false;
    }
    const fade = missingFor <= FACE_OVERLAY_HOLD_MS
      ? 1
      : 1 - (missingFor - FACE_OVERLAY_HOLD_MS) / FACE_OVERLAY_FADE_MS;
    if (fade <= 0) {
      this.pose = null;
      return false;
    }
    drawVisor(context, this.pose, width, height, Math.max(0, Math.min(1, fade)));
    return true;
  }

  private markMissingAt(timestamp: number): void {
    if (this.missingSince === Infinity) this.missingSince = timestamp;
  }
}

function drawVisor(context: CanvasRenderingContext2D, pose: FacePose, width: number, height: number, opacity: number): void {
  const centerX = pose.centerX * width;
  const centerY = pose.centerY * height;
  const visorWidth = Math.max(34, Math.min(width * 0.8, pose.width * width * 1.08));
  const visorHeight = Math.max(16, Math.min(height * 0.24, pose.height * height * 1.32));
  const radius = visorHeight * 0.42;
  const halfWidth = visorWidth / 2;
  const halfHeight = visorHeight / 2;

  context.save();
  context.translate(centerX, centerY);
  context.rotate(pose.roll);
  context.globalAlpha = opacity;
  context.globalCompositeOperation = 'source-over';
  context.filter = 'none';
  context.shadowColor = 'rgba(129, 235, 255, 0.62)';
  context.shadowBlur = Math.max(4, visorHeight * 0.42);
  context.fillStyle = 'rgba(48, 171, 202, 0.18)';
  context.strokeStyle = 'rgba(190, 249, 255, 0.96)';
  context.lineWidth = Math.max(1.5, visorHeight * 0.07);
  roundedRect(context, -halfWidth, -halfHeight, visorWidth, visorHeight, radius);
  context.fill();
  context.stroke();

  context.shadowBlur = 0;
  context.strokeStyle = 'rgba(226, 255, 255, 0.9)';
  context.lineWidth = Math.max(1, visorHeight * 0.045);
  context.beginPath();
  context.moveTo(-halfWidth * 0.58, 0);
  context.lineTo(halfWidth * 0.58, 0);
  context.stroke();
  context.beginPath();
  context.moveTo(-halfWidth * 0.84, -halfHeight * 0.52);
  context.lineTo(-halfWidth * 0.62, -halfHeight * 0.52);
  context.moveTo(halfWidth * 0.62, -halfHeight * 0.52);
  context.lineTo(halfWidth * 0.84, -halfHeight * 0.52);
  context.stroke();
  context.restore();
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const right = x + width;
  const bottom = y + height;
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(right - radius, y);
  context.quadraticCurveTo(right, y, right, y + radius);
  context.lineTo(right, bottom - radius);
  context.quadraticCurveTo(right, bottom, right - radius, bottom);
  context.lineTo(x + radius, bottom);
  context.quadraticCurveTo(x, bottom, x, bottom - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function smoothPose(previous: FacePose, next: FacePose, weight: number): FacePose {
  return {
    centerX: mix(previous.centerX, next.centerX, weight),
    centerY: mix(previous.centerY, next.centerY, weight),
    width: mix(previous.width, next.width, weight),
    height: mix(previous.height, next.height, weight),
    roll: mixAngle(previous.roll, next.roll, weight)
  };
}

function mix(first: number, second: number, weight: number): number {
  return first + (second - first) * weight;
}

function mixAngle(first: number, second: number, weight: number): number {
  const delta = Math.atan2(Math.sin(second - first), Math.cos(second - first));
  return first + delta * weight;
}

function validPose(pose: FacePose): boolean {
  return [pose.centerX, pose.centerY, pose.width, pose.height, pose.roll].every(Number.isFinite) &&
    pose.width > 0 && pose.height > 0;
}
