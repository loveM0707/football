/**
 * 고정 타임스텝 누산기.
 *
 * 렌더 시간(가변)과 시뮬레이션 시간(고정)을 분리한다.
 * 물리·판단은 항상 정확히 STEP초 단위로만 전진하므로,
 * 프레임률이 흔들려도 궤적이 달라지지 않는다.
 *
 * ── 배속 처리 ────────────────────────────────────────────────
 * 배속은 dt를 키우는 것이 아니라 "한 프레임에 실행하는 스텝 수"를 늘린다.
 * 따라서 1배속과 8배속의 시뮬레이션 궤적은 (같은 시드라면) 완전히 동일하다.
 * dt 자체를 키우면 적분 오차가 달라져 재현성이 깨지므로 절대 그렇게 하지 않는다.
 */
export class FixedStep {
  /**
   * @param {number} step 한 스텝의 시뮬레이션 시간 (초)
   * @param {number} maxStepsPerFrame 한 프레임에 허용할 최대 스텝 수
   *        (탭 비활성 복귀 등으로 누산기가 폭증했을 때 죽음의 나선 방지)
   */
  constructor({ step = 1 / 60, maxStepsPerFrame = 240 } = {}) {
    this.step = step;
    this.maxStepsPerFrame = maxStepsPerFrame;
    this.accumulator = 0;
    this.totalSteps = 0;
    /** 예산 초과로 버린 스텝 수 (진단용 — 0이 아니면 실시간 재생이 밀리고 있다는 뜻) */
    this.droppedSteps = 0;
  }

  reset() {
    this.accumulator = 0;
    this.totalSteps = 0;
    this.droppedSteps = 0;
  }

  /**
   * 실제 경과 시간을 받아 고정 스텝으로 나누어 실행한다.
   * @param {number} realDt 실제 경과 시간 (초)
   * @param {number} timeScale 배속 (1, 2, 4, 8 ...)
   * @param {(step:number)=>void} stepFn 한 스텝을 실행하는 콜백
   * @returns {number} 이번 호출에서 실행된 스텝 수
   */
  advance(realDt, timeScale, stepFn) {
    this.accumulator += realDt * timeScale;

    // 부동소수 오차 허용치.
    // 1.0초를 1/60로 나누면 실수 연산에서는 59.999...가 되어 스텝이 하나 모자란다.
    // 한 스텝의 1e-9 이내로 근접했으면 온전한 스텝으로 인정한다.
    const EPS = 1e-9;

    let steps = 0;
    while (this.accumulator >= this.step - EPS && steps < this.maxStepsPerFrame) {
      stepFn(this.step);
      this.accumulator -= this.step;
      steps++;
      this.totalSteps++;
    }

    // 예산을 다 쓰고도 누산기가 남았다면 따라잡기를 포기하고 버린다.
    // (남겨두면 다음 프레임에 더 큰 부채가 쌓여 영원히 밀린다)
    if (this.accumulator >= this.step - EPS) {
      const dropped = Math.floor(this.accumulator / this.step);
      this.droppedSteps += dropped;
      this.accumulator -= dropped * this.step;
    }

    return steps;
  }

  /**
   * 테스트·헤드리스 실행용: 정확히 n스텝을 실행한다.
   * 누산기를 거치지 않으므로 프레임률과 무관하게 완전히 결정론적이다.
   * @param {number} n 실행할 스텝 수
   * @param {(step:number, index:number)=>void} stepFn
   */
  runSteps(n, stepFn) {
    for (let i = 0; i < n; i++) {
      stepFn(this.step, i);
      this.totalSteps++;
    }
  }

  /** 지정한 시뮬레이션 시간(초)에 해당하는 스텝 수 */
  stepsForSeconds(seconds) {
    return Math.round(seconds / this.step);
  }
}
