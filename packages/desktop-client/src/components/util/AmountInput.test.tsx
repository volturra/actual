import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  configureTestAppStore,
  createTestQueryClient,
  TestProviders,
} from '#mocks';
import { mergeSyncedPrefs } from '#prefs/prefsSlice';

import { AmountInput } from './AmountInput';

describe('AmountInput', () => {
  it('keeps a hidden fraction until the text is edited', () => {
    const onUpdate = vi.fn();
    const queryClient = createTestQueryClient();
    const store = configureTestAppStore({ queryClient });
    store.dispatch(
      mergeSyncedPrefs({ defaultCurrencyCode: 'JPY', hideFraction: 'true' }),
    );
    render(
      <TestProviders queryClient={queryClient} store={store}>
        <AmountInput value={150050} onUpdate={onUpdate} />
      </TestProviders>,
    );
    const input = screen.getByRole('textbox');

    fireEvent.focus(input);
    fireEvent.keyUp(input, { key: 'Enter' });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: 'Make negative' }));
    // Clearing and retyping the rounded text is an edit
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.change(input, { target: { value: '1,501' } });
    fireEvent.blur(input);

    expect(onUpdate.mock.calls).toEqual([
      [150050],
      [150050],
      [-150050],
      [-150100],
    ]);
  });
});
