/** 报表索引与累计索引共用一个基础路径；替换时连同各自的 WAL 与共享内存文件一起处理。 */
export function indexFiles(base: string): string[] {
  return [base, `${base}.lifetime`].flatMap((file) => [
    file,
    `${file}-wal`,
    `${file}-shm`,
  ]);
}
