import type { Modal } from '#modals/modalsSlice';

export type ModalCloseRefetchProps = {
  modalShowing?: boolean;
  modalNeedsRefetch?: boolean;
};

/**
 * Whether any modal on the stack could change transactions without its
 * opener refreshing the register afterwards.
 */
export function modalStackNeedsRefetch(modalStack: Modal[]) {
  return modalStack.some(modal => !modal.openerRefreshes);
}

/**
 * Tracks the modals shown over the register between the stack opening and
 * closing. Returns a function to call on every update; it returns `true`
 * when the last modal just closed and at least one modal shown in the
 * meantime was not tagged with `openerRefreshes`.
 */
export function createModalCloseRefetchTracker() {
  let needsRefetch = false;

  return function didModalsCloseNeedingRefetch(
    prevProps: ModalCloseRefetchProps,
    props: ModalCloseRefetchProps,
  ) {
    if (prevProps.modalNeedsRefetch || props.modalNeedsRefetch) {
      needsRefetch = true;
    }

    if (prevProps.modalShowing && !props.modalShowing) {
      const result = needsRefetch;
      needsRefetch = false;
      return result;
    }

    return false;
  };
}
