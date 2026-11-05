import { Component, type ReactNode } from 'react';

/** Keeps one broken view from blanking the whole board. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="loading">
        <strong>Something went wrong.</strong>
        <code className="muted">{this.state.error.message}</code>
        <button className="btn btn-sm" style={{ justifySelf: 'center' }} onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
