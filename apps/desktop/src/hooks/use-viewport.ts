/**
 * Terminus Desktop — viewport-size hook.
 *
 * Per SPEC §6 progressive collapse breakpoints:
 *   < 1100px → narrow sidebar
 *   < 900px  → inspector becomes overlay
 *   < 700px  → sidebar becomes rail
 *
 * The hook debounces resize events to avoid layout thrash.
 */
import { useEffect, useState } from "react";

export interface ViewportBreakpoints {
  width: number;
  height: number;
  narrowSidebar: boolean;
  inspectorOverlay: boolean;
  sidebarRail: boolean;
}

function compute(width: number, height: number): ViewportBreakpoints {
  return {
    width,
    height,
    narrowSidebar: width < 1100,
    inspectorOverlay: width < 900,
    sidebarRail: width < 700,
  };
}

export function useViewport(): ViewportBreakpoints {
  const [vp, setVp] = useState<ViewportBreakpoints>(() =>
    compute(typeof window === "undefined" ? 1280 : window.innerWidth, typeof window === "undefined" ? 800 : window.innerHeight),
  );

  useEffect(() => {
    let raf = 0;
    const onResize = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setVp(compute(window.innerWidth, window.innerHeight));
      });
    };
    window.addEventListener("resize", onResize, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return vp;
}
