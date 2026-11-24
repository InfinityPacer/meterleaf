import { Archive, ArrowLeft, ArrowUpDown, Check, Layers } from "lucide-react";
import type { ReactNode } from "react";

/** 账户区标题右侧的切换按钮；Web 用通用按钮，手机首页传入自己的按钮样式。 */
export function AccountHeadingActions({
  archivedCount,
  showArchived,
  onShowArchived,
  editingOrder,
  onEditingOrder,
  canSort,
  grouped = false,
  onGrouped,
  canGroup = false,
  compactGroupLabel = false,
  render,
}: {
  archivedCount: number;
  showArchived: boolean;
  onShowArchived: (show: boolean) => void;
  editingOrder: boolean;
  onEditingOrder: (editing: boolean) => void;
  canSort: boolean;
  grouped?: boolean;
  onGrouped?: (grouped: boolean) => void;
  canGroup?: boolean;
  compactGroupLabel?: boolean;
  render: (props: {
    onClick: () => void;
    children: ReactNode;
    "aria-label"?: string;
    "aria-pressed"?: boolean;
    title?: string;
    "data-active"?: "true";
    "data-compact"?: "true";
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
  const groupLabel = grouped ? "取消按平台分组" : "按平台分组";
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
      {!editingOrder &&
        canGroup &&
        onGrouped &&
        render({
          onClick: () => onGrouped(!grouped),
          "aria-label": groupLabel,
          "aria-pressed": grouped,
          title: groupLabel,
          "data-active": grouped ? "true" : undefined,
          "data-compact": compactGroupLabel ? "true" : undefined,
          children: compactGroupLabel ? (
            <Layers size={16} aria-hidden="true" />
          ) : (
            <>
              <Layers size={16} aria-hidden="true" />
              分组
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
