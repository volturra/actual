import { app as mainApp } from '#server/main-app';
import { runHandler } from '#server/mutators';
import type { ServerEvents } from '#types/server-events';

import { app } from './app';

type SyncEvent = ServerEvents['sync-event'];

beforeEach(() => global.emptyDatabase()());

// The client's notes cache (desktop-client `notesQueries`) is only
// invalidated by sync events listing the notes table, so saving a note
// must emit one
describe('notes app', () => {
  let events: SyncEvent[];
  const onSync = (event: SyncEvent) => {
    events.push(event);
  };

  beforeEach(() => {
    events = [];
    mainApp.events.on('sync', onSync);
  });

  afterEach(() => {
    mainApp.events.off('sync', onSync);
  });

  it.each(['notes-save', 'notes-save-undoable'] as const)(
    '%s emits an applied sync event for the notes table',
    async name => {
      await runHandler(app.handlers[name], { id: 'cat-1', note: 'hello' });

      expect(
        events.some(
          event => event.type === 'applied' && event.tables.includes('notes'),
        ),
      ).toBe(true);
      expect(
        await runHandler(app.handlers['notes-get'], { id: 'cat-1' }),
      ).toEqual({ id: 'cat-1', note: 'hello' });
    },
  );
});
