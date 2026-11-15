import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CampaignRotation, campaignDwellMs as dwell, campaignTransitionMs as duration } from '../../apps/miniprogram/services/campaign-rotation';
let rotation: CampaignRotation;
let publish = vi.fn<(index: number) => void>();
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T12:00:00Z')); publish = vi.fn<(index: number) => void>(); rotation = new CampaignRotation(4, publish); });
afterEach(() => { rotation.destroy(); vi.useRealTimers(); });
function ready() { for (let i = 0; i < 4; i++) rotation.setReady(i); }

it('does not advance to a photo that is still pending', () => {
  rotation.setReady(0); vi.advanceTimersByTime(dwell * 3); expect(publish).not.toHaveBeenCalled();
  rotation.setReady(1); vi.advanceTimersByTime(dwell - 1); expect(publish).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(publish).toHaveBeenLastCalledWith(1);
});
it('gives each settled slide a full dwell and wraps from four to one', () => {
  ready();
  for (const index of [1, 2, 3, 0]) {
    vi.advanceTimersByTime(dwell); expect(rotation.index).toBe(index); expect(rotation.canActivate(index)).toBe(false);
    vi.advanceTimersByTime(duration); rotation.finished(index); expect(rotation.canActivate(index)).toBe(true);
  }
  expect(publish.mock.calls.map(c => c[0])).toEqual([1, 2, 3, 0]);
});
it('cancels the old deadline on touch and resumes eight seconds after manual settling', () => {
  ready(); vi.advanceTimersByTime(dwell - 10); rotation.beginTouch(); vi.advanceTimersByTime(dwell * 2);
  expect(publish).not.toHaveBeenCalled(); rotation.changed(2); rotation.endTouch(true);
  vi.advanceTimersByTime(duration); rotation.finished(2); publish.mockClear();
  vi.advanceTimersByTime(dwell - 1); expect(publish).not.toHaveBeenCalled(); vi.advanceTimersByTime(1);
  expect(publish).toHaveBeenLastCalledWith(3);
});
it('resumes after a non-swiping touch without requiring a change event', () => {
  ready(); rotation.beginTouch(); vi.advanceTimersByTime(dwell); rotation.endTouch(false);
  vi.advanceTimersByTime(dwell); expect(rotation.index).toBe(1);
});
it('preserves explicit pause through manual swipes and page hide/show', () => {
  ready(); expect(rotation.togglePause()).toBe(true); rotation.beginTouch(); rotation.changed(2); rotation.endTouch(true);
  vi.advanceTimersByTime(duration); rotation.finished(2); rotation.configure({ visible: false }); rotation.configure({ visible: true });
  publish.mockClear(); vi.advanceTimersByTime(dwell * 3); expect(publish).not.toHaveBeenCalled();
  expect(rotation.togglePause()).toBe(false); vi.advanceTimersByTime(dwell); expect(rotation.index).toBe(3);
});
it.each(['visible', 'inViewport', 'suspended'] as const)('stops timers while %s blocks visibility and gives a fresh dwell on return', flag => {
  ready(); vi.advanceTimersByTime(dwell - 1);
  rotation.configure({ [flag]: flag === 'suspended' }); vi.advanceTimersByTime(dwell * 3);
  expect(publish).not.toHaveBeenCalled();
  rotation.configure({ [flag]: flag !== 'suspended' }); vi.advanceTimersByTime(dwell - 1); expect(publish).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(rotation.index).toBe(1);
});
it('keeps reduced-motion swiping available but never automatically advances', () => {
  ready(); rotation.configure({ reduced: true }); vi.advanceTimersByTime(dwell * 3); expect(publish).not.toHaveBeenCalled();
  rotation.changed(2); rotation.finished(2); expect(rotation.canActivate(2)).toBe(true);
  vi.advanceTimersByTime(dwell * 3); expect(rotation.index).toBe(2);
});
it('blocks a swipe ghost tap even if native animationfinish arrives immediately', () => {
  ready(); rotation.beginTouch(); rotation.changed(1); rotation.endTouch(true); rotation.finished(1);
  expect(rotation.canActivate(1)).toBe(false); vi.advanceTimersByTime(duration); expect(rotation.canActivate(1)).toBe(true);
  expect(rotation.canActivate(0)).toBe(false);
});
it('blocks a click whose finger landed during an automatic transition', () => {
  ready(); vi.advanceTimersByTime(dwell); rotation.beginTouch(); vi.advanceTimersByTime(duration);
  rotation.finished(1); rotation.endTouch(false); rotation.finished(1);
  expect(rotation.canActivate(1)).toBe(false); vi.advanceTimersByTime(duration); expect(rotation.canActivate(1)).toBe(true);
});
it('recovers an interrupted native gesture without accumulating interval loops', () => {
  ready(); rotation.beginTouch(); rotation.changed(1); rotation.endTouch(true);
  vi.advanceTimersByTime(duration * 3); expect(rotation.snapshot().moving).toBe(false);
  expect(vi.getTimerCount()).toBe(1); vi.advanceTimersByTime(dwell); expect(rotation.index).toBe(2);
});
it('ignores stale finish/index callbacks and all callbacks after detach', () => {
  ready(); rotation.changed(2); rotation.finished(1); expect(rotation.snapshot().moving).toBe(true);
  rotation.changed(-1); rotation.changed(5); rotation.changed(NaN); expect(rotation.index).toBe(2);
  rotation.destroy(); rotation.finished(2); rotation.setReady(3); rotation.configure({ visible: true });
  vi.advanceTimersByTime(dwell * 3); expect(publish.mock.calls).toEqual([[2]]); expect(vi.getTimerCount()).toBe(0);
});
it('does not postpone a running dwell just because another image loads', () => {
  rotation.setReady(1); vi.advanceTimersByTime(dwell - 1); rotation.setReady(3); vi.advanceTimersByTime(1);
  expect(rotation.index).toBe(1);
});
it('cancels a pending advance if its next image is explicitly retried', () => {
  ready(); vi.advanceTimersByTime(dwell - 1); rotation.setReady(1, false); vi.advanceTimersByTime(dwell);
  expect(rotation.index).toBe(0); rotation.setReady(1); vi.advanceTimersByTime(dwell); expect(rotation.index).toBe(1);
});
