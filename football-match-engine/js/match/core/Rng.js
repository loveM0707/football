/**
 * 결정론적 난수 생성기 (mulberry32).
 *
 * 시뮬레이션 내부의 모든 확률적 요소는 반드시 이 클래스를 통과해야 한다.
 * Math.random()을 직접 호출하면 동일 시드 재현이 깨지므로 금지한다.
 * (tests/determinism.test.mjs 가 소스 트리를 검사해 위반을 잡아낸다)
 *
 * 난수는 "불확실성"을 표현하는 용도로만 쓴다:
 *   - 터치 오차, 판단 편차, 신체 능력의 미세 변동, 반응 지연
 * 전술적 결정 자체를 난수로 정하지 않는다.
 */
export class Rng {
  /**
   * @param {number} seed 32비트 정수 시드
   */
  constructor(seed = 12345) {
    this.seed = seed >>> 0;
    this._s = this.seed;
    this._calls = 0;
  }

  /** 현재 내부 상태를 그대로 복제한다 (분기 시뮬레이션·테스트용) */
  clone() {
    const r = new Rng(this.seed);
    r._s = this._s;
    r._calls = this._calls;
    return r;
  }

  /** 시드를 새로 지정하고 내부 상태를 초기화한다 */
  reset(seed = this.seed) {
    this.seed = seed >>> 0;
    this._s = this.seed;
    this._calls = 0;
  }

  /** [0, 1) 균등 분포 */
  float() {
    this._calls++;
    this._s = (this._s + 0x6d2b79f5) >>> 0;
    let t = this._s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [min, max) 균등 분포 */
  range(min, max) {
    return min + this.float() * (max - min);
  }

  /** [min, max] 정수 균등 분포 */
  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  /** 확률 p로 true (p<=0 이면 항상 false, p>=1 이면 항상 true) */
  chance(p) {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.float() < p;
  }

  /** -1 또는 +1 */
  sign() {
    return this.float() < 0.5 ? -1 : 1;
  }

  /**
   * 표준정규분포 근사 (Box-Muller).
   * 능력치 오차처럼 "대부분 작고 가끔 큰" 편차를 표현할 때 사용한다.
   * @param {number} mean 평균
   * @param {number} sd 표준편차
   * @param {number} clampSd 이 배수를 넘는 극단값은 잘라낸다 (기본 3σ)
   */
  gaussian(mean = 0, sd = 1, clampSd = 3) {
    // u1이 0이면 log(0) = -Infinity 이므로 하한을 둔다
    const u1 = Math.max(1e-12, this.float());
    const u2 = this.float();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const clamped = Math.max(-clampSd, Math.min(clampSd, z));
    return mean + clamped * sd;
  }

  /** 배열에서 균등 확률로 하나 선택 (빈 배열이면 null) */
  pick(arr) {
    if (!arr || arr.length === 0) return null;
    return arr[this.int(0, arr.length - 1)];
  }

  /**
   * 가중치 기반 선택.
   * @param {Array<T>} arr 후보 배열
   * @param {(item:T)=>number} weightFn 음수가 아닌 가중치 함수
   * @returns {T|null}
   * @template T
   */
  pickWeighted(arr, weightFn) {
    if (!arr || arr.length === 0) return null;
    let total = 0;
    for (const item of arr) total += Math.max(0, weightFn(item));
    if (total <= 0) return this.pick(arr);
    let r = this.float() * total;
    for (const item of arr) {
      r -= Math.max(0, weightFn(item));
      if (r <= 0) return item;
    }
    return arr[arr.length - 1];
  }

  /** 제자리 셔플 (Fisher-Yates). 원본 배열을 수정하고 그대로 반환한다. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * 하위 스트림 생성.
   * 서로 다른 시스템(터치 오차 / 판단 / 물리)이 같은 스트림을 공유하면
   * 한 시스템의 호출 횟수 변화가 다른 시스템의 난수열을 바꿔버린다.
   * 시스템별로 독립 스트림을 만들어 이런 결합을 끊는다.
   * @param {string} label 스트림 식별자
   */
  stream(label) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < label.length; i++) {
      h ^= label.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return new Rng((this.seed ^ h) >>> 0);
  }
}
