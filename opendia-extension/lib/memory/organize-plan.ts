// 记忆整理事务的「纯决策」逻辑——不碰 VFS IO，便于单测；IO 执行在 background 编排层。
// 仿 lib/backup/sources/vfs.ts 的 planVfsWrites：纯函数给判断/计划，执行层照做。

// ─── live 指纹与提交比对 ───

/** live 记忆目录的「指纹」：顶层文件名 → mtimeMs。提交时比对它，决定 swap 还是丢弃。 */
export type MemoryManifest = Record<string, number>;

/**
 * live 自拷贝那一刻起是否变过：文件集合或任一 mtime 不同即视为变了（= 用户在整理
 * 期间自己写了记忆）。变了则丢弃整理结果、保留 live（前台优先）。
 */
export function liveChangedSince(snapshot: MemoryManifest, current: MemoryManifest): boolean {
  const names = Object.keys(snapshot);
  if (names.length !== Object.keys(current).length) return true;
  for (const name of names) {
    if (!(name in current) || current[name] !== snapshot[name]) return true;
  }
  return false;
}

// ─── 启动崩溃恢复决策 ───

/** 启动恢复动作：由 staging 残留 + `.committing` 标记的组合决定。 */
export type RecoveryAction = 'none' | 'discardStaging' | 'redoCommit';

/**
 * - 无 staging → 'none'：没有未收尾的整理。
 * - staging + 无 `.committing` → 'discardStaging'：整理崩在提交前，live 从未被动 → 删 staging 即可，无需回滚。
 * - staging + 有 `.committing` → 'redoCommit'：崩在替换中途 → 幂等重做 staging→live。
 */
export function planRecovery(
  stagingExists: boolean,
  committingMarkerExists: boolean,
): RecoveryAction {
  if (!stagingExists) return 'none';
  return committingMarkerExists ? 'redoCommit' : 'discardStaging';
}
