// web_ui/shared/mapping.js
// Source→target mapping helpers, clamps, easing, and danger detection fusion.

export const Easing = {
  linear: t => t,
  ease_in: t => t*t,
  ease_out: t => 1 - Math.pow(1 - t, 2),
  ease_in_out: t => (t<0.5 ? 2*t*t : 1 - Math.pow(-2*t+2, 2)/2)
};

export function mapRange(x, inMin, inMax, outMin, outMax, curve = 'linear') {
  const t = clamp01((x - inMin) / Math.max(1e-6, (inMax - inMin)));
  const e = (Easing[curve] || Easing.linear)(t);
  return outMin + (outMax - outMin) * e;
}

export function clamp01(x) { return Math.max(0, Math.min(1, x)); }
export function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

// Normalize luminance to 0..1 using calibration
export function normLuminance(y, darkRef, brightRef) {
  if (darkRef == null || brightRef == null || brightRef <= darkRef + 1e-6) return clamp01(y);
  return clamp01((y - darkRef) / (brightRef - darkRef));
}

// Danger detector: require N of M thresholds true for sustain_ms
export class DangerDetector {
  constructor(th, requireAny = 2, sustainMs = 1200, cooldownMs = 6000) {
    this.th = th;
    this.requireAny = requireAny;
    this.sustainMs = sustainMs;
    this.cooldownMs = cooldownMs;
    this._armedAt = 0;
    this._coolUntil = 0;
    this.active = false;
  }
  // returns {triggered:boolean, signals:string[]}
  tick(signals, dt) {
    const now = performance.now();
    if (now < this._coolUntil) { this.active = false; return { triggered:false, signals:[] }; }

    const hits = [];
    if (signals.rmsDb > this.th.rms_db) hits.push('rms_db');
    if (signals.spectralFlux > this.th.spectral_flux) hits.push('spectral_flux');
    if (signals.highBandRatio > this.th.high_band_ratio) hits.push('high_band_ratio');
    if (signals.lumiDropRate > this.th.luminance_drop_rate) hits.push('lumi_drop_rate');
    if (signals.motion > this.th.motion_score) hits.push('motion_score');

    if (hits.length >= this.requireAny) {
      if (!this._armedAt) this._armedAt = now;
      if ((now - this._armedAt) >= this.sustainMs) {
        this.active = true; this._coolUntil = now + this.cooldownMs; this._armedAt = 0;
        return { triggered: true, signals: hits };
      }
    } else {
      this._armedAt = 0;
    }
    this.active = false;
    return { triggered: false, signals: hits };
  }
}