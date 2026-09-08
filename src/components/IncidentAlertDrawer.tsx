import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Eye, ScanLine, ShieldAlert } from 'lucide-react';
import { LogEntry, TabId, NotificationPrefs } from '../types';
import { isActualCriticalIncident } from '../lib/incidentUtils';

interface IncidentAlertDrawerProps {
  logs: LogEntry[];
  activeTab: TabId;
  notificationPrefs?: NotificationPrefs;
  onSelectCamera: (cameraId: string) => void;
  onJumpToLog: (logId: string) => void;
  onChangeTab: (tab: TabId) => void;
}

export default function IncidentAlertDrawer({
  logs,
  activeTab,
  notificationPrefs,
  onSelectCamera,
  onJumpToLog,
  onChangeTab,
}: IncidentAlertDrawerProps) {
  const [dismissedLogIds, setDismissedLogIds] = useState<Set<string>>(new Set());
  const [activeIncident, setActiveIncident] = useState<LogEntry | null>(null);

  // Pick the newest ACTUAL critical incident or watchlist hit that hasn't been dismissed
  useEffect(() => {
    if (notificationPrefs && !notificationPrefs.criticalAlerts) {
      setActiveIncident(null);
      return;
    }

    const latestCritical = logs.find(
      (l) => isActualCriticalIncident(l) && !dismissedLogIds.has(l.id)
    );

    if (latestCritical) {
      setActiveIncident(latestCritical);
    } else {
      setActiveIncident(null);
    }
  }, [logs, dismissedLogIds, notificationPrefs]);

  // Only feed ('monitor') and logs ('analytics') pages should show the alert window
  const isFeedOrLogs = activeTab === 'monitor' || activeTab === 'analytics';
  const shouldShow = isFeedOrLogs && !!activeIncident;

  // Keyboard accessibility: dismiss on Escape when visible
  useEffect(() => {
    if (!shouldShow || !activeIncident) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleDismiss();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shouldShow, activeIncident]);

  const handleDismiss = () => {
    if (activeIncident) {
      setDismissedLogIds((prev) => new Set(prev).add(activeIncident.id));
      setActiveIncident(null);
    }
  };

  const handleSpotlight = () => {
    if (activeIncident) {
      onSelectCamera(activeIncident.cameraId);
      onChangeTab('monitor');
      handleDismiss();
    }
  };

  const handleInspectLog = () => {
    if (activeIncident) {
      onJumpToLog(activeIncident.id);
      onChangeTab('analytics');
      handleDismiss();
    }
  };

  const isWatchlist = activeIncident?.isWatchlistMatch;

  return (
    <AnimatePresence>
      {shouldShow && activeIncident && (
        <motion.aside
          key={activeIncident.id}
          initial={{ y: 50, opacity: 0, scale: 0.95 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          exit={{ y: 50, opacity: 0, scale: 0.95 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="fixed bottom-20 lg:bottom-6 right-4 sm:right-6 z-[100] max-w-md w-[calc(100vw-2rem)] sm:w-[calc(100vw-3rem)] rounded-xl border border-critical/40 bg-surface-elevated/95 backdrop-blur-xl shadow-2xl p-4 sm:p-5 text-ink overflow-hidden"
          role="alert"
          aria-live="assertive"
        >
          {/* Subtle glowing background pulse */}
          <div className="absolute top-0 right-0 w-32 h-32 bg-critical/10 rounded-full blur-2xl pointer-events-none" />

          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-critical/20 flex items-center justify-center text-critical shrink-0 animate-pulse">
                <ShieldAlert className="w-4 h-4" strokeWidth={2.25} />
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="telemetry-tag text-critical tracking-wider font-bold whitespace-nowrap">
                    {isWatchlist ? 'WATCHLIST HIT' : 'CRITICAL INCIDENT'}
                  </span>
                  <span className="w-1.5 h-1.5 rounded-full bg-critical animate-ping" />
                </div>
                <p className="text-xs font-bold text-ink truncate">
                  {activeIncident.cameraName}
                </p>
              </div>
            </div>

            <button
              onClick={handleDismiss}
              className="text-ink-muted hover:text-ink p-2 rounded-lg hover:bg-surface-muted transition-colors active:scale-95 min-w-[36px] min-h-[36px] flex items-center justify-center"
              title="Acknowledge alert (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <p className="text-xs text-ink/90 leading-relaxed font-medium mb-3 line-clamp-2">
            {activeIncident.summary}
          </p>

          {activeIncident.alerts.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {activeIncident.alerts.slice(0, 2).map((alert, idx) => (
                <span
                  key={idx}
                  className="badge badge-critical !text-[10px] !py-0.5 whitespace-nowrap"
                >
                  {alert}
                </span>
              ))}
            </div>
          )}

          {activeIncident.detectedPlates && activeIncident.detectedPlates.length > 0 && (
            <div className="mb-3 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-muted border border-border text-[11px] font-mono font-semibold">
              <ScanLine className="w-3.5 h-3.5 text-accent shrink-0" />
              <span className="text-ink-muted text-[10px] whitespace-nowrap">PLATE DETECTED:</span>
              <span className="text-accent truncate">{activeIncident.detectedPlates.join(', ')}</span>
            </div>
          )}

          <div className="flex items-center justify-between gap-2 pt-2 border-t border-border/80">
            <span className="telemetry-tag text-ink-muted text-[10px] whitespace-nowrap">
              {activeIncident.timestamp.toLocaleTimeString()}
            </span>

            <div className="flex items-center gap-2">
              <button
                onClick={handleInspectLog}
                className="btn-ghost !px-3 !py-1.5 text-xs whitespace-nowrap"
              >
                Examine Log
              </button>
              <button
                onClick={handleSpotlight}
                className="btn-primary !px-4 !py-2 text-xs whitespace-nowrap"
              >
                <Eye className="w-3.5 h-3.5" />
                Spotlight Feed
              </button>
            </div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
