import { useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import type { AccountMergeState } from "../../domain/account-merge";
import { Button } from "./ui/button";
import { FilterSelect } from "./FilterSelect";

export function AccountMergeDialog({
  account,
  state,
  hiddenIds,
  pending,
  error,
  onClose,
  onSave,
}: {
  account: { id: string; name: string } | null;
  state: AccountMergeState | undefined;
  hiddenIds: readonly string[];
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (id: string, targetId: string | null) => void;
}) {
  const [target, setTarget] = useState("");
  useEffect(() => setTarget(""), [account?.id]);
  const members =
    state?.links.filter((link) => link.rootId === account?.id) ?? [];
  const options = (state?.accounts ?? []).filter(
    (candidate) =>
      candidate.id !== account?.id &&
      !hiddenIds.includes(candidate.id) &&
      !state?.links.some((link) => link.id === candidate.id),
  );
  const label = (id: string) => {
    const value = state?.accounts.find((item) => item.id === id);
    return value ? `${value.name} · ${value.sourceId}` : "已移除的来源账户";
  };
  return (
    <Dialog.Root
      open={!!account}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="account-confirm-backdrop" />
        <Dialog.Popup className="account-confirm account-rename account-merge">
          <Dialog.Title>合并额度与用量</Dialog.Title>
          <Dialog.Description>
            将「{account?.name}
            」的全部历史和后续用量归到目标账户，不做去重。同一额度窗口取最新快照，百分比不相加。原始记录保留，可随时解除。
          </Dialog.Description>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (account && target && !pending) onSave(account.id, target);
            }}
          >
            <span>目标账户</span>
            <FilterSelect
              label="目标账户"
              value={target}
              onChange={setTarget}
              withinDialog
              options={[
                { value: "", label: "请选择目标账户" },
                ...options.map((value) => ({
                  value: value.id,
                  label: label(value.id),
                })),
              ]}
            />
            {!options.length && (
              <p className="account-rename-hint">暂无其它可合并的账户。</p>
            )}
            {target && (
              <p className="account-rename-hint">
                确认后，当前账户将从列表收起，统一显示在「{label(target)}」下。
              </p>
            )}
            {!!members.length && (
              <section
                className="account-merge-members"
                aria-label="已合并的账户"
              >
                <h3>已合并到此账户</h3>
                <ul>
                  {members.map((member) => (
                    <li key={member.id}>
                      <span>{label(member.id)}</span>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={pending}
                        aria-label={`解除 ${label(member.id)} 的合并`}
                        onClick={() => onSave(member.id, null)}
                      >
                        解除合并
                      </Button>
                    </li>
                  ))}
                </ul>
                <p className="account-rename-hint">
                  解除后，该账户及合并到它的账户会重新作为一组显示。
                </p>
              </section>
            )}
            {error && <p role="alert">{error}</p>}
            <div className="account-rename-actions">
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={onClose}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={
                  pending ||
                  !target ||
                  !options.some((option) => option.id === target)
                }
              >
                {pending ? "正在保存…" : "确认合并"}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
