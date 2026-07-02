import { Label } from '@/components/ui/label';
import { ModelSelector } from '@/components/chat/ModelSelector';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  compactionModel,
  providerCredentials,
  customProviders as customProvidersStorage,
} from '@/lib/persistence/storage';
import { t } from '@/lib/i18n';

/**
 * AdvancedSection — 高级设置。
 *
 * 目前唯一一项是「压缩模型」：上下文压缩（摘要）专用模型。`null` = 跟随对话主模型
 * （默认）；可选一个更小更省的模型专门跑后台摘要。复用聊天的 `ModelSelector`，
 * 通过 `inheritOption` 提供「与对话模型相同」首项（写回 null），不展示「添加更多
 * 模型」入口（设置页内无意义）。
 */
export function AdvancedSection() {
  const [model, setModel] = useStorageItem(compactionModel, null);
  const [providers] = useStorageItem(providerCredentials, {});
  const [customProviderList] = useStorageItem(customProvidersStorage, []);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-base font-semibold">{t('settings.advanced.title')}</h2>

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <Label className="text-sm">{t('settings.advanced.compaction.label')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.advanced.compaction.hint')}
          </p>
        </div>
        <div className="shrink-0">
          <ModelSelector
            activeModel={model}
            configuredProviders={providers}
            customProviders={customProviderList}
            onSelect={(provider, modelId) => setModel({ provider, modelId })}
            inheritOption={{
              label: t('settings.advanced.compaction.followMain'),
              onSelect: () => setModel(null),
            }}
          />
        </div>
      </div>
    </div>
  );
}

