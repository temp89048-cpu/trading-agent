'use client';

import { Icon } from './Icon';
import { Markdown } from './Markdown';
import type { Message } from '@/lib/types';
import { useAppState } from './AppState';

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString([], {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function ChatMessage({ message, isStreamingReply }: { message: Message; isStreamingReply: boolean }) {
  const { copyMessage } = useAppState();
  const isUser = message.role === 'user';

  return (
    <div className={`group flex flex-col gap-1 rise ${isUser ? 'items-end' : 'items-start'}`}>
      <div className={`flex items-baseline gap-1.5 px-1 text-[10.5px] font-mono ${isUser ? 'flex-row-reverse' : ''}`}>
        <span className="font-semibold" style={{ color: isUser ? 'var(--cyan)' : 'var(--amber)' }}>
          {isUser ? 'You' : 'QUANT//'}
        </span>
        <span className="text-txt2">{formatTimestamp(message.ts)}</span>
      </div>
      <div
        className={`max-w-[85%] rounded-lg px-4 py-3 ${
          isUser 
            ? 'bg-cyan/10 text-txt0 border border-cyan/30 backdrop-blur-sm shadow-[0_4px_20px_rgba(0,240,255,0.1)]' 
            : 'glass-panel'
        }`}
      >
        {isUser ? (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
        ) : message.content ? (
          <Markdown text={message.content} />
        ) : isStreamingReply ? (
          <span className="caret text-txt2 text-sm"> </span>
        ) : null}
      </div>
      {!isUser && message.content && (
        <button
          onClick={() => copyMessage(message.content)}
          className="opacity-0 group-hover:opacity-100 transition flex items-center gap-1 text-[10px] font-mono px-1 text-txt2 hover:text-txt0"
        >
          <Icon name="copy" size={11} /> copy
        </button>
      )}
    </div>
  );
}
