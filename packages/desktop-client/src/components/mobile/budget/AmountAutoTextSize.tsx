import { useCallback, useLayoutEffect, useRef } from 'react';
import type { ComponentProps } from 'react';

import { Text } from '@actual-app/components/text';
import { autoTextSize } from 'auto-text-size';

type FitOptions = Pick<
  Parameters<typeof autoTextSize>[0],
  'mode' | 'minFontSizePx' | 'maxFontSizePx' | 'fontSizePrecisionPx'
>;

type AmountAutoTextSizeProps = FitOptions &
  Omit<ComponentProps<typeof Text>, 'children' | 'innerRef' | 'ref'> & {
    children: string;
  };

/**
 * `<AutoTextSize as={Text}>` for an amount that changes, e.g. when switching
 * months.
 *
 * Rendering `<AutoTextSize key={value}>` remounted the element (and its
 * `ResizeObserver`) on every change so that the text was refitted from
 * scratch. This keeps the element and refits it the way a freshly mounted one
 * would be fitted:
 *
 * - `autoTextSize()` reads the starting font size from the element's computed
 *   style and only ever writes `style.fontSize` (plus `display`/`white-space`,
 *   which it sets again before measuring). `Text` turns its `style` prop into
 *   a class, so a new element has no inline font size. Clearing the inline
 *   font size therefore gives the same starting size as a new element, whether
 *   it comes from `style` or `className`.
 * - The algorithm, its options and the container element are the same, so the
 *   fit is the same.
 */
export function AmountAutoTextSize({
  mode,
  minFontSizePx,
  maxFontSizePx,
  fontSizePrecisionPx,
  children,
  ...textProps
}: AmountAutoTextSizeProps) {
  const elementRef = useRef<HTMLSpanElement | null>(null);
  const fitRef = useRef<ReturnType<typeof autoTextSize> | null>(null);

  // A new ref callback would tear down and recreate the observer, so its
  // identity must only change with the fit options.
  const ref = useCallback(
    (innerEl: HTMLSpanElement | null) => {
      const containerEl = innerEl?.parentElement;
      if (!innerEl || !containerEl) {
        return;
      }
      innerEl.style.fontSize = '';
      const fit = autoTextSize({
        innerEl,
        containerEl,
        mode,
        minFontSizePx,
        maxFontSizePx,
        fontSizePrecisionPx,
      });
      elementRef.current = innerEl;
      fitRef.current = fit;
      return () => {
        fit.disconnect();
        if (fitRef.current === fit) {
          elementRef.current = null;
          fitRef.current = null;
        }
      };
    },
    [mode, minFontSizePx, maxFontSizePx, fontSizePrecisionPx],
  );

  // Runs before paint, like the remount it replaces, so the new text is never
  // painted at the size fitted for the previous text. Only a change of the
  // text itself needs a refit: style changes keep the element's font size in
  // `AutoTextSize` too, and the container's size is watched by the observer.
  useLayoutEffect(() => {
    if (elementRef.current) {
      elementRef.current.style.fontSize = '';
    }
    fitRef.current?.();
  }, [children]);

  return (
    <Text ref={ref} {...textProps}>
      {children}
    </Text>
  );
}
