import { useSyncExternalStore } from 'react';

import { breakpoints } from '#tokens';

// Every `useResponsive` caller shares one debounced `resize` listener. A page
// can have hundreds of callers, and a per-caller listener with its own
// debounced state update made each of them re-render separately after mount.
const RESIZE_DEBOUNCE_MS = 250;

const listeners = new Set<() => void>();
let windowSize = readWindowSize();
let resizeTimer: ReturnType<typeof setTimeout> | null = null;

function readWindowSize() {
  if (typeof window === 'undefined') {
    return { width: 0, height: 0 };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

function onResize() {
  if (resizeTimer != null) {
    clearTimeout(resizeTimer);
  }
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    windowSize = readWindowSize();
    listeners.forEach(listener => listener());
  }, RESIZE_DEBOUNCE_MS);
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    // Pick up any resize that happened while nobody was listening.
    windowSize = readWindowSize();
    window.addEventListener('resize', onResize);
  }
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener('resize', onResize);
      if (resizeTimer != null) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }
    }
  };
}

function getCurrentSize() {
  // With no subscribers the cached size may be stale, so the first caller to
  // mount reads the real size and renders the right layout immediately.
  // While subscribers exist and a resize is still debouncing, a newly mounted
  // caller gets the cached (pre-resize) size instead. That keeps every caller
  // on one agreed size, and all of them converge within RESIZE_DEBOUNCE_MS.
  if (listeners.size === 0) {
    windowSize = readWindowSize();
  }
  return windowSize;
}

function getWidth() {
  return getCurrentSize().width;
}

function getHeight() {
  return getCurrentSize().height;
}

export function useResponsive() {
  // Primitive snapshots, so callers re-render only when a value changes.
  const width = useSyncExternalStore(subscribe, getWidth, getWidth);
  const height = useSyncExternalStore(subscribe, getHeight, getHeight);

  // Possible view modes: narrow, small, medium, wide
  // To check if we're at least small width, check !isNarrowWidth
  return {
    // atLeastMediumWidth is provided to avoid checking (isMediumWidth || isWideWidth)
    atLeastMediumWidth: width >= breakpoints.medium,
    isNarrowWidth: width < breakpoints.small,
    isSmallWidth: width >= breakpoints.small && width < breakpoints.medium,
    isMediumWidth: width >= breakpoints.medium && width < breakpoints.wide,
    // No atLeastWideWidth because that's identical to isWideWidth
    isWideWidth: width >= breakpoints.wide,
    height,
    width,
  };
}
