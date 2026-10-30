import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  type DragEndEvent,
  type MouseSensorOptions,
  type PointerSensorOptions,
  type ScreenReaderInstructions,
  type TouchSensorOptions,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type TouchEvent,
} from "react";
import type { LedgerAccount } from "../../shared/report";
import { Button } from "./ui/button";

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(notify: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const media = window.matchMedia(reducedMotionQuery);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
}

function useReducedMotion() {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () =>
      typeof window !== "undefined" &&
      Boolean(window.matchMedia?.(reducedMotionQuery).matches),
    () => false,
  );
}

function isMenuControl(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest(".account-menu-trigger"))
  );
}

/** 鼠标与触控笔按短距离激活拖拽；触摸屏交给带长按延迟的 TouchSensor，避免打断页面滚动。 */
class MousePenPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: (
        { nativeEvent: event }: PointerEvent,
        { onActivation }: PointerSensorOptions,
      ) => {
        if (
          !event.isPrimary ||
          event.button !== 0 ||
          event.pointerType === "touch" ||
          isMenuControl(event.target)
        ) {
          return false;
        }
        onActivation?.({ event });
        return true;
      },
    },
  ];
}

class AccountMouseSensor extends MouseSensor {
  static activators = [
    {
      eventName: "onMouseDown" as const,
      handler: (
        { nativeEvent: event }: MouseEvent,
        { onActivation }: MouseSensorOptions,
      ) => {
        if (event.button !== 0 || isMenuControl(event.target)) {
          return false;
        }
        onActivation?.({ event });
        return true;
      },
    },
  ];
}

class AccountTouchSensor extends TouchSensor {
  static activators = [
    {
      eventName: "onTouchStart" as const,
      handler: (
        { nativeEvent: event }: TouchEvent,
        { onActivation }: TouchSensorOptions,
      ) => {
        if (event.touches.length > 1 || isMenuControl(event.target)) {
          return false;
        }
        onActivation?.({ event });
        return true;
      },
    },
  ];
}

const screenReaderInstructions: ScreenReaderInstructions = {
  draggable:
    "按空格键或回车键拿起账户，使用上下方向键调整顺序，再次按空格键或回车键放下，按 Esc 取消排序。",
};

interface SortableItemContextValue {
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  setActivatorNodeRef: (element: HTMLElement | null) => void;
  isDragging: boolean;
}

const SortableItemContext = createContext<SortableItemContextValue | null>(
  null,
);

export interface SortableAccountListProps {
  accounts: LedgerAccount[];
  enabled: boolean;
  onReorder?: (activeId: string, overId: string) => void;
  children: ReactNode;
}

export function SortableAccountList({
  accounts,
  enabled,
  onReorder,
  children,
}: SortableAccountListProps) {
  const reducedMotion = useReducedMotion();
  const sensors = useSensors(
    useSensor(MousePenPointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(AccountMouseSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(AccountTouchSensor, {
      activationConstraint: { delay: 180, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      scrollBehavior: reducedMotion ? "auto" : "smooth",
    }),
  );

  const itemIds = useMemo(
    () => accounts.map((account) => account.id),
    [accounts],
  );

  const accessibility = useMemo(() => {
    const accountName = (id: UniqueIdentifier) =>
      accounts.find((item) => item.id === String(id))?.name ?? String(id);
    const positionLabel = (id: UniqueIdentifier) => {
      const index = accounts.findIndex((item) => item.id === String(id));
      return index >= 0 ? `第 ${index + 1} 位（共 ${accounts.length} 个）` : "";
    };
    let movedFromInitialSlot = false;
    const announcements: Announcements = {
      onDragStart({ active }) {
        movedFromInitialSlot = false;
        return `已拿起 ${accountName(active.id)}，当前位于${positionLabel(active.id)}。`;
      },
      onDragOver({ active, over }) {
        if (!over) {
          return `${accountName(active.id)} 当前不在可放置区域。`;
        }
        if (over.id === active.id && !movedFromInitialSlot) {
          return undefined;
        }
        movedFromInitialSlot = over.id !== active.id;
        return `已将 ${accountName(active.id)} 移到${positionLabel(over.id)}（${accountName(over.id)} 位置）。`;
      },
      onDragEnd({ active, over }) {
        movedFromInitialSlot = false;
        if (over) {
          return `已将 ${accountName(active.id)} 放到${positionLabel(over.id)}。`;
        }
        return `已放下 ${accountName(active.id)}。`;
      },
      onDragCancel({ active }) {
        movedFromInitialSlot = false;
        return `已取消拖动，${accountName(active.id)} 保持原位置。`;
      },
    };
    return {
      announcements,
      screenReaderInstructions,
    };
  }, [accounts]);

  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (!over || active.id === over.id) return;
      onReorder?.(String(active.id), String(over.id));
    },
    [onReorder],
  );

  if (!enabled) return <>{children}</>;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      accessibility={accessibility}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

export interface SortableAccountItemProps {
  id: string;
  enabled: boolean;
  as?: "div" | "li";
  className?: string;
  manageable?: boolean;
  children: ReactNode;
}

function ActiveSortableAccountItem({
  id,
  as: Tag = "div",
  className,
  manageable = true,
  children,
}: Omit<SortableAccountItemProps, "enabled">) {
  const reducedMotion = useReducedMotion();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({
    id,
    attributes: { roleDescription: "可排序账户" },
    transition: reducedMotion
      ? null
      : { duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  });

  const translate = transform
    ? CSS.Translate.toString({ ...transform, x: 0 })
    : undefined;
  const style: CSSProperties | undefined =
    translate || transition
      ? {
          transform: translate,
          transition: reducedMotion ? "none" : transition,
        }
      : undefined;

  const contextValue = useMemo<SortableItemContextValue>(
    () => ({
      attributes,
      listeners,
      setActivatorNodeRef,
      isDragging,
    }),
    [attributes, listeners, setActivatorNodeRef, isDragging],
  );

  return (
    <SortableItemContext.Provider value={contextValue}>
      <Tag
        ref={setNodeRef}
        className={className}
        data-account-id={id}
        data-manageable={manageable ? "" : undefined}
        data-sorting="true"
        data-dragging={isDragging ? "true" : undefined}
        data-over={isOver && !isDragging ? "true" : undefined}
        style={style}
        {...listeners}
      >
        {children}
      </Tag>
    </SortableItemContext.Provider>
  );
}

export function SortableAccountItem({
  enabled,
  id,
  as: Tag = "div",
  className,
  manageable = true,
  children,
}: SortableAccountItemProps) {
  if (!enabled) {
    return (
      <Tag
        className={className}
        data-account-id={id}
        data-manageable={manageable ? "" : undefined}
      >
        {children}
      </Tag>
    );
  }
  return (
    <ActiveSortableAccountItem
      id={id}
      as={Tag}
      className={className}
      manageable={manageable}
    >
      {children}
    </ActiveSortableAccountItem>
  );
}

export function AccountDragHandle({ name }: { name: string }) {
  const context = useContext(SortableItemContext);
  if (!context) return null;
  return (
    <Button
      ref={context.setActivatorNodeRef}
      variant="ghost"
      size="icon"
      className="account-drag-handle"
      aria-label={`拖动排序 ${name}`}
      title="拖动排序"
      {...context.attributes}
      {...context.listeners}
    >
      <GripVertical size={18} aria-hidden="true" />
    </Button>
  );
}
