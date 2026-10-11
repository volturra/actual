import { createContext, useContext, useLayoutEffect, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';

// The month shown by the mobile budget page.
//
// The category lists are react-aria collections that are rebuilt (and every
// row re-rendered) whenever an item prop or a `dependencies` entry changes.
// Passing the month as a prop would therefore rebuild every list on each month
// change. Rows read it from this context instead, so only the components that
// actually show month-dependent content re-render.
const BudgetMonthContext = createContext<string | null>(null);

// The same month, for event handlers that only need it when they run (e.g. to
// open a menu for the month that is on screen). Components that only read the
// month from here don't re-render when it changes. Never read it during render.
const BudgetMonthRefContext = createContext<RefObject<string> | null>(null);

type BudgetMonthProviderProps = {
  month: string;
  children: ReactNode;
};

export function BudgetMonthProvider({
  month,
  children,
}: BudgetMonthProviderProps) {
  const monthRef = useRef(month);
  // Updated once the new month is committed, i.e. before any handler can be
  // triggered from the newly rendered rows.
  useLayoutEffect(() => {
    monthRef.current = month;
  }, [month]);

  return (
    <BudgetMonthRefContext.Provider value={monthRef}>
      <BudgetMonthContext.Provider value={month}>
        {children}
      </BudgetMonthContext.Provider>
    </BudgetMonthRefContext.Provider>
  );
}

export function useBudgetMonth(): string {
  const month = useContext(BudgetMonthContext);
  if (month == null) {
    throw new Error('useBudgetMonth must be used within a BudgetMonthProvider');
  }
  return month;
}

export function useBudgetMonthRef(): RefObject<string> {
  const monthRef = useContext(BudgetMonthRefContext);
  if (monthRef == null) {
    throw new Error(
      'useBudgetMonthRef must be used within a BudgetMonthProvider',
    );
  }
  return monthRef;
}
