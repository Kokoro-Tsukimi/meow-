import React, { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// ====================================================
// G-6 公告富文本渲染:marked 解析 Markdown → DOMPurify 消毒 → 注入
// Dashboard(最新 3 条)和 Announcements(历史页)共用这一套逻辑。
// - breaks: true 把单换行渲染成 <br>,老的纯文本公告向下兼容(视觉不变)
// - 裸网址 gfm 模式自动识别成链接,取代 F7 的手写 linkify
// - DOMPurify 消毒兜底:即使公告内容混入 <script> 等也会被剥掉
// ====================================================

marked.setOptions({ breaks: true, gfm: true });

// 所有链接强制新标签页打开 + noopener(与原 linkify 行为一致)
// hook 挂在模块级, 只注册一次
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// ---------------------------------------------------
// G-6.1 裸网址贴中文修复:
// GFM autolink 会把网址后所有非空格字符吞进链接, 而中文书写习惯里
// 网址和文字之间没有空格, 导致"网址+中文"整串被吸成一条巨型链接。
// 修法:解析前在「裸网址 → 紧随的 CJK 字符」交界处补一个空格,
// 让 autolink 在正确位置断开(渲染后链接与中文间多出的半角空格
// 正是中西文混排规范的"盘古之白", 视觉上更清爽)。
// CJK 覆盖:汉字 / 中日标点(。、「」)/ 全角符号(！？，)/ 日文假名
// ---------------------------------------------------
const CJK = '\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef\\u3040-\\u30ff';
const URL_CJK_BOUNDARY = new RegExp(`(https?:\\/\\/[^\\s${CJK}]+)(?=[${CJK}])`, 'g');
const preprocess = (text: string) => text.replace(URL_CJK_BOUNDARY, '$1 ');

export default function MarkdownContent({ content }: { content: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(preprocess(content ?? ''), { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [content]);

  return (
    <div
      className="meow-md text-sm meow-text-sub break-words"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
