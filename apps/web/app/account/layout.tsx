import type { Metadata } from "next";
export const metadata: Metadata = { title: "xRay-zoo · 用户中心" };
export default function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
