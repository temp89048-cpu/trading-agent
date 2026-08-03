type IconName =
  | 'plus' | 'search' | 'settings' | 'trash' | 'send' | 'stop' | 'copy' | 'plug' | 'x'
  | 'chevron-down' | 'trend-up' | 'trend-down' | 'terminal' | 'wallet' | 'shield' | 'check'
  | 'refresh' | 'menu' | 'edit' | 'save' | 'alert';

export function Icon({ name, size = 16, className = '' }: { name: IconName; size?: number; className?: string }) {
  const c = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, className,
  };
  switch (name) {
    case 'plus': return <svg {...c}><path d="M12 5v14M5 12h14" /></svg>;
    case 'search': return <svg {...c}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>;
    case 'settings': return <svg {...c}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008.6 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H2a2 2 0 110-4h.09A1.65 1.65 0 003.6 8.6a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H8A1.65 1.65 0 009 2.09V2a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V8a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" /></svg>;
    case 'trash': return <svg {...c}><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z" /></svg>;
    case 'send': return <svg {...c}><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>;
    case 'stop': return <svg {...c}><rect x="6" y="6" width="12" height="12" rx="2" /></svg>;
    case 'copy': return <svg {...c}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>;
    case 'plug': return <svg {...c}><path d="M12 22v-5M9 8V2M15 8V2M6 8h12a2 2 0 012 2v2a6 6 0 01-6 6H10a6 6 0 01-6-6v-2a2 2 0 012-2z" /></svg>;
    case 'x': return <svg {...c}><path d="M18 6L6 18M6 6l12 12" /></svg>;
    case 'chevron-down': return <svg {...c}><path d="M6 9l6 6 6-6" /></svg>;
    case 'trend-up': return <svg {...c}><path d="M23 6l-9.5 9.5-5-5L1 18" /><path d="M17 6h6v6" /></svg>;
    case 'trend-down': return <svg {...c}><path d="M23 18l-9.5-9.5-5 5L1 6" /><path d="M17 18h6v-6" /></svg>;
    case 'terminal': return <svg {...c}><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>;
    case 'wallet': return <svg {...c}><path d="M21 12V7H5a2 2 0 010-4h14v4" /><path d="M3 5v14a2 2 0 002 2h16v-5" /><path d="M18 12a2 2 0 000 4h4v-4h-4z" /></svg>;
    case 'shield': return <svg {...c}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>;
    case 'check': return <svg {...c}><polyline points="20 6 9 17 4 12" /></svg>;
    case 'refresh': return <svg {...c}><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" /></svg>;
    case 'menu': return <svg {...c}><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>;
    case 'edit': return <svg {...c}><path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>;
    case 'save': return <svg {...c}><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></svg>;
    case 'alert': return <svg {...c}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>;
    default: return null;
  }
}
