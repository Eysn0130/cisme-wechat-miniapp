import { CampaignRotation, campaignTransitionMs } from '../../services/campaign-rotation';
import { homeCampaignSlides, campaignEssence, campaignPrice, type HomeCampaignSlide } from '../../services/home-campaign';
import { catalogList } from '../../services/commerce';
import { cancelPageReads } from '../../services/page-requests';

interface CampaignState {
  rotation: CampaignRotation; alive: boolean; visible: boolean; epoch: number; catalogPending: boolean;
  touch: { x: number; y: number } | null; observer?: WechatMiniprogram.IntersectionObserver;
}
const states = new WeakMap<object, CampaignState>();
Component({
  options: { virtualHost: true },
  properties: { suspended: { type: Boolean, value: false }, reducedMotion: { type: Boolean, value: false } },
  data: { slides: [] as HomeCampaignSlide[], current: 0, paused: false, duration: campaignTransitionMs, productCode: '' },
  observers: {
    'suspended,reducedMotion': function () {
      states.get(this)?.rotation.configure({ suspended: this.properties.suspended, reduced: this.properties.reducedMotion });
      this.setData({ duration: this.properties.reducedMotion ? 0 : campaignTransitionMs });
    }
  },
  lifetimes: {
    attached() {
      const slides = homeCampaignSlides(getApp<IAppOption>().globalData.apiBaseUrl);
      const state: CampaignState = { alive: true, visible: true, epoch: 0, catalogPending: false, touch: null,
        rotation: new CampaignRotation(slides.length, current => {
          if (states.get(this)?.alive) { this.setData({ current }); this.prepareImages(current); }
        }) };
      states.set(this, state);
      state.rotation.configure({ suspended: this.properties.suspended, reduced: this.properties.reducedMotion });
      this.setData({ slides, duration: this.properties.reducedMotion ? 0 : campaignTransitionMs });
      void this.refreshCatalog();
    },
    ready() {
      const state = states.get(this); if (!state) return;
      try {
        state.observer = this.createIntersectionObserver({ thresholds: [0, 0.1] });
        state.observer.relativeToViewport().observe('#campaign-frame', result => {
          if (states.get(this)?.alive) state.rotation.configure({ inViewport: result.intersectionRatio > 0.05 });
        });
      } catch { /* Page show/hide and sheet suspension remain authoritative. */ }
    },
    detached() {
      const state = states.get(this); if (!state) return;
      state.alive = false; state.epoch++; state.rotation.destroy(); state.observer?.disconnect();
      cancelPageReads(this); states.delete(this);
    }
  },
  pageLifetimes: {
    show() { const state = states.get(this); if (!state) return; state.visible = true; state.rotation.configure({ visible: true }); void this.refreshCatalog(); },
    hide() { const state = states.get(this); if (!state) return; state.visible = false; state.epoch++; state.catalogPending = false; state.rotation.configure({ visible: false }); cancelPageReads(this); }
  },
  methods: {
    async refreshCatalog() {
      const state = states.get(this); if (!state?.alive || !state.visible || state.catalogPending) return;
      state.catalogPending = true;
      const epoch = ++state.epoch;
      try {
        const catalog = await catalogList(undefined, this);
        if (!state.alive || !state.visible || epoch !== state.epoch) return;
        const item = campaignEssence(catalog.items), slides = this.data.slides.map(slide => ({
          ...slide, price: slide.id === 'set' ? campaignPrice(item) : ''
        }));
        this.setData({ slides, productCode: item?.code ?? '' });
      } catch {
        if (state.alive && state.visible && epoch === state.epoch) {
          this.setData({ productCode: '', slides: this.data.slides.map(slide => ({ ...slide, price: '' })) });
        }
      } finally { if (epoch === state.epoch) state.catalogPending = false; }
    },
    prepareImages(current: number) {
      if (!states.get(this)?.alive) return;
      const slides = this.data.slides;
      const wanted = new Set([current, (current + 1) % slides.length, (current + 2) % slides.length]);
      if (slides.some((s, i) => wanted.has(i) && !s.requested)) {
        this.setData({ slides: slides.map((s, i) => wanted.has(i) ? { ...s, requested: true } : s) });
      }
    },
    imageResult(event: WechatMiniprogram.CustomEvent, failed: boolean) {
      const state = states.get(this), index = Number(event.currentTarget.dataset.index);
      const slide = this.data.slides[index];
      if (!state?.alive || !slide?.requested || slide.imageKey !== event.currentTarget.dataset.key
        || slide.imageAttempt !== Number(event.currentTarget.dataset.attempt)) return;
      this.setData({ [`slides[${index}].imageLoaded`]: !failed, [`slides[${index}].imageFailed`]: failed });
      // A failed photo has explicit stable native fallback and retry, not an
      // indefinitely blank slide. A pending photo never advances automatically.
      const hasPhoto = this.data.slides.some(s => s.imageLoaded);
      if (!hasPhoto) this.data.slides.forEach((_s, i) => state.rotation.setReady(i, false));
      else this.data.slides.forEach((s, i) => { if (s.imageLoaded || s.imageFailed) state.rotation.setReady(i); });
      this.prepareImages(this.data.current);
    },
    imageLoaded(event: WechatMiniprogram.CustomEvent) { this.imageResult(event, false); },
    imageFailed(event: WechatMiniprogram.CustomEvent) { this.imageResult(event, true); },
    retryImage(event: WechatMiniprogram.TouchEvent) {
      const index = Number(event.currentTarget.dataset.index), state = states.get(this), slide = this.data.slides[index];
      if (!state?.alive || !slide || this.properties.suspended) return;
      state.rotation.setReady(index, false);
      this.setData({ [`slides[${index}].requested`]: false, [`slides[${index}].imageAttempt`]: slide.imageAttempt + 1, [`slides[${index}].imageFailed`]: false,
        [`slides[${index}].imageLoaded`]: false }, () => {
        if (states.get(this)?.alive) this.setData({ [`slides[${index}].requested`]: true });
      });
    },
    touchStart(event: WechatMiniprogram.TouchEvent) {
      const state = states.get(this); if (!state) return;
      const touch = event.touches[0]; state.touch = touch ? { x: touch.pageX, y: touch.pageY } : null;
      state.rotation.beginTouch();
    },
    touchEnd(event: WechatMiniprogram.TouchEvent) {
      const state = states.get(this); if (!state) return;
      const end = event.changedTouches[0], start = state.touch; state.touch = null;
      state.rotation.endTouch(Boolean(start && end && (Math.abs(end.pageX - start.x) > 8 || Math.abs(end.pageY - start.y) > 8)));
    },
    touchCancel() { const state = states.get(this); if (state) { state.touch = null; state.rotation.endTouch(true); } },
    changed(event: WechatMiniprogram.CustomEvent<{ current: number }>) { states.get(this)?.rotation.changed(event.detail.current); },
    animationFinished(event: WechatMiniprogram.CustomEvent<{ current: number }>) { states.get(this)?.rotation.finished(event.detail.current); },
    togglePause() { const state = states.get(this); if (state) this.setData({ paused: state.rotation.togglePause() }); },
    activate(event: WechatMiniprogram.TouchEvent) {
      const index = Number(event.currentTarget.dataset.index), state = states.get(this), slide = this.data.slides[index];
      if (!slide || !state?.rotation.canActivate(index)) return;
      this.triggerEvent('activate', { destination: slide.destination, productCode: this.data.productCode });
    },
    rotationState() { return states.get(this)?.rotation.snapshot() ?? null; }
  }
});
