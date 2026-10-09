// @ts-strict-ignore
import { generateTransaction } from '#mocks';
import * as db from '#server/db';
import { q } from '#shared/query';

import { Spreadsheet } from './spreadsheet';

// Kept from before the timers are faked, to let real work happen in tests
const realSetImmediate = setImmediate;

beforeEach(global.emptyDatabase());

function wait(n) {
  return new Promise(resolve => setTimeout(resolve, n));
}

async function insertTransactions() {
  await db.insertAccount({ id: '1', name: 'checking', offbudget: 0 });
  await db.insertAccount({ id: '2', name: 'checking', offbudget: 1 });
  await db.insertCategoryGroup({ id: 'group1', name: 'group1' });
  await db.insertCategory({ id: 'cat1', name: 'cat1', cat_group: 'group1' });
  await db.insertCategory({ id: 'cat2', name: 'cat2', cat_group: 'group1' });

  await db.insertTransaction(
    generateTransaction({
      amount: -3200,
      account: '1',
      category: 'cat1',
      date: '2017-01-08',
    })[0],
  );
  await db.insertTransaction(
    generateTransaction({
      amount: -2800,
      account: '1',
      category: 'cat2',
      date: '2017-01-10',
    })[0],
  );
  await db.insertTransaction(
    generateTransaction({
      amount: -9832,
      account: '1',
      category: 'cat2',
      date: '2017-01-15',
    })[0],
  );
}

describe('Spreadsheet', () => {
  // test('min bug', () => {
  //   const spreadsheet = new Spreadsheet(db);

  //   spreadsheet.set('g!minTest', '=min(0, number(-20000))');
  //   expect(spreadsheet.getValue('g!minTest')).toBe(-20000);
  // });

  // test('cycles are detected', () => {
  //   const spreadsheet = new Spreadsheet(db);

  //   spreadsheet.startTransaction();
  //   spreadsheet.set('g!foo', '=baz');
  //   spreadsheet.set('g!bar', '=2');
  //   spreadsheet.set('g!baz', '=foo + bar');
  //   spreadsheet.endTransaction();

  //   expect(spreadsheet.getValue('g!baz')).toBe(1);
  // });

  // test('querying transactions based on date works', async () => {
  //   const spreadsheet = new Spreadsheet(db);

  //   await insertTransactions();

  //   spreadsheet.startTransaction();
  //   spreadsheet.set(
  //     'g!foo',
  //     `=from transactions
  //      where
  //        date >= 20170101 and
  //        date <= 20170131
  //      calculate { sum(amount) }`
  //   );
  //   spreadsheet.set(
  //     'g!foo1',
  //     `=from transactions
  //      where
  //        date >= 20170101 and
  //        date <= 20170131
  //      calculate { sum(amount) } + g!foo`
  //   );
  //   spreadsheet.set(
  //     'g!foo2',
  //     `=from transactions
  //      where
  //        date >= 20170101 and
  //        date <= 20170131
  //      calculate { sum(amount) } + g!foo1`
  //   );
  //   spreadsheet.set('g!foo3', '=g!foo2 / 100');
  //   spreadsheet.set('g!foo4', '=g!foo2');
  //   spreadsheet.endTransaction();

  //   return new Promise(resolve => {
  //     spreadsheet.onFinish(() => {
  //       expect(spreadsheet.getValue('g!foo3')).toBe(-474.96);
  //       expect(spreadsheet.getValue('g!foo4')).toBe(-47496);
  //       resolve();
  //     });
  //   });
  // });

  test('querying transactions works', async () => {
    const spreadsheet = new Spreadsheet(db);
    await insertTransactions();

    spreadsheet.startTransaction();
    spreadsheet.set('g!foo', `=from transactions select { amount, category }`);
    spreadsheet.endTransaction();

    return new Promise(resolve => {
      spreadsheet.onFinish(() => {
        expect(spreadsheet.getValue('g!foo')).toMatchSnapshot();
        resolve(undefined);
      });
    });
  });

  test('querying deep join works', async () => {
    const spreadsheet = new Spreadsheet(db);
    await db.insertPayee({ name: '', transfer_acct: '1' });
    await db.insertPayee({ name: '', transfer_acct: '2' });
    await insertTransactions();

    spreadsheet.set(
      'g!foo',
      '=from transactions where acct.offbudget = 0 and (description.transfer_acct.offbudget = null or description.transfer_acct.offbudget = 1) select { acct.offbudget, description.transfer_acct.offbudget as foo, amount }',
    );

    return new Promise(resolve => {
      spreadsheet.onFinish(() => {
        expect(spreadsheet.getValue('g!foo')).toMatchSnapshot();
        resolve(undefined);
      });
    });
  });

  test('async cells work', () => {
    const spreadsheet = new Spreadsheet();

    spreadsheet.createDynamic('foo', 'x', {
      initialValue: 1,
      run: async () => {
        await wait(100);
        return 5;
      },
    });

    spreadsheet.onFinish(() => {
      expect(spreadsheet.getValue('foo!x')).toBe(5);
    });

    expect(spreadsheet.getValue('foo!x')).toBe(1);
  });

  test('async cells work2', () => {
    const spreadsheet = new Spreadsheet();

    spreadsheet.transaction(() => {
      spreadsheet.createDynamic('foo', 'x', {
        initialValue: 1,
        run: async () => {
          await wait(100);
          return 5;
        },
      });

      spreadsheet.createDynamic('foo', 'y', {
        initialValue: 2,
        dependencies: ['x'],
        run: x => {
          return x * 3;
        },
      });
    });

    spreadsheet.onFinish(() => {
      expect(spreadsheet.getValue('foo!x')).toBe(5);
      expect(spreadsheet.getValue('foo!y')).toBe(15);
    });

    expect(spreadsheet.getValue('foo!x')).toBe(1);
    expect(spreadsheet.getValue('foo!y')).toBe(2);
  });

  describe('query cells', () => {
    // `setImmediate` is faked in these tests, so the sheet only resumes after
    // giving way when a test advances the timers
    async function waitUntil(condition: () => boolean) {
      for (let i = 0; i < 100 && !condition(); i++) {
        await new Promise(resolve => realSetImmediate(resolve));
      }
      expect(condition()).toBe(true);
    }

    const balances = {
      'account!balance-1': -15832,
      'account!balance-2': 1000,
    };

    function balanceQuery(account: string) {
      return q('transactions')
        .filter({ account })
        .options({ splits: 'none' })
        .calculate({ $sum: '$amount' })
        .serialize();
    }

    async function setupQueryCells() {
      await insertTransactions();
      await db.insertTransaction(
        generateTransaction({
          amount: 1000,
          account: '2',
          date: '2017-01-09',
        })[0],
      );

      const spreadsheet = new Spreadsheet();
      spreadsheet.transaction(() => {
        spreadsheet.createQuery('account', 'balance-1', balanceQuery('1'));
        spreadsheet.createQuery('account', 'balance-2', balanceQuery('2'));
      });
      return spreadsheet;
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    test('give other tasks a turn between query cells', async () => {
      const spreadsheet = await setupQueryCells();
      const onFinish = vi.fn();
      spreadsheet.onFinish(onFinish);

      await waitUntil(() => spreadsheet.pausedComputation != null);
      const [first, second] = spreadsheet.computeQueue;
      expect(spreadsheet.getValue(first)).toBe(balances[first]);
      expect(spreadsheet.getValue(second)).toBe(null);
      expect(onFinish).not.toHaveBeenCalled();

      vi.advanceTimersByTime(0);
      await waitUntil(() => !spreadsheet.running);
      expect(spreadsheet.getValue(second)).toBe(balances[second]);
      expect(onFinish).toHaveBeenCalledWith({ names: [first, second] });
    });

    test('compute other cells queued meanwhile right away', async () => {
      const spreadsheet = await setupQueryCells();
      await waitUntil(() => spreadsheet.pausedComputation != null);
      const [, second] = spreadsheet.computeQueue;

      spreadsheet.createDynamic('foo', 'x', { initialValue: 1, run: () => 5 });

      // Without any timer running: nothing gives way while `x` is pending
      await waitUntil(() => !spreadsheet.running);
      expect(spreadsheet.getValue('foo!x')).toBe(5);
      expect(spreadsheet.getValue(second)).toBe(balances[second]);
      expect(vi.getTimerCount()).toBe(0);
    });

    test('do not give way in a run that computes other cells', async () => {
      await insertTransactions();
      const spreadsheet = new Spreadsheet();
      spreadsheet.transaction(() => {
        spreadsheet.set('foo!x', 5);
        spreadsheet.createQuery('account', 'balance-1', balanceQuery('1'));
        spreadsheet.createQuery('account', 'balance-2', balanceQuery('2'));
      });
      const onFinish = vi.fn();
      spreadsheet.onFinish(onFinish);

      await waitUntil(() => onFinish.mock.calls.length > 0);
      expect(spreadsheet.getValue('account!balance-1')).toBe(-15832);
      expect(spreadsheet.getValue('account!balance-2')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    test('stop computing once unloaded', async () => {
      const spreadsheet = await setupQueryCells();
      await waitUntil(() => spreadsheet.pausedComputation != null);
      const [, second] = spreadsheet.computeQueue;

      spreadsheet.unload();
      vi.advanceTimersByTime(0);
      expect(spreadsheet.running).toBe(false);
      expect(spreadsheet.pausedComputation).toBe(null);
      expect(vi.getTimerCount()).toBe(0);
      expect(spreadsheet.getValue(second)).toBe(null);
    });

    test('stop once the query in flight when unloaded finishes', async () => {
      await insertTransactions();
      const spreadsheet = new Spreadsheet();
      spreadsheet.transaction(() => {
        spreadsheet.createQuery('account', 'balance-1', balanceQuery('1'));
        spreadsheet.createQuery('account', 'balance-2', balanceQuery('2'));
      });
      const [first, second] = spreadsheet.computeQueue;

      // The first query starts on the next tick. Close the sheet while it runs.
      await Promise.resolve();
      expect(spreadsheet.running).toBe(true);
      expect(spreadsheet.getValue(first)).toBe(null);
      spreadsheet.unload();
      await waitUntil(() => spreadsheet.getValue(first) != null);
      expect(spreadsheet.running).toBe(false);
      expect(spreadsheet.pausedComputation).toBe(null);
      expect(vi.getTimerCount()).toBe(0);
      expect(spreadsheet.getValue(second)).toBe(null);
    });

    test('recompute query cells when data changes mid-run', async () => {
      const spreadsheet = await setupQueryCells();
      await waitUntil(() => spreadsheet.pausedComputation != null);
      const [first, second] = spreadsheet.computeQueue;
      expect(spreadsheet.getValue(first)).toBe(balances[first]);
      expect(spreadsheet.getValue(second)).toBe(null);

      // A sync or undo changes both accounts while the run gives way
      for (const account of ['1', '2']) {
        await db.insertTransaction(
          generateTransaction({ amount: 500, account, date: '2017-01-10' })[0],
        );
      }
      spreadsheet.triggerDatabaseChanges(
        new Map([['transactions', new Map()]]),
        new Map(),
      );
      const onFinish = vi.fn();
      spreadsheet.onFinish(onFinish);

      for (let i = 0; i < 10 && spreadsheet.running; i++) {
        vi.advanceTimersByTime(0);
        await waitUntil(
          () => !spreadsheet.running || spreadsheet.pausedComputation != null,
        );
      }
      expect(spreadsheet.running).toBe(false);
      expect(spreadsheet.getValue(first)).toBe(balances[first] + 500);
      expect(spreadsheet.getValue(second)).toBe(balances[second] + 500);
      expect(onFinish).toHaveBeenCalledTimes(1);
    });

    // Advance through one pause, until the sheet gives way again or is done
    async function stepOnce(spreadsheet: Spreadsheet) {
      vi.advanceTimersByTime(0);
      await waitUntil(
        () => !spreadsheet.running || spreadsheet.pausedComputation != null,
      );
    }

    test('do not pile up query cells when data keeps changing', async () => {
      await insertTransactions();
      const spreadsheet = new Spreadsheet();
      const accounts = ['1', '2', '3', '4', '5'];
      spreadsheet.transaction(() => {
        for (const account of accounts) {
          spreadsheet.createQuery(
            'account',
            `balance-${account}`,
            balanceQuery(account),
          );
        }
      });
      const changes = [];
      spreadsheet.addEventListener('change', event => changes.push(event));
      const onFinish = vi.fn();
      spreadsheet.onFinish(onFinish);
      await waitUntil(() => spreadsheet.pausedComputation != null);

      // A sync keeps changing the data while the run gives way
      let longestQueue = 0;
      for (let i = 0; i < 100; i++) {
        spreadsheet.triggerDatabaseChanges(
          new Map([['transactions', new Map()]]),
          new Map(),
        );
        await waitUntil(() => spreadsheet.pausedComputation != null);
        longestQueue = Math.max(longestQueue, spreadsheet.computeQueue.length);
        await stepOnce(spreadsheet);
      }
      expect(longestQueue).toBeLessThanOrEqual(3 * accounts.length);
      expect(changes.length).toBeGreaterThan(0);
      expect(onFinish).toHaveBeenCalledTimes(1);

      for (let i = 0; i < 20 && spreadsheet.running; i++) {
        await stepOnce(spreadsheet);
      }
      expect(spreadsheet.running).toBe(false);
      expect(spreadsheet.getValue('account!balance-1')).toBe(-15832);
    });

    test('add a query cell created while giving way to the run', async () => {
      const spreadsheet = await setupQueryCells();
      await waitUntil(() => spreadsheet.pausedComputation != null);
      const [first, second] = spreadsheet.computeQueue;

      // The client binds another balance while the run gives way
      spreadsheet.createQuery('account', 'balance-3', balanceQuery('2'));
      const onFinish = vi.fn();
      spreadsheet.onFinish(onFinish);
      await new Promise(resolve => realSetImmediate(resolve));

      // Only query cells are queued, so the run keeps giving way
      expect(spreadsheet.pausedComputation).not.toBe(null);
      expect(spreadsheet.getValue(second)).toBe(null);
      expect(spreadsheet.computeQueue).toEqual([
        first,
        second,
        'account!balance-3',
      ]);

      for (let i = 0; i < 10 && spreadsheet.running; i++) {
        await stepOnce(spreadsheet);
      }
      expect(spreadsheet.running).toBe(false);
      expect(spreadsheet.getValue(second)).toBe(balances[second]);
      expect(spreadsheet.getValue('account!balance-3')).toBe(1000);
      expect(onFinish).toHaveBeenCalledTimes(1);
    });

    test('keep giving way after a query cell fails', async () => {
      await insertTransactions();
      const spreadsheet = new Spreadsheet();
      spreadsheet.transaction(() => {
        spreadsheet.createQuery('account', 'balance-1', balanceQuery('1'));
        spreadsheet.createQuery('account', 'balance-2', balanceQuery('2'));
        spreadsheet.createQuery('account', 'balance-3', balanceQuery('3'));
      });
      const [first, second, third] = spreadsheet.computeQueue;
      // Make the second query reject when it runs
      Object.assign(spreadsheet.getNode(second).sql.state, {
        namedParameters: [{ paramName: 'missing', paramType: 'string' }],
      });
      const onFinish = vi.fn();
      spreadsheet.onFinish(onFinish);

      await waitUntil(() => spreadsheet.pausedComputation != null);
      expect(spreadsheet.pausedComputation.idx).toBe(1);
      await stepOnce(spreadsheet);
      // The failed query gives way too, before the third one runs
      expect(spreadsheet.pausedComputation?.idx).toBe(2);
      expect(spreadsheet.getValue(third)).toBe(null);

      await stepOnce(spreadsheet);
      expect(spreadsheet.running).toBe(false);
      const expected = {
        'account!balance-1': -15832,
        'account!balance-2': 0,
        'account!balance-3': 0,
      };
      expect(spreadsheet.getValue(first)).toBe(expected[first]);
      expect(spreadsheet.getValue(second)).toBe(null);
      expect(spreadsheet.getValue(third)).toBe(expected[third]);
      expect(onFinish).toHaveBeenCalledWith({ names: [first, second, third] });
    });
  });
});
