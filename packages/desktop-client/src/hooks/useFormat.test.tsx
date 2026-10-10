import React from 'react';
import type { ReactNode } from 'react';

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createTestQueryClient, TestProviders } from '#mocks';
import { mergeSyncedPrefs } from '#prefs/prefsSlice';
import { configureAppStore } from '#redux/store';

import { useFormat } from './useFormat';

describe('useFormat', () => {
  it('formats with the current number format and currency prefs', () => {
    const queryClient = createTestQueryClient();
    const store = configureAppStore({ queryClient });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TestProviders store={store} queryClient={queryClient}>
        {children}
      </TestProviders>
    );
    const { result } = renderHook(() => useFormat(), { wrapper });

    expect(result.current(123456, 'financial')).toBe('1,234.56');

    act(() => {
      store.dispatch(
        mergeSyncedPrefs({ numberFormat: 'dot-comma', hideFraction: 'true' }),
      );
    });
    expect(result.current(123456, 'financial')).toBe('1.235');

    act(() => {
      store.dispatch(
        mergeSyncedPrefs({
          hideFraction: 'false',
          defaultCurrencyCode: 'EUR',
          currencySymbolPosition: 'after',
          currencySpaceBetweenAmountAndSymbol: 'true',
        }),
      );
    });
    expect(result.current(123456, 'financial')).toBe('1.234,56 €');
  });
});
