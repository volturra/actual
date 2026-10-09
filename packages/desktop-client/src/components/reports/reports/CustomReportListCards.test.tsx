import React from 'react';
import type { ReactNode } from 'react';

import { initServer } from '@actual-app/core/platform/client/connection';
import * as monthUtils from '@actual-app/core/shared/months';
import type { CustomReportEntity } from '@actual-app/core/types/models';
import { render, waitFor } from '@testing-library/react';

import { TestProviders } from '#mocks';

import { CustomReportListCards } from './CustomReportListCards';
import { GetCardData } from './GetCardData';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);
vi.mock('./GetCardData', () => ({ GetCardData: vi.fn(() => null) }));
vi.mock('#components/reports/ReportCard', () => ({
  ReportCard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('#components/reports/ReportCardName', () => ({
  ReportCardName: () => null,
}));
vi.mock('#hooks/useAccounts', () => ({ useAccounts: () => ({}) }));
vi.mock('#hooks/useCategories', () => ({ useCategories: () => ({}) }));
vi.mock('#hooks/usePayees', () => ({ usePayees: () => ({}) }));

const report: CustomReportEntity = {
  id: 'report',
  name: 'Report',
  startDate: '2026-01-01',
  endDate: '2026-03-31',
  isDateStatic: false,
  dateRange: 'Last 3 months',
  mode: 'total',
  groupBy: 'Category',
  interval: 'Monthly',
  balanceType: 'Payment',
  sortBy: 'desc',
  showEmpty: false,
  showOffBudget: false,
  showHiddenCategories: false,
  showUncategorized: false,
  includeCurrentInterval: false,
  trimIntervals: false,
  showTrendLines: false,
  graphType: 'BarGraph',
  conditionsOp: 'and',
  conditions: [],
};

describe('CustomReportListCards', () => {
  it('falls back to today when the transaction dates fail to load', async () => {
    initServer({
      'get-earliest-transaction': () => {
        throw new Error('lookup failed');
      },
      'get-latest-transaction': () => {
        throw new Error('lookup failed');
      },
    });

    render(
      <TestProviders>
        <CustomReportListCards widgetId="widget" report={report} />
      </TestProviders>,
    );

    const today = monthUtils.currentDay();
    await waitFor(() =>
      expect(GetCardData).toHaveBeenLastCalledWith(
        expect.objectContaining({
          earliestTransaction: today,
          latestTransaction: today,
        }),
        undefined,
      ),
    );
  });
});
