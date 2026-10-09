import type { NoteEntity } from '@actual-app/core/types/models';
import { useQuery } from '@tanstack/react-query';

import { notesQueries } from '#notes';

export function useNotes(id: NoteEntity['id']) {
  const { data } = useQuery(notesQueries.detail(id));
  return data ?? null;
}
