import { useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Bot, Sparkles, X, Send, MessageSquare } from 'lucide-react';

interface ChatMessage { role: 'user' | 'model'; text: string; }

interface ChatWidgetProps {
  isOpen: boolean;
  onToggle: () => void;
  messages: ChatMessage[];
  input: string;
  onInputChange: (v: string) => void;
  isSending: boolean;
  onSend: (e: React.FormEvent) => void;
}

export default function ChatWidget({ isOpen, onToggle, messages, input, onInputChange, isSending, onSend }: ChatWidgetProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isSending]);

  return (
    <div id="omni-chatbot-container" className="fixed bottom-24 right-6 lg:bottom-6 lg:right-6 z-[90] flex flex-col items-end">
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.97 }}
            className="w-[300px] h-[400px] sm:w-[360px] sm:h-[460px] card flex flex-col overflow-hidden mb-4 shadow-xl"
          >
            <div className="p-4 bg-surface-muted border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-accent-soft flex items-center justify-center text-accent">
                  <Bot className="w-4.5 h-4.5" strokeWidth={1.75} />
                </div>
                <div>
                  <h3 className="text-xs font-bold text-ink flex items-center gap-1">
                    OmniSee Pilot <Sparkles className="w-3 h-3 text-accent" strokeWidth={1.75} />
                  </h3>
                  <div className="flex items-center gap-1">
                    <span className="w-1 h-1 rounded-full bg-success animate-pulse" />
                    <span className="text-[9px] text-ink-muted font-semibold uppercase tracking-wide">Online</span>
                  </div>
                </div>
              </div>
              <button onClick={onToggle} className="btn-ghost !p-1.5">
                <X className="w-4 h-4" strokeWidth={1.75} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
              {messages.map((msg, idx) => (
                <div
                  key={idx}
                  className={
                    msg.role === 'user'
                      ? 'flex flex-col max-w-[85%] rounded-2xl p-2.5 text-xs leading-relaxed bg-accent text-white rounded-tr-sm self-end ml-auto'
                      : 'flex flex-col max-w-[85%] rounded-2xl p-2.5 text-xs leading-relaxed bg-surface-muted text-ink rounded-tl-sm self-start'
                  }
                >
                  <p className="whitespace-pre-wrap">{msg.text}</p>
                </div>
              ))}
              {isSending && (
                <div className="bg-surface-muted text-ink rounded-2xl rounded-tl-sm p-2.5 text-xs max-w-[85%] self-start flex items-center gap-1">
                  <span className="w-1 h-1 bg-ink-muted rounded-full animate-bounce" />
                  <span className="w-1 h-1 bg-ink-muted rounded-full animate-bounce [animation-delay:0.15s]" />
                  <span className="w-1 h-1 bg-ink-muted rounded-full animate-bounce [animation-delay:0.3s]" />
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <form onSubmit={onSend} className="p-3 bg-surface border-t border-border flex gap-2 items-center">
              <input
                type="text"
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                placeholder="Ask about camera events..."
                disabled={isSending}
                className="input !py-2 !rounded-xl flex-1 text-xs"
              />
              <button type="submit" disabled={isSending || !input.trim()} className="btn-primary !p-0 w-9 h-9 !rounded-xl shrink-0">
                <Send className="w-3.5 h-3.5" strokeWidth={1.75} />
              </button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={onToggle}
        className="w-12 h-12 rounded-full bg-accent text-white flex items-center justify-center shadow-lg pointer-events-auto"
      >
        <MessageSquare className="w-5 h-5" strokeWidth={1.75} />
      </motion.button>
    </div>
  );
}
