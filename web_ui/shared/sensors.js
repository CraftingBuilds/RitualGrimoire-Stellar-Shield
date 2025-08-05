// web_ui/shared/sensors.js
// Mic FFT/RMS + Camera luminance & motion, with simple smoothing + calibration.

export class Sensors {
  constructor(opts = {}) {
    this.opts = Object.assign({
      mic: { fftSize: 2048, smoothingMs: 120, highBandSplitHz: 2000, silenceFloorDb: -55 },
      cam: { width: 160, height: 120, fps: 24, smoothingMs: 250, exposureLock: true },
      calibrationMs: 12000 // ~12s (mic floor + light bounds + motion baseline)
    }, opts);

    // Mic/Aud
    this.ac = null;
    this.analyser = null;
    this.micSource = null;
    this.fftBins = null;
    this.sampleRate = 48000;

    // Cam/Video
    this.video = document.createElement('video');
    this.video.setAttribute('playsinline', ''); // iOS
    this.video.muted = true;
    this.vw = this.opts.cam.width; this.vh = this.opts.cam.height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.vw; this.canvas.height = this.vh;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prevFrame = null;

    // Calibration & state
    this.ready = false;
    this.cal = {
      micSilenceDb: this.opts.mic.silenceFloorDb,
      lightDarkRef: null, lightBrightRef: null,
      motionBase: 0
    };

    // Smoothed values
    this._ema = {
      micRms: 0, luminance: 0, motion: 0, highBandRatio: 0, spectralFlux: 0
    };
    this._lastSpectrum = null;
    this._lastFrameTime = 0;
  }

  async start({ useMic = true, useCamera = true } = {}) {
    const jobs = [];
    if (useMic) jobs.push(this._initMic());
    if (useCamera) jobs.push(this._initCamera());
    await Promise.all(jobs);
  }

  async calibrate(onStepMsg = () => {}) {
    // Simple guided calibration: quiet baseline, cover/expose camera, small motion baseline.
    const t0 = performance.now();
    onStepMsg('Calibrating… 5s quiet baseline (mic)');
    await this._wait(5000);

    // Estimate mic silence floor from running RMS
    const quietDb = 20 * Math.log10(this._ema.micRms + 1e-6);
    this.cal.micSilenceDb = Math.max(quietDb, this.opts.mic.silenceFloorDb);

    onStepMsg('Calibrating… cover camera (2s)');
    await this._wait(2000);
    this.cal.lightDarkRef = this._ema.luminance;

    onStepMsg('Calibrating… point to a light/window (2s)');
    await this._wait(2000);
    this.cal.lightBrightRef = this._ema.luminance;

    onStepMsg('Stabilizing…');
    await this._wait(3000);
    this.cal.motionBase = this._ema.motion * 0.7; // conservative

    this.ready = true;
    onStepMsg('Calibration complete.');
  }

  // ---- Public sample each frame ------------------------------------------------
  sample() {
    const now = performance.now();
    const dt = (now - this._lastFrameTime) / 1000;
    this._lastFrameTime = now;

    // Camera sample
    let luminance = this._ema.luminance;
    let motion = this._ema.motion;
    if (this.video.readyState >= 2) {
      this.ctx.drawImage(this.video, 0, 0, this.vw, this.vh);
      const img = this.ctx.getImageData(0, 0, this.vw, this.vh).data;

      // Luminance average (Rec.601)
      let ySum = 0;
      for (let i = 0; i < img.length; i += 4) {
        const r = img[i], g = img[i+1], b = img[i+2];
        const y = 0.299*r + 0.587*g + 0.114*b;
        ySum += y;
      }
      const yAvg = ySum / (img.length / 4) / 255; // 0..1
      luminance = this._emaUpdate('luminance', yAvg, this.opts.cam.smoothingMs);

      // Motion = mean absolute difference vs previous frame
      if (this.prevFrame) {
        let diffSum = 0, count = 0;
        for (let i = 0; i < img.length; i += 4) {
          const d = Math.abs(img[i] - this.prevFrame[i]) +
                    Math.abs(img[i+1] - this.prevFrame[i+1]) +
                    Math.abs(img[i+2] - this.prevFrame[i+2]);
          diffSum += d; count++;
        }
        const motionRaw = (diffSum / (count * 255 * 3));
        motion = this._emaUpdate('motion', motionRaw, this.opts.cam.smoothingMs);
      }
      this.prevFrame = img.slice(0); // copy
    }

    // Mic sample (RMS, FFT bands, spectral flux)
    let micRms = this._ema.micRms, spectralFlux = this._ema.spectralFlux, highBandRatio = this._ema.highBandRatio;
    if (this.analyser && this.fftBins) {
      this.analyser.getFloatFrequencyData(this.fftBins);
      const mag = this.fftBins;
      const rms = this._spectrumRms(mag);
      micRms = this._emaUpdate('micRms', rms, this.opts.mic.smoothingMs);

      const bands = this._bandEnergies(mag);
      highBandRatio = this._emaUpdate('highBandRatio', bands.high / Math.max(1e-6, (bands.low+bands.mid+bands.high)), this.opts.mic.smoothingMs);

      // Spectral flux (how much the spectrum changed)
      if (this._lastSpectrum) {
        let flux = 0;
        for (let i = 0; i < mag.length; i++) {
          const prev = this._lastSpectrum[i];
          const d = (mag[i] - prev);
          if (d > 0) flux += d;
        }
        spectralFlux = this._emaUpdate('spectralFlux', flux / mag.length, this.opts.mic.smoothingMs);
      }
      this._lastSpectrum = Float32Array.from(mag);
    }

    return {
      mic: {
        rms: micRms, // linear
        rmsDb: 20 * Math.log10(micRms + 1e-6),
        highBandRatio,
        spectralFlux
      },
      light: {
        luminance, // 0..1
        luminanceDropRate: 0, // computed in app mapping if needed
        motion
      },
      cal: this.cal,
      ready: this.ready,
      dt
    };
  }

  // ---- Internals ---------------------------------------------------------------

  async _initMic() {
    this.ac = new (window.AudioContext || window.webkitAudioContext)();
    this.sampleRate = this.ac.sampleRate;
    const stream = await navigator.mediaDevices.getUserMedia({
  audio: true,
  video: { facingMode: "user" } // 👈 this forces front camera
});
    this.analyser = this.ac.createAnalyser();
    this.analyser.fftSize = this.opts.mic.fftSize;
    this.analyser.minDecibels = -120;
    this.analyser.maxDecibels = -20;
    this.analyser.smoothingTimeConstant = 0; // we do our own smoothing
    this.micSource.connect(this.analyser);
    this.fftBins = new Float32Array(this.analyser.frequencyBinCount);
  }

  async _initCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
  audio: true,
  video: { facingMode: "user" } // 👈 this forces front camera
});
    this.video.srcObject = stream;
    await this.video.play();
  }

  _bandEnergies(mag) {
    // mag in dB; convert to linear power
    const len = mag.length;
    const binHz = this.sampleRate / (this.analyser.fftSize);
    let low = 0, mid = 0, high = 0;

    for (let i = 0; i < len; i++) {
      const f = i * binHz;
      const p = Math.pow(10, mag[i] / 20); // linear
      if (f < 250) low += p;
      else if (f < this.opts.mic.highBandSplitHz) mid += p;
      else high += p;
    }
    return { low, mid, high };
  }

  _spectrumRms(mag) {
    let sum = 0;
    for (let i = 0; i < mag.length; i++) {
      const v = Math.pow(10, mag[i] / 20);
      sum += v*v;
    }
    return Math.sqrt(sum / mag.length);
  }

  _emaUpdate(key, val, smoothingMs) {
    const a = Math.exp(-16.7 / Math.max(1, smoothingMs)); // frame-approx invariant EMA
    this._ema[key] = a * this._ema[key] + (1 - a) * val;
    return this._ema[key];
  }

  _wait(ms) { return new Promise(r => setTimeout(r, ms)); }
}