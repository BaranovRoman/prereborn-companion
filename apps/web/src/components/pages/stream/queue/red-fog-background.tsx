"use client";

import { useEffect, useRef } from "react";
import {
    calculateQueueRenderSize,
    QUEUE_QUALITY_CONFIG,
    type QueueQuality,
} from "./queue-scene-config";
import {
    createRedFogFragmentShader,
    VERTEX_SHADER,
} from "./red-fog-shaders";
import styles from "./queue-scene.module.scss";

type ShaderStatus =
    | "initializing"
    | "compiled"
    | "fallback"
    | "context-lost";

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

const compileShader = (
    gl: WebGL2RenderingContext,
    type: number,
    source: string
): WebGLShader => {
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

export const RedFogBackground = ({
    quality,
    seed,
    forceFallback,
    onDebugStateChange,
}: RedFogBackgroundProps) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const stableSeedRef = useRef(seed);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const qualityConfig = QUEUE_QUALITY_CONFIG[quality];
        stableSeedRef.current = seed;
        const reducedMotionQuery = window.matchMedia(
            "(prefers-reduced-motion: reduce)"
        );
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
        let disposed = false;
        let renderWidth = 0;
        let renderHeight = 0;

        const setCanvasVisible = (visible: boolean) => {
            canvas.classList.toggle(styles.canvasVisible, visible);
            canvas.dataset.renderer = visible ? "webgl2" : "fallback";
        };

        const report = (
            shaderStatus: ShaderStatus,
            webgl2Available = gl !== null
        ) => {
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
            const size = calculateQueueRenderSize(
                window.innerWidth,
                window.innerHeight,
                window.devicePixelRatio,
                quality
            );
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
            gl.uniform2f(
                uniforms.resolution,
                canvas.width,
                canvas.height
            );
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
                program = createProgram(
                    gl,
                    VERTEX_SHADER,
                    createRedFogFragmentShader(qualityConfig.fbmOctaves)
                );
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
                console.error("[queue-scene] Red fog shader failed", error);
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

        canvas.addEventListener("webglcontextlost", handleContextLost);
        canvas.addEventListener("webglcontextrestored", handleContextRestored);
        window.addEventListener("resize", handleResize);
        reducedMotionQuery.addEventListener("change", handleReducedMotionChange);

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
                console.error("[queue-scene] WebGL2 is unavailable; using CSS fallback");
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
            canvas.removeEventListener(
                "webglcontextrestored",
                handleContextRestored
            );
            window.removeEventListener("resize", handleResize);
            reducedMotionQuery.removeEventListener(
                "change",
                handleReducedMotionChange
            );
        };
    }, [forceFallback, onDebugStateChange, quality, seed]);

    return (
        <canvas
            ref={canvasRef}
            className={styles.canvas}
            aria-hidden="true"
            data-testid="queue-fog-canvas"
            data-renderer="fallback"
        />
    );
};
