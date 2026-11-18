import { mix } from './common';
// Goal-template note parser (peggy-generated) that runs over every category note.
import { parse } from './goal-template.generated.js';

const NOTES = [
  '#template 10',
  '#template up to 50',
  '#template up to 25 per day hold',
  '#template up to 100 per week starting 2025-01-01',
  '#template-2 123.45',
  '#template schedule Rent',
  '#template schedule full Mortgage',
  '#template schedule Netflix [increase 10%]',
  '#template 50% of Utilities',
  '#template 75% of previous Dining Out',
  '#template 200 repeat every 2 months starting 2025-06-01',
  '#template 400 repeat every year starting 2025-01-01 up to 50',
  '#template 500 by 2025-12',
  '#template 700 by 2025-10 repeat every 2 months',
  '#template average 6 months',
  '#template copy from 12 months ago',
  '#template remainder 3',
];

export function bench(n: number): number {
  let h = 2166136261;
  for (let round = 0; round < n; round++) {
    for (const note of NOTES) {
      let out: string;
      try {
        out = JSON.stringify(parse(note));
      } catch {
        out = 'err';
      }
      h = mix(h, out);
    }
  }
  return h;
}
