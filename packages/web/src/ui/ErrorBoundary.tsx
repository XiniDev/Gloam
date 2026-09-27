import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportClientError } from "../net/http.ts";
import { Button } from "./Button.tsx";
import { EmptyState } from "./EmptyState.tsx";

/** Error boundaries per panel and around the canvas (SPEC §23.6): the rest of the UI stays alive. */
export class ErrorBoundary extends Component<
  { children: ReactNode; where: string; fallback?: (reset: () => void) => ReactNode },
  { error: Error | null }
> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    reportClientError(
      "error",
      `[${this.props.where}] ${error.message}`,
      `${error.stack ?? ""}\n${info.componentStack ?? ""}`,
    );
  }

  reset = () => this.setState({ error: null });

  override render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.reset);
    return (
      <div className="grid min-h-[40vh] place-items-center p-6">
        <div className="panel max-w-md">
          <EmptyState
            art="scroll"
            title={
              this.props.where === "board"
                ? "The board hit a snag. Your table is safe — reload the board to carry on."
                : "Something went wrong here. The rest of the table is fine."
            }
            action={
              <Button variant="primary" onClick={this.reset}>
                {this.props.where === "board" ? "Reload board" : "Try again"}
              </Button>
            }
          />
        </div>
      </div>
    );
  }
}
