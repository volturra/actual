import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useResponsive } from './useResponsive';

function setWindowSize(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: height,
  });
}

function resizeWindow(width: number, height: number) {
  setWindowSize(width, height);
  window.dispatchEvent(new Event('resize'));
}

function countResizeListeners(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter(([type]) => type === 'resize').length;
}

describe('useResponsive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setWindowSize(1200, 800);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the current window size on the first render', () => {
    setWindowSize(400, 700);
    const { result } = renderHook(() => useResponsive());

    expect(result.current.width).toBe(400);
    expect(result.current.height).toBe(700);
    expect(result.current.isNarrowWidth).toBe(true);
    expect(result.current.atLeastMediumWidth).toBe(false);
  });

  it('picks up a resize that happened while nothing was subscribed', () => {
    const first = renderHook(() => useResponsive());
    expect(first.result.current.isWideWidth).toBe(true);
    first.unmount();

    // No listener is attached now, so this resize goes unnoticed...
    resizeWindow(600, 800);
    // ...but the next caller still sees the real size on its first render.
    const second = renderHook(() => useResponsive());
    expect(second.result.current.width).toBe(600);
    expect(second.result.current.isSmallWidth).toBe(true);
  });

  it('shares one resize listener and removes it with the last subscriber', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const a = renderHook(() => useResponsive());
    const b = renderHook(() => useResponsive());
    const c = renderHook(() => useResponsive());
    expect(countResizeListeners(addSpy)).toBe(1);

    a.unmount();
    b.unmount();
    expect(countResizeListeners(removeSpy)).toBe(0);

    c.unmount();
    expect(countResizeListeners(removeSpy)).toBe(1);
  });

  it('does not re-render after mount when the size is unchanged', () => {
    let renders = 0;
    function Consumer() {
      renders++;
      const { isNarrowWidth } = useResponsive();
      return <div>{isNarrowWidth ? 'narrow' : 'wide'}</div>;
    }

    render(<Consumer />);
    const rendersAfterMount = renders;

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(renders).toBe(rendersAfterMount);

    // A resize event that does not change the size does not re-render either
    act(() => {
      resizeWindow(1200, 800);
      vi.advanceTimersByTime(1000);
    });
    expect(renders).toBe(rendersAfterMount);
  });

  it('debounces resizes and switches layout across a breakpoint', () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useResponsive();
    });
    expect(result.current.isWideWidth).toBe(true);
    const rendersAfterMount = renders;

    act(() => {
      resizeWindow(900, 800);
      vi.advanceTimersByTime(100);
      resizeWindow(400, 600);
      vi.advanceTimersByTime(249);
    });
    // Still within the debounce window
    expect(result.current.width).toBe(1200);
    expect(renders).toBe(rendersAfterMount);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.width).toBe(400);
    expect(result.current.height).toBe(600);
    expect(result.current.isNarrowWidth).toBe(true);
    expect(result.current.isWideWidth).toBe(false);
    // Width and height changed in the same update, so one re-render
    expect(renders).toBe(rendersAfterMount + 1);
  });

  it('notifies every subscriber in a single update', () => {
    const a = renderHook(() => useResponsive());
    const b = renderHook(() => useResponsive());

    act(() => {
      resizeWindow(700, 500);
      vi.advanceTimersByTime(250);
    });

    expect(a.result.current.isSmallWidth).toBe(true);
    expect(b.result.current.isSmallWidth).toBe(true);
  });
});
