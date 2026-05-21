"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/",             label: "Dashboard"      },
  { href: "/architecture", label: "Architecture"   },
  { href: "/trace",        label: "Trace"          },
  { href: "/fraud",        label: "Fraud rules"    },
  { href: "/kafka",        label: "Kafka"          },
  { href: "/demo",         label: "Insert & trace" },
];

export function NavBar() {
  const path = usePathname();
  return (
    <nav className="border-b border-bg-ring/60 bg-[#0c1220]/80 backdrop-blur sticky top-0 z-20">
      <div className="max-w-[1400px] mx-auto px-5 lg:px-8 flex items-center gap-1 h-12">
        <Link href="/" className="font-semibold tracking-tight text-accent mr-4">
          FinWatch
        </Link>
        {LINKS.map((l) => {
          const active = path === l.href || (l.href !== "/" && path?.startsWith(l.href));
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`px-3 py-1.5 rounded-md text-sm transition ${
                active
                  ? "text-accent bg-accent/10"
                  : "text-gray-300 hover:text-gray-100 hover:bg-bg-ring/40"
              }`}
            >
              {l.label}
            </Link>
          );
        })}
        <div className="ml-auto flex items-center gap-2 text-xs text-gray-500">
          <span className="inline-block w-2 h-2 rounded-full bg-accent-ok animate-pulseDot" />
          live
        </div>
      </div>
    </nav>
  );
}
