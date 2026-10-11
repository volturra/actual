import * as cloudStorage from '#server/cloud-storage';
import * as db from '#server/db';
import * as prefs from '#server/prefs';

import { resetSync } from './reset';

beforeEach(async () => {
  await global.emptyDatabase()();
  void prefs.loadPrefs();
  vi.spyOn(cloudStorage, 'checkKey').mockResolvedValue({ valid: true });
  vi.spyOn(cloudStorage, 'resetSyncState').mockResolvedValue({});
  vi.spyOn(cloudStorage, 'upload').mockResolvedValue(undefined);
});

describe('resetSync', () => {
  it('does not write planner stats', async () => {
    await db.insertAccount({ id: 'acct', name: 'Checking' });

    expect(await resetSync()).toEqual({});
    expect(cloudStorage.upload).toHaveBeenCalled();

    const statTables = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_stat%'",
    );
    expect(statTables).toEqual([]);
  });
});
