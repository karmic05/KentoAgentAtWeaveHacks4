"use client";

import { useEffect, useRef } from "react";

const SEEN_KEY = "kento:intro-seen";

/**
 * First-visit explainer. A native <dialog> gives focus trapping, Escape to
 * close and an inert page for free; CSS handles the enter/exit motion.
 */
export function IntroDialog({ openSignal }: { openSignal: number }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let seen = false;
    try {
      seen = localStorage.getItem(SEEN_KEY) === "1";
    } catch {}
    if (!seen || openSignal > 0) ref.current?.showModal();
  }, [openSignal]);

  function close() {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {}
    ref.current?.close();
  }

  return (
    <dialog
      ref={ref}
      className="intro m-auto w-[min(92vw,30rem)] rounded-2xl border border-line-strong bg-panel p-0 text-text shadow-[0_24px_80px_rgba(0,0,0,0.6)]"
      onClick={(event) => {
        if (event.target === ref.current) close();
      }}
      onClose={close}
      aria-labelledby="intro-title"
    >
      <div className="p-6">
        <h2 id="intro-title" className="label">
          Kento · rescue hive
        </h2>
        <div className="mt-3 space-y-2 text-[15px] leading-relaxed text-text/85">
          <p>Autonomous rescue agents search a collapsed city block for survivors whose health is draining.</p>
          <p>They triage by urgency, re-plan around falling rubble, and pair up to dig out anyone trapped.</p>
          <p>Press Autopilot to watch, or give orders in the chat, like “assign B to S-03”.</p>
        </div>
        <div className="mt-6 flex justify-end">
          <button type="button" className="btn btn-primary" onClick={close} autoFocus>
            Start the mission
          </button>
        </div>
      </div>
    </dialog>
  );
}
