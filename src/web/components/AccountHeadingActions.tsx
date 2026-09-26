import { Archive, ArrowLeft, ArrowUpDown, Check } from "lucide-react";
import type { ReactNode } from "react";

/** 账户区标题右侧的切换按钮；Web 用通用按钮，手机首页传入自己的按钮样式。 */
export function AccountHeadingActions({
  archivedCount,
  showArchived,
  onShowArchived,
  editingOrder,
  onEditingOrder,
  canSort,
  render,
}: {
  archivedCount: number;
  showArchived: boolean;
  onShowArchived: (show: boolean) => void;
  editingOrder: boolean;
  onEditingOrder: (editing: boolean) => void;
  canSort: boolean;
  render: (props: {
    onClick: () => void;
    children: ReactNode;
    "aria-label"?: string;
    "aria-pressed"?: boolean;
  }) => ReactNode;
}) {
  if (showArchived)
    return (
      <div className="account-heading-actions">
        {render({
          onClick: () => onShowArchived(false),
          children: (
            <>
              <ArrowLeft size={16} aria-hidden="true" />
              使用中账户
            </>
          ),
        })}
      </div>
    );
  return (
    <div className="account-heading-actions">
      {archivedCount > 0 &&
        !editingOrder &&
        render({
          onClick: () => onShowArchived(true),
          children: (
            <>
              <Archive size={16} aria-hidden="true" />
              已归档 {archivedCount}
            </>
          ),
        })}
      {(canSort || editingOrder) &&
        render({
          onClick: () => onEditingOrder(!editingOrder),
          "aria-label": editingOrder ? "完成账户排序" : "调整账户顺序",
          "aria-pressed": editingOrder,
          children: (
            <>
              {editingOrder ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <ArrowUpDown size={16} aria-hidden="true" />
              )}
              {editingOrder ? "完成" : "排序"}
            </>
          ),
        })}
    </div>
  );
}
