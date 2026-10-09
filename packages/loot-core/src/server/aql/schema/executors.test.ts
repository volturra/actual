// @ts-strict-ignore
import { setClock } from '@actual-app/crdt';
import fc from 'fast-check';

import * as arbs from '#mocks/arbitrary-schema';
import * as db from '#server/db';
import { batchMessages, setSyncingMode } from '#server/sync';
import { q } from '#shared/query';
import { groupById } from '#shared/util';
import { aqlQuery } from '..';

import { isHappyPathQuery } from './executors';

beforeEach(global.emptyDatabase());

function repeat(arr, times) {
  let result = [];
  for (let i = 0; i < times; i++) {
    result = result.concat(arr);
  }
  return result;
}

function isAlive(trans, allById) {
  if (trans.parent_id) {
    const parent = allById[trans.parent_id];
    return !trans.tombstone && parent && !parent.tombstone;
  }
  return !trans.tombstone;
}

function aliveTransactions(arr) {
  const all = groupById(arr);
  return arr.filter(t => isAlive(t, all));
}

async function insertTransactions(transactions, payeeIds?: string[]) {
  return batchMessages(async () => {
    for (const trans of transactions) {
      void db.insertTransaction(trans);
    }

    if (payeeIds) {
      for (let i = 0; i < payeeIds.length; i++) {
        await db.insertPayee({
          id: payeeIds[i],
          name: 'payee' + (i + 1),
        });
      }
    }
  });
}

function expectTransactionOrder(
  data,
  fields?: Array<string | Record<string, string>>,
) {
  const expectedFields = fields || [
    { date: 'desc' },
    'starting_balance_flag',
    { sort_order: 'desc' },
    'id',
  ];

  const sorted = [...data].sort((i1, i2) => {
    for (let field of expectedFields) {
      let order = 'asc';
      if (!(typeof field === 'string')) {
        const entries = Object.entries(field)[0];
        field = entries[0];
        order = entries[1];
      }

      const f1 = i1[field];
      const f2 = i2[field];
      const before = order === 'asc' ? -1 : 1;
      const after = order === 'asc' ? 1 : -1;

      expect(f1).not.toBeUndefined();
      expect(f2).not.toBeUndefined();

      if (f1 == null && f2 != null) {
        return before;
      } else if (f1 != null && f2 == null) {
        return after;
      } else if (f1 < f2) {
        return before;
      } else if (f1 > f2) {
        return after;
      }
    }
    return 0;
  });

  expect(data.map(t => t.id)).toEqual(sorted.map(t => t.id));
}

async function expectPagedData(query, numTransactions, allData) {
  const pageCount = Math.max(Math.floor(numTransactions / 3), 3);
  let pagedData = [];
  let done = false;

  let i = 0;

  do {
    // No more than 100 loops, c'mon!
    expect(i).toBeLessThanOrEqual(100);

    // Pull in all the data via pages
    const { data } = await aqlQuery(
      query.limit(pageCount).offset(pagedData.length).serialize(),
    );

    expect(data.length).toBeLessThanOrEqual(pageCount);

    if (data.length === 0) {
      done = true;
    } else {
      pagedData = pagedData.concat(data);
    }

    i++;
  } while (!done);

  // All of the paged data together should be exactly the
  // same as the full data
  expect(pagedData).toEqual(allData);
}

describe('transaction executors', () => {
  it('queries with `splits: inline` returns only non-parents', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbs.makeTransactionArray({
          splitFreq: 2,
          minLength: 2,
          maxLength: 20,
        }),
        async arr => {
          await insertTransactions(arr);

          const { data } = await aqlQuery(
            q('transactions')
              .filter({ amount: { $lt: 0 } })
              .select('*')
              .options({ splits: 'inline' })
              .serialize(),
          );

          expect(data.filter(t => t.is_parent).length).toBe(0);
          expect(data.filter(t => t.tombstone).length).toBe(0);

          const { data: defaultData } = await aqlQuery(
            q('transactions')
              .filter({ amount: { $lt: 0 } })
              .select('*')
              .serialize(),
          );

          // inline should be the default
          expect(defaultData).toEqual(data);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('queries with `splits: none` returns only parents', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbs.makeTransactionArray({
          splitFreq: 2,
          minLength: 2,
          maxLength: 8,
        }),
        async arr => {
          await insertTransactions(arr);

          const { data } = await aqlQuery(
            q('transactions')
              .filter({ amount: { $lt: 0 } })
              .select('*')
              .options({ splits: 'none' })
              .serialize(),
          );

          expect(data.filter(t => t.is_child).length).toBe(0);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('aggregate queries work with `splits: grouped`', async () => {
    const payeeIds = ['payee1', 'payee2', 'payee3', 'payee4', 'payee5'];

    await fc.assert(
      fc
        .asyncProperty(
          arbs.makeTransactionArray({ splitFreq: 2, payeeIds, maxLength: 100 }),
          async arr => {
            await insertTransactions(arr, payeeIds);

            const aggQuery = q('transactions')
              .filter({
                $or: [{ amount: { $lt: -5 } }, { amount: { $gt: -2 } }],
                'payee.name': { $gt: '' },
              })
              .options({ splits: 'grouped' })
              .calculate({ $sum: '$amount' });

            const { data } = await aqlQuery(aggQuery.serialize());

            const sum = aliveTransactions(arr).reduce((sum, trans) => {
              const amount = trans.amount || 0;
              const matched =
                (amount < -5 || amount > -2) && trans.payee != null;
              if (!trans.tombstone && !trans.is_parent && matched) {
                return sum + amount;
              }
              return sum;
            }, 0);

            expect(data).toBe(sum);
          },
        )
        .beforeEach(() => {
          setClock(null);
          setSyncingMode('import');
          return db.execQuery(`
            DELETE FROM transactions;
            DELETE FROM payees;
            DELETE FROM payee_mapping;
          `);
        }),
    );
  }, 20_000);

  function runTest(makeQuery) {
    const payeeIds = ['payee1', 'payee2', 'payee3', 'payee4', 'payee5'];

    async function check(arr) {
      const orderFields = ['payee.name', 'amount', 'id'];

      // Insert transactions and get a list of all the alive
      // ones to make it easier to check the data later (don't
      // have to always be filtering out dead ones)
      await insertTransactions(arr, payeeIds);
      const allTransactions = aliveTransactions(arr);

      // Query time
      const { query, expectedIds, expectedMatchedIds } = makeQuery(arr);

      // First to a query without order to make sure the default
      // order works
      const { data: defaultOrderData } = await aqlQuery(query.serialize());
      expectTransactionOrder(defaultOrderData);
      expect(new Set(defaultOrderData.map(t => t.id))).toEqual(expectedIds);

      // Now do the full test, and add a custom order to make
      // sure that doesn't effect anything
      const orderedQuery = query.orderBy(orderFields);
      const { data } = await aqlQuery(orderedQuery.serialize());
      expect(new Set(data.map(t => t.id))).toEqual(expectedIds);

      // Validate paging and ordering
      await expectPagedData(orderedQuery, arr.length, data);
      expectTransactionOrder(data, orderFields);

      const matchedIds = new Set();

      // Check that all the subtransactions were returned
      for (const trans of data) {
        expect(trans.tombstone).toBe(false);

        if (expectedMatchedIds) {
          if (!trans._unmatched) {
            expect(expectedMatchedIds.has(trans.id)).toBe(true);
            matchedIds.add(trans.id);
          } else {
            expect(expectedMatchedIds.has(trans.id)).not.toBe(true);
          }
        }

        if (trans.is_parent) {
          // Parent transactions should never have a category
          expect(trans.category).toBe(null);

          expect(trans.subtransactions.length).toBe(
            allTransactions.filter(t => t.parent_id === trans.id).length,
          );

          // Subtransactions should be ordered as well
          expectTransactionOrder(trans.subtransactions, orderFields);

          trans.subtransactions.forEach(subtrans => {
            expect(subtrans.tombstone).toBe(false);

            if (expectedMatchedIds) {
              if (!subtrans._unmatched) {
                expect(expectedMatchedIds.has(subtrans.id)).toBe(true);
                matchedIds.add(subtrans.id);
              } else {
                expect(expectedMatchedIds.has(subtrans.id)).not.toBe(true);
              }
            }
          });
        }
      }

      if (expectedMatchedIds) {
        // Check that transactions that should be matched are
        // marked as such
        expect(matchedIds).toEqual(expectedMatchedIds);
      }
    }

    return fc.assert(
      fc
        .asyncProperty(
          arbs.makeTransactionArray({
            splitFreq: 0.1,
            payeeIds,
            maxLength: 100,
          }),
          check,
        )
        .beforeEach(() => {
          setClock(null);
          setSyncingMode('import');
          return db.execQuery(`
            DELETE FROM transactions;
            DELETE FROM payees;
            DELETE FROM payee_mapping;
          `);
        }),
      { numRuns: 300 },
    );
  }

  it('queries the correct transactions without filters', async () => {
    return runTest(arr => {
      const expectedIds = new Set(
        arr.filter(t => !t.tombstone && !t.is_child).map(t => t.id),
      );

      // Even though we're applying some filters, these are always
      // guaranteed to return the full split transaction so they
      // should take the optimized path
      const happyQuery = q('transactions')
        .filter({
          date: { $gt: '2017-01-01' },
        })
        .options({ splits: 'grouped' })
        .select(['*', 'payee.name']);

      // Make sure it's actually taking the happy path
      expect(isHappyPathQuery(happyQuery.serialize())).toBe(true);

      return {
        expectedIds,
        query: happyQuery,
      };
    });
  }, 20_000);

  it(`queries the correct transactions with a filter`, async () => {
    return runTest(arr => {
      const expectedIds = new Set();

      // let parents = toGroup(
      //   arr.filter(t => t.is_parent),
      //   new Map(Object.entries(groupById(arr.filter(t => t.parent_id))))
      // );

      const parents = groupById(arr.filter(t => t.is_parent && !t.tombstone));
      const matched = new Set();

      // Pick out some ids to query
      let ids = arr.reduce((ids, trans, idx) => {
        if (idx % 2 === 0) {
          const amount = trans.amount == null ? 0 : trans.amount;
          const matches = (amount < -2 || amount > -1) && trans.payee > '';

          if (matches && isAlive(trans, parents)) {
            expectedIds.add(trans.parent_id || trans.id);
            matched.add(trans.id);
          }

          ids.push(trans.id);
        }

        return ids;
      }, []);

      // Because why not? It should deduplicate them
      ids = repeat(ids, 100);

      const unhappyQuery = q('transactions')
        .filter({
          id: [{ $oneof: ids }],
          payee: { $gt: '' },
          $or: [{ amount: { $lt: -2 } }, { amount: { $gt: -1 } }],
        })
        .options({ splits: 'grouped' })
        .select(['*', 'payee.name'])
        // Using this because we want `payee` to have ids for the above
        // filter regardless if it points to a dead one or not
        .withoutValidatedRefs();

      expect(isHappyPathQuery(unhappyQuery.serialize())).toBe(false);

      return {
        expectedIds,
        expectedMatchedIds: matched,
        query: unhappyQuery,
      };
    });
  }, 20_000);
});

describe('grouped transactions with filters', () => {
  async function setup() {
    await db.insertAccount({ id: 'acct1', name: 'Checking' });
    await db.insertAccount({ id: 'acct2', name: 'Savings' });
    await db.insertCategoryGroup({ id: 'group1', name: 'Group' });
    await db.insertCategory({ id: 'food', name: 'Food', cat_group: 'group1' });
    await db.insertCategory({ id: 'rent', name: 'Rent', cat_group: 'group1' });
    await db.insertPayee({ id: 'cafe', name: 'Café Crème' });
    await db.insertPayee({ id: 'shop', name: 'Corner Shop' });

    const base = { account: 'acct1', amount: -100 };
    await insertTransactions([
      {
        ...base,
        id: 't1',
        date: '2024-01-05',
        payee: 'cafe',
        category: 'food',
      },
      { ...base, id: 't2', date: '2024-01-04', payee: 'shop', notes: 'CAFÉ' },
      {
        ...base,
        id: 't3',
        date: '2024-01-03',
        payee: 'shop',
        category: 'rent',
      },
      // A split whose second child matches a search for "cafe"
      { ...base, id: 's1', date: '2024-01-02', is_parent: true },
      {
        ...base,
        id: 's1-a',
        date: '2024-01-02',
        is_child: true,
        parent_id: 's1',
        payee: 'shop',
        category: 'rent',
      },
      {
        ...base,
        id: 's1-b',
        date: '2024-01-02',
        is_child: true,
        parent_id: 's1',
        payee: 'cafe',
        category: 'food',
      },
      {
        ...base,
        id: 't4',
        date: '2024-01-01',
        payee: 'cafe',
        category: 'food',
      },
      // Another account
      {
        ...base,
        id: 't5',
        account: 'acct2',
        date: '2024-01-06',
        payee: 'cafe',
        category: 'food',
      },
    ]);
  }

  function search(text: string) {
    return q('transactions')
      .options({ splits: 'grouped' })
      .filter({ account: 'acct1' })
      .filter({
        $or: {
          'payee.name': { $like: `%${text}%` },
          notes: { $like: `%${text}%` },
          'category.name': { $like: `%${text}%` },
          'account.name': { $like: `%${text}%` },
        },
      })
      .select('*');
  }

  async function ids(query) {
    const { data } = await aqlQuery(query.serialize());
    return data.map(t => [
      t.id,
      ...t.subtransactions.map(s => (s._unmatched ? `(${s.id})` : s.id)),
    ]);
  }

  it('matches payee and notes ignoring accents and case', async () => {
    await setup();
    expect(await ids(search('cafe'))).toEqual([
      ['t1'],
      ['t2'],
      ['s1', '(s1-a)', 's1-b'],
      ['t4'],
    ]);
    expect(await ids(search('CRÈME'))).toEqual([
      ['t1'],
      ['s1', '(s1-a)', 's1-b'],
      ['t4'],
    ]);
  });

  it('matches category and account names', async () => {
    await setup();
    expect(await ids(search('rent'))).toEqual([
      ['t3'],
      ['s1', 's1-a', '(s1-b)'],
    ]);
    expect(await ids(search('checking'))).toEqual([
      ['t1'],
      ['t2'],
      ['t3'],
      ['s1', 's1-a', 's1-b'],
      ['t4'],
    ]);
  });

  it('shows the parent of a split whose child matches a category filter', async () => {
    await setup();
    const query = q('transactions')
      .options({ splits: 'grouped' })
      .filter({ account: 'acct1', category: 'food' })
      .select('*');
    expect(await ids(query)).toEqual([
      ['t1'],
      ['s1', '(s1-a)', 's1-b'],
      ['t4'],
    ]);
  });

  it('pages filtered results in order', async () => {
    await setup();
    const query = search('cafe');
    expect(await ids(query.limit(2))).toEqual([['t1'], ['t2']]);
    expect(await ids(query.limit(2).offset(2))).toEqual([
      ['s1', '(s1-a)', 's1-b'],
      ['t4'],
    ]);
    expect(await ids(query.limit(2).offset(4))).toEqual([]);

    const ascending = query.orderBy({ date: 'asc' });
    expect(await ids(ascending.limit(3))).toEqual([
      ['t4'],
      ['s1', '(s1-a)', 's1-b'],
      ['t2'],
    ]);
    expect(await ids(ascending.limit(3).offset(3))).toEqual([['t1']]);
  });

  it('ignores deleted transactions and splits with a deleted parent', async () => {
    await setup();
    await insertTransactions([
      // A deleted child that would match doesn't pull in its parent
      {
        id: 's2',
        account: 'acct1',
        amount: -100,
        date: '2024-01-07',
        is_parent: true,
      },
      {
        id: 's2-a',
        account: 'acct1',
        amount: -100,
        date: '2024-01-07',
        is_child: true,
        parent_id: 's2',
        payee: 'shop',
      },
      {
        id: 's2-b',
        account: 'acct1',
        amount: 0,
        date: '2024-01-07',
        is_child: true,
        parent_id: 's2',
        payee: 'cafe',
        tombstone: 1,
      },
      // A matching child of a deleted parent is not shown
      {
        id: 's3',
        account: 'acct1',
        amount: -100,
        date: '2024-01-08',
        is_parent: true,
        tombstone: 1,
      },
      {
        id: 's3-a',
        account: 'acct1',
        amount: -100,
        date: '2024-01-08',
        is_child: true,
        parent_id: 's3',
        payee: 'cafe',
      },
      // A deleted plain transaction that would match
      {
        id: 't6',
        account: 'acct1',
        amount: -100,
        date: '2024-01-09',
        payee: 'cafe',
        tombstone: 1,
      },
    ]);
    expect(await ids(search('cafe'))).toEqual([
      ['t1'],
      ['t2'],
      ['s1', '(s1-a)', 's1-b'],
      ['t4'],
    ]);
    expect(await ids(search('cafe').limit(1))).toEqual([['t1']]);
    expect(await ids(search('shop'))).toEqual([
      ['s2', 's2-a'],
      ['t2'],
      ['t3'],
      ['s1', 's1-a', '(s1-b)'],
    ]);
  });

  it('matches escaped wildcards literally', async () => {
    await setup();
    await db.insertPayee({ id: 'pct', name: '100% Juice_Bar' });
    await insertTransactions([
      {
        id: 't7',
        account: 'acct1',
        amount: -100,
        date: '2024-01-10',
        payee: 'pct',
      },
      {
        id: 't8',
        account: 'acct1',
        amount: -100,
        date: '2024-01-11',
        notes: '1000 JuiceXBar',
      },
    ]);
    // `%` and `?` are wildcards unless escaped; `_` is always literal
    expect(await ids(search('0\\% juice'))).toEqual([['t7']]);
    expect(await ids(search('0% juice'))).toEqual([['t8'], ['t7']]);
    expect(await ids(search('juice_bar'))).toEqual([['t7']]);
    expect(await ids(search('juice?bar'))).toEqual([['t8'], ['t7']]);
    expect(await ids(search('juice\\?bar'))).toEqual([]);
  });

  it('does not count a child without a parent row towards the page size', async () => {
    await setup();
    await insertTransactions([
      {
        id: 'orphan',
        account: 'acct1',
        amount: -100,
        date: '2023-12-31',
        is_child: true,
        parent_id: 'missing',
        payee: 'cafe',
      },
    ]);
    const query = search('cafe').orderBy({ date: 'asc' });
    expect(await ids(query.limit(2))).toEqual([
      ['t4'],
      ['s1', '(s1-a)', 's1-b'],
    ]);
  });
});

describe('grouped transactions with filters on an incomplete parent', () => {
  async function setup() {
    await db.insertAccount({ id: 'acct1', name: 'Checking' });
    await db.insertPayee({ id: 'cafe', name: 'Cafe' });

    const base = { account: 'acct1', amount: -100, payee: 'cafe' };
    await insertTransactions([
      { ...base, id: 't1', date: '2024-01-01' },
      { ...base, id: 't2', date: '2024-01-02' },
      { ...base, id: 't3', date: '2024-01-03' },
      { ...base, id: 't4', date: '2024-01-04' },
      // A child whose parent is excluded from the view below
      {
        ...base,
        id: 'orphan-a',
        date: '2024-01-05',
        is_child: true,
        parent_id: 'orphan',
      },
    ]);

    // The parent exists in `transactions` but has no date, so
    // `v_transactions_internal` leaves it out
    db.runQuery(
      `INSERT INTO transactions (id, acct, amount, date, isParent, isChild, tombstone)
       VALUES ('orphan', 'acct1', -100, NULL, 1, 0, 0)`,
    );
  }

  function query() {
    return q('transactions')
      .options({ splits: 'grouped' })
      .filter({ account: 'acct1', payee: 'cafe' })
      .orderBy({ date: 'asc' })
      .select('*');
  }

  async function ids(query) {
    const { data } = await aqlQuery(query.serialize());
    return data.map(t => t.id);
  }

  it('does not return the group or let it use up a limit slot', async () => {
    await setup();
    expect(await ids(query())).toEqual(['t1', 't2', 't3', 't4']);
    expect(await ids(query().limit(2))).toEqual(['t1', 't2']);
  });

  it('pages without duplicating or skipping rows', async () => {
    await setup();
    // Same shape as PagedQuery: the next page starts at the number of
    // rows already loaded, and a short page means the end was reached
    const pageCount = 2;
    const page1 = await ids(query().limit(pageCount));
    const page2 = await ids(query().limit(pageCount).offset(page1.length));
    const page3 = await ids(
      query()
        .limit(pageCount)
        .offset(page1.length + page2.length),
    );

    expect(page1).toHaveLength(pageCount);
    expect(page2).toHaveLength(pageCount);
    expect(page3).toEqual([]);
    expect([...page1, ...page2]).toEqual(['t1', 't2', 't3', 't4']);
  });

  it('does not materialize the transactions view', async () => {
    await setup();
    const allSpy = vi.spyOn(db, 'all');
    try {
      await aqlQuery(query().limit(2).serialize());
      const call = allSpy.mock.calls.find(([sql]) =>
        sql.includes('GROUP_CONCAT'),
      );
      expect(call).toBeDefined();

      const [rowSql, params] = call;
      const plan = await db.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${rowSql}`,
        params,
      );
      const details = plan.map(row => row.detail);
      expect(details.length).toBeGreaterThan(0);
      expect(details).not.toContainEqual(
        expect.stringContaining('MATERIALIZE v_transactions_internal'),
      );
    } finally {
      allSpy.mockRestore();
    }
  });
});
