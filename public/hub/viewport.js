// Pan and zoom of the canvas. The world element holds the cards and is moved
// with translate + scale: screen = world * zoom + offset, in pixels relative
// to the canvas element.

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

const GRID_STEP = 24;
const MIN_GRID_SCREEN_STEP = 12;

const clampZoom = (zoom) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

export class Viewport {
  constructor(element, world, onChange) {
    this.element = element;
    this.world = world;
    this.onChange = onChange;
    this.x = 0;
    this.y = 0;
    this.zoom = 1;
    this.width = element.clientWidth;
    this.height = element.clientHeight;

    new ResizeObserver(() => this.measure()).observe(element);
  }

  // Keeps the same world point in the middle when the canvas changes size.
  measure() {
    const width = this.element.clientWidth;
    const height = this.element.clientHeight;

    if (width !== this.width || height !== this.height) {
      const center = this.centerWorld();
      this.width = width;
      this.height = height;
      this.setView(center.x, center.y, this.zoom, { silent: true });
    }
  }

  localPoint(event) {
    const rect = this.element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  toWorld(point) {
    return { x: (point.x - this.x) / this.zoom, y: (point.y - this.y) / this.zoom };
  }

  centerWorld() {
    return this.toWorld({ x: this.width / 2, y: this.height / 2 });
  }

  // Puts world point (centerX, centerY) in the middle of the canvas.
  setView(centerX, centerY, zoom, { silent = false } = {}) {
    this.zoom = clampZoom(zoom);
    this.x = this.width / 2 - centerX * this.zoom;
    this.y = this.height / 2 - centerY * this.zoom;
    this.apply(silent);
  }

  panBy(dx, dy) {
    this.x += dx;
    this.y += dy;
    this.apply();
  }

  // Zooms keeping the world point under `point` (screen) where it is.
  zoomAt(point, factor) {
    this.zoomAround(this.toWorld(point), point, this.zoom * factor);
  }

  // Places world point `anchor` at screen point `point` with the given zoom.
  zoomAround(anchor, point, zoom) {
    this.zoom = clampZoom(zoom);
    this.x = point.x - anchor.x * this.zoom;
    this.y = point.y - anchor.y * this.zoom;
    this.apply();
  }

  apply(silent = false) {
    this.world.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.zoom})`;
    this.world.style.setProperty("--zoom", String(this.zoom));

    // The dot grid follows the world; dots thin out when zoomed far out.
    let step = GRID_STEP * this.zoom;

    while (step < MIN_GRID_SCREEN_STEP) {
      step *= 2;
    }

    const style = this.element.style;
    style.setProperty("--grid-size", `${step}px`);
    style.setProperty("--grid-x", `${this.x % step}px`);
    style.setProperty("--grid-y", `${this.y % step}px`);

    if (!silent) {
      this.onChange?.();
    }
  }
}
