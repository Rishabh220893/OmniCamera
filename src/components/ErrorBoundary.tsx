import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary caught error]:', error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-surface flex flex-col items-center justify-center p-6 text-center text-ink">
          <div className="w-16 h-16 rounded-2xl bg-critical-soft flex items-center justify-center mb-5">
            <AlertTriangle className="w-8 h-8 text-critical" strokeWidth={1.75} />
          </div>
          <h1 className="text-xl font-bold tracking-tight mb-2">Something went wrong</h1>
          <p className="text-ink-muted text-sm max-w-md mb-6">
            An unexpected error occurred in the dashboard interface.
            {this.state.error?.message ? ` (${this.state.error.message})` : ''}
          </p>
          <button
            onClick={this.handleReset}
            className="btn-primary !py-2.5 !px-5 text-sm active:scale-95 whitespace-nowrap"
          >
            <RefreshCw className="w-4 h-4" strokeWidth={2} />
            Reload Dashboard
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
