import * as db from '#server/db';
import * as sheet from '#server/sheet';
import * as monthUtils from '#shared/months';

import { app } from './app';

beforeEach(() => {
  return global.emptyDatabase()();
});

async function setupBudget() {
  await sheet.loadSpreadsheet(db);
  await db.insertCategoryGroup({ id: 'group1', name: 'group1' });
  await db.insertCategoryGroup({ id: 'group2', name: 'income', is_income: 1 });
  await db.insertCategory({ name: 'foo', cat_group: 'group1' });
  await db.insertAccount({ id: 'acct', name: 'checking' });
  await db.insertTransaction({
    date: '2016-10-15',
    amount: -5000,
    account: 'acct',
  });
  const bounds = await app.handlers['get-budget-bounds']();
  await sheet.waitOnSpreadsheet();
  return bounds;
}

describe('budget/get-initial-data', () => {
  it('returns the bounds and the values of the months within them', async () => {
    const bounds = await setupBudget();
    const inBounds = monthUtils.rangeInclusive(bounds.start, bounds.end);
    const months = [
      monthUtils.subMonths(bounds.start, 1),
      ...inBounds,
      monthUtils.addMonths(bounds.end, 1),
    ];

    const result = await app.handlers['budget/get-initial-data']({
      budgetType: 'envelope',
      months,
    });

    const expected = [];
    for (const month of inBounds) {
      expected.push(
        ...(await app.handlers['envelope-budget-month']({ month })),
      );
    }
    expect(result.bounds).toEqual(bounds);
    expect(result.values).toEqual(expected);
    expect(result.values.length).toBeGreaterThan(0);
  });

  it('returns tracking budget values for a tracking budget', async () => {
    const bounds = await setupBudget();

    const result = await app.handlers['budget/get-initial-data']({
      budgetType: 'tracking',
      months: [bounds.end],
    });

    expect(result.values).toEqual(
      await app.handlers['tracking-budget-month']({ month: bounds.end }),
    );
  });
});
