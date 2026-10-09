import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SheetNameProvider } from './useSheetName';
import { useSheetValue } from './useSheetValue';
import { SpreadsheetProvider, useSpreadsheet } from './useSpreadsheet';

type CellValue = { name: string; value: string | number | boolean | null };

const mocks = vi.hoisted(() => ({
  pendingGets: new Map<string, Array<(cell: CellValue) => void>>(),
  cellsChangedListeners: new Set<(cells: CellValue[]) => void>(),
}));

vi.mock('@actual-app/core/platform/client/connection', () => ({
  send: vi.fn((method: string, args: { sheetName: string; name: string }) => {
    if (method !== 'get-cell') {
      return Promise.resolve(null);
    }
    return new Promise<CellValue>(resolve => {
      const name = `${args.sheetName}!${args.name}`;
      mocks.pendingGets.set(name, [
        ...(mocks.pendingGets.get(name) ?? []),
        resolve,
      ]);
    });
  }),
  listen: vi.fn((event: string, callback: (cells: CellValue[]) => void) => {
    if (event !== 'cells-changed') {
      return vi.fn();
    }
    mocks.cellsChangedListeners.add(callback);
    return () => {
      mocks.cellsChangedListeners.delete(callback);
    };
  }),
}));

async function resolveGetCell(name: string, value: CellValue['value']) {
  const resolvers = mocks.pendingGets.get(name);
  if (!resolvers?.length) {
    throw new Error(`No pending get-cell request for ${name}`);
  }
  mocks.pendingGets.delete(name);
  await act(async () => {
    resolvers.forEach(resolve => resolve({ name, value }));
  });
}

function emitCellsChanged(cells: CellValue[]) {
  act(() => {
    mocks.cellsChangedListeners.forEach(listener => listener(cells));
  });
}

type Spreadsheet = ReturnType<typeof useSpreadsheet>;

type CellProps = {
  onChange?: (result: { name: string; value: unknown }) => void;
  onRender: (value: unknown) => void;
};

function Cell({ onChange, onRender }: CellProps) {
  const value = useSheetValue<'envelope-budget', 'to-budget'>(
    'to-budget',
    onChange,
  );
  onRender(value);
  return null;
}

type HostProps = {
  sheet: string;
  show?: boolean;
  onChange?: CellProps['onChange'];
  onRender: CellProps['onRender'];
  onSpreadsheet: (spreadsheet: Spreadsheet) => void;
};

function SpreadsheetSpy({ onSpreadsheet }: Pick<HostProps, 'onSpreadsheet'>) {
  onSpreadsheet(useSpreadsheet());
  return null;
}

function Host({
  sheet,
  show = true,
  onChange,
  onRender,
  onSpreadsheet,
}: HostProps) {
  return (
    <SpreadsheetProvider>
      <SpreadsheetSpy onSpreadsheet={onSpreadsheet} />
      {show && (
        <SheetNameProvider name={sheet}>
          <Cell onChange={onChange} onRender={onRender} />
        </SheetNameProvider>
      )}
    </SpreadsheetProvider>
  );
}

function setup(initialProps: { sheet: string; show?: boolean }) {
  // Every value the hook returned, in render order.
  const renders: unknown[] = [];
  let spreadsheet: Spreadsheet | undefined;
  const onRender = (value: unknown) => {
    renders.push(value);
  };
  const onSpreadsheet = (instance: Spreadsheet) => {
    spreadsheet = instance;
  };

  const props = { ...initialProps, onRender, onSpreadsheet };
  const result = render(<Host {...props} />);

  return {
    renders,
    getSpreadsheet() {
      if (!spreadsheet) {
        throw new Error('Spreadsheet not rendered');
      }
      return spreadsheet;
    },
    rerender(
      nextProps: Partial<Pick<HostProps, 'sheet' | 'show' | 'onChange'>>,
    ) {
      Object.assign(props, nextProps);
      result.rerender(<Host {...props} />);
    },
    unmount: result.unmount,
  };
}

function lastOf(values: unknown[]) {
  return values[values.length - 1];
}

describe('useSheetValue', () => {
  beforeEach(() => {
    mocks.pendingGets.clear();
    mocks.cellsChangedListeners.clear();
  });

  it('renders null until the value arrives on a cache miss', async () => {
    const { renders } = setup({ sheet: 'budget202401' });

    expect(renders).toEqual([null]);

    await resolveGetCell('budget202401!to-budget', 100);

    expect(lastOf(renders)).toBe(100);
  });

  it('renders the cached value on the first render on a cache hit', async () => {
    const { renders, getSpreadsheet, rerender } = setup({
      sheet: 'budget202401',
      show: false,
    });
    getSpreadsheet().prewarmCache('budget202401!to-budget', {
      name: 'budget202401!to-budget',
      value: 250,
    });

    rerender({ show: true });

    // A single render with the cached value, no null placeholder.
    expect(renders).toEqual([250]);

    // The value is still fetched and the fresh one wins.
    await resolveGetCell('budget202401!to-budget', 300);
    expect(lastOf(renders)).toBe(300);
  });

  it('switches to the cached value of the new cell when the sheet changes', async () => {
    const { renders, getSpreadsheet, rerender } = setup({
      sheet: 'budget202401',
    });
    await resolveGetCell('budget202401!to-budget', 100);
    getSpreadsheet().prewarmCache('budget202402!to-budget', {
      name: 'budget202402!to-budget',
      value: 200,
    });
    renders.length = 0;

    rerender({ sheet: 'budget202402' });

    // The previous month's value is never rendered for the new cell, and
    // the cached value is used straight away without an extra commit.
    expect(renders).not.toContain(100);
    expect(renders.every(value => value === 200)).toBe(true);
    expect(renders.length).toBeGreaterThan(0);

    // A stale cache entry is corrected by the fetched value.
    await resolveGetCell('budget202402!to-budget', 210);
    expect(lastOf(renders)).toBe(210);
  });

  it('does not render the previous cell value when the new cell is not cached', async () => {
    const { renders, rerender } = setup({ sheet: 'budget202401' });
    await resolveGetCell('budget202401!to-budget', 100);
    renders.length = 0;

    rerender({ sheet: 'budget202402' });

    expect(renders).not.toContain(100);
    expect(lastOf(renders)).toBeNull();

    await resolveGetCell('budget202402!to-budget', 200);
    expect(lastOf(renders)).toBe(200);
    expect(renders).not.toContain(100);
  });

  it('ignores a late reply for the previous cell after the sheet changed', async () => {
    const { renders, rerender } = setup({ sheet: 'budget202401' });

    rerender({ sheet: 'budget202402' });
    await resolveGetCell('budget202402!to-budget', 200);
    await resolveGetCell('budget202401!to-budget', 100);

    expect(lastOf(renders)).toBe(200);
    expect(renders).not.toContain(100);
  });

  it('receives live updates for the bound cell', async () => {
    const onChange = vi.fn();
    const { renders, rerender } = setup({ sheet: 'budget202401' });
    rerender({ onChange });
    await resolveGetCell('budget202401!to-budget', 100);

    emitCellsChanged([{ name: 'budget202401!to-budget', value: 150 }]);
    expect(lastOf(renders)).toBe(150);
    expect(onChange).toHaveBeenLastCalledWith({
      name: 'budget202401!to-budget',
      value: 150,
    });

    // Changes to other cells are ignored.
    const renderCount = renders.length;
    emitCellsChanged([{ name: 'budget202402!to-budget', value: 999 }]);
    expect(renders.length).toBe(renderCount);

    // After switching sheets, only the new cell's updates apply.
    rerender({ sheet: 'budget202402' });
    await resolveGetCell('budget202402!to-budget', 999);
    emitCellsChanged([{ name: 'budget202401!to-budget', value: 1 }]);
    expect(lastOf(renders)).toBe(999);
    emitCellsChanged([{ name: 'budget202402!to-budget', value: 1000 }]);
    expect(lastOf(renders)).toBe(1000);
  });

  it('does not re-render when an update carries the same value', async () => {
    const { renders } = setup({ sheet: 'budget202401' });
    await resolveGetCell('budget202401!to-budget', 100);
    const renderCount = renders.length;

    emitCellsChanged([{ name: 'budget202401!to-budget', value: 100 }]);

    expect(renders.length).toBe(renderCount);
  });

  it('applies an update back to the rendered value before re-rendering', async () => {
    const { renders } = setup({ sheet: 'budget202401' });
    await resolveGetCell('budget202401!to-budget', 100);

    // Two updates arrive before React renders the first one.
    act(() => {
      mocks.cellsChangedListeners.forEach(listener => {
        listener([{ name: 'budget202401!to-budget', value: 150 }]);
        listener([{ name: 'budget202401!to-budget', value: 100 }]);
      });
    });

    expect(lastOf(renders)).toBe(100);
  });

  it('keeps cached values of unobserved cells up to date', async () => {
    const { renders, getSpreadsheet, rerender } = setup({
      sheet: 'budget202401',
    });
    await resolveGetCell('budget202401!to-budget', 100);
    getSpreadsheet().prewarmCache('budget202402!to-budget', {
      name: 'budget202402!to-budget',
      value: 200,
    });

    // The prewarmed cell changes while nothing observes it.
    emitCellsChanged([{ name: 'budget202402!to-budget', value: 220 }]);
    renders.length = 0;

    rerender({ sheet: 'budget202402' });

    expect(renders).not.toContain(200);
    expect(lastOf(renders)).toBe(220);
  });

  it('unsubscribes on unmount', async () => {
    const onChange = vi.fn();
    const { renders, rerender, getSpreadsheet } = setup({
      sheet: 'budget202401',
    });
    rerender({ onChange });
    await resolveGetCell('budget202401!to-budget', 100);
    onChange.mockClear();

    rerender({ show: false });
    const renderCount = renders.length;
    emitCellsChanged([{ name: 'budget202401!to-budget', value: 150 }]);

    expect(onChange).not.toHaveBeenCalled();
    expect(renders.length).toBe(renderCount);
    // The cache still learns about the change for the next mount.
    expect(
      getSpreadsheet().getCachedValue('budget202401', 'to-budget')?.value,
    ).toBe(150);
  });
});
