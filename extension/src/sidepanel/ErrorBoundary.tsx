import { Component, type ReactNode } from 'react';

/**
 * Without this, any render error unmounts the whole panel and leaves it blank. Showing the message makes
 * a crash reportable, and "Start over" clears the saved conversation in case that is what keeps crashing it.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('myTA side panel crashed:', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card" style={{ margin: 12 }}>
        <h2>myTA hit a snag</h2>
        <p className="small error">{this.state.error.message}</p>
        <button
          className="primary"
          onClick={async () => {
            await chrome.storage.session.remove('panelUi').catch(() => {});
            this.setState({ error: null });
          }}
        >
          Start over
        </button>
      </div>
    );
  }
}
