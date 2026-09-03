import { RefreshCw, Camera, LogOut, AlertTriangle, Sparkles, Search } from 'lucide-react';
import { cn } from '../lib/utils';
import { User as FirebaseUser } from 'firebase/auth';

interface HeaderProps {
  isCapturing: boolean;
  onToggleCapturing: () => void;
  user: FirebaseUser | null;
  onLogout: () => void;
  camerasLive: number;
  camerasTotal: number;
  alertsToday: number;
  geminiHealthy: boolean;
  onOpenSearch: () => void;
}

export default function Header({ isCapturing, onToggleCapturing, user, onLogout, camerasLive, camerasTotal, alertsToday, geminiHealthy, onOpenSearch }: HeaderProps) {
  return (
    <header className="flex flex-col bg-surface/90 backdrop-blur-xl border-b border-border sticky top-0 z-40">
      <div className="h-20 flex items-center justify-between px-6 gap-3">
      <div className="flex flex-col shrink-0">
        <h1 className="text-lg font-bold tracking-tight text-ink">OmniSee Pro</h1>
        <p className="text-[10px] text-ink-muted font-semibold uppercase tracking-[0.14em]">AI Vision Surveillance</p>
      </div>

      {/* The one search entry point for the whole app (cameras, plates,
          logs, glossary, tab navigation) — see CommandPalette. Replaces
          what used to be four separate, inconsistent search boxes with no
          shared way in. */}
      <button
        onClick={onOpenSearch}
        className="hidden md:flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-surface-muted border border-border text-ink-muted hover:text-ink hover:border-accent/30 transition-colors flex-1 max-w-xs"
      >
        <Search className="w-4 h-4 shrink-0" strokeWidth={1.75} />
        <span className="text-xs font-medium truncate">Search cameras, plates, logs...</span>
        <kbd className="ml-auto text-[10px] font-mono bg-surface border border-border rounded px-1.5 py-0.5 shrink-0">⌘K</kbd>
      </button>
      <button onClick={onOpenSearch} className="btn-ghost !p-2.5 md:hidden" title="Search (⌘K)">
        <Search className="w-4.5 h-4.5" strokeWidth={1.75} />
      </button>

      <div className="flex items-center gap-3">
        {/* State is legible from the button itself (icon + label + color) —
            a separate "Status: ONLINE" readout next to it repeated the same
            fact in a second visual language for no added information. */}
        <button
          onClick={onToggleCapturing}
          className={cn(
            'flex items-center gap-2 px-5 py-3 sm:px-6 rounded-2xl font-bold text-xs sm:text-sm transition-all active:scale-95 shadow-lg',
            isCapturing ? 'bg-critical text-white shadow-critical/25' : 'btn-primary shadow-accent/25'
          )}
        >
          {isCapturing ? <RefreshCw className="w-4 h-4 animate-spin" strokeWidth={1.75} /> : <Camera className="w-4 h-4" strokeWidth={1.75} />}
          <span className="hidden xs:inline">{isCapturing ? 'Pause Guard' : 'Activate Guard'}</span>
          <span className="inline xs:hidden">{isCapturing ? 'Pause' : 'Activate'}</span>
        </button>

        <div className="flex items-center gap-2 border-l border-border pl-3">
          {user && (
            <>
              <div className="hidden xs:flex flex-col items-end text-right">
                <span className="text-[10px] font-semibold text-ink truncate max-w-[100px]">{user.displayName || 'Active User'}</span>
                <span className="text-[9px] text-ink-muted truncate max-w-[100px]">{user.email || 'demo-guest'}</span>
              </div>

              {user.photoURL ? (
                <img src={user.photoURL} alt="User avatar" className="w-8 h-8 rounded-full border border-border" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-accent-soft border border-border flex items-center justify-center text-accent font-bold text-xs uppercase">
                  {(user.displayName || user.email || 'U').charAt(0)}
                </div>
              )}

              <button onClick={onLogout} title="Logout" className="btn-ghost !p-2 hover:!text-critical">
                <LogOut className="w-4 h-4" strokeWidth={1.75} />
              </button>
            </>
          )}
        </div>
      </div>
      </div>

      {/* One-glance system status — answers "is everything OK right now?"
          without having to scan every camera tile individually. A hairline
          border makes clear this is a secondary, at-a-glance strip and not
          another row of primary controls. */}
      <div className="flex items-center gap-5 px-6 py-2.5 border-t border-border/60 overflow-x-auto">
        {/* "Streaming now" (real-time, measured per-connection) is a
            deliberately different phrase from Registry's "status" badges
            (declared/manually-set) — see the Registry tab's "Registry
            status" column — so the two concepts never look like the same
            kind of fact at a glance. */}
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="relative flex w-2 h-2 shrink-0">
            {camerasLive > 0 && <span className="absolute inset-0 rounded-full bg-success animate-ping opacity-60" />}
            <span className={cn('relative w-2 h-2 rounded-full', camerasLive === camerasTotal && camerasTotal > 0 ? 'bg-success' : 'bg-warning')} />
          </span>
          <span className="text-[10px] font-semibold text-ink-muted whitespace-nowrap" title="Cameras with a confirmed live connection right now — not just registered">{camerasLive}/{camerasTotal} streaming now</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <AlertTriangle className={cn('w-3.5 h-3.5', alertsToday > 0 ? 'text-warning' : 'text-ink-muted')} strokeWidth={1.75} />
          <span className="text-[10px] font-semibold text-ink-muted whitespace-nowrap">{alertsToday} alert{alertsToday !== 1 ? 's' : ''} today</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Sparkles className={cn('w-3.5 h-3.5', geminiHealthy ? 'text-success' : 'text-critical')} strokeWidth={1.75} />
          <span className="text-[10px] font-semibold text-ink-muted whitespace-nowrap">Gemini {geminiHealthy ? 'responding normally' : 'reporting errors'}</span>
        </div>
      </div>
    </header>
  );
}
