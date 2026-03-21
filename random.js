/**
 * Seeded pseudo-random number generator (Mulberry32).
 * Ensures reproducible results for random slicing and jitter.
 */
export class SeededRandom {
  constructor(seed) {
    this.state = seed | 0;
  }

  /** Returns a float in [0, 1) */
  next() {
    this.state |= 0;
    this.state = (this.state + 0x6D2B79F5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Returns a float in [min, max) */
  range(min, max) {
    return min + this.next() * (max - min);
  }

  /** Returns a random unit vector (THREE.Vector3) */
  randomUnitVector(THREE) {
    const theta = this.range(0, Math.PI * 2);
    const phi = Math.acos(this.range(-1, 1));
    return new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta),
      Math.sin(phi) * Math.sin(theta),
      Math.cos(phi)
    );
  }
}
