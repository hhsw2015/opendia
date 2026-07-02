import { describe, it, expect } from 'vitest';
import type { Api, Model } from '@earendil-works/pi-ai';
import { usableCompactionTarget, type CompactionTarget } from '@/lib/agent/compaction';

/** 构造一个最小可辨识的 Model：只需 id / provider 用于断言「选中了哪个」。 */
function fakeModel(id: string, provider: string): Model<Api> {
  return { id, provider } as unknown as Model<Api>;
}

const smallModel = fakeModel('small', 'custom:cheap');

describe('usableCompactionTarget', () => {
  it('未配置压缩模型（configured 为 null）→ null（回退主模型）', () => {
    expect(usableCompactionTarget(null)).toBeNull();
  });

  it('配置了压缩模型且凭证可用 → 原样返回该目标', () => {
    const configured: CompactionTarget = { model: smallModel, apiKey: 'small-key' };
    expect(usableCompactionTarget(configured)).toBe(configured);
  });

  it('配置了压缩模型但无凭证（apiKey undefined）→ null（回退主模型）', () => {
    const configured: CompactionTarget = { model: smallModel, apiKey: undefined };
    expect(usableCompactionTarget(configured)).toBeNull();
  });

  it('配置了压缩模型但 apiKey 为空串 → null（回退主模型）', () => {
    const configured: CompactionTarget = { model: smallModel, apiKey: '' };
    expect(usableCompactionTarget(configured)).toBeNull();
  });
});
