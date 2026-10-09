import React from 'react';
import { MemoryRouter } from 'react-router';

import { initServer } from '@actual-app/core/platform/client/connection';
import { render, waitFor } from '@testing-library/react';

import { createCustomSpreadsheet } from '#components/reports/spreadsheets/custom-spreadsheet';
import { createGroupedSpreadsheet } from '#components/reports/spreadsheets/grouped-spreadsheet';
import { SpreadsheetProvider } from '#hooks/useSpreadsheet';
import { TestProviders } from '#mocks';

import { CustomReport } from './CustomReport';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);
vi.mock('#components/reports/spreadsheets/custom-spreadsheet');
vi.mock('#components/reports/spreadsheets/grouped-spreadsheet');
vi.mock('#hooks/useReport', () => ({
  useReport: () => ({ data: undefined, isPending: false }),
}));
vi.mock('#hooks/useAccounts', () => ({ useAccounts: () => ({}) }));
vi.mock('#hooks/useCategories', () => ({ useCategories: () => ({}) }));
vi.mock('#hooks/usePayees', () => ({ usePayees: () => ({}) }));
vi.mock('#components/reports/ReportSidebar', () => ({
  ReportSidebar: () => null,
}));
vi.mock('#components/reports/ReportTopbar', () => ({
  ReportTopbar: () => null,
}));
vi.mock('#components/reports/ChooseGraph', () => ({
  ChooseGraph: () => null,
}));

const getGraphData = vi.fn(() => Promise.resolve());
const getGroupData = vi.fn(() => Promise.resolve());

beforeEach(() => {
  getGraphData.mockClear();
  getGroupData.mockClear();
  vi.mocked(createCustomSpreadsheet).mockReturnValue(getGraphData);
  vi.mocked(createGroupedSpreadsheet).mockReturnValue(getGroupData);
});

describe('CustomReport', () => {
  it('loads the graph and the table once the transaction dates are known', async () => {
    let resolveLatest: ((value: { date: string }) => void) | undefined;
    initServer({
      'get-earliest-transaction': async () => ({ date: '2025-01-15' }),
      'get-latest-transaction': () =>
        new Promise(resolve => {
          resolveLatest = resolve;
        }),
    });

    render(
      <TestProviders>
        <SpreadsheetProvider>
          <MemoryRouter initialEntries={['/reports/custom']}>
            <CustomReport />
          </MemoryRouter>
        </SpreadsheetProvider>
      </TestProviders>,
    );

    // The page builds its data functions before the dates are known, but
    // must not run them yet.
    await waitFor(() => expect(createCustomSpreadsheet).toHaveBeenCalled());
    await waitFor(() => expect(resolveLatest).toBeDefined());
    expect(getGraphData).not.toHaveBeenCalled();
    expect(getGroupData).not.toHaveBeenCalled();

    resolveLatest?.({ date: '2026-03-20' });

    await waitFor(() => expect(getGraphData).toHaveBeenCalledTimes(1));
    expect(getGroupData).toHaveBeenCalledTimes(1);

    // Nothing else changes, so nothing loads again.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(getGraphData).toHaveBeenCalledTimes(1);
    expect(getGroupData).toHaveBeenCalledTimes(1);
  });
});
