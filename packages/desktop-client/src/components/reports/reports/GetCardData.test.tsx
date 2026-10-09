import React from 'react';

import type { CustomReportEntity } from '@actual-app/core/types/models';
import { render, waitFor } from '@testing-library/react';

import { createCustomSpreadsheet } from '#components/reports/spreadsheets/custom-spreadsheet';
import { createGroupedSpreadsheet } from '#components/reports/spreadsheets/grouped-spreadsheet';
import { SpreadsheetProvider } from '#hooks/useSpreadsheet';
import { TestProviders } from '#mocks';

import { GetCardData } from './GetCardData';

vi.mock('#components/reports/spreadsheets/custom-spreadsheet');
vi.mock('#components/reports/spreadsheets/grouped-spreadsheet');
vi.mock('#components/reports/ChooseGraph', () => ({
  ChooseGraph: () => null,
}));

const getGraphData = vi.fn(() => Promise.resolve());
const getGroupData = vi.fn(() => Promise.resolve());

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

type CardProps = Partial<{
  report: CustomReportEntity;
  latestTransaction: string;
}>;

function Card({
  report: cardReport = report,
  latestTransaction = '',
}: CardProps) {
  return (
    <TestProviders>
      <SpreadsheetProvider>
        <GetCardData
          report={cardReport}
          payees={[]}
          accounts={[]}
          categories={{ list: [], grouped: [] }}
          earliestTransaction={latestTransaction && '2025-01-15'}
          latestTransaction={latestTransaction}
        />
      </SpreadsheetProvider>
    </TestProviders>
  );
}

beforeEach(() => {
  getGraphData.mockClear();
  getGroupData.mockClear();
  vi.mocked(createCustomSpreadsheet).mockReturnValue(getGraphData);
  vi.mocked(createGroupedSpreadsheet).mockReturnValue(getGroupData);
});

describe('GetCardData', () => {
  it('waits for the transaction dates before loading a live range', async () => {
    const { rerender } = render(<Card />);

    // Give the effects a chance to run.
    await waitFor(() => expect(createCustomSpreadsheet).toHaveBeenCalled());
    expect(getGraphData).not.toHaveBeenCalled();
    expect(getGroupData).not.toHaveBeenCalled();

    rerender(<Card latestTransaction="2026-03-20" />);

    await waitFor(() => expect(getGraphData).toHaveBeenCalledTimes(1));
    expect(getGroupData).toHaveBeenCalledTimes(1);
  });

  it('loads a static range right away', async () => {
    render(<Card report={{ ...report, isDateStatic: true }} />);

    await waitFor(() => expect(getGraphData).toHaveBeenCalledTimes(1));
    expect(getGroupData).toHaveBeenCalledTimes(1);
  });
});
