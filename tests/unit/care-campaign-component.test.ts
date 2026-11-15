import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ catalog: vi.fn(), cancel: vi.fn() }));
vi.mock('../../apps/miniprogram/services/commerce', () => ({ catalogList: m.catalog }));
vi.mock('../../apps/miniprogram/services/page-requests', () => ({ cancelPageReads: m.cancel }));
let definition: any, component: any;
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const picture = (index: number, attempt?: number) => ({ currentTarget: { dataset: { index, key: component.data.slides[index].imageKey, attempt: attempt ?? component.data.slides[index].imageAttempt } } });
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  m.catalog.mockResolvedValue({ items: [] });
  vi.stubGlobal('getApp', () => ({ globalData: { apiBaseUrl: 'https://staging-api.cisme.cn' } }));
  vi.stubGlobal('Component', (d: any) => { definition = d; });
  await import('../../apps/miniprogram/components/care-campaign/index');
  component = { properties: { suspended: false, reducedMotion: false }, data: structuredClone(definition.data), triggerEvent: vi.fn(),
    setData(patch: any, callback?: () => void) {
      for (const [path, value] of Object.entries(patch)) {
        const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.'); let target = this.data;
        for (const part of parts.slice(0, -1)) target = target[part]; target[parts.at(-1)!] = value;
      }
      callback?.();
    } };
  for (const [key, value] of Object.entries(definition.methods)) component[key] = (value as Function).bind(component);
  definition.lifetimes.attached.call(component); await flush();
});
afterEach(() => { definition?.lifetimes.detached.call(component); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('prepares following pictures and schedules native index changes after readiness', async () => {
  definition.pageLifetimes.show.call(component); await flush();
  for (let i = 0; i < 4; i++) component.imageLoaded(picture(i));
  vi.advanceTimersByTime(8000); expect(component.data.current).toBe(1);
  expect(component.data.slides.every((s: any) => s.requested)).toBe(true);
  expect(component.rotationState().moving).toBe(true);
});
it('does not issue duplicate metadata requests while one is pending', async () => {
  let resolve!: Function; m.catalog.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const before = m.catalog.mock.calls.length, pending = component.refreshCatalog();
  definition.pageLifetimes.show.call(component); expect(m.catalog).toHaveBeenCalledTimes(before + 1);
  resolve({ items: [] }); await pending;
});
it('ignores an old failed-image callback after a fresh retry is mounted', () => {
  component.imageFailed(picture(0)); expect(component.data.slides[0].imageFailed).toBe(true);
  const old = picture(0); component.retryImage({ currentTarget: { dataset: { index: 0 } } });
  component.imageLoaded(picture(0)); component.imageFailed(old);
  expect(component.data.slides[0].imageLoaded).toBe(true); expect(component.data.slides[0].imageFailed).toBe(false);
});
it('keeps the fallback still when every photograph has failed', () => {
  component.prepareImages(2);
  for (let i = 0; i < 4; i++) component.imageFailed(picture(i));
  vi.advanceTimersByTime(40_000); expect(component.data.current).toBe(0); expect(component.rotationState().timerActive).toBe(false);
  expect(component.data.slides.every((s: any) => s.imageFailed)).toBe(true);
});
it('does not overwrite current metadata with a response arriving after hide', async () => {
  let resolve!: Function; m.catalog.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const pending = component.refreshCatalog(); definition.pageLifetimes.hide.call(component);
  resolve({ items: [{ code: 'aigerong-scalp-repair-essence-100', sourceKind: 'admin', publicationStatus: 'published', qualificationStatus: 'eligible', currency: 'CNY', price: 29800 }] });
  await pending; expect(component.data.productCode).toBe(''); expect(component.data.slides[2].price).toBe('');
  expect(m.cancel).toHaveBeenCalledWith(component);
});
it('stops while a sheet is open and resumes with a complete dwell after close', () => {
  for (let i = 0; i < 4; i++) component.imageLoaded(picture(i));
  vi.advanceTimersByTime(7999); component.properties.suspended = true; definition.observers['suspended,reducedMotion'].call(component);
  vi.advanceTimersByTime(20_000); expect(component.data.current).toBe(0);
  component.activate({ currentTarget: { dataset: { index: 0 } } }); expect(component.triggerEvent).not.toHaveBeenCalled();
  component.properties.suspended = false; definition.observers['suspended,reducedMotion'].call(component);
  vi.advanceTimersByTime(7999); expect(component.data.current).toBe(0); vi.advanceTimersByTime(1); expect(component.data.current).toBe(1);
});
it('blocks gesture clicks and activates only the settled current slide', () => {
  component.touchStart({ touches: [{ pageX: 250, pageY: 150 }] }); component.changed({ detail: { current: 1 } });
  component.touchEnd({ changedTouches: [{ pageX: 80, pageY: 153 }] }); component.animationFinished({ detail: { current: 1 } });
  component.activate({ currentTarget: { dataset: { index: 1 } } }); expect(component.triggerEvent).not.toHaveBeenCalled();
  vi.advanceTimersByTime(421); component.activate({ currentTarget: { dataset: { index: 0 } } }); expect(component.triggerEvent).not.toHaveBeenCalled();
  component.activate({ currentTarget: { dataset: { index: 1 } } }); expect(component.triggerEvent).toHaveBeenCalledWith('activate', { destination: 'essence', productCode: '' });
});
it('releases all timers and observers on detach', () => {
  let observe!: Function; const disconnect = vi.fn();
  component.createIntersectionObserver = () => ({ relativeToViewport() { return this; }, observe(_selector: string, callback: Function) { observe = callback; }, disconnect });
  definition.lifetimes.ready.call(component); for (let i = 0; i < 4; i++) component.imageLoaded(picture(i));
  observe({ intersectionRatio: 0 }); vi.advanceTimersByTime(20_000); expect(component.data.current).toBe(0);
  observe({ intersectionRatio: 1 }); vi.advanceTimersByTime(8000); expect(component.data.current).toBe(1);
  definition.lifetimes.detached.call(component); expect(disconnect).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
