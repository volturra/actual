import { useCallback } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import { GridListItem } from 'react-aria-components';
import { useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { SvgCheveronRight } from '@actual-app/components/icons/v1';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import * as monthUtils from '@actual-app/core/shared/months';
import type { CategoryEntity } from '@actual-app/core/types/models';

import { useNavigate } from '#hooks/useNavigate';
import { useSyncedPref } from '#hooks/useSyncedPref';
import { pushModal } from '#modals/modalsSlice';
import { useDispatch } from '#redux';
import { envelopeBudget, trackingBudget } from '#spreadsheet/bindings';

import { BalanceCell } from './BalanceCell';
import { BudgetCell } from './BudgetCell';
import { useBudgetMonth, useBudgetMonthRef } from './BudgetMonthContext';
import { getColumnWidth, ROW_HEIGHT } from './BudgetTable';

type IncomeCategoryNameProps = {
  category: CategoryEntity;
  onEdit: (id: CategoryEntity['id'], month: string) => void;
};

function IncomeCategoryName({ category, onEdit }: IncomeCategoryNameProps) {
  const monthRef = useBudgetMonthRef();
  const sidebarColumnWidth = getColumnWidth({
    isSidebar: true,
    offset: -10,
  });
  return (
    <View
      style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'flex-start',
        width: sidebarColumnWidth,
      }}
    >
      {/* Hidden drag button */}
      <Button
        slot="drag"
        style={{
          opacity: 0,
          width: 1,
          height: 1,
          position: 'absolute',
          overflow: 'hidden',
        }}
      />
      <Button
        variant="bare"
        style={{
          maxWidth: sidebarColumnWidth,
        }}
        onPress={() => onEdit?.(category.id, monthRef.current)}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-start',
          }}
        >
          <Text
            style={{
              ...styles.lineClamp(2),
              width: sidebarColumnWidth,
              textAlign: 'left',
              ...styles.smallText,
            }}
            data-testid="category-name"
          >
            {category.name}
          </Text>
          <SvgCheveronRight
            style={{ flexShrink: 0, color: theme.tableTextSubdued }}
            width={14}
            height={14}
          />
        </View>
      </Button>
    </View>
  );
}

type IncomeCategoryCellsProps = {
  category: CategoryEntity;
  month: string;
  onBudgetAction: (month: string, action: string, args: unknown) => void;
  onPress: () => void;
};

function IncomeCategoryCells({
  category,
  month,
  onBudgetAction,
  onPress,
}: IncomeCategoryCellsProps) {
  const { t } = useTranslation();
  const columnWidth = getColumnWidth();
  const [budgetType = 'envelope'] = useSyncedPref('budgetType');

  const budgeted =
    budgetType === 'tracking'
      ? trackingBudget.catBudgeted(category.id)
      : envelopeBudget.catBudgeted(category.id);

  const balance =
    budgetType === 'tracking'
      ? trackingBudget.catSumAmount(category.id)
      : envelopeBudget.catSumAmount(category.id);

  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
      }}
    >
      {budgetType === 'tracking' && (
        <View
          style={{
            width: columnWidth,
            justifyContent: 'center',
            alignItems: 'flex-end',
          }}
        >
          <BudgetCell
            binding={budgeted}
            type="financial"
            category={category}
            month={month}
            onBudgetAction={onBudgetAction}
          />
        </View>
      )}

      <View
        style={{
          width: columnWidth,
          justifyContent: 'center',
          alignItems: 'flex-end',
        }}
      >
        <BalanceCell
          binding={balance}
          category={category}
          onPress={onPress}
          aria-label={
            budgetType === 'envelope'
              ? t('Open balance menu for {{categoryName}} category', {
                  categoryName: category.name,
                })
              : t('Show transactions for {{categoryName}} category', {
                  categoryName: category.name,
                })
          }
        />
      </View>
    </View>
  );
}

type IncomeCategoryListItemProps = ComponentPropsWithoutRef<
  typeof GridListItem<CategoryEntity>
> & {
  onEdit: (id: CategoryEntity['id'], month: string) => void;
  onBudgetAction: (month: string, action: string, args: unknown) => void;
};

// The list's collection is built from these props, so nothing here may
// depend on the month: the row's content reads it from context instead.
export function IncomeCategoryListItem({
  onEdit,
  onBudgetAction,
  ...props
}: IncomeCategoryListItemProps) {
  const { value: category } = props;

  if (!category) {
    return null;
  }

  return (
    <GridListItem
      textValue={category.name}
      data-testid="category-row"
      {...props}
    >
      <IncomeCategoryRow
        category={category}
        onEdit={onEdit}
        onBudgetAction={onBudgetAction}
      />
    </GridListItem>
  );
}

type IncomeCategoryRowProps = {
  category: CategoryEntity;
  onEdit: (id: CategoryEntity['id'], month: string) => void;
  onBudgetAction: (month: string, action: string, args: unknown) => void;
};

function IncomeCategoryRow({
  category,
  onEdit,
  onBudgetAction,
}: IncomeCategoryRowProps) {
  const month = useBudgetMonth();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const [budgetType = 'envelope'] = useSyncedPref('budgetType');
  const balanceMenuModalName = `envelope-income-balance-menu`;

  const onShowActivity = useCallback(() => {
    void navigate(`/categories/${category.id}?month=${month}`);
  }, [category, month, navigate]);

  const onCarryover = useCallback(
    (carryover: boolean) => {
      onBudgetAction(month, 'carryover', {
        category: category.id,
        flag: carryover,
      });
    },
    [category, onBudgetAction, month],
  );

  const onOpenBalanceMenu = useCallback(() => {
    dispatch(
      pushModal({
        modal: {
          name: balanceMenuModalName,
          options: {
            month,
            categoryId: category.id,
            onCarryover,
            onShowActivity,
          },
        },
      }),
    );
  }, [
    category,
    balanceMenuModalName,
    dispatch,
    month,
    onShowActivity,
    onCarryover,
  ]);

  return (
    <View
      style={{
        height: ROW_HEIGHT,
        borderColor: theme.tableBorder,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingLeft: 5,
        paddingRight: 5,
        borderBottomWidth: 1,
        opacity: category.hidden ? 0.5 : undefined,
        backgroundColor: monthUtils.isCurrentMonth(month)
          ? theme.budgetCurrentMonth
          : theme.budgetOtherMonth,
      }}
    >
      <IncomeCategoryName category={category} onEdit={onEdit} />
      <IncomeCategoryCells
        key={`${category.id}`}
        category={category}
        month={month}
        onBudgetAction={onBudgetAction}
        onPress={budgetType === 'envelope' ? onOpenBalanceMenu : onShowActivity}
      />
    </View>
  );
}
