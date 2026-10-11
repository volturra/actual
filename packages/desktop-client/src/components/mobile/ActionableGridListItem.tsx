import React, { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { GridListItem } from 'react-aria-components';
import type { GridListItemProps } from 'react-aria-components';
import { animated, config, useSpring } from 'react-spring';

import { Button } from '@actual-app/components/button';
import { styles } from '@actual-app/components/styles';
import { theme } from '@actual-app/components/theme';
import type { WithRequired } from '@actual-app/core/types/util';
import { useDrag } from '@use-gesture/react';

type ActionableGridListItemProps<T> = {
  actions?: ReactNode | ((params: { close: () => void }) => ReactNode);
  actionsBackgroundColor?: string;
  actionsWidth?: number;
  children?: ReactNode;
} & Omit<WithRequired<GridListItemProps<T>, 'value'>, 'children'>;

// Lists build their collection by rendering every item, not only the visible
// ones. To keep that cheap, the spring and gesture handlers live in the
// item's content, which is only rendered for rows that are actually shown.
// The revealed state stays here so a swiped-open row is still open when it
// is scrolled out of view and back.
export function ActionableGridListItem<T extends object>({
  value,
  textValue,
  actions,
  actionsBackgroundColor = theme.errorBackground,
  actionsWidth = 100,
  children,
  onAction,
  ...props
}: ActionableGridListItemProps<T>) {
  const [isRevealed, setIsRevealed] = useState(false);
  // The virtualizer reuses a row's rendered view for another item when
  // scrolling, so the content is keyed to this item to keep one item's swipe
  // position from showing on another.
  const contentKey = useId();

  const hasActions = !!actions;

  return (
    <GridListItem
      {...props}
      value={value}
      textValue={textValue}
      style={{
        ...styles.mobileListItem,
        padding: 0,
        backgroundColor: hasActions
          ? actionsBackgroundColor
          : (styles.mobileListItem.backgroundColor ?? 'transparent'),
        overflow: 'hidden',
      }}
    >
      <ActionableGridListItemContent
        key={contentKey}
        actions={actions}
        actionsBackgroundColor={actionsBackgroundColor}
        actionsWidth={actionsWidth}
        isRevealed={isRevealed}
        onRevealedChange={setIsRevealed}
        onAction={onAction}
      >
        {children}
      </ActionableGridListItemContent>
    </GridListItem>
  );
}

type ActionableGridListItemContentProps = {
  actions?: ActionableGridListItemProps<object>['actions'];
  actionsBackgroundColor: string;
  actionsWidth: number;
  isRevealed: boolean;
  onRevealedChange: (isRevealed: boolean) => void;
  children?: ReactNode;
  onAction?: () => void;
};

function ActionableGridListItemContent({
  actions,
  actionsBackgroundColor,
  actionsWidth,
  isRevealed,
  onRevealedChange,
  children,
  onAction,
}: ActionableGridListItemContentProps) {
  const dragStartedRef = useRef(false);

  const hasActions = !!actions;

  // Spring animation for the swipe. It starts at the revealed offset when the
  // row was left open before this content was (re)mounted.
  const [{ x }, api] = useSpring(
    () => ({
      from: { x: isRevealed ? -actionsWidth : 0 },
      config: config.stiff,
    }),
    [],
  );

  // Handle drag gestures
  const bind = useDrag(
    ({ active, movement: [mx], velocity: [vx] }) => {
      const startPos = isRevealed ? -actionsWidth : 0;
      const currentX = startPos + mx;

      if (active) {
        dragStartedRef.current = true;
        void api.start({
          to: { x: Math.max(-actionsWidth, Math.min(0, currentX)) },
          onRest: () => {
            dragStartedRef.current = false;
          },
        });
        return;
      }

      // Snap to revealed (-actionsWidth) or closed (0) based on position and velocity
      const shouldReveal =
        currentX < -actionsWidth / 2 ||
        (vx < -0.5 && currentX < -actionsWidth / 5);

      void api.start({
        to: { x: shouldReveal ? -actionsWidth : 0 },
        onRest: () => {
          dragStartedRef.current = false;
          onRevealedChange(shouldReveal);
        },
      });
    },
    {
      axis: 'x',
      from: () => [isRevealed ? -actionsWidth : 0, 0],
      enabled: hasActions,
    },
  );

  // Prevent onAction from firing when dragging or if a drag was started
  const handleAction = () => {
    // Only allow action if no drag was started
    if (!dragStartedRef.current) {
      onAction?.();
    }
  };

  return (
    <animated.div
      {...(hasActions ? bind() : {})}
      style={{
        ...(hasActions
          ? { transform: x.to(v => `translate3d(${v}px,0,0)`) }
          : {}),
        display: 'flex',
        touchAction: hasActions ? 'pan-y' : 'auto',
        cursor: hasActions ? 'grab' : 'pointer',
      }}
    >
      {/* Main content */}
      <Button
        variant="bare"
        style={{
          flex: 1,
          backgroundColor: theme.tableBackground,
          minWidth: '100%',
          padding: 16,
          textAlign: 'left',
          borderRadius: 0,
          justifyContent: 'flex-start',
          alignItems: 'flex-start',
        }}
        onPressStart={e => e.continuePropagation()}
        onClick={handleAction}
      >
        {children}
      </Button>

      {/* Actions that appear when swiped */}
      {hasActions && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            backgroundColor: actionsBackgroundColor,
            minWidth: actionsWidth,
          }}
        >
          {typeof actions === 'function'
            ? actions({
                close: () => {
                  void api.start({
                    to: { x: 0 },
                    onRest: () => {
                      onRevealedChange(false);
                    },
                  });
                },
              })
            : actions}
        </div>
      )}
    </animated.div>
  );
}
