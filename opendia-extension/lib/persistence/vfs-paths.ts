// ─── VFS paths ───

/** Absolute VFS base path for Cebian user config. */
export const CEBIAN_HOME = '/home/user/.cebian';

/** 各会话工作区目录的公共父目录（`/workspaces/{sessionId}/`）。是 VFS 的结构性
 *  根之一——作单一事实源，供 vfs 的受保护根清单与备份布局共用。 */
export const WORKSPACES_ROOT = '/workspaces';

/** Tilde-prefixed path to prompts directory (used by scanner / agent). */
export const CEBIAN_PROMPTS_DIR = '~/.cebian/prompts';

/** Tilde-prefixed path to skills directory (used by scanner / agent). */
export const CEBIAN_SKILLS_DIR = '~/.cebian/skills';

/** 记忆系统根目录的 tilde 路径（scanner / agent / 设置页共用）。 */
export const CEBIAN_MEMORIES_DIR = '~/.cebian/memories';

/** 记忆整理的 staging 副本目录：整理 agent 只在此操作，live 不受影响（见整理事务设计）。 */
export const CEBIAN_MEMORIES_STAGING_DIR = '~/.cebian/.memories-organizing';

/** 整理提交的「committing」标记文件：存在 = 上次崩在「staging→live 替换」中途，启动时幂等重做。 */
export const CEBIAN_MEMORIES_COMMIT_MARKER = '~/.cebian/.memories-committing';

/** Standard entry file for a skill package. */
export const SKILL_ENTRY_FILE = 'SKILL.md';
