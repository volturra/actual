// @vitest-environment node
import { renderToString } from 'react-dom/server';

import { describe, expect, it } from 'vitest';

import { useResponsive } from './useResponsive';

function Consumer() {
  const { width, isNarrowWidth } = useResponsive();
  return (
    <div>
      {width} {isNarrowWidth ? 'narrow' : 'wide'}
    </div>
  );
}

describe('useResponsive without a DOM', () => {
  it('imports and server-renders without a window', () => {
    expect(typeof window).toBe('undefined');
    expect(renderToString(<Consumer />)).toContain('narrow');
  });
});
