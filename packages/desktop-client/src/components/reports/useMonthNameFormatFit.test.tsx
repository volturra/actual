import { useState } from 'react';

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMonthNameFormatFit } from './useMonthNameFormatFit';

// Candidate formats, longest first, with their rendered widths in px.
const formats = [
  { format: 'MMMM yyyy', width: 120 },
  { format: 'MMM yyyy', width: 80 },
  { format: 'MMM yy', width: 60 },
  { format: 'MMM', width: 40 },
  { format: '', width: 0 },
];

let resizeCallbacks: ResizeObserverCallback[] = [];

function Harness({
  index,
  initialFormats,
}: {
  index: number;
  initialFormats: string[];
}) {
  const [monthNameFormats, setMonthNameFormats] =
    useState<string[]>(initialFormats);
  const { monthNameVisible, monthNameRef, setFormatSizeContainer } =
    useMonthNameFormatFit(index, setMonthNameFormats);

  return (
    <>
      <div ref={monthNameRef} data-testid="container" />
      {formats.map((item, idx) => (
        <span
          key={item.format}
          ref={node => setFormatSizeContainer(idx, node)}
          data-format={item.format}
          data-width={item.width}
        />
      ))}
      <output data-testid="formats">{JSON.stringify(monthNameFormats)}</output>
      <output data-testid="visible">{String(monthNameVisible)}</output>
    </>
  );
}

function setContainerSize(clientWidth: number, scrollWidth = clientWidth) {
  const container = screen.getByTestId('container');
  container.dataset.width = String(clientWidth);
  container.dataset.scrollWidth = String(scrollWidth);
}

function notifyResize() {
  const entry = { contentRect: new DOMRect() } as ResizeObserverEntry;
  resizeCallbacks.forEach(callback => callback([entry], {} as ResizeObserver));
}

function resize() {
  act(() => {
    notifyResize();
    vi.advanceTimersByTime(20);
  });
}

function renderedFormats() {
  return JSON.parse(screen.getByTestId('formats').textContent ?? '[]');
}

describe('useMonthNameFormatFit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resizeCallbacks = [];
    // Extends the no-op stub from setupTests to capture the callbacks.
    const BaseResizeObserver = globalThis.ResizeObserver;
    vi.stubGlobal(
      'ResizeObserver',
      class extends BaseResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          super(callback);
          resizeCallbacks.push(callback);
        }
      },
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
      function (this: HTMLElement) {
        return Number(this.dataset.width ?? 0);
      },
    );
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(
      function (this: HTMLElement) {
        return Number(this.dataset.scrollWidth ?? 0);
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('picks the longest format that fits and adapts when resized', () => {
    render(<Harness index={1} initialFormats={['MMM', 'MMMM yyyy']} />);

    setContainerSize(200);
    resize();
    expect(renderedFormats()).toEqual(['MMM', 'MMMM yyyy']);

    setContainerSize(70);
    resize();
    expect(renderedFormats()).toEqual(['MMM', 'MMM yy']);

    setContainerSize(45);
    resize();
    expect(renderedFormats()).toEqual(['MMM', 'MMM']);

    setContainerSize(100);
    resize();
    expect(renderedFormats()).toEqual(['MMM', 'MMM yyyy']);
    expect(screen.getByTestId('visible')).toHaveTextContent('true');
  });

  it('falls back to the empty format when no month name fits', () => {
    render(<Harness index={0} initialFormats={[]} />);

    setContainerSize(10);
    resize();
    expect(renderedFormats()).toEqual(['']);
    expect(screen.getByTestId('visible')).toHaveTextContent('true');
  });

  it('hides the month name when the container has no room at all', () => {
    render(<Harness index={0} initialFormats={['MMM']} />);

    setContainerSize(0, 30);
    resize();
    expect(renderedFormats()).toEqual(['MMM']);
    expect(screen.getByTestId('visible')).toHaveTextContent('false');

    setContainerSize(0, 0);
    resize();
    expect(screen.getByTestId('visible')).toHaveTextContent('true');
  });

  it('debounces measurements', () => {
    render(<Harness index={0} initialFormats={[]} />);

    setContainerSize(200);
    act(() => {
      notifyResize();
      vi.advanceTimersByTime(10);
    });
    expect(renderedFormats()).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(renderedFormats()).toEqual(['MMMM yyyy']);
  });
});
