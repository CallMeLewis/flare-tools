import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

const SCALE_KEY = "uiScale";
/** The sizes offered in Settings, 1 being 100%. */
export const UI_SCALES = [0.9, 1, 1.1, 1.25, 1.5];

function storedScale(): number {
  const stored = Number(localStorage.getItem(SCALE_KEY));
  return UI_SCALES.includes(stored) ? stored : 1;
}

/** The interface zoom, saved between runs. It zooms the whole webview, so text and controls grow together. */
export function useUiScale() {
  const [scale, setScaleState] = useState(storedScale);

  useEffect(() => {
    getCurrentWebview()
      .setZoom(scale)
      .catch(() => {});
  }, [scale]);

  function setScale(next: number) {
    localStorage.setItem(SCALE_KEY, String(next));
    setScaleState(next);
  }

  return { scale, setScale };
}
