import { q } from '@actual-app/core/shared/query';
import type { NoteEntity } from '@actual-app/core/types/models';
import { queryOptions } from '@tanstack/react-query';

import { aqlQuery } from '#queries/aqlQuery';

export type NotesById = ReadonlyMap<NoteEntity['id'], NoteEntity['note']>;

export const notesQueries = {
  all: () => ['notes'],
  lists: () => [...notesQueries.all(), 'lists'],
  // One shared query of the whole notes table instead of one query per
  // note id: the budget page alone shows a notes button per category and
  // month. The table only holds account, category, group and month notes
  // (transaction notes live on transactions), so it stays small.
  list: () =>
    queryOptions<NotesById>({
      queryKey: [...notesQueries.lists()],
      queryFn: async () => {
        const { data }: { data: Array<Pick<NoteEntity, 'id' | 'note'>> } =
          await aqlQuery(q('notes').select(['id', 'note']));
        return new Map(data.map(({ id, note }) => [id, note]));
      },
      // Manually invalidated when notes change
      staleTime: Infinity,
    }),
  detail: (id: NoteEntity['id']) =>
    queryOptions<NotesById, Error, NoteEntity['note'] | null>({
      ...notesQueries.list(),
      select: notesById => notesById.get(id) ?? null,
    }),
};
