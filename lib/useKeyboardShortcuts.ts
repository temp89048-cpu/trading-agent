'use client';

import { useEffect } from 'react';

type ShortcutHandlers = {
  onSearch: () => void;
  onNewChat: () => void;
  onFocusInput: () => void;
  onSettings: () => void;
  onMcp: () => void;
  onEscape: () => void;
};

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;

      if (e.key === 'Escape') {
        handlers.onEscape();
        return;
      }
      if (!mod) return;

      // Avoid stealing browser/OS-reserved combos and typing-in-progress
      // combos that aren't ours (Cmd+A/C/V/X for select-all/copy/paste/cut).
      const key = e.key.toLowerCase();

      if (key === 'k') {
        e.preventDefault();
        handlers.onSearch();
      } else if (key === 'n') {
        e.preventDefault();
        handlers.onNewChat();
      } else if (key === '/') {
        e.preventDefault();
        handlers.onFocusInput();
      } else if (key === 's' && e.shiftKey) {
        e.preventDefault();
        handlers.onSettings();
      } else if (key === 'm' && e.shiftKey) {
        e.preventDefault();
        handlers.onMcp();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handlers.onSearch, handlers.onNewChat, handlers.onFocusInput, handlers.onSettings, handlers.onMcp, handlers.onEscape]);
}
