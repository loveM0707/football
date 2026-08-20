export class Vector2D {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  add(v) {
    return new Vector2D(this.x + v.x, this.y + v.y);
  }

  sub(v) {
    return new Vector2D(this.x - v.x, this.y - v.y);
  }

  scale(s) {
    return new Vector2D(this.x * s, this.y * s);
  }

  length() {
    return Math.hypot(this.x, this.y);
  }

  lengthSq() {
    return this.x * this.x + this.y * this.y;
  }

  normalize() {
    const len = this.length();
    if (len < 1e-9) return new Vector2D(0, 0);
    return new Vector2D(this.x / len, this.y / len);
  }

  limit(max) {
    const len = this.length();
    if (len <= max || len < 1e-9) return this.clone();
    return this.scale(max / len);
  }

  dot(v) {
    return this.x * v.x + this.y * v.y;
  }

  angle() {
    return Math.atan2(this.y, this.x);
  }

  rotate(angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new Vector2D(this.x * cos - this.y * sin, this.x * sin + this.y * cos);
  }

  clone() {
    return new Vector2D(this.x, this.y);
  }

  static distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  static fromAngle(angle, length = 1) {
    return new Vector2D(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  static lerp(a, b, t) {
    return new Vector2D(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  }

  static zero() {
    return new Vector2D(0, 0);
  }
}
