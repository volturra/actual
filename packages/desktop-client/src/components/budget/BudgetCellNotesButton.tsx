import React, { useState } from 'react';

import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { NotesButton } from '#components/NotesButton';
import { useNotes } from '#hooks/useNotes';

type BudgetCellNotesButtonProps = {
  id: string;
  /**
   * Whether the hover-only buttons of the budget cell are mounted: the
   * cell has been hovered or focused at least once.
   */
  showHoverButtons: boolean;
};

/**
 * The notes button of a budget cell. Without a note it is only visible
 * while the cell is hovered, so it is not mounted until then: a budget
 * page has one per category and month shown. An empty box of the same
 * size keeps the layout identical until it mounts, and keeps its place in
 * the Tab order: focusing it mounts the button, which takes the focus.
 */
export function BudgetCellNotesButton({
  id,
  showHoverButtons,
}: BudgetCellNotesButtonProps) {
  const hasNote = !!useNotes(id);
  const [isPlaceholderFocused, setIsPlaceholderFocused] = useState(false);

  if (!showHoverButtons && !hasNote) {
    return (
      <View
        tabIndex={0}
        style={placeholderStyle}
        onFocus={() => setIsPlaceholderFocused(true)}
      />
    );
  }

  return (
    <NotesButton
      id={id}
      defaultColor={theme.pageTextLight}
      autoFocus={isPlaceholderFocused}
    />
  );
}

// The size of NotesButton's 12px icon with its 4px padding
const placeholderStyle = { flexShrink: 0, width: 20, height: 20 };
