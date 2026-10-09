import {
  initServer,
  serverPush,
} from '@actual-app/core/platform/client/connection';
import type * as Connection from '@actual-app/core/platform/client/connection';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as BudgetFilesSlice from '#budgetfiles/budgetfilesSlice';
import { configureTestAppStore, createTestQueryClient } from '#mocks';
import { mergeLocalPrefs } from '#prefs/prefsSlice';
import type { AppStore } from '#redux/store';

import { forgetInFlightReportRequests } from './requestGeneration';
import {
  getEarliestTransaction,
  getLatestTransaction,
  makeFiltersFromConditions,
} from './sharedRequests';
import type * as SharedRequests from './sharedRequests';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

type Pending = { name: string; args: unknown; resolve: () => void };

// Each request waits until the test answers it, so requests stay in flight.
// The answer is whatever the "database" holds when the request was sent,
// which is what the worker would read.
let pending: Pending[];
let sent: Array<{ name: string; args: unknown }>;
let latestDate: string;
let earliestDate: string;
let failNext: boolean;

function answerAll() {
  const toAnswer = pending;
  pending = [];
  toAnswer.forEach(request => request.resolve());
}

function deferred<Args, Result>(name: string, read: (args?: Args) => Result) {
  return (args?: Args) => {
    sent.push({ name, args });
    // Read now: a request sees the data as of when it was sent.
    const shouldFail = failNext;
    failNext = false;
    const value = read(args);
    return new Promise<Result>((resolve, reject) => {
      pending.push({
        name,
        args,
        resolve: () =>
          shouldFail ? reject(new Error('request failed')) : resolve(value),
      });
    });
  };
}

function count(name: string) {
  return sent.filter(request => request.name === name).length;
}

function serverHandlers() {
  return {
    'get-latest-transaction': deferred('get-latest-transaction', () => ({
      date: latestDate,
    })),
    'get-earliest-transaction': deferred('get-earliest-transaction', () => ({
      date: earliestDate,
    })),
    'make-filters-from-conditions': deferred(
      'make-filters-from-conditions',
      (args?: unknown): { filters: unknown[] } => ({ filters: [{ args }] }),
    ),
    // Budget file actions
    'load-budget': async () => ({}),
    'close-budget': async () => 'ok',
    'create-budget': async () => ({}),
    'import-budget': async () => ({}),
    'load-prefs': async () => ({ id: 'budget-b' }),
    'load-global-prefs': async () => ({}),
    'preferences/get': async () => ({}),
    'get-budgets': async () => [],
    'get-remote-files': async () => [],
  };
}

beforeEach(() => {
  pending = [];
  sent = [];
  latestDate = '2024-01-31';
  earliestDate = '2020-01-01';
  failNext = false;
  initServer(serverHandlers());
});

// A failed assertion can leave a request unanswered; never let it leak into
// the next test.
afterEach(() => {
  answerAll();
  forgetInFlightReportRequests();
});

describe('shared report requests', () => {
  it('sends one request for concurrent callers and gives each its own copy', async () => {
    const calls = [
      getLatestTransaction(),
      getLatestTransaction(),
      getLatestTransaction(),
    ];
    const earliest = [getEarliestTransaction(), getEarliestTransaction()];
    await Promise.resolve();
    expect(count('get-latest-transaction')).toBe(1);
    expect(count('get-earliest-transaction')).toBe(1);

    answerAll();
    const results = await Promise.all(calls);
    expect(results).toEqual([
      { date: '2024-01-31' },
      { date: '2024-01-31' },
      { date: '2024-01-31' },
    ]);
    expect(results[0]).not.toBe(results[1]);
    expect(await Promise.all(earliest)).toEqual([
      { date: '2020-01-01' },
      { date: '2020-01-01' },
    ]);
  });

  it('shares filter lookups only between identical conditions', async () => {
    const empty = { conditions: [] };
    const onBudget = {
      conditions: [{ field: 'account', op: 'onBudget', value: '' }],
    };
    const calls = [
      ...Array.from({ length: 10 }, () => makeFiltersFromConditions(empty)),
      makeFiltersFromConditions(onBudget),
      makeFiltersFromConditions(onBudget),
    ];
    await Promise.resolve();
    expect(sent).toEqual([
      { name: 'make-filters-from-conditions', args: empty },
      { name: 'make-filters-from-conditions', args: onBudget },
    ]);

    answerAll();
    const results = await Promise.all(calls);
    expect(results[0]).toEqual({ filters: [{ args: empty }] });
    expect(results[10]).toEqual({ filters: [{ args: onBudget }] });
    // A caller changing its filters cannot change another caller's.
    results[0].filters.push('changed');
    expect(results[1]).toEqual({ filters: [{ args: empty }] });
  });

  it('keeps nothing once a request settles', async () => {
    const first = getLatestTransaction();
    await Promise.resolve();
    answerAll();
    expect(await first).toEqual({ date: '2024-01-31' });

    latestDate = '2024-02-29';
    const second = getLatestTransaction();
    await Promise.resolve();
    expect(count('get-latest-transaction')).toBe(2);
    answerAll();
    expect(await second).toEqual({ date: '2024-02-29' });
  });

  it('runs the request again after a failure', async () => {
    failNext = true;
    const failed = getLatestTransaction();
    await Promise.resolve();
    answerAll();
    await expect(failed).rejects.toThrow('request failed');

    const retry = getLatestTransaction();
    await Promise.resolve();
    answerAll();
    expect(await retry).toEqual({ date: '2024-01-31' });
    expect(count('get-latest-transaction')).toBe(2);
  });

  // Every write path (adding, editing, deleting and importing transactions,
  // applying rules, posting a schedule, a sync from another device, undo and
  // redo) reaches the client as one of these events; the loot-core test
  // `date-range-sync-events.test.ts` pins that for each path.
  it.each([
    [
      'a local write or a sync from another device',
      'sync-event',
      { type: 'applied', tables: ['transactions'] },
    ],
    ['a completed sync', 'sync-event', { type: 'success', tables: [] }],
    ['an undo or redo', 'undo-event', { tables: ['transactions'] }],
  ])(
    'a request made after %s does not join one sent before it',
    async (_, event, payload) => {
      const stale = getLatestTransaction();
      await Promise.resolve();

      // The write lands, then the client hears about it.
      latestDate = '2025-03-03';
      serverPush(event, payload);
      await Promise.resolve();

      const fresh = getLatestTransaction();
      // Requests made after the write still share with each other.
      const freshToo = getLatestTransaction();
      await Promise.resolve();
      expect(count('get-latest-transaction')).toBe(2);

      answerAll();
      expect(await stale).toEqual({ date: '2024-01-31' });
      expect(await fresh).toEqual({ date: '2025-03-03' });
      expect(await freshToo).toEqual({ date: '2025-03-03' });
    },
  );

  it('keeps sharing across sync events that change nothing', async () => {
    const first = getLatestTransaction();
    await Promise.resolve();
    serverPush('sync-event', { type: 'start' });
    await Promise.resolve();
    const second = getLatestTransaction();
    await Promise.resolve();
    expect(count('get-latest-transaction')).toBe(1);
    answerAll();
    await Promise.all([first, second]);
  });

  it('a request made after forgetting does not join one sent before', async () => {
    const stale = getEarliestTransaction();
    await Promise.resolve();
    earliestDate = '2019-05-05';
    forgetInFlightReportRequests();
    const fresh = getEarliestTransaction();
    await Promise.resolve();
    expect(count('get-earliest-transaction')).toBe(2);
    answerAll();
    expect(await stale).toEqual({ date: '2020-01-01' });
    expect(await fresh).toEqual({ date: '2019-05-05' });
  });

  describe('switching budgets', () => {
    // The test providers load the budget file actions before this file's
    // connection mock applies, so load fresh copies that use the mock.
    let slice: typeof BudgetFilesSlice;
    let shared: typeof SharedRequests;

    beforeEach(async () => {
      vi.resetModules();
      const connection: typeof Connection =
        await import('@actual-app/core/platform/client/connection');
      connection.initServer(serverHandlers());
      slice = await import('#budgetfiles/budgetfilesSlice');
      shared = await import('./sharedRequests');
    });

    function makeStore() {
      const store = configureTestAppStore({
        queryClient: createTestQueryClient(),
      });
      store.dispatch(mergeLocalPrefs({ id: 'budget-a' }));
      return store;
    }

    it.each([
      ['closing the budget', store => store.dispatch(slice.closeBudget())],
      ['closing the budget UI', store => store.dispatch(slice.closeBudgetUI())],
      [
        'loading a budget',
        store => store.dispatch(slice.loadBudget({ id: 'budget-b' })),
      ],
      ['creating a budget', store => store.dispatch(slice.createBudget({}))],
      [
        'importing a budget',
        store =>
          store.dispatch(
            slice.importBudget({ filepath: 'budget.zip', type: 'actual' }),
          ),
      ],
    ] satisfies Array<[string, (store: AppStore) => Promise<unknown>]>)(
      'a request made after %s does not join one sent before',
      async (_, switchBudget) => {
        const store = makeStore();
        const stale = shared.getLatestTransaction();
        await Promise.resolve();

        // The other budget's data.
        latestDate = '2030-12-12';
        await switchBudget(store);

        const fresh = shared.getLatestTransaction();
        await Promise.resolve();
        expect(count('get-latest-transaction')).toBe(2);

        answerAll();
        expect(await stale).toEqual({ date: '2024-01-31' });
        expect(await fresh).toEqual({ date: '2030-12-12' });
      },
    );
  });
});
