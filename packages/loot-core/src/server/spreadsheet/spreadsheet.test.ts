// @ts-strict-ignore
import { generateTransaction } from '#mocks';
import * as db from '#server/db';
import { q } from '#shared/query';

import { Spreadsheet } from './spreadsheet';

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
});

describe('Spreadsheet query cells', () => {
  function sumQuery(filter: Record<string, unknown>) {
    return q('transactions')
      .filter(filter)
      .calculate({ $sum: '$amount' })
      .serialize();
  }

  function trackComputed(spreadsheet: Spreadsheet) {
    const computed: string[] = [];
    spreadsheet.addEventListener('change', ({ names }) => {
      computed.push(...names);
    });
    return computed;
  }

  function finished(spreadsheet: Spreadsheet) {
    return new Promise(resolve => {
      // Computations start on the next tick
      setTimeout(() => spreadsheet.onFinish(resolve), 0);
    });
  }

  test('binding the same query again does not rerun it', async () => {
    const spreadsheet = new Spreadsheet();
    await insertTransactions();
    const computed = trackComputed(spreadsheet);

    spreadsheet.createQuery('g', 'balance', sumQuery({ account: '1' }));
    await finished(spreadsheet);
    expect(spreadsheet.getValue('g!balance')).toBe(-15832);

    // A new but equal object, as it arrives from the client on every bind
    spreadsheet.createQuery('g', 'balance', sumQuery({ account: '1' }));
    await finished(spreadsheet);

    expect(computed).toEqual(['g!balance']);
    expect(spreadsheet.getValue('g!balance')).toBe(-15832);
  });

  test('binding a different query reruns it', async () => {
    const spreadsheet = new Spreadsheet();
    await insertTransactions();
    const computed = trackComputed(spreadsheet);

    spreadsheet.createQuery('g', 'balance', sumQuery({ category: 'cat1' }));
    await finished(spreadsheet);
    expect(spreadsheet.getValue('g!balance')).toBe(-3200);

    spreadsheet.createQuery('g', 'balance', sumQuery({ category: 'cat2' }));
    await finished(spreadsheet);

    expect(computed).toEqual(['g!balance', 'g!balance']);
    expect(spreadsheet.getValue('g!balance')).toBe(-12632);
  });

  test('a data change reruns a cell bound with the same query', async () => {
    const spreadsheet = new Spreadsheet();
    await insertTransactions();
    const computed = trackComputed(spreadsheet);

    spreadsheet.createQuery('g', 'balance', sumQuery({ account: '1' }));
    await finished(spreadsheet);

    const [transaction] = generateTransaction({
      amount: -1000,
      account: '1',
      date: '2017-01-20',
    });
    await db.insertTransaction(transaction);
    spreadsheet.triggerDatabaseChanges(
      new Map(),
      new Map([['transactions', new Map([[transaction.id, transaction]])]]),
    );
    await finished(spreadsheet);
    expect(computed).toEqual(['g!balance', 'g!balance']);
    expect(spreadsheet.getValue('g!balance')).toBe(-16832);

    // Binding again afterwards reuses the fresh value
    spreadsheet.createQuery('g', 'balance', sumQuery({ account: '1' }));
    await finished(spreadsheet);
    expect(computed).toHaveLength(2);
    expect(spreadsheet.getValue('g!balance')).toBe(-16832);
  });

  test('binding again reruns a query skipped after an error', async () => {
    const spreadsheet = new Spreadsheet();
    await insertTransactions();

    spreadsheet.transaction(() => {
      spreadsheet.createQuery('g', 'balance', sumQuery({ account: '1' }));
      spreadsheet.createDynamic('g', 'broken', {
        initialValue: 0,
        run: () => {
          throw new Error('broken cell');
        },
      });
    });
    // The broken cell runs first and stops the computations
    await finished(spreadsheet);
    expect(spreadsheet.getValue('g!balance')).toBe(null);

    spreadsheet.createQuery('g', 'balance', sumQuery({ account: '1' }));
    await finished(spreadsheet);
    expect(spreadsheet.getValue('g!balance')).toBe(-15832);
  });

  test('a category merge reruns transaction query cells', async () => {
    const spreadsheet = new Spreadsheet();
    await insertTransactions();

    spreadsheet.createQuery('g', 'cat2', sumQuery({ category: 'cat2' }));
    await finished(spreadsheet);
    expect(spreadsheet.getValue('g!cat2')).toBe(-12632);

    // The query joins `categories` (to check the reference), so merging a
    // category into it invalidates the cell
    await db.deleteCategory({ id: 'cat1' }, 'cat2');
    spreadsheet.triggerDatabaseChanges(
      new Map(),
      new Map([
        ['category_mapping', new Map([['cat1', { id: 'cat1' }]])],
        ['categories', new Map([['cat1', { id: 'cat1' }]])],
      ]),
    );
    await finished(spreadsheet);

    expect(spreadsheet.getValue('g!cat2')).toBe(-15832);
  });
});
