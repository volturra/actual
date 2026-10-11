import { Text } from '@actual-app/components/text';
import { css } from '@emotion/css';
import { render } from '@testing-library/react';
import { AutoTextSize } from 'auto-text-size';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AmountAutoTextSize } from './AmountAutoTextSize';

// jsdom has no layout, so model one: a container `containerWidth` px wide and
// text that is 0.6em wide per character.
let containerWidth = 40;

type Observer = {
  callback: ResizeObserverCallback;
  observed: Element[];
  disconnected: boolean;
};
let observers: Observer[] = [];
let frames: FrameRequestCallback[] = [];

function flushFrames() {
  while (frames.length > 0) {
    const pending = frames;
    frames = [];
    pending.forEach(callback => callback(0));
  }
}

function fontSizeOf(element: Element) {
  return parseFloat(getComputedStyle(element).fontSize);
}

beforeEach(() => {
  containerWidth = 40;
  observers = [];
  frames = [];

  vi.stubGlobal(
    'ResizeObserver',
    class {
      observer: Observer;
      constructor(callback: ResizeObserverCallback) {
        this.observer = { callback, observed: [], disconnected: false };
        observers.push(this.observer);
      }
      observe(element: Element) {
        this.observer.observed.push(element);
        // Like the browser, report the initial size.
        this.observer.callback([], this as unknown as ResizeObserver);
      }
      unobserve() {
        // not used by auto-text-size
      }
      disconnect() {
        this.observer.disconnected = true;
      }
    },
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });

  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.container ? containerWidth : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(
    function (this: HTMLElement) {
      return (this.textContent ?? '').length * fontSizeOf(this) * 0.6;
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const containerStyle = { padding: 0 };
const classFontSize = css({ fontSize: 12 });

function Amount({
  text,
  fontSizeFrom = 'style',
}: {
  text: string;
  fontSizeFrom?: 'style' | 'className';
}) {
  return (
    <div data-container="true" style={containerStyle}>
      <AmountAutoTextSize
        minFontSizePx={6}
        maxFontSizePx={12}
        mode="oneline"
        data-testid="amount"
        {...(fontSizeFrom === 'style'
          ? { style: { fontSize: 12, textAlign: 'right' } }
          : { className: classFontSize })}
      >
        {text}
      </AmountAutoTextSize>
    </div>
  );
}

// What the remounting `<AutoTextSize key={value} as={Text}>` produced.
function freshFit(text: string, fontSizeFrom: 'style' | 'className') {
  const { getByTestId, unmount } = render(
    <div data-container="true" style={containerStyle}>
      <AutoTextSize
        as={Text}
        minFontSizePx={6}
        maxFontSizePx={12}
        mode="oneline"
        data-testid="fresh"
        {...(fontSizeFrom === 'style'
          ? { style: { fontSize: 12, textAlign: 'right' } }
          : { className: classFontSize })}
      >
        {text}
      </AutoTextSize>
    </div>,
  );
  flushFrames();
  const fontSize = getByTestId('fresh').style.fontSize;
  unmount();
  return fontSize;
}

describe('AmountAutoTextSize', () => {
  it('keeps the element and its observer when the text changes', () => {
    const { getByTestId, rerender } = render(<Amount text="1.00" />);
    flushFrames();
    const element = getByTestId('amount');

    rerender(<Amount text="12,345.67" />);
    flushFrames();

    expect(getByTestId('amount')).toBe(element);
    expect(element).toHaveTextContent('12,345.67');
    expect(observers).toHaveLength(1);
    expect(observers[0].disconnected).toBe(false);
  });

  it('refits when the text changes', () => {
    const { getByTestId, rerender } = render(<Amount text="1.00" />);
    flushFrames();
    const element = getByTestId('amount');
    expect(fontSizeOf(element)).toBe(12);

    rerender(<Amount text="12,345.67" />);
    expect(frames).toHaveLength(1);
    flushFrames();

    expect(fontSizeOf(element)).toBeLessThan(12);
  });

  it.each(['style', 'className'] as const)(
    'fits like a newly mounted element when the text gets longer or shorter (font size from %s)',
    fontSizeFrom => {
      const texts = ['1.00', '12,345.67', '1,234,567.89', '123.45', '0.00'];
      const { getByTestId, rerender } = render(
        <Amount text={texts[0]} fontSizeFrom={fontSizeFrom} />,
      );
      flushFrames();
      const element = getByTestId('amount');

      const fits = [element.style.fontSize];
      for (const text of texts.slice(1)) {
        rerender(<Amount text={text} fontSizeFrom={fontSizeFrom} />);
        flushFrames();
        fits.push(element.style.fontSize);
      }

      expect(fits).toEqual(texts.map(text => freshFit(text, fontSizeFrom)));
      // The longest amount had to shrink below the starting size.
      expect(parseFloat(fits[2])).toBeLessThan(parseFloat(fits[1]));
    },
  );

  it('does not refit when it re-renders with the same text', () => {
    const { rerender } = render(<Amount text="12,345.67" />);
    flushFrames();

    rerender(<Amount text="12,345.67" />);

    expect(frames).toHaveLength(0);
  });

  it('refits when the container is resized', () => {
    const { getByTestId } = render(<Amount text="12,345.67" />);
    flushFrames();
    const element = getByTestId('amount');
    const before = fontSizeOf(element);

    containerWidth = 30;
    observers[0].callback([], {} as ResizeObserver);
    flushFrames();

    expect(fontSizeOf(element)).toBeLessThan(before);
  });

  it('disconnects its observer when unmounted', () => {
    const { unmount } = render(<Amount text="1.00" />);
    flushFrames();

    unmount();

    expect(observers).toHaveLength(1);
    expect(observers[0].disconnected).toBe(true);
  });
});
