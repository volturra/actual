import type { RefObject } from 'react';

import type { Falsy } from '@actual-app/core/types/util';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { addItems } from '#contextmenu/contextMenuSlice';
import type { ContextMenuItem } from '#contextmenu/types';
import { useRefEventListener } from '#hooks/useRefEventListener';
import { useDispatch } from '#redux';

import { useContextMenu } from './useContextMenu';

// Mock dependencies
vi.mock('#redux', () => ({
  useDispatch: vi.fn(),
  useSelector: vi.fn(),
}));

vi.mock('#hooks/useRefEventListener', () => ({
  useRefEventListener: vi.fn(),
}));

describe('useContextMenu', () => {
  let mockDispatch: Mock;
  let mockTriggerRef: {
    current: { getBoundingClientRect: Mock; dispatchEvent: Mock };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatch = vi.fn();
    (useDispatch as unknown as Mock).mockReturnValue(mockDispatch);

    mockTriggerRef = {
      current: {
        getBoundingClientRect: vi.fn(() => ({ x: 100, y: 200, height: 50 })),
        dispatchEvent: vi.fn(),
      },
    };
  });

  it('should register contextmenu event listener on triggerRef', () => {
    const items = [{ name: 'test', text: 'Test', onClick: vi.fn() }];

    renderHook(() =>
      useContextMenu({
        triggerRef: mockTriggerRef as unknown as RefObject<HTMLElement | null>,
        items,
      }),
    );

    expect(useRefEventListener).toHaveBeenCalledWith(
      mockTriggerRef,
      'contextmenu',
      expect.any(Function),
    );
  });

  it('should dispatch addItems when contextmenu event is fired and enabled is true', () => {
    const items = [{ name: 'test', text: 'Test', onClick: vi.fn() }];

    renderHook(() =>
      useContextMenu({
        triggerRef: mockTriggerRef as unknown as RefObject<HTMLElement | null>,
        items,
      }),
    );

    const listener = (useRefEventListener as Mock).mock.calls[0][2];

    // Simulate event
    listener({
      preventDefault: vi.fn(),
      clientX: 100,
      clientY: 200,
    } as unknown as MouseEvent);

    expect(mockDispatch).toHaveBeenCalledWith(addItems(items));
  });

  it('should leave out hidden and falsy items', () => {
    const visible = { name: 'visible', text: 'Visible', onClick: vi.fn() };
    const hidden = {
      name: 'hidden',
      text: 'Hidden',
      onClick: vi.fn(),
      hidden: true,
    };

    renderHook(() =>
      useContextMenu({
        triggerRef: mockTriggerRef as unknown as RefObject<HTMLElement | null>,
        items: [visible, hidden, false, null],
      }),
    );

    const listener = (useRefEventListener as Mock).mock.calls[0][2];
    listener({
      preventDefault: vi.fn(),
      clientX: 100,
      clientY: 200,
    } as unknown as MouseEvent);

    expect(mockDispatch).toHaveBeenCalledWith(addItems([visible]));
  });

  it('should only call an items function when the menu opens', () => {
    const visible = { name: 'visible', text: 'Visible', onClick: vi.fn() };
    const hidden = {
      name: 'hidden',
      text: 'Hidden',
      onClick: vi.fn(),
      hidden: true,
    };
    const getItems = vi.fn((): Falsy<ContextMenuItem>[] => [
      visible,
      hidden,
      false,
    ]);

    const { rerender } = renderHook(() =>
      useContextMenu({
        triggerRef: mockTriggerRef as unknown as RefObject<HTMLElement | null>,
        items: getItems,
      }),
    );
    rerender();

    expect(getItems).not.toHaveBeenCalled();

    const listener = (useRefEventListener as Mock).mock.calls.at(-1)?.[2];
    listener({
      preventDefault: vi.fn(),
      clientX: 100,
      clientY: 200,
    } as unknown as MouseEvent);

    expect(getItems).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(addItems([visible]));
  });

  it('should not call an items function when enabled is false', () => {
    const getItems = vi.fn(() => [
      { name: 'test', text: 'Test', onClick: vi.fn() },
    ]);

    renderHook(() =>
      useContextMenu({
        triggerRef: mockTriggerRef as unknown as RefObject<HTMLElement | null>,
        enabled: false,
        items: getItems,
      }),
    );

    const listener = (useRefEventListener as Mock).mock.calls[0][2];
    listener({
      preventDefault: vi.fn(),
      clientX: 100,
      clientY: 200,
    } as unknown as MouseEvent);

    expect(getItems).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('should not dispatch addItems when enabled is false', () => {
    const items = [{ name: 'test', text: 'Test', onClick: vi.fn() }];

    renderHook(() =>
      useContextMenu({
        triggerRef: mockTriggerRef as unknown as RefObject<HTMLElement | null>,
        enabled: false,
        items,
      }),
    );

    const listener = (useRefEventListener as Mock).mock.calls[0][2];

    // Simulate event
    listener({
      preventDefault: vi.fn(),
      clientX: 100,
      clientY: 200,
    } as unknown as MouseEvent);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('should provide handleContextMenu callback that dispatches contextmenu event', () => {
    const items = [{ name: 'test', text: 'Test', onClick: vi.fn() }];

    const { result } = renderHook(() =>
      useContextMenu({
        triggerRef: mockTriggerRef as unknown as RefObject<HTMLElement | null>,
        items,
      }),
    );

    act(() => {
      result.current.handleContextMenu();
    });

    expect(mockTriggerRef.current.getBoundingClientRect).toHaveBeenCalled();
    expect(mockTriggerRef.current.dispatchEvent).toHaveBeenCalled();

    const dispatchedEvent =
      mockTriggerRef.current.dispatchEvent.mock.calls[0][0];
    expect(dispatchedEvent.type).toBe('contextmenu');
    expect(dispatchedEvent.clientX).toBe(100);
    expect(dispatchedEvent.clientY).toBe(250); // y + height (200 + 50)
  });

  it('handleContextMenu should do nothing if enabled is false', () => {
    const items = [{ name: 'test', text: 'Test', onClick: vi.fn() }];

    const { result } = renderHook(() =>
      useContextMenu({
        triggerRef: mockTriggerRef as unknown as RefObject<HTMLElement | null>,
        enabled: false,
        items,
      }),
    );

    act(() => {
      result.current.handleContextMenu();
    });

    expect(mockTriggerRef.current.dispatchEvent).not.toHaveBeenCalled();
  });
});
