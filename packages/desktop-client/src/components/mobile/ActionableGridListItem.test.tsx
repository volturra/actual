import React from 'react';
import { GridList, ListLayout, Virtualizer } from 'react-aria-components';
import { Globals } from 'react-spring';

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ActionableGridListItem } from './ActionableGridListItem';

type DragState = {
  active: boolean;
  movement: [number, number];
  velocity: [number, number];
};

// Each useDrag call registers its handler and tags the element it is bound
// to, so a test can simulate a swipe on a specific row.
const dragHandlers = new Map<string, (state: DragState) => void>();
let nextDragId = 0;

vi.mock('@use-gesture/react', () => ({
  useDrag: (handler: (state: DragState) => void) => {
    const id = String(nextDragId++);
    dragHandlers.set(id, handler);
    return () => ({ 'data-drag-id': id });
  },
}));

type Item = { id: string; name: string };

const items: Item[] = Array.from({ length: 30 }, (_, i) => ({
  id: `item-${i}`,
  name: `Item ${i}`,
}));

function TestList({ onAction }: { onAction: (item: Item) => void }) {
  return (
    <Virtualizer layout={ListLayout} layoutOptions={{ rowHeight: 50 }}>
      <GridList
        aria-label="Items"
        items={items}
        style={{ height: 200, overflow: 'auto' }}
      >
        {item => (
          <ActionableGridListItem
            id={item.id}
            value={item}
            textValue={item.name}
            actions={<button>Delete {item.name}</button>}
            onAction={() => onAction(item)}
          >
            {item.name}
          </ActionableGridListItem>
        )}
      </GridList>
    </Virtualizer>
  );
}

function getSwipeContainer(name: string) {
  const row = screen.getByRole('row', { name });
  const swipeContainer = row.querySelector('[data-drag-id]');
  if (!(swipeContainer instanceof HTMLElement)) {
    throw new Error(`No swipe container for ${name}`);
  }
  return swipeContainer;
}

function getSwipeTransform(name: string) {
  return getSwipeContainer(name).style.transform;
}

async function swipe(name: string, movementX: number) {
  const dragId = getSwipeContainer(name).dataset.dragId ?? '';
  await act(async () => {
    dragHandlers.get(dragId)?.({
      active: false,
      movement: [movementX, 0],
      velocity: [0, 0],
    });
  });
}

function scrollTo(scrollTop: number) {
  const grid = screen.getByRole('grid');
  act(() => {
    grid.scrollTop = scrollTop;
    fireEvent.scroll(grid);
  });
}

describe('ActionableGridListItem', () => {
  beforeAll(() => {
    Globals.assign({ skipAnimation: true });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(
      1500,
    );
  });

  afterAll(() => {
    Globals.assign({ skipAnimation: false });
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    dragHandlers.clear();
  });

  it('only renders rows near the viewport', () => {
    render(<TestList onAction={vi.fn()} />);

    expect(screen.getByRole('row', { name: 'Item 0' })).toBeInTheDocument();
    expect(
      screen.queryByRole('row', { name: 'Item 29' }),
    ).not.toBeInTheDocument();
  });

  it('calls onAction when tapped', async () => {
    const onAction = vi.fn();
    render(<TestList onAction={onAction} />);

    await userEvent.click(screen.getByText('Item 1'));

    expect(onAction).toHaveBeenCalledWith(items[1]);
  });

  it('keeps a swiped-open row open after it scrolls out of view and back', async () => {
    render(<TestList onAction={vi.fn()} />);

    expect(getSwipeTransform('Item 0')).toBe('translate3d(0px,0,0)');

    await swipe('Item 0', -80);

    await waitFor(() =>
      expect(getSwipeTransform('Item 0')).toBe('translate3d(-100px,0,0)'),
    );
    expect(getSwipeTransform('Item 1')).toBe('translate3d(0px,0,0)');

    // Scroll far enough that the first rows' content unmounts...
    scrollTo(1300);
    expect(
      screen.queryByRole('row', { name: 'Item 0' }),
    ).not.toBeInTheDocument();
    // The rows now shown reuse the scrolled-out rows' views, but none of them
    // was swiped open.
    for (const index of [25, 26, 27, 28, 29]) {
      expect(getSwipeTransform(`Item ${index}`)).toBe('translate3d(0px,0,0)');
    }

    // ...and back: the content mounts again and should still be revealed.
    scrollTo(0);
    expect(getSwipeTransform('Item 0')).toBe('translate3d(-100px,0,0)');
    expect(getSwipeTransform('Item 1')).toBe('translate3d(0px,0,0)');

    // Swiping back closes it, and it stays closed after another remount.
    await swipe('Item 0', 80);
    await waitFor(() =>
      expect(getSwipeTransform('Item 0')).toBe('translate3d(0px,0,0)'),
    );

    scrollTo(1300);
    scrollTo(0);
    expect(getSwipeTransform('Item 0')).toBe('translate3d(0px,0,0)');
  });
});
