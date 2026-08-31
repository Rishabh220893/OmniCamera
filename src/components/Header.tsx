import { RefreshCw, Camera, LogOut } from 'lucide-react';
import { cn } from '../lib/utils';
import { User as FirebaseUser } from 'firebase/auth';

interface HeaderProps {
  isCapturing: boolean;
  onToggleCapturing: () => void;
  user: FirebaseUser | null;
  onLogout: () => void;
}

export default function Header({ isCapturing, onToggleCapturing, user, onLogout }: HeaderProps) {
  return (
    <header className="h-20 flex items-center justify-between px-6 bg-surface/90 backdrop-blur-xl border-b border-border sticky top-0 z-40">
      <div className="flex flex-col">
        <h1 className="text-lg font-bold tracking-tight text-ink">OmniSee Pro</h1>
        <p className="text-[10px] text-ink-muted font-semibold uppercase tracking-[0.14em]">AI Vision Surveillance</p>
      </div>

      <div className="flex items-center gap-3">
        <div className="hidden sm:flex flex-col items-end mr-1">
          <span className="text-[10px] font-semibold text-ink-muted uppercase">Status</span>
          <div className="flex items-center gap-1.5">
            <span className={cn('w-1.5 h-1.5 rounded-full', isCapturing ? 'bg-success animate-pulse' : 'bg-warning')} />
            <span className="text-xs font-mono font-semibold text-ink">{isCapturing ? 'ONLINE' : 'STANDBY'}</span>
          </div>
        </div>

        <button
          onClick={onToggleCapturing}
          className={cn(
            'flex items-center gap-2 px-4 py-2.5 sm:px-5 rounded-xl font-semibold text-[11px] sm:text-sm transition-all active:scale-95',
            isCapturing ? 'bg-critical text-white' : 'btn-primary'
          )}
        >
          {isCapturing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} /> : <Camera className="w-3.5 h-3.5" strokeWidth={1.75} />}
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
    </header>
  );
}
