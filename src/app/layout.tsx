import type { Metadata } from 'next';
import './globals.css';

// Used only for framework fallback pages; normal HTML comes from the bank server.
export const metadata: Metadata = {
  title: '题屿',
  description: '题库与浮窗检索',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
