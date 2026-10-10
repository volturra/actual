import { send } from '@actual-app/core/platform/client/connection';
import type { TransactionEntity } from '@actual-app/core/types/models';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Modal } from '#modals/modalsSlice';
import { aqlQuery } from '#queries/aqlQuery';

import { useTransactionBatchActions } from './useTransactionBatchActions';

const mockDispatch = vi.fn();

vi.mock('#redux', async importOriginal => ({
  ...(await importOriginal()),
  useDispatch: () => mockDispatch,
}));

vi.mock('#queries/aqlQuery', () => ({
  aqlQuery: vi.fn(),
}));

vi.mock(
  '@actual-app/core/platform/client/connection',
  async importOriginal => ({
    ...(await importOriginal()),
    send: vi.fn(),
  }),
);

const transaction = {
  id: 'trans-1',
  account: 'acc-1',
  date: '2026-10-01',
  amount: -1000,
  category: null,
  cleared: false,
  reconciled: false,
} as unknown as TransactionEntity;

function pushedModal(): Modal {
  const action = mockDispatch.mock.calls.at(-1)?.[0];
  return action.payload.modal;
}

describe('useTransactionBatchActions onBatchEdit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aqlQuery).mockResolvedValue({
      data: [transaction],
      dependencies: [],
    });
  });

  it('tags the edit modal when the caller refetches on settle', async () => {
    const { result } = renderHook(() => useTransactionBatchActions());

    await result.current.onBatchEdit({
      name: 'category',
      ids: [transaction.id],
      refetchesOnSettled: true,
    });

    expect(pushedModal()).toMatchObject({
      name: 'category-autocomplete',
      openerRefreshes: true,
    });
  });

  it('leaves the edit modal untagged by default', async () => {
    const { result } = renderHook(() => useTransactionBatchActions());

    await result.current.onBatchEdit({ name: 'notes', ids: [transaction.id] });

    const modal = pushedModal();
    expect(modal.name).toBe('edit-field');
    expect(modal.openerRefreshes).toBeFalsy();
  });

  it('calls onSuccess and onSettled only once the change is saved', async () => {
    let finishSave: (() => void) | undefined;
    vi.mocked(send).mockImplementation(
      () =>
        new Promise(resolve => {
          finishSave = () => resolve(undefined as never);
        }),
    );
    const onSuccess = vi.fn();
    const onSettled = vi.fn();
    const { result } = renderHook(() => useTransactionBatchActions());

    await result.current.onBatchEdit({
      name: 'category',
      ids: [transaction.id],
      refetchesOnSettled: true,
      onSuccess,
      onSettled,
    });

    const modal = pushedModal();
    if (modal.name !== 'category-autocomplete') {
      throw new Error(`Unexpected modal ${modal.name}`);
    }
    const saved = modal.options.onSelect(
      'cat-1',
      'Food',
    ) as unknown as Promise<void>;

    await Promise.resolve();
    expect(send).toHaveBeenCalledWith(
      'transactions-batch-update',
      expect.objectContaining({
        updated: [
          expect.objectContaining({ id: transaction.id, category: 'cat-1' }),
        ],
      }),
    );
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();

    finishSave?.();
    await saved;
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('still calls onSettled when saving the change fails', async () => {
    const error = new Error('batch update failed');
    vi.mocked(send).mockRejectedValue(error);
    const onSuccess = vi.fn();
    const onSettled = vi.fn();
    const { result } = renderHook(() => useTransactionBatchActions());

    await result.current.onBatchEdit({
      name: 'category',
      ids: [transaction.id],
      refetchesOnSettled: true,
      onSuccess,
      onSettled,
    });

    const modal = pushedModal();
    if (modal.name !== 'category-autocomplete') {
      throw new Error(`Unexpected modal ${modal.name}`);
    }
    const saved = modal.options.onSelect(
      'cat-1',
      'Food',
    ) as unknown as Promise<void>;

    // The error still propagates as before
    await expect(saved).rejects.toBe(error);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
