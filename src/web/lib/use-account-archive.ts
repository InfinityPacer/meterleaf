import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

interface ArchiveState {
  archived: string[];
  hidden: string[];
  writable: boolean;
}
const key = ["account-archive"];

/** 归档状态由本地服务保存，只有写入成功才更新页面，失败保留原列表。 */
export function useAccountArchive() {
  const client = useQueryClient();
  const query = useQuery<ArchiveState>({
    queryKey: key,
    queryFn: async () => {
      // 演示账本不对应服务端账户，保留只读菜单而不读取真实账户偏好。
      if (import.meta.env.VITE_METERLEAF_DEMO === "true")
        return { archived: [], hidden: [], writable: false };
      const response = await fetch("/api/accounts/archive");
      if (!response.ok) throw new Error("账户归档状态读取失败");
      return response.json();
    },
    staleTime: 15000,
  });
  const mutation = useMutation({
    mutationFn: async (
      value: { id: string; archived: boolean } | { id: string; hidden: true },
    ) => {
      const response = await fetch("/api/accounts/archive", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      if (!response.ok) throw new Error("账户操作失败，请重试");
      return response.json() as Promise<ArchiveState>;
    },
    onSuccess: (state) => client.setQueryData(key, state),
  });
  return { ...query, mutation };
}
