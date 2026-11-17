import type { ReactNode } from "react";
import "./style.css";
export const metadata = {
  title: "xRay-zoo · 全球网络",
  description: "选择套餐，连接世界。",
};
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
