import { runHandler } from '#server/mutators';

import { app } from './app';
import { Spreadsheet } from './spreadsheet';

const mocks = vi.hoisted(() => ({ sheet: null as Spreadsheet | null }));

vi.mock('#server/sheet', () => ({ get: () => mocks.sheet }));

describe('spreadsheet app', () => {
  beforeEach(() => {
    const sheet = new Spreadsheet();
    sheet.set('budget202401!to-budget', 100);
    sheet.set('budget202402!to-budget', 200);
    mocks.sheet = sheet;
  });

  it('get-cells returns the same values as get-cell, in request order', async () => {
    const cells = [
      { sheetName: 'budget202402', name: 'to-budget' },
      { sheetName: 'budget202401', name: 'to-budget' },
      { sheetName: 'budget202403', name: 'to-budget' },
    ];

    const batched = await runHandler(app.handlers['get-cells'], { cells });
    const single = await Promise.all(
      cells.map(cell => runHandler(app.handlers['get-cell'], cell)),
    );

    expect(batched).toEqual([
      { name: 'budget202402!to-budget', value: 200 },
      { name: 'budget202401!to-budget', value: 100 },
      { name: 'budget202403!to-budget', value: null },
    ]);
    expect(batched).toEqual(single);
  });
});
