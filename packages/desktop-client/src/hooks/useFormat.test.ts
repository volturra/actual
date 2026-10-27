import { createElement } from 'react';
import type { ReactNode } from 'react';

import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  configureTestAppStore,
  createTestQueryClient,
  TestProviders,
} from '#mocks';
import { mergeSyncedPrefs } from '#prefs/prefsSlice';

import { useFormat } from './useFormat';

// useFormat reads the prefs from the store
function renderWithCurrency(defaultCurrencyCode: string) {
  const queryClient = createTestQueryClient();
  const store = configureTestAppStore({ queryClient });
  store.dispatch(mergeSyncedPrefs({ defaultCurrencyCode }));
  return renderHook(() => useFormat(), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(TestProviders, { queryClient, store }, children),
  });
}

describe('useFormat', () => {
  it('reads and shows amounts ×100 in a currency without decimals', () => {
    const format = renderWithCurrency('JPY').result.current;

    expect(format(150000, 'financial')).toBe('‪¥‬1,500');
    expect(format.forEdit(150000)).toBe('1,500');
    expect(format.fromEdit('1500')).toBe(150000);
    expect(format.fromEdit(format.forEdit(150050))).toBe(150050);
  });
});
