export class GestureController {
  private lastToggleAt = -Infinity;

  constructor(private readonly onToggle: () => void) {}

  attach(): () => void {
    const listener = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== 'x') return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')) return;

      const now = performance.now();
      if (now - this.lastToggleAt < 600) return;
      this.lastToggleAt = now;
      event.preventDefault();
      this.onToggle();
    };
    document.addEventListener('keydown', listener, true);
    return () => document.removeEventListener('keydown', listener, true);
  }
}
