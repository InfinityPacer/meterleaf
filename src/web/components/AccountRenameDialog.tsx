import { useEffect, useId, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Button } from "./ui/button";

export interface RenameTarget {
  id: string;
  /** 当前显示的名称，可能已是别名。 */
  name: string;
  /** 上游同步的原名，清空别名后恢复为它。 */
  upstreamName: string;
  hasAlias: boolean;
}

/** 别名只改本地展示；留空保存等同于恢复原名。 */
export function AccountRenameDialog({
  target,
  pending,
  error,
  onClose,
  onSave,
}: {
  target: RenameTarget | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (alias: string | null) => void;
}) {
  const inputId = useId();
  const [value, setValue] = useState("");
  useEffect(() => {
    if (target) setValue(target.hasAlias ? target.name : "");
  }, [target]);
  const trimmed = value.trim();
  return (
    <Dialog.Root
      open={!!target}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="account-confirm-backdrop" />
        <Dialog.Popup className="account-confirm account-rename">
          <Dialog.Title>重命名账户</Dialog.Title>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSave(trimmed || null);
            }}
          >
            <label htmlFor={inputId}>显示名称</label>
            <input
              id={inputId}
              value={value}
              maxLength={40}
              autoComplete="off"
              placeholder={target?.upstreamName}
              onChange={(event) => setValue(event.target.value)}
            />
            <Dialog.Description className="account-rename-hint">
              只在 Meterleaf 中显示，不影响上游账户。留空则使用原名「
              {target?.upstreamName}」。
            </Dialog.Description>
            {error && <p role="alert">{error}</p>}
            <div className="account-rename-actions">
              {target?.hasAlias && (
                <Button
                  type="button"
                  variant="ghost"
                  className="account-rename-reset"
                  disabled={pending}
                  onClick={() => onSave(null)}
                >
                  恢复原名
                </Button>
              )}
              <Dialog.Close render={<Button type="button" variant="outline" />}>
                取消
              </Dialog.Close>
              <Button type="submit" disabled={pending}>
                保存
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
