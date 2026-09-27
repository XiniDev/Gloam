import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { ErrorBoundary } from "./ui/ErrorBoundary.tsx";
import { FullScreenLoader } from "./ui/FullScreenLoader.tsx";
import { Toaster } from "./ui/Toast.tsx";

const Root = lazy(() => import("./routes/Root.tsx"));
const Join = lazy(() => import("./routes/Join.tsx"));
const Wait = lazy(() => import("./routes/Wait.tsx"));
const TableRoute = lazy(() => import("./routes/Table.tsx"));
const Closed = lazy(() => import("./routes/Closed.tsx"));
const Setup = lazy(() => import("./routes/Setup.tsx"));
const Admin = lazy(() => import("./admin/AdminApp.tsx"));

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
            <Route path="*" element={<Root />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
      <Toaster />
    </BrowserRouter>
  );
}
