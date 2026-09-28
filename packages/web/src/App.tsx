import { Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { ErrorBoundary } from "./ui/ErrorBoundary.tsx";
import { FullScreenLoader } from "./ui/FullScreenLoader.tsx";
import { lazyPage } from "./ui/lazyPage.ts";
import { Toaster } from "./ui/Toast.tsx";

const Root = lazyPage(() => import("./routes/Root.tsx"));
const Join = lazyPage(() => import("./routes/Join.tsx"));
const Wait = lazyPage(() => import("./routes/Wait.tsx"));
const TableRoute = lazyPage(() => import("./routes/Table.tsx"));
const Closed = lazyPage(() => import("./routes/Closed.tsx"));
const Setup = lazyPage(() => import("./routes/Setup.tsx"));
const Admin = lazyPage(() => import("./admin/AdminApp.tsx"));
/** Test builds only (AC-DS-03's evidence): every icon at 16 / 20 / 24 px and the atlas — gone from production builds. */
const IconSheet = __GLOAM_TEST__ ? lazyPage(() => import("./routes/IconSheet.tsx")) : null;

/** Routes (SPEC §23.1): `/`, `/join`, `/wait`, `/table`, `/admin/*` (lazy), `/setup`, `/closed`. */
export function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary where="app">
        <Suspense fallback={<FullScreenLoader />}>
          <Routes>
            <Route path="/" element={<Root />} />
            <Route path="/join" element={<Join />} />
            <Route path="/wait" element={<Wait />} />
            <Route path="/table" element={<TableRoute />} />
            <Route path="/closed" element={<Closed />} />
            <Route path="/setup" element={<Setup />} />
            <Route path="/admin/*" element={<Admin />} />
            {IconSheet ? <Route path="/__icons" element={<IconSheet />} /> : null}
            <Route path="*" element={<Root />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
      <Toaster />
    </BrowserRouter>
  );
}
