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
 * - BENCHMARK_BUDGET_TYPE: `envelope` (default) or `tracking`
 * - BENCHMARK_MOBILE=0: skip the mobile scenarios
 * - BENCHMARK_NO_SETTLE=1: don't wait for the page to go quiet before each
 *   measured repetition
 * - BENCHMARK_TRACE=1: write a per-repetition event trace to traces/
 * - BENCHMARK_WORKER_PROFILE=1 (with BENCHMARK_PROFILE): also profile the
 *   backend worker
 * - BENCHMARK_DIAG=1: log the page's console errors
 *
 * Results go to test-results/benchmarks/latest.{json,md}; compare two runs
 * with `node compare.mjs <baseline.json> <candidate.json>`.
 *
 * Measured callbacks (`run`) only wait with `locator.waitFor()`: a failing
 * `expect()` poll snapshots the whole page and would be measured too.
 * Setup and teardown can use `expect()`.
 */
import type { Browser, Locator, Page } from '@playwright/test';

// Playwright doesn't resolve baseUrl imports here, so a relative import is needed
// oxlint-disable-next-line typescript-paths/absolute-parent-import
import { expect, test } from '../fixtures';

import {
  BenchmarkHarness,
  createBenchmarkBudget,
  RESULTS_DIR,
} from './harness';
import type { BenchmarkRefs, Scenario } from './harness';

const BIG_ACCOUNT = 'Chase Sapphire Visa';
const BUDGET_TYPE =
  process.env.BENCHMARK_BUDGET_TYPE === 'tracking' ? 'tracking' : 'envelope';

async function navigate(page: Page, path: string) {
  await page.evaluate(p => {
    const nav = (
      window as unknown as {
        __navigate?: (to: string, options?: { state?: unknown }) => void;
      }
    ).__navigate;
    if (!nav) {
      throw new Error('window.__navigate is not available');
    }
    // A unique state stops the app's useNavigate from turning a navigation
    // back to the previous path into history.back(), which leaves the app
    // after a reload.
    nav(p, { state: { benchmarkNavigation: performance.now() } });
  }, path);
}

async function escape(page: Page, times = 1) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press('Escape');
  }
}

async function blur(page: Page) {
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
}

/**
 * Leaves cell editing mode. Escape alone closes autocompletes but keeps the
 * cell in edit mode; blurring the input ends it.
 */
async function stopEditing(page: Page) {
  await page.keyboard.press('Escape');
  await blur(page);
  await expect(
    page.locator(
      '[data-testid="budget-table"] input, [data-testid="transaction-table"] input',
    ),
  ).toHaveCount(0);
}

/**
 * Waits until no loading spinner is left inside `container`. Report data is
 * computed in the backend, so without this the page can look idle (no
 * commits) long before the report is shown.
 */
async function waitForLoaded(page: Page, container: string) {
  // Spinners are the only infinitely repeating CSS animations in the app
  await page.waitForFunction(
    selector => {
      const root = document.querySelector(selector);
      return (
        !!root &&
        !root
          .getAnimations({ subtree: true })
          .some(a => a.effect?.getTiming().iterations === Infinity)
      );
    },
    container,
    { timeout: 120_000, polling: 'raf' },
  );
}

/** Page crashes and errors; console errors too with BENCHMARK_DIAG=1. */
function logPageProblems(page: Page, label: string) {
  page.on('crash', () => console.log(`BENCH ${label} page crashed`));
  page.on('pageerror', e =>
    console.log(`BENCH ${label} page error`, e.message.slice(0, 300)),
  );
  if (process.env.BENCHMARK_DIAG) {
    page.on('console', m => {
      if (m.type() === 'error') {
        console.log(`BENCH ${label} console error`, m.text().slice(0, 300));
      }
    });
  }
}

function money(dollars: number) {
  return dollars.toLocaleString('en-US', { minimumFractionDigits: 2 });
}

function nextMonth(month: string) {
  const [year, m] = month.split('-').map(Number);
  return m === 12
    ? `${year + 1}-01`
    : `${year}-${String(m + 1).padStart(2, '0')}`;
}

function selectScenarios(scenarios: Scenario[]) {
  // Comma-separated substrings of scenario names. Later scenarios rely on
  // the state earlier ones leave behind (e.g. `register:` needs one of the
  // `accounts:` scenarios first), so include those too.
  const only = process.env.BENCHMARK_ONLY?.split(',').filter(Boolean);
  return scenarios.filter(
    scenario => !only || only.some(part => scenario.name.includes(part)),
  );
}

test('UI benchmarks', async ({ browser }) => {
  test.setTimeout(150 * 60_000);

  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const bench = await BenchmarkHarness.install(page);
  logPageProblems(page, 'desktop');

  const created = await createBenchmarkBudget(page, {
    budgetType: BUDGET_TYPE,
  });
  bench.meta.budget = created;
  console.log('BENCH budget created in', created.wallMs, 'ms', created.timings);
  console.log('BENCH dataset', JSON.stringify(created.stats));

  for (const scenario of selectScenarios(
    desktopScenarios(page, created.refs),
  )) {
    await bench.run(scenario);
  }
  await page.close();

  if (process.env.BENCHMARK_MOBILE !== '0') {
    const mobileMeta = await runMobile(browser, bench.results);
    bench.meta.mobileBudget = mobileMeta;
  }

  bench.write();
  console.log('BENCH results written to', RESULTS_DIR);
});

function desktopScenarios(page: Page, refs: BenchmarkRefs): Scenario[] {
  const budgetTable = page.getByTestId('budget-table');
  const transactionTable = page.getByTestId('transaction-table');
  const rows = transactionTable.getByTestId('row');
  const budgetRow = (name: string) =>
    budgetTable.getByTestId('row').filter({
      has: page.getByTestId('category-name').getByText(name, { exact: true }),
    });
  const toBudgetPage = async () => {
    await navigate(page, '/budget');
    await expect(budgetTable).toBeVisible({ timeout: 60_000 });
  };

  const scenarios: Scenario[] = [];
  const add = (scenario: Scenario) => scenarios.push(scenario);

  // --- App load ------------------------------------------------------------
  add({
    name: 'app: load + open budget',
    reps: 3,
    warmup: 0,
    run: async () => {
      await page.reload();
      await budgetTable.waitFor({ timeout: 60_000 });
    },
  });

  // --- Budget page (opens on the last full month) ----------------------------
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
      await groceriesBudget().locator('input').waitFor();
    },
    teardown: () => stopEditing(page),
  });
  add({
    name: 'budget: type amount + Enter',
    setup: async () => {
      await groceriesBudget().click();
      await expect(groceriesBudget().locator('input')).toBeVisible();
    },
    run: async rep => {
      // A different amount every time; an unchanged value is a no-op
      await page.keyboard.type(String(1300 + rep));
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
      await budgetRow('Groceries').waitFor({ state: 'detached' });
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
  const toggleHidden = () =>
    page.getByRole('button', { name: 'Toggle hidden categories' });
  add({
    // Always measured showing them; the teardown hides them again
    name: 'budget: show hidden categories',
    setup: openBudgetMenu,
    run: () => toggleHidden().click(),
    teardown: async () => {
      await expect(budgetRow('Tolls')).toHaveCount(1);
      await openBudgetMenu();
      await toggleHidden().click();
      await expect(budgetRow('Tolls')).toHaveCount(0);
    },
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
  const templateMonth = nextMonth(refs.currentMonth);
  const monthMenu = async () => {
    await page
      .locator(`[data-testid="budget-summary"][data-month="${templateMonth}"]`)
      .getByRole('button', { name: 'Menu' })
      .click();
  };
  const monthMenuItem = (name: string) =>
    page.getByRole('button', { name, exact: true });
  let monthsAhead = 0;
  const backToFocusMonth = async () => {
    for (; monthsAhead > 0; monthsAhead--) {
      await page.getByTitle('Previous month').click();
    }
  };
  add({
    // The month after the current one has no budget yet, so templates fill
    // every category
    name: 'budget: apply budget templates',
    reps: 3,
    setup: async () => {
      await stopEditing(page);
      for (; monthsAhead < 2; monthsAhead++) {
        await page.getByTitle('Next month').click();
      }
      await monthMenu();
      await expect(monthMenuItem('Apply budget template')).toBeVisible();
    },
    run: () => monthMenuItem('Apply budget template').click(),
    cleanup: backToFocusMonth,
    teardown: async () => {
      // The templates were applied (Groceries has `#template 1400`)
      await expect(groceriesBudget()).toContainText(money(1400));
      await monthMenu();
      await monthMenuItem('Set budgets to zero').click();
      await backToFocusMonth();
    },
  });

  // --- Category transactions view (click a spent amount) ---------------------
  add({
    name: 'budget: open category transactions',
    setup: toBudgetPage,
    run: async () => {
      await budgetRow('Groceries')
        .getByTestId('category-month-spent')
        .first()
        .click();
      await rows.first().waitFor();
    },
  });

  // --- Accounts --------------------------------------------------------------
  const accountLink = (name: string | RegExp) =>
    page.getByRole('link', { name });
  add({
    name: 'accounts: open All accounts',
    setup: toBudgetPage,
    run: async () => {
      await accountLink(/^All accounts/).click();
      await rows.first().waitFor();
    },
  });
  add({
    name: `accounts: open ${BIG_ACCOUNT}`,
    setup: toBudgetPage,
    run: async () => {
      await accountLink(new RegExp(`^${BIG_ACCOUNT}`)).click();
      await rows.first().waitFor();
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
      await cell(rows.nth(5), 'payee').getByRole('textbox').waitFor();
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
      await cell(rows.nth(7), 'category').getByRole('textbox').waitFor();
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
    run: async rep => {
      // A different amount every time; an unchanged value is a no-op
      await page.keyboard.type(`${12 + rep}.34`);
      await page.keyboard.press('Enter');
    },
    teardown: () => stopEditing(page),
  });
  add({
    name: 'register: add transaction (open)',
    setup: () => stopEditing(page),
    run: async () => {
      await page.getByRole('button', { name: 'Add New' }).click();
      await page.getByTestId('new-transaction').waitFor();
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
      await page
        .getByTestId('new-transaction')
        .getByTestId('row')
        .nth(2)
        .waitFor();
    },
    teardown: async () => {
      await page.getByRole('button', { name: 'Cancel' }).click();
    },
  });

  const accountMenu = () =>
    page.getByRole('button', { name: 'Account menu' }).click();
  const menuItem = (name: string) =>
    page.getByRole('button', { name, exact: true });
  add({
    name: 'register: sort by payee',
    setup: () => stopEditing(page),
    run: () =>
      page
        .getByTestId('transaction-table-header')
        .getByRole('button', { name: 'Payee' })
        .click(),
    teardown: async () => {
      await accountMenu();
      await menuItem('Remove all sorting').click();
    },
  });
  const splitsButton = () =>
    page.getByRole('button', { name: /^(Collapse|Expand) split transactions/ });
  add({
    name: 'register: collapse split transactions',
    run: () => splitsButton().click(),
    teardown: () => splitsButton().click(),
  });
  const columnsModal = page.getByTestId('transaction-table-columns-modal');
  const toggleBalanceColumn = async () => {
    await accountMenu();
    await menuItem('Manage table columns').click();
    await columnsModal.locator('label[for="toggle-column-balance"]').click();
  };
  const saveColumns = () =>
    columnsModal.getByRole('button', { name: 'Save', exact: true }).click();
  add({
    name: 'register: show running balance',
    setup: async () => {
      await toggleBalanceColumn();
      await expect(
        columnsModal.locator('#toggle-column-balance'),
      ).toBeChecked();
    },
    run: async () => {
      await saveColumns();
      await columnsModal.waitFor({ state: 'hidden' });
    },
    teardown: async () => {
      await toggleBalanceColumn();
      await saveColumns();
      await expect(columnsModal).toBeHidden();
    },
  });
  add({
    name: 'register: hide reconciled',
    setup: accountMenu,
    run: () => menuItem('Hide reconciled transactions').click(),
    teardown: async () => {
      await accountMenu();
      await menuItem('Show reconciled transactions').click();
    },
  });
  add({
    name: 'register: open reconcile',
    run: async () => {
      await page.getByRole('button', { name: 'Reconcile' }).click();
      await page.locator('[data-popover]').getByRole('textbox').waitFor();
    },
    teardown: async () => {
      await escape(page);
      await expect(page.locator('[data-popover]')).toHaveCount(0);
    },
  });
  const search = () => page.getByPlaceholder(/^Search/);
  const selectButton = page.getByTestId('transactions-select-button');
  add({
    // Set the category of every Kroger transaction in the account
    name: 'register: bulk set category',
    reps: 3,
    setup: async () => {
      await stopEditing(page);
      await search().fill('Kroger');
      await expect(rows.first()).toContainText('Kroger');
      await selectAll();
      await selectButton.click();
      await page
        .getByTestId('transactions-select-tooltip')
        .getByRole('button', { name: 'Category' })
        .click();
      await expect(page.getByRole('dialog').getByRole('textbox')).toBeFocused();
    },
    run: async rep => {
      await page.keyboard.type(rep % 2 ? 'Household Supplies' : 'Groceries');
      await page.keyboard.press('Enter');
    },
    teardown: async () => {
      await expect(page.getByRole('dialog')).toHaveCount(0);
      if (await selectButton.isVisible()) {
        await selectAll();
      }
      await search().fill('');
      await expect(selectButton).toBeHidden();
    },
  });
  add({
    name: 'register: search',
    setup: async () => {
      await stopEditing(page);
    },
    run: async () => {
      await search().fill('Kroger');
    },
    teardown: async () => {
      await search().fill('');
      await expect(rows.first()).toBeVisible();
    },
  });
  const removeFilters = async () => {
    const remove = page.getByRole('button', { name: 'Delete filter' });
    while ((await remove.count()) > 0) {
      await remove.first().click();
    }
  };
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
    teardown: removeFilters,
  });
  add({
    name: 'register: apply saved filter',
    run: async () => {
      await page.getByRole('button', { name: 'Filter' }).click();
      await page
        .getByTestId('filters-select-tooltip')
        .getByRole('button', { name: /^Saved/ })
        .click();
      await page
        .getByTestId('filters-menu-tooltip')
        .getByRole('textbox')
        .click();
      await page.keyboard.type('Big restaurant');
      await page.keyboard.press('Enter');
      await page
        .getByTestId('filters-menu-tooltip')
        .getByRole('button', { name: 'Apply' })
        .click();
    },
    teardown: removeFilters,
  });

  // --- Payees / rules / schedules ------------------------------------------
  const tableRows = page.getByTestId('table').getByTestId('row');
  add({
    name: 'payees: load',
    setup: toBudgetPage,
    run: async () => {
      await navigate(page, '/payees');
      await tableRows.first().waitFor();
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
    setup: toBudgetPage,
    run: async () => {
      await navigate(page, '/rules');
      await tableRows.first().waitFor();
    },
  });
  add({
    name: 'rules: search',
    run: () => page.getByPlaceholder('Filter rules...').fill('Amazon'),
    teardown: () => page.getByPlaceholder('Filter rules...').fill(''),
  });
  add({
    name: 'schedules: load',
    setup: toBudgetPage,
    run: async () => {
      await navigate(page, '/schedules');
      await tableRows.first().waitFor();
    },
  });

  // --- Reports -----------------------------------------------------------------
  const reportsPage = page.getByTestId('reports-page');
  // [name, path, what to wait for once loaded, reps]
  const chart = reportsPage.locator('.recharts-surface').first();
  const reports: Array<[string, string, Locator?, number?]> = [
    ['reports: dashboard', '/reports'],
    ['reports: net worth', '/reports/net-worth'],
    ['reports: cash flow', '/reports/cash-flow'],
    [
      'reports: spending (last full month)',
      `/reports/spending/${refs.widgets['spending-card']}`,
    ],
    ['reports: new custom report', '/reports/custom'],
    [
      'reports: saved report, payees all time by year (table)',
      `/reports/custom/${refs.reports.payeesAllTime}`,
      reportsPage.getByText('Kroger', { exact: true }).first(),
      1,
    ],
    [
      'reports: saved report, categories 24 months (lines)',
      `/reports/custom/${refs.reports.categoryLines}`,
      chart,
    ],
    [
      'reports: saved report, categories 12 months (stacked)',
      `/reports/custom/${refs.reports.categoryStacked}`,
      chart,
    ],
    ['reports: calendar', `/reports/calendar/${refs.widgets['calendar-card']}`],
    ['reports: summary', `/reports/summary/${refs.widgets['summary-card']}`],
    [
      'reports: age of money',
      `/reports/age-of-money/${refs.widgets['age-of-money-card']}`,
    ],
    [
      'reports: crossover',
      `/reports/crossover/${refs.widgets['crossover-card']}`,
    ],
  ];
  for (const [name, path, ready, reps = 3] of reports) {
    add({
      name,
      reps,
      warmup: reps === 1 ? 0 : undefined,
      setup: toBudgetPage,
      run: async () => {
        await navigate(page, path);
        await reportsPage.waitFor();
        await waitForLoaded(page, '[data-testid="reports-page"]');
        await ready?.waitFor({ timeout: 300_000 });
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
        await toBudgetPage();
      }
      await page.mouse.move(0, 0);
      await blur(page);
    },
    run: async () => {
      await page.keyboard.press('ControlOrMeta+k');
      await commandBar.waitFor();
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

  return scenarios;
}

/**
 * Mobile scenarios run in their own phone-sized context. Its storage is
 * separate, so the budget is created again there.
 */
async function runMobile(
  browser: Browser,
  results: BenchmarkHarness['results'],
) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    // Makes the app use its fixed Playwright date, like the fixtures do
    userAgent: 'playwright',
  });
  const page = await context.newPage();
  logPageProblems(page, 'mobile');
  const bench = await BenchmarkHarness.install(page, results);
  const created = await createBenchmarkBudget(page, {
    budgetType: BUDGET_TYPE,
  });
  const { refs } = created;

  const budgetTable = page.getByTestId('budget-table');
  const transactionList = page.getByLabel('Transaction list');
  const transactions = transactionList.getByRole('button');
  const toBudgetPage = async () => {
    await navigate(page, '/budget');
    await expect(budgetTable).toBeVisible({ timeout: 60_000 });
  };
  const accountId = refs.accounts[BIG_ACCOUNT];
  const groceriesId = refs.categories.Groceries;

  const scenarios: Scenario[] = [
    {
      name: 'mobile: budget next month',
      setup: toBudgetPage,
      run: () => page.getByRole('button', { name: 'Next month' }).click(),
      teardown: () =>
        page.getByRole('button', { name: 'Previous month' }).click(),
    },
    {
      name: `mobile: open ${BIG_ACCOUNT}`,
      setup: toBudgetPage,
      run: async () => {
        await navigate(page, `/accounts/${accountId}`);
        await transactions.first().waitFor();
      },
    },
    {
      name: 'mobile: account transactions scroll',
      setup: async () => {
        const box = await transactionList.boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        }
      },
      run: () => page.mouse.wheel(0, 3000),
    },
    {
      name: 'mobile: category transactions',
      setup: toBudgetPage,
      run: async () => {
        await navigate(
          page,
          `/categories/${groceriesId}?month=${refs.focusMonth}`,
        );
        await transactions.first().waitFor();
      },
    },
    {
      name: 'mobile: payees load',
      setup: toBudgetPage,
      run: async () => {
        await navigate(page, '/payees');
        await page
          .getByRole('grid', { name: 'Payees' })
          .getByRole('gridcell')
          .first()
          .waitFor();
      },
    },
    {
      name: 'mobile: rules load',
      setup: toBudgetPage,
      run: async () => {
        await navigate(page, '/rules');
        await page
          .getByRole('grid', { name: 'Rules' })
          .getByRole('row')
          .first()
          .waitFor();
      },
    },
    // Last: reloading can leave the mobile page on a blank screen
    {
      name: 'mobile: load + open budget',
      reps: 3,
      warmup: 0,
      run: async () => {
        await page.reload();
        await budgetTable.waitFor({ timeout: 60_000 });
      },
    },
  ];

  for (const scenario of selectScenarios(scenarios)) {
    await bench.run(scenario);
  }
  await context.close();
  return { wallMs: created.wallMs, timings: created.timings };
}
