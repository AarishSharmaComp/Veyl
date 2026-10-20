import { drawShockwave } from './shockwave';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rotation: number;
  spin: number;
  life: number;
  maxLife: number;
  color: string;
}

export interface EffectBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class ParticleEffect {
  private particles: Particle[] = [];
  private startedAt = 0;
  private mode: 'disappear' | 'reappear' = 'disappear';
  private bounds: EffectBounds = { x: 0, y: 0, width: 0, height: 0 };

  start(mode: 'disappear' | 'reappear', bounds: EffectBounds, intensity: number): void {
    this.mode = mode;
    this.bounds = bounds;
    this.startedAt = performance.now();
    this.particles = [];
    if (intensity <= 0) return;
    const count = Math.round(52 + intensity * 80);
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height * 0.48;
    const maxRadius = Math.max(bounds.width, bounds.height) * 0.55;

    for (let index = 0; index < count; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * maxRadius;
      const originX = centerX + Math.cos(angle) * radius * 0.55;
      const originY = centerY + Math.sin(angle) * radius * 0.72;
      const direction = mode === 'disappear' ? 1 : -1;
      this.particles.push({
        x: originX,
        y: originY,
        vx: (Math.cos(angle) * (16 + Math.random() * 54) + direction * 9) * intensity,
        vy: (Math.sin(angle) * (16 + Math.random() * 54) - 14) * intensity,
        size: 1 + Math.random() * (2 + intensity * 2.5),
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.18,
        life: 0,
        maxLife: 380 + Math.random() * 440,
        color: Math.random() > 0.24 ? '#d8c2ff' : '#ffadc0'
      });
    }
  }

  render(context: CanvasRenderingContext2D, now: number, intensity: number): boolean {
    if (!this.startedAt || intensity <= 0 || now - this.startedAt > 950) return false;
    const elapsed = now - this.startedAt;
    const centerX = this.bounds.x + this.bounds.width / 2;
    const centerY = this.bounds.y + this.bounds.height * 0.48;
    const progress = Math.min(1, elapsed / 760);

    context.save();
    context.globalCompositeOperation = 'screen';
    for (const particle of this.particles) {
      particle.life = elapsed;
      const lifeProgress = Math.min(1, particle.life / particle.maxLife);
      if (lifeProgress >= 1) continue;
      particle.x += particle.vx * 0.016;
      particle.y += particle.vy * 0.016;
      particle.vy += 18 * 0.016;
      particle.rotation += particle.spin;
      const opacity = Math.sin(lifeProgress * Math.PI) * (1 - progress * 0.35) * 0.9;
      context.globalAlpha = opacity;
      context.fillStyle = particle.color;
      context.translate(particle.x, particle.y);
      context.rotate(particle.rotation);
      context.fillRect(-particle.size / 2, -particle.size / 2, particle.size * 1.8, particle.size);
      context.setTransform(1, 0, 0, 1, 0, 0);
    }
    context.restore();

    const shockProgress = Math.min(1, elapsed / 520);
    drawShockwave(context, centerX, centerY, Math.max(this.bounds.width, this.bounds.height) * (0.12 + shockProgress * 0.65), 1 - shockProgress, intensity);
    return true;
  }

  get active(): boolean {
    return Boolean(this.startedAt && performance.now() - this.startedAt <= 950);
  }
}
