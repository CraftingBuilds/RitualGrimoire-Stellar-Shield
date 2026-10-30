const starField = [];
const runeSymbols = ["✦", "✧", "◈", "◎", "✺", "✹"];

function makeStars(count) {
  const data = [];
  for (let i = 0; i < count; i += 1) {
    data.push({
      x: Math.random(),
      y: Math.random(),
      r: Math.random() * 2.4 + 0.4,
      a: Math.random() * 0.8 + 0.2,
      drift: Math.random() * 0.8 + 0.2,
    });
  }
  return data;
}

export async function runApp({ canvas }) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context is not available.");

  let width = 0;
  let height = 0;
  let dpr = 1;
  const stars = makeStars(180);

  function resizeCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  window.addEventListener("resize", resizeCanvas, { passive: true });
  resizeCanvas();

  let audioCtx = null;
  let osc = null;
  let gainNode = null;
  let audioStarted = false;

  function ensureAudio() {
    if (audioStarted) return;
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;

    audioCtx = new AudioCtor();
    osc = audioCtx.createOscillator();
    gainNode = audioCtx.createGain();

    osc.type = "sine";
    osc.frequency.value = 220;
    gainNode.gain.value = 0.0005;

    osc.connect(gainNode).connect(audioCtx.destination);
    osc.start();
    audioStarted = true;

    const t = audioCtx.currentTime;
    osc.frequency.linearRampToValueAtTime(174.61, t + 0.8);
    gainNode.gain.exponentialRampToValueAtTime(0.04, t + 0.7);
  }

  window.addEventListener("pointerdown", ensureAudio, { once: true });
  window.addEventListener("keydown", ensureAudio, { once: true });

  function drawBackground(t, cx, cy) {
    const bg = ctx.createRadialGradient(cx, cy, 40, cx, cy, Math.max(width, height) * 0.8);
    bg.addColorStop(0, "rgba(19, 35, 64, 0.96)");
    bg.addColorStop(0.45, "rgba(6, 13, 30, 0.97)");
    bg.addColorStop(1, "rgba(2, 4, 12, 1)");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    for (const star of stars) {
      const x = star.x * width;
      const y = (star.y * height + t * 10 * star.drift) % (height + 20);
      const alpha = star.a + Math.sin(t * 2 + star.x * 10) * 0.15;
      ctx.beginPath();
      ctx.fillStyle = `rgba(196, 220, 255, ${alpha})`;
      ctx.arc(x, y, star.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawRuneRing(t, cx, cy, radius) {
    const count = 16;
    const angleStep = (Math.PI * 2) / count;

    for (let i = 0; i < count; i += 1) {
      const angle = t * 0.35 + i * angleStep;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      const symbol = runeSymbols[i % runeSymbols.length];

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle + Math.PI / 2);
      ctx.font = `${18 + ((i % 3) * 2)}px Georgia, serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = i % 2 === 0 ? "rgba(164, 220, 255, 0.9)" : "rgba(123, 199, 255, 0.75)";
      ctx.fillText(symbol, 0, 0);
      ctx.restore();
    }
  }

  function drawShield(t, cx, cy) {
    const pulse = 1 + Math.sin(t * 2.3) * 0.08;
    const outerRadius = Math.min(width, height) * 0.22 * pulse;
    const innerRadius = outerRadius * 0.72;

    ctx.save();
    ctx.translate(cx, cy);

    for (let ring = 0; ring < 6; ring += 1) {
      const radius = outerRadius * (0.45 + ring * 0.18);
      ctx.beginPath();
      ctx.strokeStyle = `rgba(166, 221, 255, ${0.18 + ring * 0.12})`;
      ctx.lineWidth = 1.2 + ring * 0.5;
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(154, 216, 255, 0.92)";
    ctx.shadowBlur = 30;
    ctx.shadowColor = "rgba(116, 193, 255, 0.8)";
    ctx.arc(0, 0, outerRadius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.fillStyle = "rgba(76, 121, 188, 0.12)";
    ctx.arc(0, 0, outerRadius * 0.9, 0, Math.PI * 2);
    ctx.fill();

    const hexPoints = 6;
    ctx.beginPath();
    for (let i = 0; i <= hexPoints; i += 1) {
      const angle = (i / hexPoints) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(angle) * innerRadius;
      const y = Math.sin(angle) * innerRadius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = "rgba(182, 230, 255, 0.7)";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    for (let i = 0; i < 36; i += 1) {
      const angle = (i / 36) * Math.PI * 2 + t * 0.8;
      const x = Math.cos(angle) * (innerRadius + 12);
      const y = Math.sin(angle) * (innerRadius + 12);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(118, 184, 255, 0.35)";
    ctx.stroke();

    ctx.beginPath();
    ctx.fillStyle = "rgba(131, 204, 255, 0.12)";
    ctx.arc(0, 0, innerRadius * 0.46, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;

    ctx.beginPath();
    ctx.strokeStyle = "rgba(170, 228, 255, 0.9)";
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 3; i += 1) {
      const offset = (Math.PI * 2 * i) / 3 + t * 0.6;
      ctx.moveTo(
        Math.cos(offset) * (outerRadius * 0.2),
        Math.sin(offset) * (outerRadius * 0.2)
      );
      ctx.lineTo(
        Math.cos(offset) * (outerRadius * 0.9),
        Math.sin(offset) * (outerRadius * 0.9)
      );
    }
    ctx.stroke();

    ctx.restore();
  }

  function drawAura(t, cx, cy) {
    ctx.save();
    for (let i = 0; i < 5; i += 1) {
      const radius = Math.min(width, height) * (0.18 + i * 0.08) + Math.sin(t * 1.2 + i) * 12;
      ctx.beginPath();
      ctx.strokeStyle = `rgba(154, 208, 255, ${0.08 + i * 0.05})`;
      ctx.lineWidth = 1.5;
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawText(t) {
    const cx = width / 2;
    const cy = height / 2 + 110;

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = '600 26px "Segoe UI", sans-serif';
    ctx.fillStyle = "rgba(231, 241, 255, 0.95)";
    ctx.fillText("Stellar Shield", cx, cy);

    ctx.font = '500 12px "Segoe UI", sans-serif';
    ctx.fillStyle = "rgba(160, 220, 255, 0.8)";
    ctx.fillText("PROTECTION • ALIGNMENT • RITUAL", cx, cy + 32);

    const pulse = 0.5 + (Math.sin(t * 3.2) + 1) * 0.25;
    ctx.strokeStyle = `rgba(175, 232, 255, ${0.5 + pulse * 0.2})`;
    ctx.beginPath();
    ctx.moveTo(cx - 110, cy + 58);
    ctx.lineTo(cx + 110, cy + 58);
    ctx.stroke();
    ctx.restore();
  }

  function renderFrame(t) {
    const cx = width / 2;
    const cy = height / 2;

    drawBackground(t, cx, cy);
    drawAura(t, cx, cy);
    drawRuneRing(t, cx, cy, Math.min(width, height) * 0.30);
    drawShield(t, cx, cy);
    drawText(t);

    if (osc && gainNode && audioCtx) {
      const now = audioCtx.currentTime;
      const base = 220 + Math.sin(t * 1.4) * 18;
      osc.frequency.setTargetAtTime(base, now, 0.25);
      const g = 0.015 + (Math.sin(t * 3.5) + 1) * 0.015;
      gainNode.gain.setTargetAtTime(g, now, 0.2);
    }
  }

  function tick(now) {
    const t = now * 0.001;
    renderFrame(t);
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

window.addEventListener("error", (event) => {
  console.error("Shield runtime error:", event.error || event.message);
});
