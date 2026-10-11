import type * as Connection from '@actual-app/core/platform/client/connection';
import * as monthUtils from '@actual-app/core/shared/months';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureTestAppStore, createTestQueryClient } from '#mocks';

import type * as InitialBudgetData from './initialBudgetData';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

const START = '2024-05';
const bounds = { start: '2024-01', end: '2024-12' };
// One month before the start month to four after it, within the bounds
const prewarmedMonths = [
  '2024-04',
  '2024-05',
  '2024-06',
  '2024-07',
  '2024-08',
  '2024-09',
];

// The app store loads this module (through the budget file actions) before
// this file's connection mock applies, so each test loads fresh copies.
let initServer: typeof Connection.initServer;
let clearServer: typeof Connection.clearServer;
let serverPush: typeof Connection.serverPush;
let forgetInitialBudgetData: typeof InitialBudgetData.forgetInitialBudgetData;
let preloadInitialBudgetData: typeof InitialBudgetData.preloadInitialBudgetData;
let takeInitialBudgetData: typeof InitialBudgetData.takeInitialBudgetData;

let sent: Array<{ name: string; args: unknown }>;
let budgetType: 'envelope' | 'tracking' | undefined;

function monthValues(month: string) {
  return [
    {
      name: `${monthUtils.sheetForMonth(month)}!to-budget`,
      value: Number(month.replace('-', '')),
    },
  ];
}

function setupServer() {
  sent = [];
  // Like the backend: requests are answered in the order they were sent,
  // each reply in its own task
  const record =
    <A, T>(name: string, reply: (args: A) => T) =>
    (args?: A) => {
      sent.push({ name, args });
      return new Promise<T>(resolve =>
        setTimeout(() => resolve(reply(args as A)), 0),
      );
    };
  initServer({
    'get-budget-bounds': record('get-budget-bounds', () => bounds),
    'preferences/get': record('preferences/get', () => ({ budgetType })),
    'envelope-budget-month': record(
      'envelope-budget-month',
      ({ month }: { month: string }) => monthValues(month),
    ),
    'tracking-budget-month': record(
      'tracking-budget-month',
      ({ month }: { month: string }) => monthValues(month),
    ),
    // Budget file actions
    'load-budget': record('load-budget', () => ({})),
    'load-prefs': record('load-prefs', () => ({ id: 'budget-a' })),
    'load-global-prefs': record('load-global-prefs', () => ({})),
  });
}

function sentNames() {
  return sent.map(request => request.name);
}

function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  });
}

// Let every mock request and its follow-ups settle
async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

describe('initial budget data', () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ initServer, clearServer, serverPush } =
      await import('@actual-app/core/platform/client/connection'));
    ({
      forgetInitialBudgetData,
      preloadInitialBudgetData,
      takeInitialBudgetData,
    } = await import('./initialBudgetData'));
    budgetType = undefined;
    setupServer();
    setWidth(1024);
    window.history.replaceState(null, '', '/budget');
    localStorage.clear();
    localStorage.setItem('budget-a-budget.startMonth', JSON.stringify(START));
  });

  afterEach(async () => {
    forgetInitialBudgetData();
    await clearServer();
  });

  it('hands the budget page the data requested when the budget loaded', async () => {
    preloadInitialBudgetData('budget-a');
    await settle();

    expect(sentNames()).toEqual([
      'get-budget-bounds',
      'preferences/get',
      ...prewarmedMonths.map(() => 'envelope-budget-month'),
    ]);
    expect(sent.slice(2).map(request => request.args)).toEqual(
      prewarmedMonths.map(month => ({ month })),
    );

    const data = await takeInitialBudgetData({
      budgetId: 'budget-a',
      budgetType: undefined,
      startMonth: START,
    });
    expect(data).toEqual({
      bounds,
      monthValues: prewarmedMonths.map(monthValues),
    });
  });

  it('is requested right after the budget loads, before the prefs', async () => {
    const slice = await import('#budgetfiles/budgetfilesSlice');
    const store = configureTestAppStore({
      queryClient: createTestQueryClient(),
    });
    await store.dispatch(slice.loadBudget({ id: 'budget-a' }));

    // The backend answers in order: everything that renders once the prefs
    // are in (the sidebar's balances among them) comes after the months
    expect(sentNames()).toEqual([
      'load-budget',
      'get-budget-bounds',
      'preferences/get',
      'load-prefs',
      ...prewarmedMonths.map(() => 'envelope-budget-month'),
      'load-global-prefs',
      'preferences/get',
    ]);
    expect(
      await takeInitialBudgetData({
        budgetId: 'budget-a',
        budgetType: 'envelope',
        startMonth: START,
      }),
    ).not.toBe(null);
  });

  it('reuses a request that is still in flight', async () => {
    preloadInitialBudgetData('budget-a');
    const data = takeInitialBudgetData({
      budgetId: 'budget-a',
      budgetType: 'envelope',
      startMonth: START,
    });

    expect(await data).toEqual({
      bounds,
      monthValues: prewarmedMonths.map(monthValues),
    });
    expect(sentNames()).toHaveLength(2 + prewarmedMonths.length);
  });

  it('can be taken only once', async () => {
    preloadInitialBudgetData('budget-a');
    const take = () =>
      takeInitialBudgetData({
        budgetId: 'budget-a',
        budgetType: 'envelope',
        startMonth: START,
      });

    expect(await take()).not.toBe(null);
    expect(await take()).toBe(null);
  });

  it('uses the tracking budget months for a tracking budget', async () => {
    budgetType = 'tracking';
    preloadInitialBudgetData('budget-a');
    await settle();

    expect(sentNames().slice(2)).toEqual(
      prewarmedMonths.map(() => 'tracking-budget-month'),
    );
    expect(
      await takeInitialBudgetData({
        budgetId: 'budget-a',
        budgetType: 'tracking',
        startMonth: START,
      }),
    ).not.toBe(null);
  });

  it('starts from the current month without a stored start month', async () => {
    localStorage.clear();
    preloadInitialBudgetData('budget-a');

    expect(
      await takeInitialBudgetData({
        budgetId: 'budget-a',
        budgetType: 'envelope',
        startMonth: monthUtils.currentMonth(),
      }),
    ).not.toBe(null);
  });

  it('is not used for another budget', async () => {
    preloadInitialBudgetData('budget-a');
    await settle();

    expect(
      await takeInitialBudgetData({
        budgetId: 'budget-b',
        budgetType: 'envelope',
        startMonth: START,
      }),
    ).toBe(null);
  });

  it('is not used once another budget loads or the budget closes', async () => {
    preloadInitialBudgetData('budget-a');
    preloadInitialBudgetData('budget-b');
    expect(
      await takeInitialBudgetData({
        budgetId: 'budget-a',
        budgetType: 'envelope',
        startMonth: START,
      }),
    ).toBe(null);

    preloadInitialBudgetData('budget-a');
    forgetInitialBudgetData();
    expect(
      await takeInitialBudgetData({
        budgetId: 'budget-a',
        budgetType: 'envelope',
        startMonth: START,
      }),
    ).toBe(null);
  });

  it('is not used for another start month or budget type', async () => {
    preloadInitialBudgetData('budget-a');
    expect(
      await takeInitialBudgetData({
        budgetId: 'budget-a',
        budgetType: 'envelope',
        startMonth: '2024-06',
      }),
    ).toBe(null);

    preloadInitialBudgetData('budget-a');
    expect(
      await takeInitialBudgetData({
        budgetId: 'budget-a',
        budgetType: 'tracking',
        startMonth: START,
      }),
    ).toBe(null);
  });

  it('is not used once a cell of a month it holds changes', async () => {
    preloadInitialBudgetData('budget-a');
    await settle();

    serverPush('cells-changed', [{ name: 'budget202406!to-budget', value: 1 }]);
    await settle();

    expect(
      await takeInitialBudgetData({
        budgetId: 'budget-a',
        budgetType: 'envelope',
        startMonth: START,
      }),
    ).toBe(null);
  });

  // The month replies arrive one by one, with pushes in between
  async function preloadWithHeldMonths(heldMonths: string[]) {
    const release: Array<() => void> = [];
    initServer({
      'get-budget-bounds': async () => bounds,
      'preferences/get': async () => ({}),
      'envelope-budget-month': ({ month }: { month: string }) =>
        heldMonths.includes(month)
          ? new Promise(resolve =>
              release.push(() => resolve(monthValues(month))),
            )
          : Promise.resolve(monthValues(month)),
    });
    preloadInitialBudgetData('budget-a');
    await settle();
    return () => release.forEach(resolve => resolve());
  }

  it('is not used when a month changes between the month replies', async () => {
    // 2024-04 has been answered, the other months not yet
    const releaseOthers = await preloadWithHeldMonths(prewarmedMonths.slice(1));

    serverPush('cells-changed', [{ name: 'budget202404!to-budget', value: 1 }]);
    await settle();
    releaseOthers();

    expect(
      await takeInitialBudgetData({
        budgetId: 'budget-a',
        budgetType: 'envelope',
        startMonth: START,
      }),
    ).toBe(null);
  });

  it('is used when a month changes before its own reply', async () => {
    // The reply is read after the change, so it already includes it
    const releaseOthers = await preloadWithHeldMonths(prewarmedMonths.slice(1));

    serverPush('cells-changed', [{ name: 'budget202407!to-budget', value: 1 }]);
    await settle();
    releaseOthers();

    expect(
      await takeInitialBudgetData({
        budgetId: 'budget-a',
        budgetType: 'envelope',
        startMonth: START,
      }),
    ).not.toBe(null);
  });

  it('is still used when only cells of other sheets change', async () => {
    preloadInitialBudgetData('budget-a');
    await settle();

    serverPush('cells-changed', [
      { name: 'account!accounts-balance', value: 1 },
      { name: 'budget202301!to-budget', value: 1 },
    ]);
    await settle();

    expect(
      await takeInitialBudgetData({
        budgetId: 'budget-a',
        budgetType: 'envelope',
        startMonth: START,
      }),
    ).not.toBe(null);
  });

  it('is not used when a request fails', async () => {
    initServer({
      'get-budget-bounds': () => Promise.reject(new Error('closed')),
      'preferences/get': async () => ({}),
    });
    preloadInitialBudgetData('budget-a');

    expect(
      await takeInitialBudgetData({
        budgetId: 'budget-a',
        budgetType: 'envelope',
        startMonth: START,
      }),
    ).toBe(null);
  });

  it('requests nothing for the mobile budget page', async () => {
    setWidth(400);
    preloadInitialBudgetData('budget-a');
    await settle();

    expect(sent).toEqual([]);
  });

  it('requests nothing when the app opens on another page', async () => {
    window.history.replaceState(null, '', '/accounts');
    preloadInitialBudgetData('budget-a');
    await settle();

    expect(sent).toEqual([]);
    expect(
      await takeInitialBudgetData({
        budgetId: 'budget-a',
        budgetType: 'envelope',
        startMonth: START,
      }),
    ).toBe(null);
  });
});
