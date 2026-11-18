// Month/day math (date-fns under the hood) used by every budget view.
import * as monthUtils from '../../../packages/loot-core/src/shared/months';

import { mix } from './common';

export function bench(n: number): number {
  let h = 2166136261;
  for (let round = 0; round < n; round++) {
    let m = '2020-01';
    for (let i = 0; i < 120; i++) {
      m = monthUtils.nextMonth(m);
      const range = monthUtils.rangeInclusive(monthUtils.subMonths(m, 2), m);
      h = mix(h, range.length);
      h = mix(h, monthUtils.lastDayOfMonth(m));
      h = mix(h, monthUtils.addDays(monthUtils.firstDayOfMonth(m), i % 28));
      h = mix(h, monthUtils.differenceInCalendarMonths('2020-01', m));
    }
  }
  return h;
}
