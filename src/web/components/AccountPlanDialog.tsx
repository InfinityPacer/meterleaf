import { useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { manualAccountPlans } from "../../shared/account-plan";
import { planBadge } from "../lib/plan";
import { FilterSelect } from "./FilterSelect";
import { Button } from "./ui/button";

export interface PlanTarget {
  id: string;
  name: string;
  /** 用户已指定的套餐；未指定时为 null，使用自动识别结果。 */
  plan: string | null;
}

const automatic = "";

/**
 * 套餐只影响徽标和额度预估依据。补上或修正套餐不算套餐变化，
 * 本周期已有的额度读数继续参与预估。
 */
export function AccountPlanDialog({
  target,
  pending,
  error,
  onClose,
  onSave,
}: {
  target: PlanTarget | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (plan: string | null) => void;
}) {
  const [value, setValue] = useState(automatic);
  useEffect(() => {
    if (target) setValue(target.plan ?? automatic);
  }, [target]);
  return (
    <Dialog.Root
      open={!!target}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="account-confirm-backdrop" />
        <Dialog.Popup className="account-confirm account-rename account-merge">
          <Dialog.Title>设置套餐</Dialog.Title>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSave(value || null);
            }}
          >
            <span>「{target?.name}」的套餐</span>
            <FilterSelect
              label="套餐"
              value={value}
              onChange={setValue}
              withinDialog
              options={[
                { value: automatic, label: "自动识别" },
                ...manualAccountPlans.map((plan) => ({
                  value: plan,
                  label: planBadge({
                    plan,
                    kind: "subscription",
                    platform: "anthropic",
                  })!.label,
                })),
              ]}
            />
            <Dialog.Description className="account-rename-hint">
              自动识别使用采集器从 Claude Code
              读到的套餐。账户不再登录这台电脑、读不到套餐时，可以在这里指定。设置后本周期的额度预估照常使用已有数据。
            </Dialog.Description>
            {error && <p role="alert">{error}</p>}
            <div className="account-rename-actions">
              <Dialog.Close render={<Button type="button" variant="outline" />}>
                取消
              </Dialog.Close>
              <Button
                type="submit"
                disabled={pending || value === (target?.plan ?? automatic)}
              >
                保存
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
