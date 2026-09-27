import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useSession } from "../state/session.ts";
import { FullScreenLoader } from "../ui/FullScreenLoader.tsx";
import { Sparkle } from "../ui/ornaments.tsx";

/** `/` sends people where their session says they belong (SPEC §23.1). */
export default function Root() {
  const refresh = useSession((s) => s.refresh);
  const navigate = useNavigate();
  const [setupHint, setSetupHint] = useState(false);

  useEffect(() => {
    void (async () => {
      const me = await refresh();
      if (!me) {
        navigate("/join", { replace: true });
        return;
      }
      if (!me.authenticated) {
        if (me.setupNeeded && me.local) {
          setSetupHint(true);
          return;
        }
        navigate("/join", { replace: true });
        return;
      }
      if (me.session?.kind === "admin") {
        navigate("/admin", { replace: true });
        return;
      }
      const status = me.session?.status;
      if (status === "admitted" && me.table.open) navigate("/table", { replace: true });
      else if ((status === "pending" || status === "kicked") && me.table.open)
        navigate("/wait", { replace: true });
      else navigate("/join", { replace: true });
    })();
  }, [navigate, refresh]);

  if (!setupHint) return <FullScreenLoader />;
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-bg p-4">
      <div className="panel relative max-w-[520px] p-8">
        <div className="mb-3 flex items-center gap-2">
          <Sparkle />
          <span className="caps text-12 text-brass">First run</span>
        </div>
        <h1 className="text-28 text-bone">Finish setting up your table</h1>
        <p className="mt-3 text-16 text-muted">
          Open the one-time <strong className="text-bone">setup link</strong> printed in the terminal where
          you ran <code className="mono text-14 text-brass-bright">pnpm start</code>. It works for 30 minutes
          on this PC only. If it expired, stop the server (Ctrl+C) and start it again for a fresh link.
        </p>
      </div>
    </main>
  );
}
