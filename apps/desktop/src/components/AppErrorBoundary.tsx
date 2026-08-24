import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState, errorPreset } from "./ErrorState";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
  copyState: "idle" | "copied" | "failed";
}

/** Last-resort renderer recovery surface; task data remains in the control plane. */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  public override state: AppErrorBoundaryState = { error: null, copyState: "idle" };

  public static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error, copyState: "idle" };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Terminus renderer error", error, info.componentStack);
  }

  private readonly copyError = async (): Promise<void> => {
    const { error } = this.state;
    if (!error) return;
    try {
      await navigator.clipboard.writeText(error.stack ?? error.message);
      this.setState({ copyState: "copied" });
    } catch {
      this.setState({ copyState: "failed" });
    }
  };

  public override render(): ReactNode {
    const { error, copyState } = this.state;
    if (!error) return this.props.children;
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas px-6">
        <div className="w-full max-w-lg">
          <ErrorState
            {...errorPreset("applicationError")}
            title="The interface stopped unexpectedly"
            description="Task data is safe in the local service. Reload the window to continue."
            detail={error.message}
            action={{ label: "Reload", onClick: () => window.location.reload() }}
            secondaryAction={{
              label: copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy error",
              onClick: () => void this.copyError(),
            }}
          />
        </div>
      </main>
    );
  }
}
