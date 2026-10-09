import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { debounce } from 'es-toolkit/compat';

import { useMergedRefs } from '#hooks/useMergedRefs';
import { useResizeObserver } from '#hooks/useResizeObserver';

/**
 * Picks the longest month name format that fits in a calendar card's month
 * header and reports it as `monthNameFormats[index]`.
 *
 * Attach `monthNameRef` to the header container, and `setFormatSizeContainer`
 * to one hidden element per candidate format (longest first), each carrying a
 * `data-format` attribute and the formatted text to measure.
 *
 * This lives in its own hook because it reads refs inside a debounced
 * callback, which React Compiler cannot prove is never called during render.
 * Keeping it here means only this hook is left uncompiled, not the components
 * that use it.
 */
export function useMonthNameFormatFit(
  index: number,
  setMonthNameFormats: Dispatch<SetStateAction<string[]>>,
) {
  const [monthNameVisible, setMonthNameVisible] = useState(true);
  const formatSizeContainers = useRef<(HTMLSpanElement | null)[]>([]);
  const monthNameContainerRef = useRef<HTMLDivElement>(null);

  const debouncedResizeCallback = useMemo(
    () =>
      debounce(() => {
        const container = monthNameContainerRef.current;
        const containerWidth = container?.clientWidth ?? 0;

        const suitableFormat = formatSizeContainers.current
          .map(sizeContainer => ({
            width: sizeContainer?.clientWidth ?? 0,
            format: sizeContainer?.getAttribute('data-format') ?? '',
          }))
          .find(m => containerWidth > m.width);

        if (container && suitableFormat) {
          setMonthNameFormats(prev => {
            if (prev[index] === suitableFormat.format) return prev;
            // `slice` keeps the holes left for months that haven't been
            // measured yet, which the card's `reduce` skips; spreading would
            // turn them into `undefined` entries.
            const newArray = prev.slice();
            newArray[index] = suitableFormat.format;
            return newArray;
          });
          setMonthNameVisible(true);
          return;
        }

        setMonthNameVisible(
          !container || container.scrollWidth <= container.clientWidth,
        );
      }, 20),
    [index, setMonthNameFormats],
  );

  useEffect(
    () => () => debouncedResizeCallback.cancel(),
    [debouncedResizeCallback],
  );

  const monthNameResizeRef = useResizeObserver<HTMLDivElement>(
    debouncedResizeCallback,
  );
  const monthNameRef = useMergedRefs<HTMLDivElement>(
    monthNameContainerRef,
    monthNameResizeRef,
  );

  const setFormatSizeContainer = useCallback(
    (formatIndex: number, node: HTMLSpanElement | null) => {
      if (node) formatSizeContainers.current[formatIndex] = node;
    },
    [],
  );

  return { monthNameVisible, monthNameRef, setFormatSizeContainer };
}
