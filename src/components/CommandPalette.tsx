import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, Camera as CameraIcon, ScanLine, BookOpen, Eye, BarChart2, Map as MapIcon, Settings2, CornerDownLeft } from 'lucide-react';
import { CameraConfig, LogEntry, TabId } from '../types';
import { GLOSSARY_TERMS } from '../data/glossary';
import { cn } from '../lib/utils';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  cameras: CameraConfig[];
  logs: LogEntry[];
  onSelectCamera: (id: string) => void;
  onJumpToLog: (logId: string) => void;
  onChangeTab: (tab: TabId) => void;
}

type ResultItem = {
  id: string;
  group: 'Go to' | 'Cameras' | 'Logs & plates' | 'Guide';
  label: string;
  sublabel?: string;
  icon: typeof Search;
  onSelect: () => void;
};

const NAV_TARGETS: { tab: TabId; label: string; icon: typeof Eye; keywords: string }[] = [
  { tab: 'monitor', label: 'Feed', icon: Eye, keywords: 'feed monitor live cameras watch' },
  { tab: 'analytics', label: 'Logs', icon: BarChart2, keywords: 'logs analytics archive plates events' },
  { tab: 'map', label: 'Registry', icon: MapIcon, keywords: 'registry map fleet asset gap audit' },
  { tab: 'settings', label: 'Settings', icon: Settings2, keywords: 'settings setup config webhook watchlist faces' },
  { tab: 'guide', label: 'Guide', icon: BookOpen, keywords: 'guide help glossary docs' },
];

// A single search entry point over cameras, logs/plates, glossary terms, and
// tab navigation — replacing four separate, inconsistent search boxes (one
// per tab) with one the user only has to learn once. Per-tab filters (e.g.
// Registry's department/status dropdowns) stay where they are: they're doing
// real narrowing work on an already-open view, not acting as an entry point.
export default function CommandPalette({ isOpen, onClose, cameras, logs, onSelectCamera, onJumpToLog, onChangeTab }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      const t = setTimeout(() => inputRef.current?.focus(), 10);
      return () => clearTimeout(t);
    }
  }, [isOpen]);

  const results = useMemo<ResultItem[]>(() => {
    const q = query.trim().toLowerCase();
    const items: ResultItem[] = [];

    NAV_TARGETS.forEach(t => {
      if (!q || t.keywords.includes(q) || t.label.toLowerCase().includes(q)) {
        items.push({ id: `nav-${t.tab}`, group: 'Go to', label: t.label, icon: t.icon, onSelect: () => onChangeTab(t.tab) });
      }
    });

    if (q) {
      cameras
        .filter(c => `${c.name} ${c.department || ''} ${c.ownership || ''}`.toLowerCase().includes(q))
        .slice(0, 6)
        .forEach(c => {
          items.push({ id: `cam-${c.id}`, group: 'Cameras', label: c.name, sublabel: c.department || 'Camera', icon: CameraIcon, onSelect: () => onSelectCamera(c.id) });
        });

      logs
        .filter(l => `${l.cameraName} ${l.summary} ${(l.detectedPlates || []).join(' ')}`.toLowerCase().includes(q))
        .slice(0, 6)
        .forEach(l => {
          const plateHit = (l.detectedPlates || []).find(p => p.toLowerCase().includes(q));
          items.push({
            id: `log-${l.id}`, group: 'Logs & plates',
            label: plateHit || l.summary.slice(0, 70),
            sublabel: `${l.cameraName} · ${l.timestamp.toLocaleString()}`,
            icon: ScanLine, onSelect: () => onJumpToLog(l.id)
          });
        });

      GLOSSARY_TERMS
        .filter(t => t.term.toLowerCase().includes(q) || t.definition.toLowerCase().includes(q))
        .slice(0, 4)
        .forEach(t => {
          items.push({ id: `glossary-${t.term}`, group: 'Guide', label: t.term, sublabel: t.definition.slice(0, 80), icon: BookOpen, onSelect: () => onChangeTab('guide') });
        });
    }

    return items;
  }, [query, cameras, logs, onSelectCamera, onJumpToLog, onChangeTab]);

  useEffect(() => { setSelectedIndex(0); }, [query]);

  const grouped = useMemo(() => {
    const map = new Map<ResultItem['group'], ResultItem[]>();
    results.forEach(r => { const arr = map.get(r.group) || []; arr.push(r); map.set(r.group, arr); });
    return Array.from(map.entries());
  }, [results]);

  const handleActivate = (item: ResultItem) => { item.onSelect(); onClose(); };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(i => Math.min(results.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[selectedIndex]) handleActivate(results[selectedIndex]); }
    else if (e.key === 'Escape') { onClose(); }
  };

  let renderIndex = -1;

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[200] flex items-start justify-center pt-[12vh] px-4">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="absolute inset-0 bg-ink/40 backdrop-blur-sm" />
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: -8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97, y: -8 }}
            className="relative w-full max-w-xl card overflow-hidden shadow-2xl flex flex-col max-h-[70vh]"
          >
            <div className="flex items-center gap-3 px-5 py-4 border-b border-border">
              <Search className="w-4.5 h-4.5 text-ink-muted shrink-0" strokeWidth={1.75} />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Search cameras, plates, logs — or jump to a tab..."
                className="flex-1 bg-transparent outline-none text-sm text-ink placeholder:text-ink-muted"
              />
              <kbd className="text-[10px] font-mono text-ink-muted bg-surface-muted border border-border rounded px-1.5 py-0.5 shrink-0">Esc</kbd>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar py-2">
              {results.length === 0 ? (
                <p className="text-xs text-ink-muted text-center py-10">
                  {query ? `No matches for "${query}".` : 'Start typing to search cameras, plates, and logs — or browse tabs below.'}
                </p>
              ) : (
                grouped.map(([group, items]) => (
                  <div key={group} className="px-2 py-1.5">
                    <p className="px-3 text-[10px] font-bold text-ink-muted uppercase tracking-widest mb-1">{group}</p>
                    {items.map(item => {
                      renderIndex++;
                      const idx = renderIndex;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onMouseEnter={() => setSelectedIndex(idx)}
                          onClick={() => handleActivate(item)}
                          className={cn('w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left', idx === selectedIndex ? 'bg-accent-soft' : 'hover:bg-surface-muted')}
                        >
                          <item.icon className={cn('w-4 h-4 shrink-0', idx === selectedIndex ? 'text-accent' : 'text-ink-muted')} strokeWidth={1.75} />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-ink truncate">{item.label}</p>
                            {item.sublabel && <p className="text-[10px] text-ink-muted truncate">{item.sublabel}</p>}
                          </div>
                          {idx === selectedIndex && <CornerDownLeft className="w-3.5 h-3.5 text-ink-muted shrink-0" strokeWidth={1.75} />}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
