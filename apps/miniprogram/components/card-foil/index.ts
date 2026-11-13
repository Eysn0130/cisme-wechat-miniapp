import { shouldReduceMotion } from '../../services/layout';

type MaterialRuntime = { alive: boolean; observer: WechatMiniprogram.IntersectionObserver | null };
const runtimes = new WeakMap<object, MaterialRuntime>();
type MaterialHost = {
  data: { visible: boolean; inViewport: boolean; lowMotion: boolean; ambientOn: boolean; silkReady: boolean; engravingReady: boolean; textureUnavailable: boolean };
  properties: { reduced: boolean; quiet: boolean };
  setData(patch: WechatMiniprogram.IAnyObject): void;
};
function synchronizeAmbient(component: MaterialHost) {
  const ambientOn = Boolean(component.data.visible && component.data.inViewport && component.data.silkReady
    && component.data.engravingReady && !component.data.textureUnavailable && !component.data.lowMotion
    && !component.properties.reduced && !component.properties.quiet);
  if (component.data.ambientOn !== ambientOn) component.setData({ ambientOn });
}
Component({
  options: { virtualHost: true },
  properties: {
    tone: { type: String, value: 'coupon' }, active: { type: Boolean, value: false },
    x: { type: Number, value: 50 }, y: { type: Number, value: 50 },
    intro: { type: Boolean, value: false }, flash: { type: Boolean, value: false },
    reduced: { type: Boolean, value: false }, quiet: { type: Boolean, value: false }
  },
  data: {
    visible: true, inViewport: false, ambientOn: false, lowMotion: false,
    silkReady: false, engravingReady: false, textureUnavailable: false,
    introActive: false, flashActive: false, shiftX: 0, shiftY: 0, angle: 0,
    engraveX: 0, engraveY: 0, spotX: 0, spotY: 0
  },
  observers: {
    'x,y': function (x: number, y: number) {
      const bounded = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 50;
      const dx = bounded(x) - 50, dy = bounded(y) - 50;
      this.setData({ shiftX: Math.round(dx * .7), shiftY: Math.round(dy * .25), angle: Math.round(dx * .06),
        engraveX: Math.round(dx * .1), engraveY: Math.round(dy * .06), spotX: Math.round(dx * .5), spotY: Math.round(dy * .4) });
    },
    flash: function (value: boolean) {
      this.setData({ flashActive: Boolean(value && this.data.visible && !this.data.lowMotion && !this.properties.reduced), ...(value ? { introActive: false } : {}) });
    },
    'reduced,quiet': function () { synchronizeAmbient(this); }
  },
  lifetimes: {
    attached() {
      const runtime: MaterialRuntime = { alive: true, observer: null }; runtimes.set(this, runtime);
      const lowMotion = shouldReduceMotion();
      this.setData({ lowMotion, introActive: Boolean(this.properties.intro && !lowMotion && !this.properties.reduced) });
      if (lowMotion || typeof this.createIntersectionObserver !== 'function') return;
      try {
        runtime.observer = this.createIntersectionObserver({ thresholds: [0, .01], initialRatio: 0 });
        runtime.observer.relativeToViewport().observe('.foil', result => {
          if (!runtime.alive || runtimes.get(this) !== runtime) return;
          const inViewport = result.intersectionRatio > 0;
          if (inViewport !== this.data.inViewport) this.setData({ inViewport });
          synchronizeAmbient(this);
        });
      } catch { runtime.alive = false; runtime.observer?.disconnect(); runtime.observer = null; this.setData({ inViewport: false, ambientOn: false }); }
    },
    detached() {
      const runtime = runtimes.get(this);
      if (runtime) { runtime.alive = false; runtime.observer?.disconnect(); runtimes.delete(this); }
    }
  },
  methods: {
    finishSweep() { this.setData({ introActive: false, flashActive: false }); },
    textureLoaded(event: WechatMiniprogram.CustomEvent) {
      const texture = event.currentTarget.dataset.texture;
      if (texture !== 'silk' && texture !== 'engraving') return;
      this.setData(texture === 'silk' ? { silkReady: true } : { engravingReady: true });
      synchronizeAmbient(this);
    },
    textureFailed() { this.setData({ textureUnavailable: true }); synchronizeAmbient(this); }
  },
  pageLifetimes: {
    hide() { this.setData({ visible: false, ambientOn: false, introActive: false, flashActive: false }); },
    show() { this.setData({ visible: true }); synchronizeAmbient(this); }
  }
});
