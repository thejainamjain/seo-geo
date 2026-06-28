import { redirect } from 'next/navigation';

export default function ProjectRoot({ params }: { params: { projectId: string } }) {
  redirect(`/projects/${params.projectId}/overview`);
}
