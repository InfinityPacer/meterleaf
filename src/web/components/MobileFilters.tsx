import { useEffect, useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { useMobileLayout } from "../lib/use-mobile-layout";
import { Button } from "./ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetClose,
} from "./ui/sheet";

/** 日期是高频入口；其余筛选共享同一组控件，选择立即生效。 */
export function MobileFilters({
  children,
  date,
  primary,
  presets,
  summary,
  page,
  enabled,
}: {
  children: ReactNode;
  date?: ReactNode;
  /** 手机高频筛选直接展示，其余条件保留在弹层。 */
  primary?: ReactNode;
  presets?: ReactNode;
  summary: string;
  page: string;
  enabled: boolean;
}) {
  const mobile = useMobileLayout();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [mobile, page]);
  if (!mobile || !enabled)
    return (
      <div className="filterbar">
        <div className="filters">
          {date}
          {children}
        </div>
      </div>
    );
  return (
    <div className="mobile-filterbar">
      {presets}
      <div className="mobile-filter-actions">
        {!presets && date}
        {primary}
        <Button
          variant="outline"
          className="mobile-filter-trigger"
          onClick={() => setOpen(true)}
          aria-label="筛选与计价"
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <SlidersHorizontal size={17} />
          <span>筛选</span>
        </Button>
      </div>
      <p className="mobile-filter-summary sr-only">{summary}</p>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="mobile-filter-sheet">
          <SheetHeader>
            <SheetTitle>筛选与计价</SheetTitle>
            <SheetDescription>{summary}</SheetDescription>
          </SheetHeader>
          <div className="mobile-filter-fields">{children}</div>
          <SheetClose render={<Button className="mobile-filter-done" />}>
            完成
          </SheetClose>
        </SheetContent>
      </Sheet>
    </div>
  );
}
