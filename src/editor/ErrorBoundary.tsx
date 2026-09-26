/**
 * Keeps one failing panel from taking the editor down, and shows why.
 *
 * @portOnly
 */
import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error(`[${this.props.name}]`, error);
  }

  override render() {
    if (this.state.error)
      return (
        <div className="panel-error">
          <b>{this.props.name} failed:</b> {this.state.error.message}
          <pre>{this.state.error.stack}</pre>
          <button onClick={() => this.setState({ error: null })}>retry</button>
        </div>
      );
    return this.props.children;
  }
}
