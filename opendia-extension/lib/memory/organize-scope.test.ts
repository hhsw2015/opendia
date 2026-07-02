import { describe, it, expect } from 'vitest';
import { isWithinStaging, organizePathArgs } from '@/lib/memory/organize-scope';

const ROOT = '~/.cebian/.memories-organizing';
// normalizePath(ROOT) = /home/user/.cebian/.memories-organizing

describe('isWithinStaging', () => {
  it('根目录本身 → true', () => {
    expect(isWithinStaging(ROOT, ROOT)).toBe(true);
    expect(isWithinStaging('/home/user/.cebian/.memories-organizing', ROOT)).toBe(true);
  });

  it('根下文件 → true（含 ~ 与绝对两种写法）', () => {
    expect(isWithinStaging(`${ROOT}/user_profile.md`, ROOT)).toBe(true);
    expect(isWithinStaging('/home/user/.cebian/.memories-organizing/feedback.md', ROOT)).toBe(true);
  });

  it('../ 逃逸 → false', () => {
    expect(isWithinStaging(`${ROOT}/../memories/user_profile.md`, ROOT)).toBe(false);
    expect(isWithinStaging(`${ROOT}/../../etc/passwd`, ROOT)).toBe(false);
  });

  it('指向 live 记忆目录 → false', () => {
    expect(isWithinStaging('~/.cebian/memories/user_profile.md', ROOT)).toBe(false);
  });

  it('相邻同名前缀目录不误命中 → false', () => {
    expect(isWithinStaging(`${ROOT}-bak/x.md`, ROOT)).toBe(false);
  });
});

describe('organizePathArgs', () => {
  it('fs_rename → old_path + new_path 两个', () => {
    expect(organizePathArgs('fs_rename', { old_path: '/a', new_path: '/b' })).toEqual(['/a', '/b']);
  });

  it('fs_rename 缺一个路径 → 只取存在的（缺的不漏成 undefined）', () => {
    expect(organizePathArgs('fs_rename', { old_path: '/a' })).toEqual(['/a']);
  });

  it('单 path 工具 → [path]', () => {
    expect(organizePathArgs('fs_edit_file', { path: '/x' })).toEqual(['/x']);
    expect(organizePathArgs('fs_list', { path: '/d' })).toEqual(['/d']);
  });

  it('无 path 参数 → 空数组', () => {
    expect(organizePathArgs('fs_list', {})).toEqual([]);
  });
});
