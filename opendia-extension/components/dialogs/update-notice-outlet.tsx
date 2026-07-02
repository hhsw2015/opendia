import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useUpdateCheck } from '@/hooks/useUpdateCheck';
import { getInstallGuideUrl } from '@/lib/site-links';
import { updateNoticeState } from '@/lib/persistence/storage';
import { t } from '@/lib/i18n';

/** 弹窗层节流：关闭/立即更新后 24h 内不再自动弹出。 */
const PROMPT_THROTTLE_MS = 24 * 60 * 60 * 1000;

/**
 * 应用打开时主动检查更新，命中条件则弹出「发现新版本」对话框。
 * 复用 `useUpdateCheck`（自带 6h 网络缓存），不重复请求 GitHub。
 *
 * 显示条件：状态为 updateAvailable，且最新版本未被跳过，
 * 且距上次提醒已超过 24h。每次 mount 只决策一次。
 *
 * 在 sidepanel 的 App.tsx 挂载一个即可。
 */
export function UpdateNoticeOutlet() {
  const { status } = useUpdateCheck();
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<{ current: string; latest: string } | null>(null);
  // 防止同一次 mount 内（状态对象引用变化时）重复决策弹窗。
  const decidedRef = useRef(false);

  useEffect(() => {
    if (status.kind !== 'updateAvailable') return;
    if (decidedRef.current) return;

    let cancelled = false;
    const { current, latest } = status;
    void (async () => {
      try {
        const state = await updateNoticeState.getValue();
        // decidedRef 只在确实要弹窗时才置位，且要在 cancelled 检查之后——
        // 否则 StrictMode 双跑时，第一次会同步置位 decidedRef 但其 async 被
        // cancelled，第二次又被 decidedRef 挡掉，导致弹窗永远不出现。
        if (cancelled || decidedRef.current) return;
        if (state.skippedVersion === latest) return;
        if (Date.now() - state.lastPromptedAt < PROMPT_THROTTLE_MS) return;
        decidedRef.current = true;
        setInfo({ current, latest });
        setOpen(true);
      } catch (err) {
        console.warn('[UpdateNotice] failed to read notice state:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [status]);

  /** 记录本次提醒时间，触发 24h 节流。 */
  async function markPrompted() {
    const state = await updateNoticeState.getValue();
    await updateNoticeState.setValue({ ...state, lastPromptedAt: Date.now() });
  }

  // 关闭 / ESC / 遮罩：等同「稍后提醒」，写入节流时间。
  function handleClose() {
    setOpen(false);
    void markPrompted();
  }

  function handleUpdateNow() {
    window.open(getInstallGuideUrl(), '_blank', 'noopener');
    setOpen(false);
    void markPrompted();
  }

  async function handleSkipVersion() {
    if (!info) return;
    setOpen(false);
    // 「跳过此版本」是按版本永久跳过，与 24h 节流相互独立，
    // 因此只写 skippedVersion，不动 lastPromptedAt——这样若 24h 内出更新版，
    // 新版本仍能正常弹出而不被节流误抑制。
    const state = await updateNoticeState.getValue();
    await updateNoticeState.setValue({ ...state, skippedVersion: info.latest });
  }

  if (!info) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) handleClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('dialogs.updateNotice.title')}</DialogTitle>
          <DialogDescription>
            {t('dialogs.updateNotice.description', [info.latest, info.current])}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:flex-row sm:justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={handleSkipVersion}>
            {t('dialogs.updateNotice.skipVersion')}
          </Button>
          <Button size="sm" onClick={handleUpdateNow}>
            {t('dialogs.updateNotice.updateNow')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
