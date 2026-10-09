import type { ReactNode } from 'react';

import {
  initServer,
  serverPush,
} from '@actual-app/core/platform/client/connection';
import type { NoteEntity } from '@actual-app/core/types/models';
import type { QueryClient } from '@tanstack/react-query';
import { act, render, renderHook, screen } from '@testing-library/react';

import { resetApp } from '#app/appSlice';
import {
  configureTestAppStore,
  createTestQueryClient,
  TestProviders,
} from '#mocks';
import { notesQueries } from '#notes';
import { mergeLocalPrefs } from '#prefs/prefsSlice';
import { listenForSyncEvent } from '#sync-events';

import { useNotes } from './useNotes';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

describe('useNotes', () => {
  let notes: NoteEntity[];
  let queryCount: number;
  let serverHandlers: Parameters<typeof initServer>[0];
  let queryClient: QueryClient;
  let store: ReturnType<typeof configureTestAppStore>;
  let unlisten: () => void;

  beforeEach(() => {
    notes = [
      { id: 'cat-1', note: 'first' },
      { id: 'cat-2', note: 'second' },
      { id: 'account-acc-1', note: 'account note' },
      { id: 'budget-2024-01', note: 'month note' },
      { id: 'cat-1-2024-01', note: 'category month note' },
    ];
    queryCount = 0;
    serverHandlers = {
      query: async () => {
        queryCount++;
        return { data: notes.map(n => ({ ...n })), dependencies: ['notes'] };
      },
      'close-budget': async () => 'ok',
    };
    initServer(serverHandlers);
    queryClient = createTestQueryClient();
    store = configureTestAppStore({ queryClient });
    store.dispatch(mergeLocalPrefs({ id: 'budget-a' }));
    unlisten = listenForSyncEvent(store, queryClient);
  });

  afterEach(() => {
    unlisten();
  });

  function wrapper({ children }: { children: ReactNode }) {
    return (
      <TestProviders queryClient={queryClient} store={store}>
        {children}
      </TestProviders>
    );
  }

  async function flush() {
    // Let the mocked server and react-query's batched notifications
    // (scheduled with setTimeout) settle
    await act(async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    });
  }

  function setNote(id: string, note: string) {
    notes = [...notes.filter(n => n.id !== id), { id, note }];
  }

  async function pushSync(
    type: 'applied' | 'success',
    tables: string[] = ['notes'],
  ) {
    serverPush('sync-event', { type, tables });
    await flush();
  }

  function observerCount() {
    return (
      queryClient
        .getQueryCache()
        .find({ queryKey: notesQueries.list().queryKey })
        ?.getObserversCount() ?? 0
    );
  }

  it('returns null while loading, then the note for each kind of id', async () => {
    const { result } = renderHook(
      () => ({
        category: useNotes('cat-1'),
        account: useNotes('account-acc-1'),
        budgetMonth: useNotes('budget-2024-01'),
        categoryMonth: useNotes('cat-1-2024-01'),
        missing: useNotes('cat-404'),
      }),
      { wrapper },
    );

    expect(result.current).toEqual({
      category: null,
      account: null,
      budgetMonth: null,
      categoryMonth: null,
      missing: null,
    });

    await flush();

    expect(result.current).toEqual({
      category: 'first',
      account: 'account note',
      budgetMonth: 'month note',
      categoryMonth: 'category month note',
      missing: null,
    });
  });

  it('runs one query for any number of consumers', async () => {
    renderHook(
      () => Array.from({ length: 200 }, (_, i) => useNotes(`cat-${i}`)),
      { wrapper },
    );
    await flush();
    expect(queryCount).toBe(1);

    // A consumer mounting later (for example the next month's buttons)
    // reads the shared data without querying again
    const { result } = renderHook(() => useNotes('cat-2'), { wrapper });
    expect(result.current).toBe('second');
    await flush();
    expect(queryCount).toBe(1);
  });

  it.each(['applied', 'success'] as const)(
    'updates when notes change (%s sync event)',
    async type => {
      const { result } = renderHook(() => useNotes('cat-1'), { wrapper });
      await flush();

      // Edited
      setNote('cat-1', 'edited');
      await pushSync(type);
      expect(result.current).toBe('edited');

      // Cleared, e.g. by undo
      notes = notes.filter(n => n.id !== 'cat-1');
      await pushSync(type);
      expect(result.current).toBeNull();

      // Created
      setNote('cat-1', 'created');
      await pushSync(type);
      expect(result.current).toBe('created');
    },
  );

  it('ignores sync events that do not touch notes', async () => {
    renderHook(() => useNotes('cat-1'), { wrapper });
    await flush();
    expect(queryCount).toBe(1);

    await pushSync('applied', ['transactions', 'categories']);
    expect(queryCount).toBe(1);
  });

  it('only re-renders consumers whose note changed', async () => {
    const renders: Record<string, number> = { 'cat-1': 0, 'cat-2': 0 };
    function Consumer({ id }: { id: string }) {
      renders[id]++;
      return <span>{useNotes(id)}</span>;
    }

    render(
      <>
        <Consumer id="cat-1" />
        <Consumer id="cat-2" />
      </>,
      { wrapper },
    );
    await flush();
    const before = { ...renders };

    setNote('cat-2', 'second edited');
    await pushSync('applied');

    expect(screen.getByText('second edited')).toBeTruthy();
    expect(renders['cat-1']).toBe(before['cat-1']);
    expect(renders['cat-2']).toBe(before['cat-2'] + 1);
  });

  it('drops its observers when the last consumer unmounts', async () => {
    const first = renderHook(() => useNotes('cat-1'), { wrapper });
    const second = renderHook(() => useNotes('cat-2'), { wrapper });
    await flush();
    expect(observerCount()).toBe(2);

    first.unmount();
    expect(observerCount()).toBe(1);
    second.unmount();
    expect(observerCount()).toBe(0);

    // With nobody listening, a notes change only marks the data stale; the
    // next consumer refetches instead of seeing the old note
    setNote('cat-1', 'changed while unmounted');
    await pushSync('applied');
    expect(queryCount).toBe(1);

    const { result } = renderHook(() => useNotes('cat-1'), { wrapper });
    await flush();
    expect(queryCount).toBe(2);
    expect(result.current).toBe('changed while unmounted');
  });

  it('ignores sync events while no budget is loaded', async () => {
    renderHook(() => useNotes('cat-1'), { wrapper });
    await flush();
    expect(queryCount).toBe(1);

    // Leaves the query cache alone, unlike closeBudget
    store.dispatch(resetApp());
    expect(store.getState().prefs.local.id).toBeUndefined();
    await pushSync('applied');
    await pushSync('success');
    expect(queryCount).toBe(1);
  });

  it('does not show notes from a previously open budget', async () => {
    const { result, unmount } = renderHook(() => useNotes('cat-1'), {
      wrapper,
    });
    await flush();
    expect(result.current).toBe('first');
    unmount();

    // setupTests loads the redux slices (through #mocks) before this file's
    // connection mock applies, so load a fresh budgetfilesSlice that uses
    // the mock, as prefsSlice.test.ts does
    vi.resetModules();
    const connection =
      await import('@actual-app/core/platform/client/connection');
    connection.initServer(serverHandlers);
    const { closeBudget } = await import('#budgetfiles/budgetfilesSlice');

    await act(() => store.dispatch(closeBudget()));
    expect(store.getState().prefs.local.id).toBeUndefined();
    store.dispatch(mergeLocalPrefs({ id: 'budget-b' }));
    notes = [{ id: 'cat-1', note: 'other budget' }];

    const reopened = renderHook(() => useNotes('cat-1'), { wrapper });
    expect(reopened.result.current).toBeNull();
    await flush();
    expect(reopened.result.current).toBe('other budget');
  });
});
