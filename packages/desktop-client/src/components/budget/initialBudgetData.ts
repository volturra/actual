import { breakpoints } from '@actual-app/components/tokens';
import { listen, send } from '@actual-app/core/platform/client/connection';
import * as monthUtils from '@actual-app/core/shared/months';
import type { Handlers } from '@actual-app/core/types/handlers';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';

import { getValidMonthBounds } from './MonthsContext';
import type { MonthBounds } from './MonthsContext';

type BudgetType = NonNullable<SyncedPrefs['budgetType']>;
type MonthValues = Awaited<ReturnType<Handlers['envelope-budget-month']>>;

export type InitialBudgetData = {
  bounds: MonthBounds;
  monthValues: MonthValues[];
};

type Preload = {
  budgetId: string;
  // Null until the synced prefs arrive
  budgetType: BudgetType | null;
  startMonth: string;
  data: Promise<InitialBudgetData | null>;
  // Set when a cell of a month whose values already arrived changes, so the
  // values held here would be older than the ones the server has
  isStale: boolean;
  stopListening: () => void;
  expiry: ReturnType<typeof setTimeout>;
};

// Long enough for the budget page to mount after the budget loads, short
// enough that data nobody asked for doesn't linger
const PRELOAD_EXPIRY_MS = 30_000;

let preload: Preload | null = null;

/** The months the budget page loads into the spreadsheet before it renders. */
export function getPrewarmMonths(bounds: MonthBounds, startMonth: string) {
  const numMonths = 3;
  const { start, end } = getValidMonthBounds(
    bounds,
    monthUtils.subMonths(startMonth, 1),
    monthUtils.addMonths(startMonth, numMonths + 1),
  );
  return monthUtils.rangeInclusive(start, end);
}

/** The current values of every budget cell of `month`. */
export function getMonthValues(
  budgetType: SyncedPrefs['budgetType'],
  month: string,
): Promise<MonthValues> {
  return budgetType === 'tracking'
    ? send('tracking-budget-month', { month })
    : send('envelope-budget-month', { month });
}

function readStartMonth(budgetId: string): string {
  // Where `useLocalPref('budget.startMonth')` keeps it
  try {
    const stored = localStorage.getItem(`${budgetId}-budget.startMonth`);
    const month: unknown = stored != null ? JSON.parse(stored) : null;
    if (typeof month === 'string' && month) {
      return month;
    }
  } catch {
    // Fall back to the current month, like the budget page does
  }
  return monthUtils.currentMonth();
}

function isDesktopBudgetRoute() {
  // The desktop budget page is the only user, so don't make the backend do
  // this work ahead of what the mobile budget page or another page needs.
  const { pathname } = window.location;
  return (
    window.innerWidth >= breakpoints.small &&
    (pathname === '/' || pathname === '/budget')
  );
}

/** Drops the preloaded budget page data, if any. */
export function forgetInitialBudgetData() {
  if (preload) {
    preload.stopListening();
    clearTimeout(preload.expiry);
    preload = null;
  }
}

/**
 * Requests what the desktop budget page needs before it can render (the
 * month bounds and the values of the months around the start month) right
 * after `budgetId` is loaded. The backend answers requests in order, so this
 * puts them ahead of the sidebar's and title bar's balance queries, which
 * otherwise bind first and can take a second on a large budget.
 *
 * Nothing is cached: the budget page takes the data once, for this budget
 * only, and only if no cell of the months already answered changed since.
 */
export function preloadInitialBudgetData(budgetId: string) {
  forgetInitialBudgetData();
  if (!isDesktopBudgetRoute()) {
    return;
  }

  const startMonth = readStartMonth(budgetId);
  const answeredSheets = new Set<string>();
  const boundsRequest = send('get-budget-bounds');
  const prefsRequest = send('preferences/get');

  const current: Preload = {
    budgetId,
    budgetType: null,
    startMonth,
    data: Promise.resolve(null),
    isStale: false,
    stopListening: listen('cells-changed', nodes => {
      if (
        nodes.some(node => answeredSheets.has(node.name.split('!')[0] ?? ''))
      ) {
        current.isStale = true;
      }
    }),
    expiry: setTimeout(() => {
      if (preload === current) {
        forgetInitialBudgetData();
      }
    }, PRELOAD_EXPIRY_MS),
  };

  current.data = Promise.all([boundsRequest, prefsRequest])
    .then(([bounds, syncedPrefs]) => {
      const budgetType = syncedPrefs.budgetType ?? 'envelope';
      current.budgetType = budgetType;
      const months = getPrewarmMonths(bounds, startMonth);
      return Promise.all(
        months.map(month =>
          getMonthValues(budgetType, month).then(values => {
            answeredSheets.add(monthUtils.sheetForMonth(month));
            return values;
          }),
        ),
      ).then(monthValues => ({ bounds, monthValues }));
    })
    .catch(() => null);

  preload = current;
}

/**
 * Takes the data `preloadInitialBudgetData` requested, if it was for this
 * budget, budget type and start month. It can be taken only once. Resolves
 * to null when there is none or it may be out of date; the caller then
 * requests the data itself.
 */
export function takeInitialBudgetData({
  budgetId,
  budgetType,
  startMonth,
}: {
  budgetId: string | undefined;
  budgetType: SyncedPrefs['budgetType'];
  startMonth: string;
}): Promise<InitialBudgetData | null> {
  const taken = preload;
  if (!taken || taken.budgetId !== budgetId) {
    return Promise.resolve(null);
  }
  preload = null;
  clearTimeout(taken.expiry);

  return taken.data.then(data => {
    taken.stopListening();
    if (
      !data ||
      taken.isStale ||
      taken.budgetType !== (budgetType ?? 'envelope') ||
      taken.startMonth !== startMonth
    ) {
      return null;
    }
    return data;
  });
}
