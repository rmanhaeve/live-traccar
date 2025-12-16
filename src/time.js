let overrideBaseMs = null;
let overrideAnchorRealMs = null;
let overrideTicking = true;

export function setNowOverride(baseMs, { ticking = true } = {}) {
  if (!Number.isFinite(baseMs)) {
    overrideBaseMs = null;
    overrideAnchorRealMs = null;
    overrideTicking = true;
    return;
  }
  overrideBaseMs = baseMs;
  overrideAnchorRealMs = Date.now();
  overrideTicking = Boolean(ticking);
}

export function clearNowOverride() {
  overrideBaseMs = null;
  overrideAnchorRealMs = null;
  overrideTicking = true;
}

export function hasNowOverride() {
  return Number.isFinite(overrideBaseMs);
}

export function getTimeOverrideBaseMs() {
  return Number.isFinite(overrideBaseMs) ? overrideBaseMs : null;
}

export function getNowMs() {
  if (overrideBaseMs != null && overrideAnchorRealMs != null) {
    const delta = overrideTicking ? Date.now() - overrideAnchorRealMs : 0;
    return overrideBaseMs + delta;
  }
  return Date.now();
}

export function getNowDate() {
  return new Date(getNowMs());
}

export function setOverrideTicking(ticking) {
  const now = Date.now();
  if (overrideBaseMs == null) {
    if (!ticking) {
      overrideBaseMs = now;
      overrideAnchorRealMs = now;
    }
  } else {
    overrideAnchorRealMs = now;
  }
  overrideTicking = Boolean(ticking);
  if (ticking && overrideBaseMs == null) {
    overrideAnchorRealMs = null;
  }
}

export function getOverrideTicking() {
  if (overrideBaseMs == null) return null;
  return overrideTicking;
}
