// Side-effect module: registers ask_user UI component with the UI tool registry.
// Import this file once in the sidepanel to enable rendering ask_user blocks.

import { uiToolRegistry, type InteractiveToolComponentProps } from '@/lib/tools/ui-registry';
import type { AskUserRequest, AskUserAnswer, AskUserResponse } from '@/lib/tools/ask-user';
import { AskUserBlock } from './AskUserBlock';
import { TOOL_ASK_USER } from '@/lib/tools/names';

// ─── v1 → v2 归一化 ───
// COMPAT(ask_user v1): 旧持久化调用是单问题形状 { question, options?, allow_free_text? }。
// 归一成 v2 的 questions[] 单题，让历史会话用同一翻页组件渲染。也顺带兜住流式半包 /
// 字段缺失（返回空数组，组件再降级为 null）。
// 清理方式不是裸删：未来在加载时按版本号做一次性数据迁移、把旧数据升级成最新形状后，
// 再移除本读时兼容（裸删会让仍存在 DB 里的旧会话渲染失败）。
function normalizeQuestions(args: unknown): AskUserRequest['questions'] {
  const a = args as {
    questions?: unknown;
    question?: unknown;
    options?: unknown;
    allow_free_text?: unknown;
  };
  if (Array.isArray(a?.questions)) {
    return a.questions as AskUserRequest['questions'];
  }
  if (typeof a?.question === 'string') {
    return [
      {
        id: 'q1',
        question: a.question,
        options: Array.isArray(a.options)
          ? (a.options as AskUserRequest['questions'][number]['options'])
          : undefined,
        allow_free_text: typeof a.allow_free_text === 'boolean' ? a.allow_free_text : undefined,
      },
    ];
  }
  return [];
}

// ─── UI adapter for the registry's generic interface ───

// COMPAT(ask_user v1): 旧 v1 结果把用户答案存在 toolResult.content 文本里、没有
// details.answers；去掉 renderResultAsUserBubble 后这类旧答案既不出气泡、卡片也读不到。
// 这里从 content 合成一份答案，避免历史会话的回答凭空消失。
// 清理时机同 normalizeQuestions：随未来的版本号数据迁移一并移除，而非裸删。
function legacyAnswersFromContent(
  request: unknown,
  questions: AskUserRequest['questions'],
  toolResult: InteractiveToolComponentProps<AskUserRequest>['toolResult'],
  cancelled: boolean,
): Record<string, AskUserAnswer> | undefined {
  const a = request as { questions?: unknown; question?: unknown };
  const isLegacy = !!a && typeof a === 'object' && !Array.isArray(a.questions) && typeof a.question === 'string';
  if (!isLegacy || cancelled || !toolResult || questions.length !== 1) return undefined;

  const text = toolResult.content
    .filter((b): b is { type: 'text'; text: string } => b?.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) return undefined;

  const q = questions[0];
  // 旧答案若正好是某个选项 label，则还原为选中态；否则当作自由文本。
  const matchedOption = (q.options ?? []).some((o) => o?.label === text);
  return {
    [q.id]: matchedOption
      ? { selected: [text], free_text: '', skipped: false }
      : { selected: [], free_text: text, skipped: false },
  };
}

function AskUserToolComponent({
  args: request,
  isPending,
  toolResult,
  onResolve,
}: InteractiveToolComponentProps<AskUserRequest>) {
  const details = toolResult?.details as
    | { cancelled?: boolean; answers?: Record<string, AskUserAnswer> }
    | undefined;
  const questions = normalizeQuestions(request);
  const answers =
    details?.answers ?? legacyAnswersFromContent(request, questions, toolResult, details?.cancelled === true);
  return (
    <AskUserBlock
      questions={questions}
      answers={answers}
      isPending={isPending}
      onSubmit={isPending ? (onResolve as (response: AskUserResponse) => void) : undefined}
    />
  );
}

// ─── Register with the UI tool registry ───

// 不设 renderResultAsUserBubble：答案展示在卡片已答态内（读 details.answers），
// 不再额外渲染成用户气泡；同时下一条 assistant 也不会另起一个 Agent 头。
uiToolRegistry.register<AskUserRequest>({
  name: TOOL_ASK_USER,
  Component: AskUserToolComponent,
});
