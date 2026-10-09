import { generateSQLWithState } from '@actual-app/core/server/aql/compiler';
import { schema, schemaConfig } from '@actual-app/core/server/aql/schema/index';
import * as monthUtils from '@actual-app/core/shared/months';
import { describe, expect, it } from 'vitest';

import { makeQuery } from './makeQuery';

function serialize(groupBy?: string) {
  return makeQuery(
    'assets',
    '2026-01-01',
    '2026-01-31',
    'Daily',
    '$and',
    [],
    groupBy,
  ).serialize();
}

function whereClause(startDate: string, endDate: string, interval: string) {
  const { sql } = generateSQLWithState(
    makeQuery('debts', startDate, endDate, interval, '$and', []).serialize(),
    schema,
    schemaConfig,
  );
  return sql
    .slice(sql.indexOf('WHERE'), sql.indexOf('GROUP BY'))
    .replace(/\s+/g, ' ');
}

// The date filters of a compiled query, as a predicate on 'YYYY-MM-DD'
// dates. The compiled bounds are YYYYMMDD integers.
function compiledDateFilter(
  startDate: string,
  endDate: string,
  interval: string,
) {
  const where = whereClause(startDate, endDate, interval);
  const bounds = [...where.matchAll(/\.date (>=|<=|<) (\d{8})\b/g)].map(
    ([, op, bound]) => ({
      op,
      bound: `${bound.slice(0, 4)}-${bound.slice(4, 6)}-${bound.slice(6)}`,
    }),
  );
  expect(bounds).toHaveLength(2);
  return (date: string) =>
    bounds.every(({ op, bound }) =>
      op === '>=' ? date >= bound : op === '<=' ? date <= bound : date < bound,
    );
}

// What the report has always meant: the transaction's day, month or year
// lies between the start's and the end's, inclusive.
function sameIntervalRange(
  startDate: string,
  endDate: string,
  interval: string,
) {
  const length = interval === 'Monthly' ? 7 : interval === 'Yearly' ? 4 : 10;
  return (date: string) =>
    date.slice(0, length) >= startDate.slice(0, length) &&
    date.slice(0, length) <= endDate.slice(0, length);
}

const intervals = ['Daily', 'Weekly', 'Monthly', 'Yearly'];

const dateEdges = [
  '2023-01-01',
  '2023-01-31',
  '2023-02-01',
  '2023-02-28',
  '2023-03-01',
  '2023-06-15',
  '2023-12-31',
  '2024-01-01',
  '2024-02-28',
  '2024-02-29',
  '2024-03-01',
  '2024-12-31',
  '2025-01-01',
];

describe('makeQuery', () => {
  it('groups and selects notes for tag reports', () => {
    const query = serialize('Tag');

    expect(query.groupExpressions).toContain('notes');
    expect(query.selectExpressions).toContain('notes');
  });

  it.each(['Category', 'Payee', 'Account', 'Interval', undefined])(
    'does not select notes for %s reports',
    groupBy => {
      const query = serialize(groupBy);

      expect(query.groupExpressions).not.toContain('notes');
      expect(query.selectExpressions).not.toContain('notes');
    },
  );

  it.each(intervals)(
    'compares the bare date column for %s reports so the date index is used',
    interval => {
      const where = whereClause('2025-02-14', '2025-07-09', interval);

      expect(where).not.toMatch(/SUBSTR/i);
      expect(where).toMatch(/\.date >= \d{8} AND \S+\.date <=? \d{8}/);
    },
  );

  it.each([
    ['Monthly', '2025-02-14', '2025-07-09', '>= 20250201', '< 20250801'],
    ['Monthly', '2024-12-31', '2025-12-31', '>= 20241201', '< 20260101'],
    ['Monthly', '2024-02-29', '2024-02-29', '>= 20240201', '< 20240301'],
    ['Yearly', '2023-07-01', '2025-06-30', '>= 20230101', '< 20260101'],
    ['Daily', '2025-02-14', '2025-07-09', '>= 20250214', '<= 20250709'],
    ['Weekly', '2025-02-09', '2025-07-12', '>= 20250209', '<= 20250712'],
  ])(
    'filters %s reports from %s to %s by whole intervals',
    (interval, startDate, endDate, lower, upper) => {
      const where = whereClause(startDate, endDate, interval);

      expect(where).toContain(`.date ${lower} AND`);
      expect(where).toContain(`.date ${upper}`);
    },
  );

  it.each(intervals)(
    'keeps the same days as comparing whole intervals for %s reports',
    interval => {
      const days = monthUtils.dayRangeInclusive('2022-11-01', '2025-02-28');
      for (const startDate of dateEdges) {
        for (const endDate of dateEdges) {
          const actual = compiledDateFilter(startDate, endDate, interval);
          const expected = sameIntervalRange(startDate, endDate, interval);
          const mismatches = days.filter(day => actual(day) !== expected(day));

          expect({ startDate, endDate, mismatches }).toEqual({
            startDate,
            endDate,
            mismatches: [],
          });
        }
      }
    },
  );
});
