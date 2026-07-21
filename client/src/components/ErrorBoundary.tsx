import { Component, type ErrorInfo, type ReactNode } from "react";

// React's only way to stop a render-time throw from tearing down the whole app.
// It has to be a class — there is no hook equivalent.
//
// The case this exists for is a lazily-loaded chunk that never arrives. Building
// the client renames the hashed chunk files, so a tab still holding the previous
// index.html requests a URL that no longer exists; the dynamic import rejects,
// and React re-throws that during render. With no boundary above it the
// rejection reaches the root and React unmounts everything, leaving a blank page
// with nothing to click and no hint that a reload would fix it.
//
// Recovery is a reload rather than a re-render on purpose: React.lazy caches a
// rejected import for the life of the page, so resetting this component's state
// would re-throw the same error on the next render. Reloading fetches the
// current index.html, which names chunks that actually exist.
export class ErrorBoundary extends Component<
  { children: ReactNode; message: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The user gets the message below; the console keeps what actually broke.
    console.error("[ui] render failed:", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="empty">
        <p>{this.props.message}</p>
        <button className="link-btn" onClick={() => window.location.reload()}>
          Reload the page
        </button>
      </div>
    );
  }
}
