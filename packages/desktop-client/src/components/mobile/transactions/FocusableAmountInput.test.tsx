import { setNumberFormat } from '@actual-app/core/shared/util';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  configureTestAppStore,
  createTestQueryClient,
  TestProviders,
} from '#mocks';
import { mergeSyncedPrefs } from '#prefs/prefsSlice';

import { FocusableAmountInput } from './FocusableAmountInput';

describe('FocusableAmountInput', () => {
  it('takes typed digits as whole units in a currency without decimals', () => {
    setNumberFormat({ format: 'comma-dot', hideFraction: false });
    const queryClient = createTestQueryClient();
    const store = configureTestAppStore({ queryClient });
    store.dispatch(mergeSyncedPrefs({ defaultCurrencyCode: 'JPY' }));
    render(
      <TestProviders queryClient={queryClient} store={store}>
        <FocusableAmountInput value={0} focused />
      </TestProviders>,
    );

    const input = screen.getByTestId<HTMLInputElement>('amount-input');
    for (const digit of '1500') {
      fireEvent.change(input, { target: { value: input.value + digit } });
    }
    expect(input.value).toBe('1,500');
  });
});
