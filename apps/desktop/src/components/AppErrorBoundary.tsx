import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState, errorPreset } from "./ErrorState";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

/** Last-resort renderer recovery surface; task data remains in the control plane. */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  public state: AppErrorBoundaryState = { error: null };

  public static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Terminus renderer error", error, info.componentStack);
  }

  public render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas px-6">
        <div className="w-full max-w-xl rounded-xl border border-subtle bg-elevated shadow-lg">
          <ErrorState
            {...errorPreset("applicationError")}
            detail={error.message}
            action={{ label: "Reload interface", onClick: () => window.location.reload() }}
          />
        </div>
      </main>
    );
  }
}
