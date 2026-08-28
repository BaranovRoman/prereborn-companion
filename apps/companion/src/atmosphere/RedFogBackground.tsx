// WK-116 - ported from
// apps/web/src/components/pages/stream/queue/red-fog-background.tsx. The
// WK-115 pass deliberately left this WebGL2 shader out and used a
// CSS-only fallback instead, on a performance assumption - that decision
// is reversed here per an explicit follow-up task: reach real parity with
// the web atmosphere first, then apply Companion-specific safeguards on
// top (see the `visibilitychange` handling below, which the web original
// does NOT have - web's queue scene is normally the only thing on screen,
// Companion runs continuously alongside Dota + OBS, so pausing the RAF
// loop while the window is hidden/minimized is a real, additive safeguard
// here, not present upstream). Everything else (WebGL2 setup, resize,
// uniforms, shader compile/context-loss handling, reduced-motion) is
// ported near-verbatim - only the CSS Module class references
// (`styles.canvas`/`styles.canvasVisible`) are swapped for Companion's
// plain BEM-ish classNames (App.css has no CSS Modules), since this is a
// separate Vite app with nothing to import web's component from.
import { useEffect, useRef } from "react";
import {
  calculateQueueRenderSize,
  QUEUE_QUALITY_CONFIG,
  type QueueQuality,
} from "./queue-scene-config";
import { createRedFogFragmentShader, VERTEX_SHADER } from "./red-fog-shaders";

type ShaderStatus = "initializing" | "compiled" | "fallback" | "context-lost";

export interface RedFogDebugState {
  webgl2Available: boolean;
  renderWidth: number;
  renderHeight: number;
  targetFps: number;
  shaderStatus: ShaderStatus;
  reducedMotion: boolean;
}

interface RedFogBackgroundProps {
  quality: QueueQuality;
  seed: number;
  forceFallback: boolean;
  onDebugStateChange: (state: RedFogDebugState) => void;
}

const compileShader = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader => {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL2 shader allocation failed");

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "Unknown shader compile error";
    gl.deleteShader(shader);
    throw new Error(message);
  }

  return shader;
};

const createProgram = (
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string
): WebGLProgram => {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();

  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error("WebGL2 program allocation failed");
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? "Unknown shader link error";
    gl.deleteProgram(program);
    throw new Error(message);
  }

  return program;
};

export const RedFogBackground = ({ quality, seed, forceFallback, onDebugStateChange }: RedFogBackgroundProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stableSeedRef = useRef(seed);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const qualityConfig = QUEUE_QUALITY_CONFIG[quality];
    stableSeedRef.current = seed;
    const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reducedMotion = reducedMotionQuery.matches;
    let gl: WebGL2RenderingContext | null = null;
    let program: WebGLProgram | null = null;
    let vertexArray: WebGLVertexArrayObject | null = null;
    let uniforms: {
      time: WebGLUniformLocation | null;
      resolution: WebGLUniformLocation | null;
      quality: WebGLUniformLocation | null;
      seed: WebGLUniformLocation | null;
    } | null = null;
    let animationFrame = 0;
    let lastFrameTime = -Infinity;
    let startTime = 0;
    let pausedAt = 0;
    let disposed = false;
    let renderWidth = 0;
    let renderHeight = 0;

    const setCanvasVisible = (visible: boolean) => {
      canvas.classList.toggle("app-atmosphere__canvas--visible", visible);
      canvas.dataset.renderer = visible ? "webgl2" : "fallback";
    };

    const report = (shaderStatus: ShaderStatus, webgl2Available = gl !== null) => {
      onDebugStateChange({
        webgl2Available,
        renderWidth,
        renderHeight,
        targetFps: reducedMotion ? 0 : qualityConfig.targetFps,
        shaderStatus,
        reducedMotion,
      });
    };

    const stopLoop = () => {
      if (animationFrame !== 0) {
        cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
    };

    const destroyResources = () => {
      stopLoop();
      if (!gl) return;
      if (vertexArray) gl.deleteVertexArray(vertexArray);
      if (program) gl.deleteProgram(program);
      vertexArray = null;
      program = null;
      uniforms = null;
    };

    const resize = () => {
      if (!gl) return;
      const size = calculateQueueRenderSize(window.innerWidth, window.innerHeight, window.devicePixelRatio, quality);
      renderWidth = size.width;
      renderHeight = size.height;

      if (canvas.width !== size.width || canvas.height !== size.height) {
        canvas.width = size.width;
        canvas.height = size.height;
      }
      gl.viewport(0, 0, size.width, size.height);
    };

    const draw = (timeSeconds: number) => {
      if (!gl || !program || !vertexArray || !uniforms || disposed) return;
      gl.useProgram(program);
      gl.bindVertexArray(vertexArray);
      gl.uniform1f(uniforms.time, timeSeconds);
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
      gl.uniform1f(uniforms.quality, qualityConfig.shaderQuality);
      gl.uniform1f(uniforms.seed, stableSeedRef.current);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const frame = (timestamp: number) => {
      if (disposed || reducedMotion || !program) return;

      const frameInterval = 1000 / qualityConfig.targetFps;
      if (timestamp - lastFrameTime >= frameInterval - 0.5) {
        if (startTime === 0) startTime = timestamp;
        lastFrameTime = timestamp;
        draw((timestamp - startTime) / 1000);
      }
      animationFrame = requestAnimationFrame(frame);
    };

    const startLoop = () => {
      stopLoop();
      lastFrameTime = -Infinity;
      startTime = 0;
      if (reducedMotion) {
        draw(18.0);
        report("compiled");
        return;
      }
      animationFrame = requestAnimationFrame(frame);
    };

    const initializeResources = (): boolean => {
      if (!gl) return false;
      destroyResources();

      try {
        program = createProgram(gl, VERTEX_SHADER, createRedFogFragmentShader(qualityConfig.fbmOctaves));
        vertexArray = gl.createVertexArray();
        if (!vertexArray) {
          throw new Error("WebGL2 vertex array allocation failed");
        }
        uniforms = {
          time: gl.getUniformLocation(program, "uTime"),
          resolution: gl.getUniformLocation(program, "uResolution"),
          quality: gl.getUniformLocation(program, "uQuality"),
          seed: gl.getUniformLocation(program, "uSeed"),
        };
        resize();
        draw(reducedMotion ? 18.0 : 0.0);
        setCanvasVisible(true);
        report("compiled");
        startLoop();
        return true;
      } catch (error) {
        console.error("[atmosphere] Red fog shader failed", error);
        destroyResources();
        setCanvasVisible(false);
        report("fallback", true);
        return false;
      }
    };

    const handleResize = () => {
      if (!gl || !program) return;
      resize();
      draw(reducedMotion ? 18.0 : performance.now() / 1000);
      report("compiled");
    };

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      stopLoop();
      program = null;
      vertexArray = null;
      setCanvasVisible(false);
      report("context-lost", true);
    };

    const handleContextRestored = () => {
      if (disposed) return;
      gl = canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: "low-power",
      });
      if (!gl || !initializeResources()) {
        setCanvasVisible(false);
        report("fallback", gl !== null);
      }
    };

    const handleReducedMotionChange = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
      if (!program) return;
      startLoop();
      report("compiled");
    };

    // WK-116 - Companion-only addition (not present in the web reference,
    // see this file's doc comment): the app keeps running while the user
    // is in Dota/OBS, so a hidden/minimized Companion window should not
    // keep spending GPU cycles on a shader nobody can see. Page Visibility
    // is the standard cross-platform signal for "the window is
    // minimized/on another virtual desktop" in a webview - stop the RAF
    // loop entirely rather than merely lowering its rate, and resume from
    // a fresh `requestAnimationFrame` (not a stale one) when visible again.
    // `pausedAt` shifts `startTime` forward by however long the pause
    // lasted, so the shader's `uTime` doesn't jump discontinuously (which
    // would read as a visible "pop") the moment the window is restored.
    const handleVisibilityChange = () => {
      if (!program) return;
      if (document.hidden) {
        pausedAt = performance.now();
        stopLoop();
        return;
      }
      if (pausedAt > 0) {
        startTime += performance.now() - pausedAt;
        pausedAt = 0;
      }
      if (!reducedMotion && animationFrame === 0) {
        animationFrame = requestAnimationFrame(frame);
      }
    };

    canvas.addEventListener("webglcontextlost", handleContextLost);
    canvas.addEventListener("webglcontextrestored", handleContextRestored);
    window.addEventListener("resize", handleResize);
    reducedMotionQuery.addEventListener("change", handleReducedMotionChange);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    if (forceFallback) {
      setCanvasVisible(false);
      report("fallback", false);
    } else {
      gl = canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: "low-power",
      });

      if (!gl) {
        console.error("[atmosphere] WebGL2 is unavailable; using CSS fallback");
        setCanvasVisible(false);
        report("fallback", false);
      } else {
        initializeResources();
      }
    }

    return () => {
      disposed = true;
      destroyResources();
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
      window.removeEventListener("resize", handleResize);
      reducedMotionQuery.removeEventListener("change", handleReducedMotionChange);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [forceFallback, onDebugStateChange, quality, seed]);

  return (
    <canvas
      ref={canvasRef}
      className="app-atmosphere__canvas"
      aria-hidden="true"
      data-testid="atmosphere-fog-canvas"
      data-renderer="fallback"
    />
  );
};
