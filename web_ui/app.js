// web_ui/stellar-shield/app.js
import { mapRange, normLuminance, DangerDetector, clamp, clamp01, Easing } from "../shared/mapping.js";

export async function runApp({ sensors, mappings, pools, canvas, ac }) {
  const ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Audio: fixed 741 Hz generator with slow LFO amplitude
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ac.createOscillator(); osc.type = 'sine'; osc.frequency.value = 741;
  const lfo = ac.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.65;
  const lfoGain = ac.createGain(); lfoGain.gain.value = 0.08; // depth
  const amp = ac.createGain(); amp.gain.value = 0.70; // base volume
  lfo.connect(lfoGain).connect(amp.gain);
  osc.connect(amp).connect(ac.destination);
  // Fade in
  amp.gain.setValueAtTime(0.0001, ac.currentTime);
  amp.gain.exponentialRampToValueAtTime(0.70, ac.currentTime + 2.0);
  lfo.start(); osc.start();

  // Danger detector
  const dd = new DangerDetector(
    mappings.danger.thresholds,
    mappings.danger.require_any,
    mappings.danger.sustain_ms,
    mappings.danger.cooldown_ms
  );

  // Shape rotation state
  let shapeList = [...pools.neutral];
  let shapeBiasUntil = 0;
  let rotDegPerSec = 10; // base; will be modulated
  let bubbleBaseVmin = 18;
  let bubbleMaxVmin = 36;
  let absorbLevel = 0; // 0..1
  let bubbleAddVmin = 0; // expansion on peaks
  let lastLumi = null; let lumiDropRate = 0;

  // Render loop
  let rafId = 0; let running = true;
  window.addEventListener('shield:end', () => { running = false; });
  
  loop();

  async function loop() {
    if (!running) return stopAll();
    // ... your loop body ...
    }
    
    async function stopAll() {
     // Fade out audio
     ampFade(0.0001, 2.0).then(() => { try { osc.stop(); lfo.stop(); ac.close(); } catch(e){} });
     cancelAnimationFrame(rafId);
+    // stop sensors (camera + mic tracks)
+    try {
+      if (sensors && sensors.video && sensors.video.srcObject) {
+        sensors.video.srcObject.getTracks().forEach(t => t.stop());
+      }
+      if (sensors && sensors.micSource && sensors.micSource.mediaStream) {
+        sensors.micSource.mediaStream.getTracks().forEach(t => t.stop());
+      }
+      if (sensors.ac && sensors.ac.state !== 'closed') await sensors.ac.close();
+    } catch(e){}
     // reset UI
     setTimeout(() => location.reload(), 300);
   }

   function ampFade(target, seconds) {
     return new Promise(res => ￼{￼
    const s = sensors.sample();

    // Compute luminance normalization & drop rate
    const yNorm = normLuminance(s.light.luminance, s.cal.lightDarkRef, s.cal.lightBrightRef);
    if (lastLumi != null) {
      const dl = (yNorm - lastLumi); // per frame
      // approx per second (clamp range)
      lumiDropRate = Math.max(0, -dl / Math.max(1e-3, s.dt));
      lumiDropRate = Math.min(1, lumiDropRate);
    }
    lastLumi = yNorm;

    // Map brightness/bloom
    const brightness = clamp(
      mapRange(yNorm, 0, 1, mappings.brightness.out_min, mappings.brightness.out_max, mappings.brightness.curve),
      mappings.safety.min_brightness, mappings.safety.max_brightness
    );
    const bloom = mapRange(yNorm, 0, 1, mappings.bloom.out_min, mappings.bloom.out_max, mappings.bloom.curve);

    // Map mic to scale/rotation
    const scale = mapRange(s.mic.rms, 0.01, 0.2, mappings.scale_from_rms.out_min, mappings.scale_from_rms.out_max, mappings.scale_from_rms.curve);
    const rotBase = mapRange(s.mic.rms, 0.01, 0.2, mappings.rotation_from_rms.out_min, mappings.rotation_from_rms.out_max, mappings.rotation_from_rms.curve);

    // Spectral flux→ absorb & bubble expansion (decayed)
    const absorbTarget = clamp01(mapRange(s.mic.spectralFlux, 0.002, 0.02, mappings.absorb_from_flux.out_min, mappings.absorb_from_flux.out_max, 'linear'));
    absorbLevel = lerpWithDecay(absorbLevel, absorbTarget, mappings.absorb_from_flux.decay_ms, s.dt);
    const bubbleTarget = clamp(mapRange(s.mic.spectralFlux, 0.002, 0.02, mappings.bubble_from_peak.out_min, mappings.bubble_from_peak.out_max, 'linear'), 0, mappings.bubble_from_peak.out_max);
    bubbleAddVmin = lerpWithDecay(bubbleAddVmin, bubbleTarget, mappings.bubble_from_peak.decay_ms, s.dt);

    // Danger fusion
    const ddRes = dd.tick({
      rmsDb: s.mic.rmsDb,
      spectralFlux: s.mic.spectralFlux,
      highBandRatio: s.mic.highBandRatio,
      lumiDropRate: lumiDropRate,
      motion: s.light.motion
    }, s.dt);

    // Apply danger response (temporarily bias shapes + boundary emphasis)
    if (ddRes.triggered) {
      shapeBiasUntil = performance.now() + mappings.danger.response.bias_duration_ms;
      // reorder rotation weights: warding/containment favored
      shapeList = weightedCycle(pools, mappings.danger.response.shape_weights);
    }
    if (performance.now() > shapeBiasUntil) {
      shapeList = weightedCycle(pools, { neutral: 0.70, calming: 0.10, strengthening: 0.20 });
    }

    // Rotation boost strategy
    rotDegPerSec = rotBase + (dd.active && mappings.danger.response.rotation_boost === 'modest' ? 2.0 : 0.0);

    // Brightness strategy under danger
    let brightnessAdj = brightness;
    if (dd.active) {
      const bs = mappings.danger.response.brightness_strategy;
      if (bs === 'stealth') brightnessAdj = Math.max(mappings.safety.min_brightness, brightness - 0.05);
      else if (bs === 'deter') brightnessAdj = Math.min(mappings.safety.max_brightness, brightness + 0.05);
    }

    // Draw
    drawScene(ctx, canvas, {
      brightness: brightnessAdj, bloom, scale, absorbLevel,
      bubbleVmin: bubbleBaseVmin + bubbleAddVmin, shapeList, rotDegPerSec,
      boundaryGain: (dd.active ? mappings.danger.response.boundary.edge_gain : 1.0),
      meshGain: (dd.active ? mappings.danger.response.boundary.mesh_gain : 1.0)
    });

    rafId = requestAnimationFrame(loop);
  }

  async function stop() {
    // Fade out audio
    ampFade(0.0001, 2.5).then(() => { osc.stop(); lfo.stop(); ac.close(); });
    cancelAnimationFrame(rafId);
    // Optional: prompt for notes or log
    // For now, just reload to reset.
    setTimeout(() => location.reload(), 500);
  }

  function ampFade(target, seconds) {
    return new Promise(res => {
      const now = ac.currentTime;
      ac.destination.context; // no-op
      // Smooth exponential fade
      const g = amp;
      if (g) {
        g.gain.exponentialRampToValueAtTime(Math.max(0.0001, target), now + seconds);
        setTimeout(res, seconds * 1000);
      } else res();
    });
  }

  function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }

  function lerpWithDecay(curr, target, decayMs, dt) {
    const a = Math.exp(-dt / (decayMs / 1000));
    return a * curr + (1 - a) * target;
  }
}

// hand back a controller for direct stop
return { stop: () => { running = false; /* next frame stops */ setTimeout(stopAll, 0); } };
}

// ---------- Drawing -------------------------------------------------------------

function drawScene(ctx, canvas, p) {
  const { width:w, height:h } = canvas;
  const vmin = Math.min(w, h);

  // backdrop with brightness as gamma
  ctx.save();
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(0,0,w,h);
  ctx.globalAlpha = p.brightness;

  // Bubble glow
  const cx = w/2, cy = h/2;
  const r = (p.bubbleVmin / 100) * vmin * p.scale;
  const grad = ctx.createRadialGradient(cx, cy, r*0.2, cx, cy, r*1.15);
  grad.addColorStop(0, 'rgba(160,190,255,0.35)');
  grad.addColorStop(0.6, 'rgba(100,140,255,0.15)');
  grad.addColorStop(1, 'rgba(20,40,100,0.0)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(cx, cy, r*1.1, 0, Math.PI*2); ctx.fill();

  // Boundary edge
  ctx.lineWidth = Math.max(2, r*0.015) * p.boundaryGain;
  ctx.strokeStyle = 'rgba(190,220,255,0.85)';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.stroke();

  // Absorb ring (inner pulse on flux)
  if (p.absorbLevel > 0.01) {
    ctx.lineWidth = Math.max(1, r*0.01) * p.meshGain * (0.5 + 0.5*p.absorbLevel);
    ctx.strokeStyle = `rgba(190,240,255,${0.25 + 0.5*p.absorbLevel})`;
    ctx.beginPath(); ctx.arc(cx, cy, r*0.65, 0, Math.PI*2); ctx.stroke();
  }

  // Sacred geometry rotation
  const t = performance.now() / 1000;
  const rot = (t * p.rotDegPerSec) * Math.PI / 180;
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.scale(p.scale, p.scale);

  drawSacred(ctx, vmin, p.shapeList);

  ctx.restore();
}

let _shapeIndex = 0; let _lastShapeTime = 0;
function drawSacred(ctx, vmin, shapeList) {
  const now = performance.now();
  // rotate shape every ~8 seconds
  if (now - _lastShapeTime > 8000) { _shapeIndex = (_shapeIndex + 1) % shapeList.length; _lastShapeTime = now; }
  const name = shapeList[_shapeIndex];
  const size = (vmin * 0.18);

  ctx.save();
  ctx.strokeStyle = 'rgba(200,220,255,0.85)';
  ctx.lineWidth = Math.max(1.5, vmin*0.0035);

  switch (name) {
    case 'seed-of-life': drawSeedOfLife(ctx, size); break;
    case 'hexagram': drawHexagram(ctx, size); break;
    case 'flower-of-life': drawFlowerOfLife(ctx, size*0.9); break;
    case 'merkaba': drawMerkaba(ctx, size); break;
    case 'vesica-piscis': drawVesica(ctx, size); break;
    case 'nested-circles': drawNestedCircles(ctx, size); break;
    case 'heptagram': drawRegularStar(ctx, 7, size); break;
    case 'unicursal-hexagram': drawUnicursalHex(ctx, size); break;
    case 'cube-projection': drawCube(ctx, size); break;
    case 'pentacle': drawRegularStar(ctx, 5, size); break;
    case 'shield-knot': drawShieldKnot(ctx, size); break;
    case 'medusa-rosette': drawRosette(ctx, size); break;
    case 'metatron-cube': drawMetatron(ctx, size*0.9); break;
    case 'solomonic-seal': drawSolomonic(ctx, size); break;
    case 'saturnine-ring': drawSaturnRing(ctx, size); break;
    case 'lattice-mesh': drawLattice(ctx, size*1.2); break;
    default: drawSeedOfLife(ctx, size);
  }

  ctx.restore();
}

// --- Minimal procedural shapes (enough to start; refine later) -----------------
function drawSeedOfLife(ctx, r) {
  const circles = [
    [0,0],[r,0],[r/2, r*Math.sqrt(3)/2],[-r/2, r*Math.sqrt(3)/2],[-r,0],[-r/2,-r*Math.sqrt(3)/2],[r/2,-r*Math.sqrt(3)/2]
  ];
  circles.forEach(([x,y]) => { ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.stroke(); });
}

function drawHexagram(ctx, r) {
  regularPolygon(ctx, 3, r, 0); regularPolygon(ctx, 3, r, Math.PI);
}
function regularPolygon(ctx, n, r, rot=0) {
  ctx.beginPath();
  for (let i=0;i<n;i++) {
    const a = rot + i*(2*Math.PI/n);
    const x = r*Math.cos(a), y=r*Math.sin(a);
    if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.closePath(); ctx.stroke();
}
function drawFlowerOfLife(ctx, r){
  // simple 2-ring approximation
  drawSeedOfLife(ctx, r);
  const ring = 2*r;
  for (let k=0;k<6;k++){
    const a = k*Math.PI/3;
    ctx.beginPath(); ctx.arc(r*Math.cos(a), r*Math.sin(a), r, 0, Math.PI*2); ctx.stroke();
    ctx.beginPath(); ctx.arc(-r*Math.cos(a), -r*Math.sin(a), r, 0, Math.PI*2); ctx.stroke();
  }
}
function drawMerkaba(ctx, r){ regularPolygon(ctx, 3, r*1.1, 0); regularPolygon(ctx, 3, r*1.1, Math.PI); }
function drawVesica(ctx, r){ ctx.beginPath(); ctx.arc(-r/2,0,r,0,Math.PI*2); ctx.stroke(); ctx.beginPath(); ctx.arc(r/2,0,r,0,Math.PI*2); ctx.stroke(); }
function drawNestedCircles(ctx, r){ for(let k=1;k<=4;k++){ ctx.beginPath(); ctx.arc(0,0,(k/4)*r*1.5,0,Math.PI*2); ctx.stroke(); } }
function drawRegularStar(ctx, n, r){
  const step = Math.floor(n/2);
  ctx.beginPath();
  for(let i=0;i<n;i++){
    const a1 = (i*2*Math.PI/n), a2 = ((i+step)%n)*2*Math.PI/n;
    ctx.moveTo(r*Math.cos(a1), r*Math.sin(a1));
    ctx.lineTo(r*Math.cos(a2), r*Math.sin(a2));
  }
  ctx.stroke();
}
function drawUnicursalHex(ctx, r){
  // approximate path
  ctx.beginPath();
  for(let i=0;i<6;i++){
    const a = i*Math.PI/3;
    ctx.lineTo(r*Math.cos(a), r*Math.sin(a));
    ctx.lineTo(r*0.3*Math.cos(a+Math.PI/6), r*0.3*Math.sin(a+Math.PI/6));
  }
  ctx.closePath(); ctx.stroke();
}
function drawCube(ctx, r){
  const s = r*0.7;
  ctx.beginPath(); ctx.rect(-s,-s,2*s,2*s); ctx.stroke();
  ctx.beginPath(); ctx.rect(-s*0.3,-s*0.3,2*s,2*s); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-s,-s); ctx.lineTo(-s*0.3,-s*0.3);
  ctx.moveTo(s,-s); ctx.lineTo(s*1.7,-s*0.3);
  ctx.moveTo(-s,s); ctx.lineTo(-s*0.3,s*1.7);
  ctx.moveTo(s,s); ctx.lineTo(s*1.7,s*1.7);
  ctx.stroke();
}
function drawShieldKnot(ctx, r){
  for(let i=0;i<4;i++){
    ctx.beginPath();
    ctx.arc(0,0,r*(0.5+0.1*i), i*Math.PI/2, (i+2)*Math.PI/2);
    ctx.stroke();
  }
}
function drawRosette(ctx, r){
  ctx.beginPath();
  for(let k=0;k<12;k++){
    const a = k*Math.PI/6;
    ctx.moveTo(0,0);
    ctx.lineTo(r*Math.cos(a), r*Math.sin(a));
  }
  ctx.stroke();
}
function drawMetatron(ctx, r){
  // seed + lines
  drawSeedOfLife(ctx, r*0.8);
  for(let k=0;k<6;k++){
    const a = k*Math.PI/3;
    const x = r*Math.cos(a), y = r*Math.sin(a);
    ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(x,y); ctx.stroke();
  }
}
function drawSolomonic(ctx, r){ drawRegularStar(ctx, 6, r); }
function drawSaturnRing(ctx, r){
  ctx.beginPath(); ctx.ellipse(0,0,r*1.2,r*0.6,0,0,Math.PI*2); ctx.stroke();
}
function drawLattice(ctx, r){
  const step = r/5;
  for(let x=-r; x<=r; x+=step){ ctx.beginPath(); ctx.moveTo(x,-r); ctx.lineTo(x,r); ctx.stroke(); }
  for(let y=-r; y<=r; y+=step){ ctx.beginPath(); ctx.moveTo(-r,y); ctx.lineTo(r,y); ctx.stroke(); }
}
// Weighted rotation helper
function weightedCycle(pools, w) {
  const order = [];
  function pushPool(name, count) { const arr = pools[name]||[]; for(let i=0;i<count;i++) arr.forEach(s=>order.push(s)); }
  const total = Object.values(w).reduce((a,b)=>a+b,0) || 1;
  const mult = 10 / total; // scale to ~10 steps
  for (const k of Object.keys(w)) pushPool(k, Math.max(0, Math.round(w[k]*mult)));
  return order.length ? order : (pools.neutral || []);
}