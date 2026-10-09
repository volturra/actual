/**
 * UI performance benchmarks on the large generated benchmark budget
 * (packages/loot-core/src/mocks/benchmark-budget.ts).
 *
 * Not part of the regular e2e suite (the file doesn't match `*.test.ts`).
 * From the repository root:
 *
 *   yarn lage build:browser --to=@actual-app/web
 *   E2E_USE_BUILD=1 yarn workspace @actual-app/web run e2e:bench
 *
 * Environment variables:
 * - BENCHMARK_REPS: measured repetitions per scenario (default 5)
 * - BENCHMARK_WARMUP: unmeasured repetitions before those (default 1)
 * - BENCHMARK_ONLY: comma-separated substrings of scenario names to run
 * - BENCHMARK_PROFILE=1: also record a CPU profile of one extra repetition
 *   per scenario (summarize with `node analyze-profile.mjs <file>`)
 * - BENCHMARK_OUT: output directory (default test-results/benchmarks)
 *
 * Results go to test-results/benchmarks/latest.{json,md}; compare two runs
 * with `node compare.mjs <baseline.json> <candidate.json>`.
 */
import type { Locator, Page } from '@playwright/test';

// Playwright doesn't resolve baseUrl imports here, so a relative import is needed
// oxlint-disable-next-line typescript-paths/absolute-parent-import
import { expect, test } from '../fixtures';

import {
  BenchmarkHarness,
  createBenchmarkBudget,
  RESULTS_DIR,
} from './harness';
import type { Scenario } from './harness';

const BIG_ACCOUNT = 'Chase Sapphire Visa';

async function navigate(page: Page, path: string) {
  await page.evaluate(p => {
    const nav = (window as unknown as { __navigate?: (to: string) => void })
      .__navigate;
    if (!nav) {
      throw new Error('window.__navigate is not available');
    }
    nav(p);
  }, path);
}

async function escape(page: Page, times = 1) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press('Escape');
  }
}

/**
 * Leaves cell editing mode. Escape alone closes autocompletes but keeps the
 * cell in edit mode; blurring the input ends it.
 */
async function stopEditing(page: Page) {
  await page.keyboard.press('Escape');
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await expect(
    page.locator(
      '[data-testid="budget-table"] input, [data-testid="transaction-table"] input',
    ),
  ).toHaveCount(0);
}

test('UI benchmarks', async ({ browser }) => {
  test.setTimeout(60 * 60_000);

  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const bench = await BenchmarkHarness.install(page);

  const created = await createBenchmarkBudget(page);
  bench.meta.budget = created;
  console.log('BENCH budget created in', created.wallMs, 'ms', created.timings);
  console.log('BENCH dataset', JSON.stringify(created.stats));

  const budgetTable = page.getByTestId('budget-table');
  const transactionTable = page.getByTestId('transaction-table');
  const rows = transactionTable.getByTestId('row');
  const budgetRow = (name: string) =>
    budgetTable.getByTestId('row').filter({
      has: page.getByTestId('category-name').getByText(name, { exact: true }),
    });

  const scenarios: Scenario[] = [];
  const add = (scenario: Scenario) => scenarios.push(scenario);

  // --- App load ------------------------------------------------------------
  add({
    name: 'app: load + open budget',
    reps: 3,
    warmup: 0,
    run: async () => {
      await page.reload();
      await expect(budgetTable).toBeVisible({ timeout: 60_000 });
    },
  });

  // --- Budget page -----------------------------------------------------------
  const groceriesBudget = () =>
    budgetRow('Groceries').getByTestId('budget').first();
  add({
    name: 'budget: click budgeted cell',
    setup: async () => {
      await stopEditing(page);
      await expect(groceriesBudget().locator('input')).toHaveCount(0);
    },
    run: async () => {
      await groceriesBudget().click();
      await expect(groceriesBudget().locator('input')).toBeVisible();
    },
    teardown: () => stopEditing(page),
  });
  add({
    name: 'budget: type amount + Enter',
    setup: async () => {
      await groceriesBudget().click();
      await expect(groceriesBudget().locator('input')).toBeVisible();
    },
    run: async () => {
      await page.keyboard.type('1234');
      await page.keyboard.press('Enter');
    },
    teardown: () => stopEditing(page),
  });
  add({
    name: 'budget: next month',
    run: () => page.getByTitle('Next month').click(),
    teardown: () => page.getByTitle('Previous month').click(),
  });
  add({
    name: 'budget: previous month',
    run: () => page.getByTitle('Previous month').click(),
    teardown: () => page.getByTitle('Next month').click(),
  });
  const groupName = (name: string) =>
    budgetTable.getByText(name, { exact: true }).first();
  add({
    name: 'budget: collapse group',
    run: async () => {
      await groupName('Food').click();
      await expect(budgetRow('Groceries')).toHaveCount(0);
    },
    teardown: async () => {
      await groupName('Food').click();
      await expect(budgetRow('Groceries')).toHaveCount(1);
    },
  });
  const openBudgetMenu = async () => {
    await page
      .getByTestId('budget-totals')
      .getByRole('button', { name: 'Menu' })
      .click();
  };
  add({
    name: 'budget: toggle hidden categories',
    setup: openBudgetMenu,
    run: () =>
      page.getByRole('button', { name: 'Toggle hidden categories' }).click(),
  });
  add({
    name: 'budget: scroll to bottom',
    run: async () => {
      await page
        .getByTestId('budget-table-scroll-container')
        .evaluate(el => el.scrollTo({ top: el.scrollHeight }));
    },
    teardown: async () => {
      await page
        .getByTestId('budget-table-scroll-container')
        .evaluate(el => el.scrollTo({ top: 0 }));
    },
  });

  // --- Category transactions view (click a spent amount) ---------------------
  add({
    name: 'budget: open category transactions',
    setup: async () => {
      await navigate(page, '/budget');
      await expect(budgetTable).toBeVisible();
    },
    run: async () => {
      await budgetRow('Groceries')
        .getByTestId('category-month-spent')
        .first()
        .click();
      await expect(rows.first()).toBeVisible();
    },
  });

  // --- Accounts --------------------------------------------------------------
  const accountLink = (name: string | RegExp) =>
    page.getByRole('link', { name });
  add({
    name: 'accounts: open All accounts',
    setup: async () => {
      await navigate(page, '/budget');
      await expect(budgetTable).toBeVisible();
    },
    run: async () => {
      await accountLink(/^All accounts/).click();
      await expect(rows.first()).toBeVisible();
    },
  });
  add({
    name: `accounts: open ${BIG_ACCOUNT}`,
    setup: async () => {
      await navigate(page, '/budget');
      await expect(budgetTable).toBeVisible();
    },
    run: async () => {
      await accountLink(new RegExp(`^${BIG_ACCOUNT}`)).click();
      await expect(rows.first()).toBeVisible();
    },
  });

  const cell = (row: Locator, field: string) => row.getByTestId(field);
  add({
    name: 'register: scroll',
    run: async () => {
      await transactionTable.hover();
      await page.mouse.wheel(0, 3000);
    },
  });
  add({
    name: 'register: scroll to top',
    reps: 1,
    warmup: 0,
    run: async () => {
      await transactionTable.hover();
      await page.mouse.wheel(0, -100_000);
    },
  });
  add({
    name: 'register: click payee',
    setup: async () => {
      await stopEditing(page);
      await expect(cell(rows.nth(5), 'payee').getByRole('textbox')).toHaveCount(
        0,
      );
    },
    run: async () => {
      await cell(rows.nth(5), 'payee').click();
      await expect(
        cell(rows.nth(5), 'payee').getByRole('textbox'),
      ).toBeVisible();
    },
    teardown: () => stopEditing(page),
  });
  add({
    name: 'register: type in payee autocomplete',
    setup: async () => {
      await cell(rows.nth(5), 'payee').click();
      await expect(
        cell(rows.nth(5), 'payee').getByRole('textbox'),
      ).toBeVisible();
    },
    run: () => page.keyboard.type('Sta'),
    teardown: () => stopEditing(page),
  });
  add({
    name: 'register: open category autocomplete',
    setup: () => stopEditing(page),
    run: async () => {
      await cell(rows.nth(7), 'category').click();
      await expect(
        cell(rows.nth(7), 'category').getByRole('textbox'),
      ).toBeVisible();
    },
    teardown: () => stopEditing(page),
  });
  add({
    name: 'register: select row checkbox',
    run: () => cell(rows.nth(6), 'select').click(),
    teardown: () => cell(rows.nth(6), 'select').click(),
  });
  const selectAll = () =>
    page.getByTestId('transaction-table-header').getByTestId('select').click();
  add({
    name: 'register: select all',
    run: selectAll,
    teardown: selectAll,
  });
  add({
    name: 'register: edit amount',
    setup: async () => {
      await stopEditing(page);
      await cell(rows.nth(12), 'debit').click();
      await expect(
        cell(rows.nth(12), 'debit').getByRole('textbox'),
      ).toBeVisible();
    },
    run: async () => {
      await page.keyboard.type('12.34');
      await page.keyboard.press('Enter');
    },
    teardown: () => stopEditing(page),
  });
  add({
    name: 'register: add transaction (open)',
    setup: () => stopEditing(page),
    run: async () => {
      await page.getByRole('button', { name: 'Add New' }).click();
      await expect(page.getByTestId('new-transaction')).toBeVisible();
    },
    teardown: async () => {
      await page.getByRole('button', { name: 'Cancel' }).click();
    },
  });
  add({
    name: 'register: split new transaction',
    setup: async () => {
      await page.getByRole('button', { name: 'Add New' }).click();
      const newRow = page.getByTestId('new-transaction').getByTestId('row');
      await cell(newRow.first(), 'category').click();
    },
    run: async () => {
      await page.getByTestId('split-transaction-button').click();
      await expect(
        page.getByTestId('new-transaction').getByTestId('row'),
      ).toHaveCount(3);
    },
    teardown: async () => {
      await page.getByRole('button', { name: 'Cancel' }).click();
    },
  });
  add({
    name: 'register: search',
    setup: async () => {
      await stopEditing(page);
    },
    run: async () => {
      await page.getByPlaceholder(/^Search/).fill('Kroger');
    },
    teardown: async () => {
      await page.getByPlaceholder(/^Search/).fill('');
      await expect(rows.first()).toBeVisible();
    },
  });
  add({
    name: 'register: filter by category',
    run: async () => {
      await page.getByRole('button', { name: 'Filter' }).click();
      await page
        .getByTestId('filters-select-tooltip')
        .getByRole('button', { name: 'Category' })
        .click();
      await page.keyboard.type('Restaurants');
      await page.keyboard.press('Enter');
      await page
        .getByTestId('filters-menu-tooltip')
        .getByRole('button', { name: 'Apply' })
        .click();
    },
    teardown: async () => {
      await page.getByRole('button', { name: 'Delete filter' }).first().click();
    },
  });

  // --- Payees / rules / schedules ------------------------------------------
  const tableRows = page.getByTestId('table').getByTestId('row');
  const fromBudget = async () => {
    await navigate(page, '/budget');
    await expect(budgetTable).toBeVisible();
  };
  add({
    name: 'payees: load',
    setup: fromBudget,
    run: async () => {
      await navigate(page, '/payees');
      await expect(tableRows.first()).toBeVisible();
    },
  });
  add({
    name: 'payees: search',
    run: () => page.getByPlaceholder('Filter payees...').fill('Star'),
    teardown: () => page.getByPlaceholder('Filter payees...').fill(''),
  });
  add({
    name: 'payees: select row',
    run: () => cell(tableRows.nth(3), 'select').click(),
    teardown: () => cell(tableRows.nth(3), 'select').click(),
  });
  add({
    name: 'rules: load',
    setup: fromBudget,
    run: async () => {
      await navigate(page, '/rules');
      await expect(tableRows.first()).toBeVisible();
    },
  });
  add({
    name: 'rules: search',
    run: () => page.getByPlaceholder('Filter rules...').fill('Amazon'),
    teardown: () => page.getByPlaceholder('Filter rules...').fill(''),
  });
  add({
    name: 'schedules: load',
    setup: fromBudget,
    run: async () => {
      await navigate(page, '/schedules');
      await expect(tableRows.first()).toBeVisible();
    },
  });

  // --- Reports -----------------------------------------------------------------
  const reportsPage = page.getByTestId('reports-page');
  for (const [name, path] of [
    ['reports: dashboard', '/reports'],
    ['reports: net worth', '/reports/net-worth'],
    ['reports: cash flow', '/reports/cash-flow'],
    ['reports: spending', '/reports/spending'],
    ['reports: new custom report', '/reports/custom'],
  ] as const) {
    add({
      name,
      reps: 3,
      setup: fromBudget,
      run: async () => {
        await navigate(page, path);
        await expect(reportsPage).toBeVisible();
      },
    });
  }

  // --- Command bar -------------------------------------------------------------
  const commandBar = page.getByRole('combobox', { name: 'Command Bar' });
  const closeCommandBar = async () => {
    await escape(page);
    await expect(commandBar).toBeHidden();
  };
  add({
    name: 'command bar: open',
    setup: async () => {
      if (!(await budgetTable.isVisible())) {
        await fromBudget();
      }
      await page.mouse.move(0, 0);
      await page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.blur(),
      );
    },
    run: async () => {
      await page.keyboard.press('ControlOrMeta+k');
      await expect(commandBar).toBeVisible();
    },
    teardown: closeCommandBar,
  });
  add({
    name: 'command bar: type',
    setup: async () => {
      await page.keyboard.press('ControlOrMeta+k');
      await expect(commandBar).toBeVisible();
    },
    run: () => page.keyboard.type('gro'),
    teardown: closeCommandBar,
  });

  // Comma-separated substrings of scenario names. Later scenarios rely on
  // the state earlier ones leave behind (e.g. `register:` needs one of the
  // `accounts:` scenarios first), so include those too.
  const only = process.env.BENCHMARK_ONLY?.split(',').filter(Boolean);
  for (const scenario of scenarios) {
    if (only && !only.some(part => scenario.name.includes(part))) {
      continue;
    }
    await bench.run(scenario);
  }

  bench.write();
  console.log('BENCH results written to', RESULTS_DIR);
  await page.close();
});
