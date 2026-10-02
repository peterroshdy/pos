import type { LucideIcon } from "lucide-react";

export function EmptyState({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description?: string }) {
  return <div className="empty-state"><span><Icon size={26} /></span><strong>{title}</strong>{description && <p>{description}</p>}</div>;
}
