import type { Metadata } from "next";
import {
  ArrowRight,
  Braces,
  ExternalLink,
  History,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Terminus",
  description: "Local coding work with durable state, governed effects, and verification evidence.",
};

interface RuntimeHealth {
  readonly control: "connected" | "unavailable";
  readonly kernel: "connected" | "degraded" | "unavailable";
  readonly events: "ready" | "unavailable";
}

const CONTROL_URL = process.env.TERMINUS_CONTROL_URL ?? "http://127.0.0.1:3050";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runtimeHealth(): Promise<RuntimeHealth> {
  try {
    const response = await fetch(`${CONTROL_URL}/v1/system/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1_200),
    });
    if (!response.ok) {
      return { control: "unavailable", kernel: "unavailable", events: "unavailable" };
    }
    const value: unknown = await response.json();
    if (!isRecord(value)) {
      return { control: "unavailable", kernel: "unavailable", events: "unavailable" };
    }
    const ready = value.ready === true;
    return {
      control: "connected",
      kernel: ready ? "connected" : "degraded",
      events: ready ? "ready" : "unavailable",
    };
  } catch {
    return { control: "unavailable", kernel: "unavailable", events: "unavailable" };
  }
}

const RECORDS = [
  { label: "Diff", icon: Braces },
  { label: "Commands", icon: SquareTerminal },
  { label: "Verification", icon: ShieldCheck },
  { label: "Recovery", icon: History },
] as const;

function statusText(status: RuntimeHealth[keyof RuntimeHealth]): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "degraded":
      return "Connected, enforcement degraded";
    case "ready":
      return "Ready to subscribe";
    case "unavailable":
      return "Unavailable until connected";
  }
}

export default async function HomePage() {
  const health = await runtimeHealth();
  const statuses = [
    { label: "Control plane", value: health.control },
    { label: "Effect kernel", value: health.kernel },
    { label: "Event stream", value: health.events },
  ] as const;

  return (
    <main className="min-h-[100dvh] bg-[#0b1018] text-[#f4f7fb] selection:bg-[#2f76ff] selection:text-white">
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-[1440px] flex-col px-5 sm:px-8 lg:px-14">
        <header className="flex h-20 items-center border-b border-white/8 sm:h-[88px]">
          <a href="/" className="text-[19px] font-semibold tracking-[-0.03em] text-white">
            Terminus
          </a>
        </header>

        <section className="grid flex-1 gap-16 py-14 md:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)] md:items-center md:py-20 lg:gap-24">
          <div className="max-w-2xl">
            <h1 className="max-w-[760px] text-[clamp(3rem,5vw,4.75rem)] font-medium leading-[1.02] tracking-[-0.055em] text-white">
              Reliable coding work, with evidence.
            </h1>
            <p className="mt-8 max-w-[590px] text-lg leading-8 text-[#9ba8ba] sm:text-xl">
              Terminus runs locally. Desktop and TUI connect to the same durable task state and recorded evidence.
            </p>
            <div className="mt-10 flex flex-col items-start gap-5 sm:flex-row sm:items-center">
              <a
                href="terminus://app/index.html"
                className="inline-flex min-h-12 items-center justify-center rounded-md bg-[#2f76ff] px-6 text-[15px] font-medium text-white transition-colors hover:bg-[#4b89ff] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#76a6ff] active:translate-y-px"
              >
                Open Desktop
              </a>
              <a
                href="https://github.com/ezzy1630/Terminus/tree/main/apps/tui"
                className="group inline-flex min-h-12 items-center gap-2 px-1 text-[15px] font-medium text-[#68a0ff] hover:text-[#91baff] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#76a6ff]"
              >
                Run the TUI
                <ArrowRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-0.5" />
              </a>
            </div>
          </div>

          <section aria-labelledby="runtime-status" className="self-stretch md:flex md:flex-col md:justify-center">
            <h2 id="runtime-status" className="font-mono text-xs font-medium uppercase tracking-[0.18em] text-[#8391a6]">
              Runtime status
            </h2>
            <dl className="mt-5 border-t border-white/14">
              {statuses.map((item) => (
                <div key={item.label} className="grid gap-2 border-b border-white/10 py-7 sm:grid-cols-[1fr_auto] sm:items-center">
                  <dt className="text-[17px] font-medium text-[#eef2f8]">{item.label}</dt>
                  <dd className="text-sm text-[#8f9db1]">{statusText(item.value)}</dd>
                </div>
              ))}
            </dl>
          </section>
        </section>

        <section aria-labelledby="records-heading" className="border-t border-white/14 py-10 sm:py-12">
          <h2 id="records-heading" className="font-mono text-xs font-medium uppercase tracking-[0.18em] text-[#8391a6]">
            What Terminus records
          </h2>
          <div className="mt-8 grid gap-x-8 gap-y-7 sm:grid-cols-2 lg:grid-cols-4">
            {RECORDS.map(({ label, icon: Icon }) => (
              <div key={label} className="flex items-center gap-4">
                <Icon aria-hidden="true" strokeWidth={1.7} className="size-5 shrink-0 text-[#4e8cff]" />
                <h3 className="text-[16px] font-medium text-[#eef2f8]">{label}</h3>
              </div>
            ))}
          </div>
        </section>

        <footer className="flex flex-col gap-5 border-t border-white/8 py-8 text-sm sm:flex-row sm:items-center">
          <nav aria-label="Project links" className="flex items-center gap-7">
            <a className="text-[#68a0ff] hover:text-[#91baff]" href={`${CONTROL_URL}/v1/system/health`}>
              Public API
            </a>
            <a className="inline-flex items-center gap-1.5 text-[#68a0ff] hover:text-[#91baff]" href="https://github.com/ezzy1630/Terminus">
              Repository
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          </nav>
        </footer>
      </div>
    </main>
  );
}
