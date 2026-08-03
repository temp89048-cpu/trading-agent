'use client';

import { useEffect, useRef } from 'react';
import { useAppState } from './AppState';
import { ChatMessage } from './ChatMessage';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';

export function ChatArea() {
  const { activeConv, streaming, lastError, sendMessage } = useAppState();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [activeConv?.messages.length, activeConv?.messages[activeConv.messages.length - 1]?.content]);

  return (
    <div className="flex-1 overflow-y-auto px-4 md:px-10 py-6">
      <div className="max-w-3xl mx-auto flex flex-col gap-5">
        {!activeConv || activeConv.messages.length === 0 ? (
          <EmptyState onPick={(prompt) => sendMessage(prompt)} />
        ) : (
          activeConv.messages.map((m, i) => (
            <ChatMessage
              key={m.id}
              message={m}
              isStreamingReply={streaming && i === activeConv.messages.length - 1 && m.role === 'assistant'}
            />
          ))
        )}

        {lastError && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md border text-xs font-mono border-red text-red bg-bg2">
            <Icon name="x" size={13} /> {lastError}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
