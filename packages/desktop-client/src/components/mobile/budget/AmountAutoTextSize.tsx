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
 * Fits an amount's text to its container like `<AutoTextSize as={Text}>`,
 * refitting the same element when the text changes (e.g. when switching
 * months) instead of remounting it.
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
      // `autoTextSize()` starts from the computed font size and only writes
      // the inline one, so clearing that starts from the size `Text` sets
      // through its `style` or `className`
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

  // Clears the old fit during the commit and requests a refit, which the
  // library runs in the next `requestAnimationFrame`, before that frame is
  // painted. Only a change of the text needs a refit: `AutoTextSize` doesn't
  // refit on style changes either, and the observer watches the container's
  // size.
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
