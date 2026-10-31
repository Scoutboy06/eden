import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";

import { AppLayout } from "@/layout/AppLayout";
import { navigation } from "@/navigation";
import { ThemeEffect } from "@/settings/theme-settings";

const router = createBrowserRouter([
  {
    Component: AppLayout,
    children: [
      ...navigation.map(({ href, Page }) => ({ path: href, Component: Page })),
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);

export function App() {
  return (
    <>
      <ThemeEffect />
      <RouterProvider router={router} />
    </>
  );
}
