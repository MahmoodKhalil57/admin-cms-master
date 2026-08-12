import { createFileRoute } from "@tanstack/react-router";
import { tanStackRouterProvider } from "ra-router-tanstack";
import { Admin } from "@/components/admin";

export const Route = createFileRoute("/")({ component: App });

export function App() {
  return <Admin routerProvider={tanStackRouterProvider}></Admin>;
}