import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";

import { AppLayout } from "@/layouts/AppLayout";
import { navigation } from "@/navigation";
import { ProjectPicker } from "@/pages/ProjectPicker";
import { ProjectRoute } from "@/pages/ProjectRoute";
import { ThemeEffect } from "@/settings/theme-settings";
import { Toaster } from "@/components/ui/toast";

const router = createBrowserRouter([
  { path: "/", Component: ProjectPicker },
  {
    path: "/p/:project",
    Component: ProjectRoute,
    children: [
      {
        Component: AppLayout,
        children: navigation.map(({ href, Page }) => ({
          index: href === "",
          path: href || undefined,
          Component: Page,
        })),
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);

export function App() {
  return (
    <>
      <ThemeEffect />
      <RouterProvider router={router} />
      <Toaster timeout={2500} />
    </>
  );
}
