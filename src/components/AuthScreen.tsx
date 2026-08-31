import { motion } from 'motion/react';
import { Fingerprint, Sparkles } from 'lucide-react';

interface AuthScreenProps {
  loginError: string | null;
  isSigningIn: boolean;
  onGoogleLogin: () => void;
  onGuestBypass: () => void;
}

export default function AuthScreen({ loginError, isSigningIn, onGoogleLogin, onGuestBypass }: AuthScreenProps) {
  return (
    <motion.div
      key="auth"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.02 }}
      className="fixed inset-0 z-[200] bg-surface flex flex-col items-center justify-center p-6"
    >
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-3">
          <div className="w-14 h-14 bg-surface-muted border border-border rounded-2xl mx-auto flex items-center justify-center text-accent">
            <Fingerprint className="w-7 h-7" strokeWidth={1.75} />
          </div>
          <h2 className="text-xl font-bold text-ink tracking-tight">Sign in to OmniSee</h2>
          <p className="text-xs text-ink-muted font-medium">Access your surveillance dashboard</p>
        </div>

        <div className="space-y-5">
          {loginError && (
            <div className="badge-critical rounded-2xl p-4 text-left space-y-3 !inline-block w-full !normal-case">
              <p className="text-xs font-bold text-critical">Login setup issue detected</p>
              <p className="text-[11px] text-ink leading-relaxed font-medium">
                Firebase returned: <code className="text-critical font-mono text-[10px] break-all">{loginError}</code>
              </p>

              {loginError.includes('auth/configuration-not-found') && (
                <div className="text-[11px] text-ink-muted space-y-2 mt-2 pt-2 border-t border-border">
                  <p className="text-ink font-bold">How to enable Auth on your Firebase project:</p>
                  <ol className="list-decimal list-inside space-y-1">
                    <li>Go to your <a href="https://console.firebase.google.com/" target="_blank" rel="noopener noreferrer" className="text-accent underline">Firebase Console</a></li>
                    <li>Open your project</li>
                    <li>Go to <span className="text-ink">Authentication</span> &rarr; <span className="text-ink">Sign-in method</span></li>
                    <li>Click <span className="text-ink">Add provider</span> &rarr; select <span className="text-ink">Google</span></li>
                    <li>Enable it, choose support email, and click <span className="text-ink">Save</span></li>
                  </ol>
                </div>
              )}

              {loginError.includes('auth/unauthorized-domain') && (
                <div className="text-[11px] text-ink-muted space-y-2 mt-2 pt-2 border-t border-border">
                  <p className="text-ink font-bold">Domain authorization required:</p>
                  <p className="leading-relaxed">
                    Firebase requires this domain to be added to your Authorized Domains list:
                  </p>
                  <div className="bg-surface p-2 rounded border border-border font-mono text-[10px] text-accent select-all break-all text-center my-1">
                    {window.location.hostname}
                  </div>
                  <p className="text-warning text-[10px] mt-2 font-bold">
                    Quick workaround: use "Bypass Login" below to access all app functions immediately.
                  </p>
                </div>
              )}
            </div>
          )}

          <button
            onClick={onGoogleLogin}
            disabled={isSigningIn}
            className="btn-secondary w-full py-4 text-sm"
          >
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="w-5 h-5" alt="Google" />
            {isSigningIn ? "Signing in..." : "Sign in with Google"}
          </button>

          <div className="relative flex py-1 items-center">
            <div className="flex-grow border-t border-border"></div>
            <span className="flex-shrink mx-4 text-ink-muted text-[10px] font-bold uppercase tracking-wider">or</span>
            <div className="flex-grow border-t border-border"></div>
          </div>

          <button
            onClick={onGuestBypass}
            className="btn-ghost w-full py-3.5 text-xs border border-border rounded-xl"
          >
            <Sparkles className="w-4 h-4 text-accent" strokeWidth={1.75} />
            Bypass Login (Guest Demo)
          </button>
        </div>
      </div>
    </motion.div>
  );
}
