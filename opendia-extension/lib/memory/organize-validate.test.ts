import { describe, it, expect } from 'vitest';
import { validateOrganized, type OrganizedFile } from '@/lib/memory/organize-validate';
import { USER_PROFILE_DESCRIPTION } from '@/lib/memory/types';

/** 拼一个带 frontmatter 的记忆文件全文。 */
function file(name: string, type: string, description: string, body = 'b'): OrganizedFile {
  return { name, content: `---\nname: n\ndescription: ${description}\ntype: ${type}\n---\n\n${body}\n` };
}

const PROFILE = file('user_profile.md', 'user', USER_PROFILE_DESCRIPTION);

describe('validateOrganized', () => {
  it('合法集合 → ok', () => {
    expect(
      validateOrganized([
        PROFILE,
        file('feedback_terse.md', 'feedback', '先结论'),
        file('reference_flights.md', 'reference', '国航'),
      ]),
    ).toEqual({ ok: true });
  });

  it('空集合 → ok', () => {
    expect(validateOrganized([])).toEqual({ ok: true });
  });

  it('非顶层 / 非 .md → 拒绝', () => {
    expect(validateOrganized([file('sub/x.md', 'feedback', 'd')]).ok).toBe(false);
    expect(validateOrganized([file('notes.txt', 'feedback', 'd')]).ok).toBe(false);
  });

  it('缺失 / 非法 type → 拒绝', () => {
    expect(validateOrganized([file('x.md', 'project', 'd')]).ok).toBe(false);
  });

  it('多个 user 档 → 拒绝', () => {
    const second = file('user_profile.md', 'user', USER_PROFILE_DESCRIPTION);
    // 同名不可能并存于一个目录；用不同名的两个 user 档触发 userCount>1 之前会先撞「必须叫 user_profile.md」。
    const other = file('user_other.md', 'user', USER_PROFILE_DESCRIPTION);
    expect(validateOrganized([PROFILE, other]).ok).toBe(false);
    expect(validateOrganized([PROFILE, second]).ok).toBe(false); // 退化：重复同名也拒
  });

  it('user 类但不叫 user_profile.md → 拒绝', () => {
    expect(validateOrganized([file('user_role.md', 'user', USER_PROFILE_DESCRIPTION)]).ok).toBe(false);
  });

  it('user_profile.md 的 description 不是固定标签 → 拒绝', () => {
    expect(validateOrganized([file('user_profile.md', 'user', '名字猫咪，后端')]).ok).toBe(false);
  });

  it('user_profile.md 但不是 user 类 → 拒绝', () => {
    expect(validateOrganized([file('user_profile.md', 'feedback', USER_PROFILE_DESCRIPTION)]).ok).toBe(false);
  });

  it('user_profile.md 的 description 带多余空白（非逐字相等）→ 拒绝', () => {
    const padded: OrganizedFile = {
      name: 'user_profile.md',
      content: `---\nname: n\ndescription: " ${USER_PROFILE_DESCRIPTION} "\ntype: user\n---\n\nb\n`,
    };
    expect(validateOrganized([padded]).ok).toBe(false);
  });

  it('坏掉的 frontmatter → 拒绝（不外抛）', () => {
    const broken: OrganizedFile = {
      name: 'x.md',
      content: '---\nname: "unterminated\n  : : :\n---\nbody',
    };
    const r = validateOrganized([broken]);
    expect(r.ok).toBe(false);
  });
});
