import type { ReactNode } from 'react';

import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as MonthNameFormatFit from '#components/reports/useMonthNameFormatFit';
import { TestProviders } from '#mocks';

import { CalendarCard } from './CalendarCard';

vi.mock('@actual-app/core/platform/client/connection', () => ({
  send: vi.fn(async () => null),
}));

vi.mock('#components/reports/ReportCard', () => ({
  ReportCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('#components/reports/graphs/CalendarGraph', () => ({
  CalendarGraph: () => null,
}));

// Every month calls this hook with its index, so this counts how often each
// month's CalendarCardInner runs.
const monthRuns = vi.hoisted(() => new Map<number, number>());

vi.mock('#components/reports/useMonthNameFormatFit', async importOriginal => {
  const actual = await importOriginal<typeof MonthNameFormatFit>();
  return {
    useMonthNameFormatFit: (
      ...args: Parameters<typeof actual.useMonthNameFormatFit>
    ) => {
      monthRuns.set(args[0], (monthRuns.get(args[0]) ?? 0) + 1);
      return actual.useMonthNameFormatFit(...args);
    },
  };
});

vi.mock('#hooks/useNavigate', () => ({
  useNavigate: () => vi.fn(),
}));

// Created once: the card resets its month name formats whenever the report
// data changes identity.
const mockReportData = vi.hoisted(() => ({
  calendarData: [0, 1, 2].map(month => {
    const start = new Date(2024, month, 1);
    return { start, end: start, data: [], totalExpense: 0, totalIncome: 0 };
  }),
}));

vi.mock('#components/reports/useReport', () => ({
  useReport: () => mockReportData,
}));

// Rendered widths, in px, of each candidate month name format.
const formatWidths: Record<string, number> = {
  'MMMM yyyy': 120,
  'MMM yyyy': 80,
  'MMM yy': 60,
  MMM: 40,
  '': 0,
};

// Elements are re-observed whenever their ref callback changes, so keep one
// entry per element.
let observed = new Map<Element, ResizeObserverCallback>();

// The month header containers, in month order: observed elements that hold
// the month name button but not the hidden format measurements.
function monthHeaders() {
  return [...observed]
    .map(([element, callback]) => ({ element, callback }))
    .filter(
      ({ element }) =>
        element.isConnected &&
        element.querySelector('button') &&
        !element.querySelector('[data-format]'),
    );
}

function reportMonthWidth(monthIndex: number, width: number) {
  const header = monthHeaders()[monthIndex];
  (header.element as HTMLElement).dataset.width = String(width);
  act(() => {
    header.callback(
      [{ contentRect: new DOMRect() } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    vi.advanceTimersByTime(20);
  });
}

function monthNames() {
  return monthHeaders().map(({ element }) => element.textContent);
}

describe('CalendarCard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    observed = new Map();
    // Extends the no-op stub from setupTests to capture what is observed.
    const BaseResizeObserver = globalThis.ResizeObserver;
    vi.stubGlobal(
      'ResizeObserver',
      class extends BaseResizeObserver {
        callback: ResizeObserverCallback;
        constructor(callback: ResizeObserverCallback) {
          super(callback);
          this.callback = callback;
        }
        observe(element: Element) {
          observed.set(element, this.callback);
        }
      },
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
      function (this: HTMLElement) {
        const format = this.getAttribute('data-format');
        if (format !== null) return formatWidths[format] ?? 0;
        return Number(this.dataset.width ?? 0);
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function renderCard() {
    render(
      <TestProviders>
        <CalendarCard widgetId="calendar" onMetaChange={vi.fn()} />
      </TestProviders>,
    );
  }

  it('starts with the full month name', () => {
    renderCard();
    expect(monthNames()).toEqual([
      'January 2024',
      'February 2024',
      'March 2024',
    ]);
  });

  it('handles one month being measured before the others', () => {
    renderCard();

    reportMonthWidth(1, 50);

    expect(monthNames()).toEqual(['Jan', 'Feb', 'Mar']);
  });

  it('shows every month in the shortest format any month needs', () => {
    renderCard();

    reportMonthWidth(0, 50);
    reportMonthWidth(1, 200);
    reportMonthWidth(2, 200);

    expect(monthNames()).toEqual(['Jan', 'Feb', 'Mar']);
  });

  it('re-renders no month when a measurement keeps the shared format', () => {
    renderCard();
    reportMonthWidth(0, 50);
    monthRuns.clear();

    // February fits the full name, but every month keeps showing 'MMM'.
    reportMonthWidth(1, 200);

    expect(monthNames()).toEqual(['Jan', 'Feb', 'Mar']);
    expect(Object.fromEntries(monthRuns)).toEqual({});
  });
});
