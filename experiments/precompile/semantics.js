// Small spec-conformance probes. Every line should print "ok"; run with
// ./semantics.sh to compare engines. Real Actual code depends on each of these.
var out =
  typeof print === 'function'
    ? print
    : function (s) {
        console.log(s);
      };
function check(name, got, want) {
  out(
    (got === want ? 'ok   ' : 'FAIL ') +
      name +
      (got === want ? '' : ' got ' + JSON.stringify(got)),
  );
}
var o = Object.assign({}, { hash: 1 }, { 1: 2, 0: 3 });
check(
  'integer keys enumerate first (Object.keys)',
  Object.keys(o).join(','),
  '0,1,hash',
);
check(
  'integer keys first (JSON.stringify)',
  JSON.stringify(o),
  '{"0":3,"1":2,"hash":1}',
);
check(
  'for-in order',
  (function () {
    var k = [];
    for (var x in o) k.push(x);
    return k.join(',');
  })(),
  '0,1,hash',
);
check('default sort is string order', [10, 9, 1].sort().join(','), '1,10,9');
check('Unicode toUpperCase', 'ß'.toUpperCase(), 'SS');
check('Date.parse ISO date', Date.parse('2025-02-28'), 1740700800000);
check('toFixed rounding', (1.005).toFixed(2), '1.00');
check(
  'regex lookahead',
  '1,234.56'.replace(/[,.](?=[^.,]*$)/, '|'),
  '1,234|56',
);
check('regex unicode escape', /−/.test('−'), true);
check('String(-0)', String(-0), '0');
check('Math.round(-2.5)', Math.round(-2.5), -2);
check('parseInt hex', parseInt('FFFF', 16), 65535);
check(
  'Map insertion order',
  Array.from(
    new Map([
      [2, 'a'],
      [1, 'b'],
    ]).keys(),
  ).join(','),
  '2,1',
);
check('typeof Intl', typeof Intl, 'object');
check('typeof TextEncoder', typeof TextEncoder, 'function');
check('Array.prototype.at', [1, 2, 3].at(-1), 3);
check(
  'optional catch / try',
  (function () {
    try {
      null.x;
    } catch {
      return 'caught';
    }
  })(),
  'caught',
);
check(
  'per-iteration let binding in for-of',
  (function () {
    var fs = [];
    for (let k of ['a', 'b'])
      fs.push(function () {
        return k;
      });
    return fs[0]() + fs[1]();
  })(),
  'ab',
);
