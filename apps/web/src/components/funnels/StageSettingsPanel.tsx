"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** Keep fields mounted when closed, so switching displays never loses input. */
export function StageSettingsPanel({ open, focusRequest, canClose, onClose, children }: {
  open: boolean; focusRequest: number; canClose: boolean; onClose: () => void; children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const [closeError, setCloseError] = useState(false);
  useEffect(() => {
    if (!open || !focusRequest) return;
    const frame = requestAnimationFrame(() => {
      const heading = panel.current?.querySelector<HTMLElement>(".funnel-inspector-heading h2");
      if (panel.current) panel.current.scrollTop = 0;
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView({ block: "nearest", behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, focusRequest]);
  useEffect(() => { if (canClose) setCloseError(false); }, [canClose]);
  return <aside ref={panel} hidden={!open} className="funnel-settings-panel" aria-label="Stage settings">
    <div className="funnel-settings-top"><strong>Stage settings</strong><button type="button" className="btn btn-ghost min-h-11 normal-case" aria-label="Close stage settings" onClick={() => { if (!canClose) { setCloseError(true); return; } onClose(); }}>Close</button></div>
    {closeError && <p role="alert" className="funnel-settings-warning">Complete or remove the invalid field before closing settings. Your unfinished value is preserved.</p>}
    {children}
  </aside>;
}
