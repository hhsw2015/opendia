import { describe, it, expect } from 'vitest';
import { liveChangedSince, planRecovery } from '@/lib/memory/organize-plan';

describe('liveChangedSince', () => {
  it('完全一致 → false', () => {
    expect(liveChangedSince({ 'a.md': 1, 'b.md': 2 }, { 'a.md': 1, 'b.md': 2 })).toBe(false);
  });

  it('文件数不同 → true（新增或删除）', () => {
    expect(liveChangedSince({ 'a.md': 1 }, { 'a.md': 1, 'b.md': 2 })).toBe(true);
    expect(liveChangedSince({ 'a.md': 1, 'b.md': 2 }, { 'a.md': 1 })).toBe(true);
  });

  it('同名但 mtime 变了 → true', () => {
    expect(liveChangedSince({ 'a.md': 1 }, { 'a.md': 2 })).toBe(true);
  });

  it('文件被替换（同数量、不同名）→ true', () => {
    expect(liveChangedSince({ 'a.md': 1 }, { 'b.md': 1 })).toBe(true);
  });

  it('空 → 空 → false', () => {
    expect(liveChangedSince({}, {})).toBe(false);
  });
});

describe('planRecovery', () => {
  it('无 staging → none', () => {
    expect(planRecovery(false, false)).toBe('none');
    expect(planRecovery(false, true)).toBe('none'); // 无 staging 时标记无意义
  });

  it('staging + 无 .committing → discardStaging（崩在提交前，live 没动）', () => {
    expect(planRecovery(true, false)).toBe('discardStaging');
  });

  it('staging + 有 .committing → redoCommit（崩在替换中途，幂等重做）', () => {
    expect(planRecovery(true, true)).toBe('redoCommit');
  });
});
