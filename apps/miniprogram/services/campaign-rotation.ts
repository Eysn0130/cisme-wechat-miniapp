export const campaignDwellMs = 4_500;
export const campaignManualDwellMs = 3_000;
export const campaignTransitionMs = 420;

/** One dwell timer, plus a bounded native-animation interruption recovery. */
export class CampaignRotation {
  index = 0;
  private alive = true;
  private visible = true;
  private inViewport = true;
  private suspended = false;
  private reduced = false;
  private manual = false;
  private touching = false;
  private touchBlocked = false;
  private moving = false;
  private lockedUntil = 0;
  private ready: boolean[];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private recovery: ReturnType<typeof setTimeout> | null = null;

  constructor(private count: number, private publish: (index: number) => void,
    private dwell = campaignDwellMs, private duration = campaignTransitionMs) {
    this.ready = Array.from({ length: count }, () => false);
  }
  private valid(index: number) { return Number.isInteger(index) && index >= 0 && index < this.count; }
  private enabled() {
    return this.alive && this.visible && this.inViewport && !this.suspended && !this.reduced
      && !this.touching && !this.moving && this.count > 1;
  }
  private clearDwell() { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  private clearRecovery() { if (this.recovery !== null) clearTimeout(this.recovery); this.recovery = null; }
  private arm() {
    if (this.timer !== null || !this.enabled() || !this.ready[(this.index + 1) % this.count]) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.enabled() || !this.ready[(this.index + 1) % this.count]) return;
      this.manual = false;
      this.moveTo((this.index + 1) % this.count);
    }, this.manual ? campaignManualDwellMs : this.dwell);
  }
  private watchAnimation() {
    this.clearRecovery();
    // Native animationfinish normally settles immediately. Interrupted/cancelled
    // gestures must not leave the carousel permanently locked.
    this.recovery = setTimeout(() => {
      this.recovery = null;
      if (!this.alive || !this.visible || this.touching) return;
      this.moving = false;
      this.arm();
    }, Math.max(1_200, this.duration * 3));
  }
  private moveTo(index: number) {
    this.clearDwell();
    this.index = index;
    this.moving = !this.reduced;
    this.lockedUntil = Date.now() + (this.reduced ? 0 : this.duration);
    this.publish(index);
    if (this.moving) this.watchAnimation(); else this.arm();
  }
  setReady(index: number, ready = true) {
    if (!this.alive || !this.valid(index)) return;
    this.ready[index] = ready;
    if (!ready && index === (this.index + 1) % this.count) this.clearDwell();
    this.arm();
  }
  configure(flags: { visible?: boolean; inViewport?: boolean; suspended?: boolean; reduced?: boolean }) {
    const before = this.enabled();
    if (flags.visible !== undefined) this.visible = flags.visible;
    if (flags.inViewport !== undefined) this.inViewport = flags.inViewport;
    if (flags.suspended !== undefined) this.suspended = flags.suspended;
    if (flags.reduced !== undefined) this.reduced = flags.reduced;
    if (!this.visible || this.suspended || !this.inViewport || this.reduced) {
      this.clearDwell(); this.clearRecovery(); this.moving = false; this.touching = false; this.manual = false;
    }
    if (!before && this.enabled()) this.clearDwell();
    this.arm();
  }
  beginTouch() {
    if (!this.alive || !this.visible || !this.inViewport || this.suspended) return;
    this.touchBlocked = this.moving || Date.now() < this.lockedUntil;
    this.touching = true; this.clearDwell(); this.clearRecovery();
  }
  endTouch(moved: boolean) {
    if (!this.alive || !this.visible) return;
    this.touching = false;
    if (moved) this.manual = true;
    if (moved || this.touchBlocked) this.lockedUntil = Date.now() + this.duration;
    this.touchBlocked = false;
    if (this.moving) this.watchAnimation();
    this.clearDwell(); this.arm();
  }
  changed(index: number) {
    if (!this.alive || !this.visible || !this.valid(index)) return;
    this.clearDwell();
    const different = this.index !== index;
    if (this.touching && different) this.manual = true;
    this.index = index; this.moving = !this.reduced;
    this.lockedUntil = Date.now() + (this.reduced ? 0 : this.duration);
    if (different) this.publish(index);
    if (this.moving) this.watchAnimation(); else this.arm();
  }
  finished(index: number) {
    if (!this.alive || !this.visible || !this.valid(index) || index !== this.index) return;
    this.clearRecovery(); this.moving = false;
    this.clearDwell(); this.arm();
  }
  canActivate(index: number) {
    return this.alive && this.visible && this.inViewport && !this.suspended && !this.touching && !this.moving
      && this.valid(index) && index === this.index && Date.now() >= this.lockedUntil;
  }
  snapshot() {
    return { index: this.index, alive: this.alive, visible: this.visible, inViewport: this.inViewport,
      suspended: this.suspended, reduced: this.reduced, manual: this.manual,
      touching: this.touching, moving: this.moving, timerActive: this.timer !== null };
  }
  destroy() { this.alive = false; this.clearDwell(); this.clearRecovery(); }
}
