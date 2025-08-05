// ... keep your imports at top ...
import { mapRange, normLuminance, DangerDetector, clamp, clamp01, Easing } from "../shared/mapping.js";

export async function runApp({ sensors, mappings, pools, canvas }) {
  const ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Audio: fixed 741 Hz generator with slow LFO amplitude
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ac.createOscillator(); osc.type = 'sine'; osc.frequency.value = 741;
  const lfo = ac.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.65;
  const lfoGain = ac.createGain(); lfoGain.gain.value = 0.08;
  const amp = ac.createGain(); amp.gain.value = 0.70;
  lfo.connect(lfoGain).connect(amp.gain);
  osc.connect(amp).connect(ac.destination);
  amp.gain.setValueAtTime(0.0001, ac.currentTime);
  amp.gain.exponentialRampToValueAtTime(0.70, ac.currentTime + 0.25); // ⚡ Faster fade-in
  lfo.start(); osc.start();
  await ac.resume().then(() => console.log("✅ AudioContext resumed"));

  const dd = new DangerDetector(
    mappings.danger.thresholds,
    mappings.danger.require_any,
    mappings.danger.sustain_ms,
    mappings.danger.cooldown_ms
  );

  let shapeList = [...pools.neutral];
  let shapeBiasUntil = 0;
  let rotDegPerSec = 10;
  let bubbleBaseVmin = 18;
  let bubbleMaxVmin = 36;
  let absorbLevel = 0;
  let bubbleAddVmin = 0;
  let lastLumi = null; let lumiDropRate = 0;
  let rafId = 0; let running = true;

  window.addEventListener('shield:end', () => { running = false; });
  loop(); // 🔥 Start loop immediately

  async function loop() {
    console.log("[loop] Frame running");

    if (!running) return stopAll();

    const s = sensors.sample?.();
    if (!s || !s.mic || !s.light || !Number.isFinite(s.mic.rms)) {
      console.warn("⚠️ Sensor data not ready or invalid", s);
      drawLoading(ctx, canvas); // soft feedback
      rafId = requestAnimationFrame(loop);
      return;
    }

    const yNorm = normLuminance(s.light.luminance, s.cal.lightDarkRef, s.cal.lightBrightRef);
    if (lastLumi != null) {
      const dl = (yNorm - lastLumi);
      lumiDropRate = Math.max(0, -dl / Math.max(1e-3, s.dt));
      lumiDropRate = Math.min(1, lumiDropRate);
    }
    lastLumi = yNorm;

    const brightness = clamp(
      mapRange(yNorm, 0, 1, mappings.brightness.out_min, mappings.brightness.out_max, mappings.brightness.curve),
      mappings.safety.min_brightness, mappings.safety.max_brightness
    );
    const bloom = mapRange(yNorm, 0, 1, mappings.bloom.out_min, mappings.bloom.out_max, mappings.bloom.curve);
    const scale = clamp(mapRange(s.mic.rms, 0.01, 0.2, mappings.scale_from_rms.out_min, mappings.scale_from_rms.out_max, mappings.scale_from_rms.curve), 0.1, 5);
    const rotBase = mapRange(s.mic.rms, 0.01, 0.2, mappings.rotation_from_rms.out_min, mappings.rotation_from_rms.out_max, mappings.rotation_from_rms.curve);
    const absorbTarget = clamp01(mapRange(s.mic.spectralFlux, 0.002, 0.02, mappings.absorb_from_flux.out_min, mappings.absorb_from_flux.out_max, 'linear'));
    absorbLevel = lerpWithDecay(absorbLevel, absorbTarget, mappings.absorb_from_flux.decay_ms, s.dt);
    const bubbleTarget = clamp(mapRange(s.mic.spectralFlux, 0.002, 0.02, mappings.bubble_from_peak.out_min, mappings.bubble_from_peak.out_max, 'linear'), 0, mappings.bubble_from_peak.out_max);
    bubbleAddVmin = lerpWithDecay(bubbleAddVmin, bubbleTarget, mappings.bubble_from_peak.decay_ms, s.dt);

    const ddRes = dd.tick({
      rmsDb: s.mic.rmsDb,
      spectralFlux: s.mic.spectralFlux,
      highBandRatio: s.mic.highBandRatio,
      lumiDropRate: lumiDropRate,
      motion: s.light.motion
    }, s.dt);

    if (ddRes.triggered) {
      shapeBiasUntil = performance.now() + mappings.danger.response.bias_duration_ms;
      shapeList = weightedCycle(pools, mappings.danger.response.shape_weights);
    }
    if (performance.now() > shapeBiasUntil) {
      shapeList = weightedCycle(pools, { neutral: 0.70, calming: 0.10, strengthening: 0.20 });
    }

    rotDegPerSec = rotBase + (dd.active && mappings.danger.response.rotation_boost === 'modest' ? 2.0 : 0.0);

    let brightnessAdj = brightness;
    if (dd.active) {
      const bs = mappings.danger.response.brightness_strategy;
      if (bs === 'stealth') brightnessAdj = Math.max(mappings.safety.min_brightness, brightness - 0.05);
      else if (bs === 'deter') brightnessAdj = Math.min(mappings.safety.max_brightness, brightness + 0.05);
    }

    drawScene(ctx, canvas, {
      brightness: brightnessAdj, bloom,
      scale: Number.isFinite(scale) ? scale : 1.0,
      absorbLevel,
      bubbleVmin: bubbleBaseVmin + bubbleAddVmin,
      shapeList, rotDegPerSec,
      boundaryGain: dd.active ? mappings.danger.response.boundary.edge_gain : 1.0,
      meshGain: dd.active ? mappings.danger.response.boundary.mesh_gain : 1.0
    });

    rafId = requestAnimationFrame(loop);
  }

  async function stopAll() {
    ampFade(0.0001, 0.75).then(() => {
      try { osc.stop(); lfo.stop(); ac.close(); } catch (e) {}
    });
    cancelAnimationFrame(rafId);
    try {
      if (sensors?.video?.srcObject) sensors.video.srcObject.getTracks().forEach(t => t.stop());
      if (sensors?.micSource?.mediaStream) sensors.micSource.mediaStream.getTracks().forEach(t => t.stop());
      if (sensors?.ac?.state !== 'closed') await sensors.ac.close();
    } catch (e) {}
    setTimeout(() => location.reload(), 300);
  }

  function ampFade(target, seconds) {
    return new Promise(res => {
      const now = ac.currentTime;
      if (amp?.gain) {
        amp.gain.exponentialRampToValueAtTime(Math.max(0.0001, target), now + seconds);
        setTimeout(res, seconds * 1000);
      } else res();
    });
  }

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function lerpWithDecay(curr, target, decayMs, dt) {
    const a = Math.exp(-dt / (decayMs / 1000));
    return a * curr + (1 - a) * target;
  }
}

// Optional loading animation while waiting for sensors
function drawLoading(ctx, canvas) {
  const { width, height } = canvas;
  const cx = width / 2, cy = height / 2;
  ctx.clearRect(0, 0, width, height);
  ctx.beginPath();
  ctx.arc(cx, cy, 25 + 5 * Math.sin(Date.now() / 300), 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(200,200,255,0.2)';
  ctx.lineWidth = 3;
  ctx.stroke();
}

// Global JS error catcher
window.onerror = function (msg, url, line, col, err) {
  console.error("🔥 JS Error:", msg, "at", line + ":" + col);
  if (err?.stack) console.error(err.stack);
};