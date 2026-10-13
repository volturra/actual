import { useEffect } from 'react';
import type { ReactNode } from 'react';

import { initServer } from '@actual-app/core/platform/client/connection';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TestProviders } from '#mocks';

import { AgeOfMoneyCard } from './AgeOfMoneyCard';
import { CashFlowCard } from './CashFlowCard';
import { CrossoverCard } from './CrossoverCard';
import { NetWorthCard } from './NetWorthCard';
import { SankeyCard } from './SankeyCard';
import { SummaryCard } from './SummaryCard';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

// The report queries never settle, so only the lookups before them run.
vi.mock('#queries/aqlQuery', () => ({
  aqlQuery: () => new Promise(vi.fn()),
}));

vi.mock('#components/reports/ReportCard', () => ({
  ReportCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('#hooks/useNavigate', () => ({
  useNavigate: () => vi.fn(),
}));

// Runs each card's spreadsheet function, as the real hook does, but never
// reports results, so the cards stay in their loading state.
vi.mock('#components/reports/useReport', () => ({
  useReport: (
    _sheetName: string,
    getData: ((spreadsheet: unknown, setData: () => void) => unknown) | null,
  ) => {
    useEffect(() => {
      void getData?.({}, vi.fn());
    }, [getData]);
    return null;
  },
}));

// jsdom does not implement matchMedia, which the chart animation hook uses for
// reduced-motion detection
window.matchMedia = (query: string): MediaQueryList => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(() => false),
});

let requests: Array<{ name: string; args: unknown }> = [];

function countRequests(name: string, args?: unknown) {
  return requests.filter(
    request =>
      request.name === name &&
      (args === undefined ||
        JSON.stringify(request.args) === JSON.stringify(args)),
  ).length;
}

// Answers after a short wait, as the worker does while it runs the requests
// one at a time, so requests sent while the cards mount overlap.
function record<Args, Result>(name: string, result: Result) {
  return (args?: Args) => {
    requests.push({ name, args });
    return new Promise<Result>(resolve =>
      setTimeout(() => resolve(result), 10),
    );
  };
}

beforeEach(() => {
  requests = [];
  initServer({
    'get-earliest-transaction': record('get-earliest-transaction', {
      date: '2020-01-05',
    }),
    'get-latest-transaction': record('get-latest-transaction', {
      date: '2024-06-30',
    }),
    'make-filters-from-conditions': record<unknown, { filters: unknown[] }>(
      'make-filters-from-conditions',
      { filters: [] },
    ),
  });
});

function renderDashboard() {
  const onMetaChange = vi.fn();
  render(
    <TestProviders>
      <NetWorthCard
        widgetId="net-worth"
        accounts={[]}
        onMetaChange={onMetaChange}
      />
      <CrossoverCard
        widgetId="crossover"
        accounts={[]}
        onMetaChange={onMetaChange}
      />
      <AgeOfMoneyCard widgetId="age-of-money" onMetaChange={onMetaChange} />
      <CashFlowCard widgetId="cash-flow" onMetaChange={onMetaChange} />
      <SummaryCard widgetId="summary" onMetaChange={onMetaChange} />
      <SankeyCard widgetId="sankey" onMetaChange={onMetaChange} />
    </TestProviders>,
  );
}

describe('reports dashboard cards', () => {
  it('send each distinct date and filter lookup once when they mount together', async () => {
    renderDashboard();

    await waitFor(() => {
      expect(countRequests('get-latest-transaction')).toBeGreaterThan(0);
      expect(countRequests('get-earliest-transaction')).toBeGreaterThan(0);
      expect(
        countRequests('make-filters-from-conditions', { conditions: [] }),
      ).toBeGreaterThan(0);
    });
    // Let every card finish its lookups.
    await new Promise(resolve => setTimeout(resolve, 100));

    // Without sharing: 5 latest, 3 earliest and 6 empty filter lookups.
    expect(countRequests('get-latest-transaction')).toBe(1);
    expect(countRequests('get-earliest-transaction')).toBe(1);
    // Once the latest date arrives the cards recompute their date ranges and
    // load again, so the filters are looked up once per round.
    expect(
      countRequests('make-filters-from-conditions', { conditions: [] }),
    ).toBe(2);
    expect(requests).toHaveLength(4);
  });
});
