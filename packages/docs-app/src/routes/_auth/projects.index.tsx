import { createFileRoute } from "@tanstack/react-router";
import { FirstProjectRedirect } from "#/components/first-project-redirect.tsx";

export const Route = createFileRoute("/_auth/projects/")({
  loader: async ({ context }) => (await context.read((api) => api.projects.list()))[0] || null,
  component: ProjectsIndex,
});

function ProjectsIndex() {
  const first = Route.useLoaderData();
  return <FirstProjectRedirect project={first} />;
}
