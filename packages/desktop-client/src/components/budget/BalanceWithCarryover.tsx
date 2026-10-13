// @ts-strict-ignore
import React, { useCallback } from 'react';
import type {
  ComponentPropsWithoutRef,
  ComponentType,
  CSSProperties,
} from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { SvgArrowThinRight } from '@actual-app/components/icons/v1';
import { styles } from '@actual-app/components/styles';
import { theme } from '@actual-app/components/theme';
import { Tooltip } from '@actual-app/components/tooltip';
import { View } from '@actual-app/components/view';
import type { TransObjectLiteral } from '@actual-app/core/types/util';
import { css } from '@emotion/css';

import { CellValue, CellValueText } from '#components/spreadsheet/CellValue';
import { useFeatureFlag } from '#hooks/useFeatureFlag';
import { useFormat } from '#hooks/useFormat';
import type { FormatType } from '#hooks/useFormat';
import { useSheetValue } from '#hooks/useSheetValue';
import type { Binding } from '#spreadsheet';

import { makeBalanceAmountStyle } from './util';

type CarryoverIndicatorProps = {
  style?: CSSProperties;
};

export function CarryoverIndicator({ style }: CarryoverIndicatorProps) {
  return (
    <View
      style={{
        marginLeft: 2,
        position: 'absolute',
        right: '-4px',
        alignSelf: 'center',
        justifyContent: 'center',
        top: 0,
        bottom: 0,
        ...style,
      }}
    >
      <SvgArrowThinRight
        width={style?.width || 7}
        height={style?.height || 7}
        style={style}
      />
    </View>
  );
}

function GoalTooltipRow({ children }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 10,
      }}
    >
      {children}
    </div>
  );
}

type GoalStatusDisplayProps = {
  balanceValue: number;
  type: FormatType;
  goalValue: number | null;
  budgetedValue: number | null;
  longGoalValue: number | null;
};

// Its own component so the goal tooltip's content is only rendered (and its
// amounts formatted) when the tooltip is shown, not for every budget cell.
function GoalStatusDisplay({
  balanceValue,
  type,
  goalValue,
  budgetedValue,
  longGoalValue,
}: GoalStatusDisplayProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const differenceToGoal =
    longGoalValue === 1 ? balanceValue - goalValue : budgetedValue - goalValue;

  return (
    <>
      <span style={{ fontWeight: 'bold' }}>
        {differenceToGoal === 0 ? (
          <span style={{ color: theme.templateNumberFunded }}>
            <Trans>Fully funded</Trans>
          </span>
        ) : differenceToGoal > 0 ? (
          <span style={{ color: theme.templateNumberFunded }}>
            <Trans>
              Overfunded ({{ amount: format(differenceToGoal, 'financial') }})
            </Trans>
          </span>
        ) : (
          <span style={{ color: theme.templateNumberUnderFunded }}>
            <Trans>
              Underfunded ({{ amount: format(differenceToGoal, 'financial') }})
            </Trans>
          </span>
        )}
      </span>
      <GoalTooltipRow>
        <Trans>
          <div>Goal Type:</div>
          <div>
            {
              {
                type: longGoalValue === 1 ? t('Goal') : t('Automation'),
              } as TransObjectLiteral
            }
          </div>
        </Trans>
      </GoalTooltipRow>
      <GoalTooltipRow>
        <Trans>
          <div>Goal:</div>
          <div>
            {
              {
                amount: format(goalValue, 'financial'),
              } as TransObjectLiteral
            }
          </div>
        </Trans>
      </GoalTooltipRow>
      <GoalTooltipRow>
        {longGoalValue !== 1 ? (
          <Trans>
            <div>Budgeted:</div>
            <div>
              {
                {
                  amount: format(budgetedValue, 'financial'),
                } as TransObjectLiteral
              }
            </div>
          </Trans>
        ) : (
          <Trans>
            <div>Balance:</div>
            <div>
              {
                {
                  amount: format(balanceValue, type),
                } as TransObjectLiteral
              }
            </div>
          </Trans>
        )}
      </GoalTooltipRow>
    </>
  );
}

type CellValueChildren = ComponentPropsWithoutRef<typeof CellValue>['children'];

type ChildrenWithClassName = (
  props: Parameters<CellValueChildren>[0] & {
    className: string;
  },
) => ReturnType<CellValueChildren>;

type BalanceWithCarryoverProps = Omit<
  ComponentPropsWithoutRef<typeof CellValue>,
  'children' | 'binding'
> & {
  children?: ChildrenWithClassName;
  carryover: Binding<'envelope-budget' | 'tracking-budget', 'carryover'>;
  /**
   * Expense category balance binding is `leftover`,
   * while income category balance binding is `sum-amount`.
   */
  balance: Binding<
    'envelope-budget' | 'tracking-budget',
    'leftover' | 'sum-amount'
  >;
  goal: Binding<'envelope-budget' | 'tracking-budget', 'goal'>;
  budgeted: Binding<'envelope-budget' | 'tracking-budget', 'budget'>;
  longGoal: Binding<'envelope-budget' | 'tracking-budget', 'long-goal'>;
  isDisabled?: boolean;
  shouldInlineGoalStatus?: boolean;
  CarryoverIndicator?: ComponentType<CarryoverIndicatorProps>;
  tooltipDisabled?: boolean;
};

export function BalanceWithCarryover({
  carryover,
  balance,
  goal,
  budgeted,
  longGoal,
  isDisabled,
  shouldInlineGoalStatus,
  CarryoverIndicator: CarryoverIndicatorComponent = CarryoverIndicator,
  tooltipDisabled,
  children,
  ...props
}: BalanceWithCarryoverProps) {
  const { isNarrowWidth } = useResponsive();
  const carryoverValue = useSheetValue(carryover);
  const goalValue = useSheetValue(goal);
  const budgetedValue = useSheetValue(budgeted);
  const longGoalValue = useSheetValue(longGoal);
  const isGoalTemplatesEnabled = useFeatureFlag('goalTemplatesEnabled');
  const getBalanceAmountStyle = useCallback(
    (balanceValue: number) =>
      makeBalanceAmountStyle(
        balanceValue,
        isGoalTemplatesEnabled ? goalValue : null,
        longGoalValue === 1 ? balanceValue : budgetedValue,
      ),
    [budgetedValue, goalValue, isGoalTemplatesEnabled, longGoalValue],
  );
  const getDefaultClassName = useCallback(
    (balanceValue: number) =>
      css({
        ...getBalanceAmountStyle(balanceValue),
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        textAlign: 'right',
        ...(!isDisabled && {
          cursor: 'pointer',
        }),
        ':hover': { textDecoration: 'underline' },
      }),
    [getBalanceAmountStyle, isDisabled],
  );
  return (
    <CellValue binding={balance} type="financial" {...props}>
      {({ type, name, value: balanceValue }) => (
        <>
          <Tooltip
            content={
              <View style={{ padding: 10 }}>
                <GoalStatusDisplay
                  balanceValue={balanceValue}
                  type={type}
                  goalValue={goalValue}
                  budgetedValue={budgetedValue}
                  longGoalValue={longGoalValue}
                />
              </View>
            }
            style={{ ...styles.tooltip, borderRadius: '0px 5px 5px 0px' }}
            placement="bottom"
            triggerProps={{
              delay: 750,
              isDisabled:
                !isGoalTemplatesEnabled ||
                goalValue == null ||
                isNarrowWidth ||
                tooltipDisabled,
            }}
          >
            {children ? (
              children({
                type,
                name,
                value: balanceValue,
                className: getDefaultClassName(balanceValue),
              })
            ) : (
              <CellValueText
                type={type}
                name={name}
                value={balanceValue}
                className={getDefaultClassName(balanceValue)}
              />
            )}
          </Tooltip>

          {carryoverValue && (
            <CarryoverIndicatorComponent
              style={getBalanceAmountStyle(balanceValue)}
            />
          )}
          {shouldInlineGoalStatus &&
            isGoalTemplatesEnabled &&
            goalValue !== null && (
              <>
                <View
                  style={{
                    borderTop: '1px solid ' + theme.tableBorderSeparator,
                    width: '160px',
                    margin: '3px 0px',
                  }}
                />
                <View>
                  <GoalStatusDisplay
                    balanceValue={balanceValue}
                    type={type}
                    goalValue={goalValue}
                    budgetedValue={budgetedValue}
                    longGoalValue={longGoalValue}
                  />
                </View>
              </>
            )}
        </>
      )}
    </CellValue>
  );
}
