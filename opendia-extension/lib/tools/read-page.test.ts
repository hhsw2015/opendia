import { describe, it, expect } from 'vitest';
import { sanitizeSelector } from '@/lib/tools/read-page';

describe('sanitizeSelector', () => {
  // ── 模型笔误：应被清洗 ──
  it('删除结尾悬挂的引号', () => {
    expect(sanitizeSelector('div#search"')).toBe('div#search');
  });

  it('删除复杂选择器结尾悬挂的引号', () => {
    expect(sanitizeSelector('#main > section:nth-of-type(1)"')).toBe(
      '#main > section:nth-of-type(1)',
    );
  });

  it('剥离整体包裹的双引号', () => {
    expect(sanitizeSelector('"div#search"')).toBe('div#search');
  });

  it('剥离整体包裹的单引号', () => {
    expect(sanitizeSelector("'#main'")).toBe('#main');
  });

  it('删除开头悬挂的引号', () => {
    expect(sanitizeSelector('"div#search')).toBe('div#search');
  });

  it('还原「悬挂 + 包裹」叠加的脏输入', () => {
    expect(sanitizeSelector('\'"#main"')).toBe('#main');
  });

  it('trim 首尾空白', () => {
    expect(sanitizeSelector('  #main  ')).toBe('#main');
  });

  // ── 合法选择器：必须原样保留 ──
  it('保留属性选择器（成对双引号）', () => {
    expect(sanitizeSelector('input[name="q"]')).toBe('input[name="q"]');
  });

  it('保留含 CSS 转义引号的选择器（反斜杠）', () => {
    // CSS.escape('search"') === 'search\\"'，结尾的转义引号不能被削掉
    expect(sanitizeSelector('#search\\"')).toBe('#search\\"');
  });

  it('保留属性选择器（成对单引号）', () => {
    expect(sanitizeSelector("a[href='/home']")).toBe("a[href='/home']");
  });

  it('保留多属性成对引号', () => {
    expect(sanitizeSelector('[data-x="y"][data-z="w"]')).toBe(
      '[data-x="y"][data-z="w"]',
    );
  });

  it('保留无引号的普通选择器', () => {
    expect(sanitizeSelector('#main > section:nth-of-type(1)')).toBe(
      '#main > section:nth-of-type(1)',
    );
  });
});
