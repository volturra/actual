import { describe, expect, it, vi } from 'vitest';

import {
  getInitialState,
  popModal,
  pushModal,
  reducer,
  replaceModal,
} from '#modals/modalsSlice';
import type { Modal } from '#modals/modalsSlice';

import {
  createModalCloseRefetchTracker,
  modalStackNeedsRefetch,
} from './modalCloseRefetch';
import type { ModalCloseRefetchProps } from './modalCloseRefetch';

const columnsModal: Modal = {
  name: 'transaction-table-columns',
  options: { columns: [], onSave: vi.fn() },
  openerRefreshes: true,
};

const batchCategoryModal: Modal = {
  name: 'category-autocomplete',
  options: { onSelect: vi.fn() },
  openerRefreshes: true,
};

const untaggedCategoryModal: Modal = {
  name: 'category-autocomplete',
  options: { onSelect: vi.fn() },
};

const scheduleModal: Modal = {
  name: 'schedule-edit',
  options: { id: 'schedule-1' },
};

type Action =
  | ReturnType<typeof pushModal>
  | ReturnType<typeof popModal>
  | ReturnType<typeof replaceModal>;

// Feeds the register's props through the tracker the way
// `componentDidUpdate` sees them, starting from `initialStack` at mount, and
// counts the refetches it asks for
function countRefetches(actions: Action[], initialStack: Modal[] = []) {
  const shouldRefetch = createModalCloseRefetchTracker();
  let state = { ...getInitialState(), modalStack: initialStack };
  const toProps = (): ModalCloseRefetchProps => ({
    modalShowing: state.modalStack.length > 0,
    modalNeedsRefetch: modalStackNeedsRefetch(state.modalStack),
  });

  let props = toProps();
  let refetches = 0;
  for (const action of actions) {
    state = reducer(state, action);
    const prevProps = props;
    props = toProps();
    if (shouldRefetch(prevProps, props)) {
      refetches++;
    }
  }
  return refetches;
}

describe('modal close refetch', () => {
  it('does not refetch after a modal whose opener refreshes closes', () => {
    expect(
      countRefetches([pushModal({ modal: columnsModal }), popModal()]),
    ).toBe(0);
    expect(
      countRefetches([pushModal({ modal: batchCategoryModal }), popModal()]),
    ).toBe(0);
  });

  it('still refetches after an untagged modal closes', () => {
    expect(
      countRefetches([pushModal({ modal: scheduleModal }), popModal()]),
    ).toBe(1);
    // The same modal opened by code that doesn't refresh keeps the refetch
    expect(
      countRefetches([pushModal({ modal: untaggedCategoryModal }), popModal()]),
    ).toBe(1);
  });

  it('refetches when an untagged modal was stacked on a tagged one', () => {
    expect(
      countRefetches([
        pushModal({ modal: batchCategoryModal }),
        pushModal({ modal: scheduleModal }),
        popModal(),
        popModal(),
      ]),
    ).toBe(1);
  });

  it('refetches when a tagged modal replaced an untagged one', () => {
    expect(
      countRefetches([
        pushModal({ modal: scheduleModal }),
        replaceModal({ modal: columnsModal }),
        popModal(),
      ]),
    ).toBe(1);
  });

  it('refetches when an untagged modal was already open at mount', () => {
    expect(countRefetches([popModal()], [scheduleModal])).toBe(1);
  });

  it('decides again for every time the modals open', () => {
    expect(
      countRefetches([
        pushModal({ modal: scheduleModal }),
        popModal(),
        pushModal({ modal: columnsModal }),
        popModal(),
        pushModal({ modal: scheduleModal }),
        popModal(),
      ]),
    ).toBe(2);
  });
});
