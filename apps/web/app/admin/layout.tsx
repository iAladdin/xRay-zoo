import type { Metadata } from "next";
export const metadata: Metadata = { title: "xRay-zoo · 管理员后台" };
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
