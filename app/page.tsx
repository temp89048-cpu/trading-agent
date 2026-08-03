'use client';

import { useEffect, useState } from 'react';
import { Header } from '@/components/Header';
import { ConversationSidebar } from '@/components/ConversationSidebar';
import { TradingSidebar } from '@/components/TradingSidebar';
import { ChatArea } from '@/components/ChatArea';
import { ChatInputBar } from '@/components/ChatInputBar';
import { SettingsModal } from '@/components/SettingsModal';
import { McpManagerModal } from '@/components/McpManagerModal';
import { SearchModal } from '@/components/SearchModal';
import { useAppState } from '@/components/AppState';
import { useKeyboardShortcuts } from '@/lib/useKeyboardShortcuts';

export default function Home() {
  const { newConversation } = useAppState();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  // Both sidebars default open (matches desktop layout in every prior
  // commit). On a narrow viewport that would cover the whole screen, so
  // collapse them once, on mount, based on actual window size — not a
  // guess baked into the initial state, which would mismatch on desktop.
  useEffect(() => {
    if (window.innerWidth < 768) setSidebarOpen(false);
    if (window.innerWidth < 1024) setRightOpen(false);
  }, []);

  useKeyboardShortcuts({
    onSearch: () => setShowSearch(true),
    onNewChat: () => newConversation(),
    onFocusInput: () => document.getElementById('chat-input')?.focus(),
    onSettings: () => setShowSettings(true),
    onMcp: () => setShowMcp(true),
    onEscape: () => {
      setShowSearch(false);
      setShowSettings(false);
      setShowMcp(false);
    },
  });

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden">
      <Header
        onToggleSidebar={() => setSidebarOpen((s) => !s)}
        onToggleRight={() => setRightOpen((s) => !s)}
        onOpenSettings={() => setShowSettings(true)}
        onOpenMcp={() => setShowMcp(true)}
        onOpenSearch={() => setShowSearch(true)}
      />

      <div className="flex flex-1 min-h-0 relative">
        {/* Conversation sidebar: fixed/overlay on mobile, in-flow on md+ */}
        {sidebarOpen && (
          <>
            <div className="fixed inset-0 z-20 bg-black/60 md:hidden" onClick={() => setSidebarOpen(false)} />
            <div className="fixed md:static inset-y-0 left-0 z-30 md:z-auto">
              <ConversationSidebar onNavigate={() => setSidebarOpen(false)} />
            </div>
          </>
        )}

        <main className="flex-1 min-w-0 flex flex-col relative bg-bg0">
          <ChatArea />
          <ChatInputBar onOpenSettings={() => setShowSettings(true)} />
        </main>

        {/* Trading sidebar: fixed/overlay on mobile, in-flow on lg+ */}
        {rightOpen && (
          <>
            <div className="fixed inset-0 z-20 bg-black/60 lg:hidden" onClick={() => setRightOpen(false)} />
            <div className="fixed lg:static inset-y-0 right-0 z-30 lg:z-auto flex">
              <TradingSidebar onClose={() => setRightOpen(false)} />
            </div>
          </>
        )}
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showMcp && <McpManagerModal onClose={() => setShowMcp(false)} />}
      {showSearch && <SearchModal onClose={() => setShowSearch(false)} />}
    </div>
  );
}
