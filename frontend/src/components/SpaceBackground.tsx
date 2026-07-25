import { useEffect, useRef } from "react";

interface Star {
  x: number;
  y: number;
  size: number;
  opacity: number;
  twinkleSpeed: number;
  twinkleOffset: number;
}

interface Planet {
  x: number;
  y: number;
  radius: number;
  color: string;
  glowColor: string;
  orbitSpeed: number;
  orbitRadius: number;
  orbitOffset: number;
  hasRing: boolean;
}

export default function SpaceBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationId: number;
    let stars: Star[] = [];
    let planets: Planet[] = [];

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      initScene();
    };

    const initScene = () => {
      const w = canvas.width;
      const h = canvas.height;

      // Generate stars
      stars = Array.from({ length: 200 }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        size: Math.random() * 1.8 + 0.3,
        opacity: Math.random() * 0.6 + 0.2,
        twinkleSpeed: Math.random() * 0.02 + 0.005,
        twinkleOffset: Math.random() * Math.PI * 2,
      }));

      // Distant planets/satellites
      planets = [
        {
          x: w * 0.85, y: h * 0.15, radius: 18,
          color: "hsl(15, 60%, 35%)", glowColor: "hsla(15, 70%, 45%, 0.15)",
          orbitSpeed: 0.0003, orbitRadius: 8, orbitOffset: 0, hasRing: true,
        },
        {
          x: w * 0.12, y: h * 0.75, radius: 10,
          color: "hsl(210, 50%, 40%)", glowColor: "hsla(210, 60%, 50%, 0.12)",
          orbitSpeed: 0.0005, orbitRadius: 5, orbitOffset: Math.PI, hasRing: false,
        },
        {
          x: w * 0.55, y: h * 0.9, radius: 6,
          color: "hsl(43, 40%, 45%)", glowColor: "hsla(43, 50%, 55%, 0.1)",
          orbitSpeed: 0.0008, orbitRadius: 3, orbitOffset: Math.PI / 2, hasRing: false,
        },
      ];
    };

    const draw = (time: number) => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.fillStyle = "hsl(240, 10%, 6%)";
      ctx.fillRect(0, 0, w, h);

      // Stars
      for (const star of stars) {
        const flicker = Math.sin(time * star.twinkleSpeed + star.twinkleOffset) * 0.3 + 0.7;
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(43, 30%, 85%, ${star.opacity * flicker})`;
        ctx.fill();
      }

      // Planets
      for (const p of planets) {
        const px = p.x + Math.sin(time * p.orbitSpeed + p.orbitOffset) * p.orbitRadius;
        const py = p.y + Math.cos(time * p.orbitSpeed + p.orbitOffset) * p.orbitRadius * 0.4;

        // Glow
        const glow = ctx.createRadialGradient(px, py, p.radius * 0.5, px, py, p.radius * 3);
        glow.addColorStop(0, p.glowColor);
        glow.addColorStop(1, "transparent");
        ctx.beginPath();
        ctx.arc(px, py, p.radius * 3, 0, Math.PI * 2);
        ctx.fillStyle = glow;
        ctx.fill();

        // Body
        ctx.beginPath();
        ctx.arc(px, py, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();

        // Ring
        if (p.hasRing) {
          ctx.beginPath();
          ctx.ellipse(px, py, p.radius * 2.2, p.radius * 0.4, -0.3, 0, Math.PI * 2);
          ctx.strokeStyle = `hsla(43, 40%, 55%, 0.25)`;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }

      animationId = requestAnimationFrame(draw);
    };

    resize();
    animationId = requestAnimationFrame(draw);
    window.addEventListener("resize", resize);

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
    />
  );
}
