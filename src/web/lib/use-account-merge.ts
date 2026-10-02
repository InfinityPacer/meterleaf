import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccountMergeState } from "../../domain/account-merge";

const key = ["account-merge"];

export function useAccountMerge() {
  const client = useQueryClient();
  const query = useQuery<AccountMergeState>({
    queryKey: key,
    queryFn: async () => {
      if (import.meta.env.VITE_METERLEAF_DEMO === "true")
        return { writable: false, accounts: [], links: [] };
      const response = await fetch("/api/accounts/merge");
      if (!response.ok) throw new Error("合并状态读取失败");
      return response.json();
    },
    staleTime: 15000,
  });
  const mutation = useMutation({
    mutationFn: async (value: { id: string; targetId: string | null }) => {
      const response = await fetch("/api/accounts/merge", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? "合并操作失败，请重试");
      }
      return response.json() as Promise<AccountMergeState>;
    },
    onSuccess: (state) => {
      client.setQueryData(key, state);
      void client.invalidateQueries({ queryKey: ["ledger"] });
    },
  });
  return { ...query, mutation };
}
