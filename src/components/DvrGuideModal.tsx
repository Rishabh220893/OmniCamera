import { motion, AnimatePresence } from 'motion/react';
import { ChevronLeft, X, Settings, Info, RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';
import { SETUP_GUIDES } from '../data/setupGuides';

interface DvrGuideModalProps {
  isOpen: boolean;
  selectedGuideId: string | null;
  onSelectGuide: (id: string | null) => void;
  onShowGeneral: () => void;
  onClose: () => void;
}

export default function DvrGuideModal({ isOpen, selectedGuideId, onSelectGuide, onShowGeneral, onClose }: DvrGuideModalProps) {
  const showingGeneral = isOpen && !selectedGuideId;

  return (
    <AnimatePresence>
      {(isOpen || selectedGuideId) && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-10">
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 12 }}
            className="relative w-full max-w-4xl card overflow-hidden flex flex-col lg:flex-row max-h-[90vh] shadow-xl"
          >
            <div className="w-full lg:w-64 bg-surface-muted border-r border-border overflow-y-auto p-5 hidden lg:block">
              <h3 className="text-[10px] font-bold text-ink-muted uppercase tracking-widest mb-4">Device library</h3>
              <div className="space-y-1">
                {SETUP_GUIDES.map(guide => (
                  <button
                    key={guide.id}
                    onClick={() => onSelectGuide(guide.id)}
                    className={cn('w-full flex items-center gap-3 p-2.5 rounded-xl text-left text-xs font-semibold', selectedGuideId === guide.id ? 'bg-accent text-white' : 'text-ink-muted hover:bg-surface')}
                  >
                    <guide.icon className="w-4 h-4" strokeWidth={1.75} />
                    {guide.brand}
                  </button>
                ))}
                <button
                  onClick={onShowGeneral}
                  className={cn('w-full flex items-center gap-3 p-2.5 rounded-xl text-left text-xs font-semibold', showingGeneral ? 'bg-accent text-white' : 'text-ink-muted hover:bg-surface')}
                >
                  <Settings className="w-4 h-4" strokeWidth={1.75} />
                  DVR General
                </button>
              </div>
            </div>

            <div className="flex-1 flex flex-col min-h-0 bg-surface">
              <div className="p-5 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <button onClick={onClose} className="lg:hidden text-ink-muted"><ChevronLeft /></button>
                  <div>
                    <h3 className="text-base font-bold text-ink">
                      {selectedGuideId ? SETUP_GUIDES.find(g => g.id === selectedGuideId)?.title : 'DVR Integration Guide'}
                    </h3>
                    <p className="text-[10px] text-ink-muted font-bold uppercase tracking-widest">Interactive setup assistant</p>
                  </div>
                </div>
                <button onClick={onClose} className="btn-ghost !p-2 !rounded-full"><X className="w-4 h-4" strokeWidth={1.75} /></button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 lg:p-10 space-y-10 custom-scrollbar">
                {selectedGuideId ? (
                  SETUP_GUIDES.find(g => g.id === selectedGuideId)?.steps.map((step, idx) => (
                    <div key={idx} className="space-y-3">
                      <div className="flex items-center gap-3">
                        <div className="w-7 h-7 rounded-full bg-accent flex items-center justify-center text-white text-xs font-bold">{idx + 1}</div>
                        <h4 className="text-sm font-bold text-ink">{step.title}</h4>
                      </div>
                      {/* break-words: several steps embed a long unbroken
                          rtsp:// URL — without it that single "word" just
                          overflows the panel on a narrow screen instead of
                          wrapping. */}
                      <p className="text-sm text-ink-muted leading-relaxed pl-10 break-words">{step.content}</p>
                    </div>
                  ))
                ) : (
                  <div className="space-y-8">
                    <section className="space-y-3">
                      <h4 className="text-xs font-bold uppercase tracking-widest text-accent flex items-center gap-2">
                        <Info className="w-4 h-4" strokeWidth={1.75} /> Standard RTSP URL patterns
                      </h4>
                      <div className="panel p-5 font-mono text-[11px] space-y-3">
                        <div className="space-y-1">
                          <div className="text-ink-muted italic">// Hikvision</div>
                          <div className="text-accent break-all">rtsp://admin:12345@192.168.1.10:554/Streaming/Channels/101</div>
                        </div>
                        <div className="space-y-1 pt-3 border-t border-border">
                          <div className="text-ink-muted italic">// Dahua / CP Plus</div>
                          <div className="text-success break-all">rtsp://admin:admin123@192.168.1.10:554/cam/realmonitor?channel=1&subtype=0</div>
                        </div>
                      </div>
                    </section>
                    <section className="space-y-3">
                      <h4 className="text-xs font-bold uppercase tracking-widest text-accent flex items-center gap-2">
                        <RefreshCw className="w-4 h-4" strokeWidth={1.75} /> The browser protocol gap
                      </h4>
                      <p className="text-xs text-ink-muted leading-relaxed">
                        Browsers do not support RTSP natively. You must use a bridge like <span className="text-ink font-semibold">go2rtc</span> or <span className="text-ink font-semibold">WebRTC-Streamer</span> to convert the stream to a browser-compatible format.
                      </p>
                    </section>
                  </div>
                )}
              </div>

              <div className="p-6 bg-surface-muted border-t border-border">
                <button onClick={onClose} className="btn-primary w-full py-3.5">Finish setup</button>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
