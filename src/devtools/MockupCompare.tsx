// Dev-only fidelity check: lays the approved mockup over the live app at the
// reference viewport. ⌥M cycles off → mockup → 50% onion skin → difference
// (black wherever the live app matches the mockup exactly).
import { useEffect, useState } from "react";
import mockupUrl from "../../docs/mockups/2026-09-16/04-environment-rnd.png";
import "./mockupCompare.css";

const MODES = ["off", "mockup", "onion", "difference"] as const;
type CompareMode = (typeof MODES)[number];

const LABELS: Record<CompareMode, string> = {
  off: "",
  mockup: "Mockup 04",
  onion: "Mockup 04 · 50%",
  difference: "Difference · black = identical",
};

interface Props {
  onActiveChange: (active: boolean) => void;
}

export default function MockupCompare({ onActiveChange }: Props) {
  const [mode, setMode] = useState<CompareMode>("off");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.code !== "KeyM") return;
      e.preventDefault();
      setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    onActiveChange(mode !== "off");
  }, [mode, onActiveChange]);

  if (mode === "off") return null;
  return (
    <>
      <img className={`mockup-compare mockup-compare-${mode}`} src={mockupUrl} alt="" aria-hidden />
      <div className="mockup-compare-chip">⌥M · {LABELS[mode]}</div>
    </>
  );
}
