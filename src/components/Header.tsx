import { RefreshCw, Camera, LogOut, AlertTriangle, Sparkles, Search, Sun, Moon, Shield } from 'lucide-react';
import { cn } from '../lib/utils';
import { User as FirebaseUser } from 'firebase/auth';
import { GuardScope } from '../types';

interface HeaderProps {
  isCapturing: boolean;
  onToggleCapturing: () => void;
  guardScope: GuardScope;
  onChangeGuardScope: (scope: GuardScope) => void;
  user: FirebaseUser | null;
  onLogout: () => void;
  camerasLive: number;
  camerasTotal: number;
  alertsToday: number;
  geminiHealthy: boolean;
  onOpenSearch: () => void;
  theme?: 'light' | 'dark';
  onToggleTheme?: () => void;
}

export default function Header({
  isCapturing, onToggleCapturing, guardScope, onChangeGuardScope,
  user, onLogout, camerasLive, camerasTotal, alertsToday, geminiHealthy, onOpenSearch,
  theme, onToggleTheme
}: HeaderProps) {
  return (
    <header className="flex flex-col bg-surface/95 backdrop-blur-xl border-b border-border sticky top-0 z-40">
      <div className="h-18 flex items-center justify-between px-5 sm:px-6 gap-3">
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <h1 className="text-base sm:text-lg font-bold font-display tracking-tight text-ink">OmniSee Pro</h1>
              <span className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono font-bold tracking-wider uppercase bg-accent-soft text-accent border border-accent/20">
                SOC v2.4
              </span>
            </div>
            <p className="text-[10px] text-ink-muted font-mono font-medium uppercase tracking-[0.14em]">
              Autonomous Vision Mesh
            </p>
          </div>
        </div>

        {/* Global Search (Command Palette) */}
        <button
          onClick={onOpenSearch}
          className="hidden md:flex items-center gap-2.5 px-4 py-2 rounded-xl bg-surface-muted border border-border text-ink-muted hover:text-ink hover:border-accent/40 active:scale-[0.98] transition-all flex-1 max-w-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Search className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
          <span className="text-xs font-medium truncate">Search cameras, plates, logs...</span>
          <kbd className="ml-auto text-[10px] font-mono bg-surface border border-border rounded px-1.5 py-0.5 shrink-0 text-ink-muted">⌘K</kbd>
        </button>
        <button onClick={onOpenSearch} className="btn-ghost !p-2 min-w-[36px] min-h-[36px] flex items-center justify-center !rounded-xl active:scale-95 md:hidden" title="Search (⌘K)">
          <Search className="w-4 h-4" strokeWidth={2} />
        </button>

        {/* Guard Patrol Trigger & Scope Selector */}
        <div className="flex items-center gap-2.5">
          {/* Scope Selector */}
          <div className="hidden sm:flex items-center bg-surface-muted p-1 rounded-xl border border-border text-[11px] font-semibold">
            <span className="text-[9px] uppercase tracking-wider text-ink-muted px-2 font-mono">Scope</span>
            <button
              onClick={() => onChangeGuardScope('active')}
              className={cn(
                'px-3.5 py-1.5 rounded-lg transition-all active:scale-95 whitespace-nowrap min-h-[30px] flex items-center justify-center',
                guardScope === 'active' ? 'bg-surface text-ink shadow-xs border border-border/80 font-bold' : 'text-ink-muted hover:text-ink'
              )}
              title="Monitor focused camera only"
            >
              Active
            </button>
            <button
              onClick={() => onChangeGuardScope('selected')}
              className={cn(
                'px-3.5 py-1.5 rounded-lg transition-all active:scale-95 whitespace-nowrap min-h-[30px] flex items-center justify-center',
                guardScope === 'selected' ? 'bg-surface text-ink shadow-xs border border-border/80 font-bold' : 'text-ink-muted hover:text-ink'
              )}
              title="Monitor manually selected AI tiles"
            >
              Selected
            </button>
            <button
              onClick={() => onChangeGuardScope('all')}
              className={cn(
                'px-3.5 py-1.5 rounded-lg transition-all active:scale-95 whitespace-nowrap min-h-[30px] flex items-center justify-center',
                guardScope === 'all' ? 'bg-surface text-ink shadow-xs border border-border/80 font-bold' : 'text-ink-muted hover:text-ink'
              )}
              title="Monitor all perimeter cameras"
            >
              Perimeter
            </button>
          </div>

          <button
            onClick={onToggleCapturing}
            className={cn(
              'inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-xs tracking-wide transition-all duration-150 active:scale-95 shadow-xs whitespace-nowrap min-h-[38px]',
              isCapturing ? 'bg-critical text-white hover:bg-critical/90 shadow-critical/20' : 'btn-primary shadow-accent/20'
            )}
            title="Toggle autonomous Guard monitoring (Hotkey: Space)"
          >
            {isCapturing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" strokeWidth={2} /> : <Camera className="w-3.5 h-3.5" strokeWidth={2} />}
            <span className="hidden xs:inline">{isCapturing ? 'Pause Guard' : 'Activate Guard'}</span>
            <span className="inline xs:hidden">{isCapturing ? 'Pause' : 'Activate'}</span>
          </button>

          {/* Theme Quick Toggle */}
          {onToggleTheme && (
            <button
              onClick={onToggleTheme}
              className="btn-ghost !p-2 min-w-[36px] min-h-[36px] flex items-center justify-center !rounded-xl active:scale-95"
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? <Sun className="w-4 h-4 text-warning" /> : <Moon className="w-4 h-4 text-ink-muted" />}
            </button>
          )}

          {/* User Profile & Logout */}
          <div className="flex items-center gap-2 border-l border-border pl-2 sm:pl-3">
            {user && (
              <>
                <div className="hidden md:flex flex-col items-end text-right">
                  <span className="text-[11px] font-semibold text-ink truncate max-w-[110px]">{user.displayName || 'Active User'}</span>
                  <span className="text-[10px] font-mono text-ink-muted truncate max-w-[110px]">{user.email || 'demo-guest'}</span>
                </div>

                {user.photoURL ? (
                  <img src={user.photoURL} alt="User avatar" className="w-7 h-7 rounded-lg border border-border object-cover" />
                ) : (
                  <div className="w-7 h-7 rounded-lg bg-accent-soft border border-border flex items-center justify-center text-accent font-bold text-xs uppercase">
                    {(user.displayName || user.email || 'U').charAt(0)}
                  </div>
                )}

                <button onClick={onLogout} title="Logout" className="btn-ghost !p-2 min-w-[36px] min-h-[36px] flex items-center justify-center !rounded-xl active:scale-95 hover:!text-critical">
                  <LogOut className="w-4 h-4" strokeWidth={1.75} />
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Telemetry Status Ribbon */}
      <div className="flex items-center gap-6 px-5 sm:px-6 py-2 border-t border-border/70 overflow-x-auto bg-surface-muted/30">
        <div className="flex items-center gap-2 shrink-0">
          <span className="relative flex w-2 h-2 shrink-0">
            {camerasLive > 0 && <span className="absolute inset-0 rounded-full bg-success animate-ping opacity-75" />}
            <span className={cn('relative w-2 h-2 rounded-full', camerasLive === camerasTotal && camerasTotal > 0 ? 'bg-success' : 'bg-warning')} />
          </span>
          <span className="telemetry-tag text-ink-muted" title="Confirmed streaming feeds">
            {camerasLive}/{camerasTotal} ONLINE
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <Shield className={cn('w-3.5 h-3.5', isCapturing ? 'text-accent animate-pulse' : 'text-ink-muted')} strokeWidth={2} />
          <span className="telemetry-tag text-ink-muted">
            {isCapturing ? (
              <span className="text-accent font-bold">GUARD ACTIVE · {guardScope.toUpperCase()}</span>
            ) : (
              'GUARD STANDBY'
            )}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <AlertTriangle className={cn('w-3.5 h-3.5', alertsToday > 0 ? 'text-warning' : 'text-ink-muted')} strokeWidth={2} />
          <span className="telemetry-tag text-ink-muted">
            {alertsToday} INCIDENT{alertsToday !== 1 ? 'S' : ''} TODAY
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <Sparkles className={cn('w-3.5 h-3.5', geminiHealthy ? 'text-success' : 'text-critical')} strokeWidth={2} />
          <span className="telemetry-tag text-ink-muted">
            GEMINI {geminiHealthy ? 'SYNCHRONIZED' : 'FAULT'}
          </span>
        </div>
      </div>
    </header>
  );
}
