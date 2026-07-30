const VERTEX_SHADER = `#version 300 es
precision highp float;

void main() {
    vec2 position = vec2(
        float((gl_VertexID << 1) & 2),
        float(gl_VertexID & 2)
    );
    gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const createRedFogFragmentShader = (octaves: 2 | 3 | 4) => `#version 300 es
precision highp float;

#define FBM_OCTAVES ${octaves}
#if FBM_OCTAVES > 3
#define MACRO_OCTAVES 3
#else
#define MACRO_OCTAVES FBM_OCTAVES
#endif
#define MICRO_OCTAVES FBM_OCTAVES

uniform float uTime;
uniform vec2 uResolution;
uniform float uQuality;
uniform float uSeed;

out vec4 outColor;

const float smokeDensity = 1.02;
const float edgeGlowStrength = 1.08;
const float redIntensity = 1.36;
const float microDetail = 0.84;
const float warpStrength = 0.17;
const float macroSpeed = 0.0037;
const float microSpeed = 0.0200;

float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32 + uSeed * 0.00037);
    return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
    vec2 cell = floor(p);
    vec2 local = fract(p);
    vec2 smoothLocal = local * local * (3.0 - 2.0 * local);

    float hashA = hash21(cell);
    float hashB = hash21(cell + vec2(1.0, 0.0));
    float hashC = hash21(cell + vec2(0.0, 1.0));
    float hashD = hash21(cell + vec2(1.0, 1.0));

    vec2 gradientA = normalize(
        fract(vec2(hashA * 23.31, hashA * 91.17)) - 0.5 +
        vec2(0.0001)
    );
    vec2 gradientB = normalize(
        fract(vec2(hashB * 23.31, hashB * 91.17)) - 0.5 +
        vec2(0.0001)
    );
    vec2 gradientC = normalize(
        fract(vec2(hashC * 23.31, hashC * 91.17)) - 0.5 +
        vec2(0.0001)
    );
    vec2 gradientD = normalize(
        fract(vec2(hashD * 23.31, hashD * 91.17)) - 0.5 +
        vec2(0.0001)
    );

    float a = dot(gradientA, local);
    float b = dot(gradientB, local - vec2(1.0, 0.0));
    float c = dot(gradientC, local - vec2(0.0, 1.0));
    float d = dot(gradientD, local - vec2(1.0, 1.0));
    float gradientNoise = mix(
        mix(a, b, smoothLocal.x),
        mix(c, d, smoothLocal.x),
        smoothLocal.y
    );

    return clamp(0.5 + gradientNoise * 0.72, 0.0, 1.0);
}

float fbmMacro(vec2 p) {
    float value = 0.0;
    float amplitude = 0.54;
    mat2 rotation = mat2(0.80, -0.60, 0.60, 0.80);

    for (int octave = 0; octave < MACRO_OCTAVES; octave++) {
        value += amplitude * valueNoise(p);
        p = rotation * p * 2.03 + vec2(13.17, 7.91);
        amplitude *= 0.49;
    }

    return value;
}

float fbmMicro(vec2 p) {
    float value = 0.5;
    float amplitude = 0.30;
    mat2 rotation = mat2(0.80, -0.60, 0.60, 0.80);

    for (int octave = 0; octave < MICRO_OCTAVES; octave++) {
        value += amplitude * (valueNoise(p) - 0.5);
        p = rotation * p * 2.03 + vec2(13.17, 7.91);
        amplitude *= 0.82;
    }

    return clamp(value, 0.0, 1.0);
}

vec2 emberLayer(
    vec2 uv,
    float time,
    float scale,
    float riseSpeed,
    float occupancy,
    float layerSeed
) {
    float aspect = uResolution.x / uResolution.y;
    vec2 emberSpace = vec2((uv.x - 0.5) * aspect, uv.y);

    float windPhase =
        emberSpace.y * 7.0 +
        time * (0.26 + riseSpeed * 0.18) +
        layerSeed;
    emberSpace.x +=
        sin(windPhase) * 0.011 +
        sin(windPhase * 0.47 + 1.9) * 0.006;

    vec2 gridPosition = emberSpace * scale;
    gridPosition.y -= time * riseSpeed;
    vec2 cell = floor(gridPosition);
    vec2 localPosition = fract(gridPosition);

    float presence = hash21(
        cell + vec2(layerSeed, layerSeed * 1.73)
    );
    float presenceMask = smoothstep(
        1.0 - occupancy,
        1.0 - occupancy * 0.32,
        presence
    );

    vec2 anchor = vec2(
        0.24 +
            hash21(cell + vec2(layerSeed * 2.31, 19.17)) * 0.52,
        0.34 +
            hash21(cell + vec2(41.73, layerSeed * 0.83)) * 0.40
    );
    vec2 delta = localPosition - anchor;

    float shapeSeed = hash21(
        cell + vec2(layerSeed * 0.41, 73.91)
    );
    float tailLength = mix(0.13, 0.31, shapeSeed);
    float tailProgress = clamp(-delta.y / tailLength, 0.0, 1.0);
    float tailCurve =
        sin(cell.y * 0.73 + layerSeed) *
        0.032 *
        tailProgress *
        tailProgress;
    float tailWidth = mix(0.034, 0.010, tailProgress);
    float tailBand =
        smoothstep(-tailLength, -tailLength * 0.72, delta.y) *
        (1.0 - smoothstep(-0.006, 0.026, delta.y));
    float trail =
        (1.0 - smoothstep(
            tailWidth,
            tailWidth + 0.018,
            abs(delta.x - tailCurve)
        )) *
        tailBand *
        pow(1.0 - tailProgress, 0.72);

    float headStretch = mix(0.82, 1.28, shapeSeed);
    vec2 headPosition = vec2(
        delta.x * 1.32,
        delta.y * headStretch
    );
    float headDistance = length(headPosition);
    float core = 1.0 - smoothstep(0.016, 0.055, headDistance);
    float aura = exp(
        -104.0 *
        dot(
            vec2(delta.x * 1.48, delta.y * 0.88),
            vec2(delta.x * 1.48, delta.y * 0.88)
        )
    );

    float altitudeFade =
        smoothstep(0.015, 0.105, uv.y) *
        (1.0 - smoothstep(0.66, 0.98, uv.y));
    float sourceBias = mix(
        1.0,
        0.28,
        smoothstep(0.16, 0.90, uv.y)
    );
    float flicker =
        0.80 +
        0.20 *
        sin(
            time * mix(4.2, 7.6, shapeSeed) +
            presence * 19.0
        );
    float visibility =
        presenceMask *
        altitudeFade *
        sourceBias *
        flicker;

    return vec2(
        (aura * 0.30 + trail * 0.58) * visibility,
        core * visibility
    );
}

void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;

    float time = uTime;
    float macroTime = time * macroSpeed;
    float microTime = time * microSpeed;
    mat2 flowRotation = mat2(0.86, -0.50, 0.50, 0.86);
    mat2 curlRotation = mat2(0.68, -0.73, 0.73, 0.68);
    vec2 baseP = p * vec2(0.92, 1.08);
    vec2 flowP = flowRotation * baseP;
    vec2 crossP = curlRotation * baseP;

    float fieldA = fbmMacro(
        flowP * 1.22 +
        vec2(macroTime * 0.66, macroTime * 0.20) +
        vec2(uSeed * 0.0013, 0.0)
    );
    float fieldB = fbmMacro(
        crossP * 1.38 +
        vec2(fieldA - 0.5, 0.5 - fieldA) * 0.28 +
        vec2(-macroTime * 0.36, macroTime * 0.51) +
        vec2(0.0, uSeed * 0.0011)
    );

    vec2 primaryWarp =
        flowRotation * vec2(fieldA - 0.5, fieldB - 0.5);
    vec2 secondaryWarp = curlRotation * vec2(
        fieldB - fieldA,
        fieldA + fieldB - 1.0
    );
    vec2 warpedP = baseP;
    warpedP +=
        primaryWarp *
        warpStrength *
        mix(1.28, 1.48, uQuality);
    warpedP +=
        secondaryWarp *
        warpStrength *
        mix(0.78, 0.98, uQuality);

    float macroSmoke = fbmMacro(
        (flowRotation * warpedP) * vec2(0.84, 1.22) * 2.35 +
        vec2(-macroTime * 0.42, macroTime * 0.16)
    );
    vec2 internalFlow = curlRotation * vec2(
        macroSmoke - 0.5,
        fieldB - fieldA
    );
    vec2 microDriftA = flowRotation * vec2(
        microTime * 0.54,
        -microTime * 0.16
    );
    vec2 microDriftB = curlRotation * vec2(
        microTime * 0.36,
        microTime * 0.48
    );
    float microDirectionBlend = smoothstep(
        0.20,
        0.78,
        fieldA * 0.58 + fieldB * 0.42
    );
    vec2 microDrift = mix(
        microDriftA,
        microDriftB,
        microDirectionBlend
    );
    mat2 microRotationA = mat2(0.94, -0.34, 0.34, 0.94);
    mat2 microRotationB = mat2(0.78, 0.63, -0.63, 0.78);
    vec2 microPA =
        microRotationA *
        (flowRotation * warpedP) *
        vec2(1.34, 0.78);
    microPA += primaryWarp * 0.07 + internalFlow * 0.14;
    vec2 microPB =
        microRotationB *
        (curlRotation * warpedP) *
        vec2(0.82, 1.42);
    microPB += secondaryWarp * 0.09 - internalFlow.yx * 0.11;
    vec2 microP = mix(
        microPA,
        microPB,
        microDirectionBlend
    );
    float microSmoke = fbmMicro(
        microP * 11.7 +
        microDrift
    );

    float centerDistance = length(p * vec2(0.82, 1.22));
    float sideLift = smoothstep(0.34, 0.88, abs(p.x));
    float lowerLift = smoothstep(-0.04, 0.50, -p.y);

    float macroBase =
        macroSmoke * 0.62 +
        fieldA * 0.23 +
        fieldB * 0.15;
    float macroBody = smoothstep(
        0.08,
        0.92,
        macroBase * 1.30
    );
    float backField = fieldA * 0.55 + fieldB * 0.45;
    float backVolume = smoothstep(
        0.06,
        0.94,
        backField * 1.18
    );
    float smokeVeil = smoothstep(
        0.10,
        0.90,
        macroBase * 0.72 + backVolume * 0.28
    );
    float macroDepth = clamp(
        macroBody * 0.70 +
        backVolume * 0.28 +
        smokeVeil * 0.12,
        0.0,
        1.0
    );
    float macroBoundary = smoothstep(
        0.05,
        0.52,
        abs(fieldA - fieldB)
    );
    float volumeLight = clamp(
        (
            0.26 +
            macroDepth * 0.50 +
            lowerLift * 0.12 +
            sideLift * 0.06
        ) * edgeGlowStrength,
        0.0,
        1.0
    );
    float darkPockets = smoothstep(
        0.56,
        0.86,
        1.0 - (fieldA * 0.48 + fieldB * 0.52)
    ) * (1.0 - macroDepth * 0.34);

    float microPresence = smoothstep(
        0.32,
        0.70,
        macroDepth * 0.70 + macroBoundary * 0.30
    );
    microPresence *= mix(0.38, 1.0, smokeVeil);
    float microMotionMask = smoothstep(
        0.20,
        0.64,
        macroDepth * 0.72 + smokeVeil * 0.28
    );
    float microFlow = smoothstep(0.24, 0.76, microSmoke);
    float microSignal = microFlow - 0.5;
    float microModulation =
        1.0 +
        microSignal * 0.48 * microMotionMask * microDetail;
    float filamentBand =
        smoothstep(0.48, 0.57, microSmoke) -
        smoothstep(0.60, 0.69, microSmoke);
    float thinFilaments =
        filamentBand * filamentBand *
        microPresence *
        mix(0.52, 1.0, macroBoundary) *
        microDetail;
    float shadowCuts =
        smoothstep(0.58, 0.86, 1.0 - microSmoke) *
        microPresence;

    float pulse = 0.994 + 0.006 * sin(time * 0.055 + uSeed * 0.013);
    float atmosphere =
        0.088 +
        macroDepth * 0.205 +
        backVolume * 0.050 +
        smokeVeil *
            (0.060 + microSignal * 0.070 * microMotionMask) +
        volumeLight * 0.025 +
        lowerLift * 0.026 +
        sideLift * 0.014;
    float density =
        macroDepth *
        smokeDensity *
        (0.38 + macroBoundary * 0.14) *
        microModulation;
    density += thinFilaments * (0.27 + volumeLight * 0.19);
    density += backVolume * 0.075;
    density +=
        smokeVeil *
        (0.030 + microSignal * 0.065 * microMotionMask);
    density *= 1.0 - shadowCuts * 0.045;
    density *= mix(0.86, 1.08, volumeLight);
    density *= 1.0 - darkPockets * 0.20;
    density *= pulse;

    vec3 nearBlack = vec3(0.018, 0.0025, 0.0040);
    vec3 deepMaroon = vec3(0.160, 0.011, 0.021);
    vec3 darkRed = vec3(0.330, 0.020, 0.031);
    vec3 crimson = vec3(0.520, 0.028, 0.036);
    vec3 ember = vec3(0.540, 0.048, 0.028);

    vec3 color = mix(
        nearBlack,
        deepMaroon,
        clamp(
            0.36 +
            smoothstep(0.015, 0.62, atmosphere + density * 0.46) * 0.58,
            0.0,
            0.94
        )
    );
    color = mix(
        color,
        darkRed,
        smoothstep(0.04, 0.82, density) * 0.55
    );
    color = mix(
        color,
        crimson,
        smoothstep(0.48, 1.08, density) * 0.30
    );
    color = mix(
        color,
        ember,
        smoothstep(0.88, 1.18, density) * (0.014 + 0.014 * uQuality)
    );
    color +=
        vec3(0.150, 0.007, 0.010) *
        thinFilaments *
        mix(0.72, 1.0, macroBoundary) *
        (0.17 + volumeLight * 0.13);

    color *= mix(0.88, 1.0, 1.0 - darkPockets);

    float verticalShade = mix(1.06, 0.91, smoothstep(0.0, 1.0, uv.y));
    color *= verticalShade;

    float vignetteBase =
        16.0 * uv.x * uv.y * (1.0 - uv.x) * (1.0 - uv.y);
    float vignette = 0.82 + 0.18 * pow(max(vignetteBase, 0.0), 0.18);
    color *= vignette;
    color *= 1.0 - exp(-centerDistance * centerDistance * 2.7) * 0.010;

    float luminance = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(
        vec3(luminance),
        color,
        clamp(0.70 * redIntensity, 0.0, 1.0)
    );

    vec2 embers = emberLayer(
        uv,
        time,
        10.0,
        0.44,
        0.072,
        17.1
    );
    embers +=
        emberLayer(
            uv,
            time,
            14.0,
            0.62,
            0.050,
            83.4
        ) *
        mix(0.58, 1.0, uQuality);
    embers +=
        emberLayer(
            uv,
            time,
            7.5,
            0.29,
            0.068,
            147.2
        ) *
        uQuality *
        0.78;

    color +=
        vec3(1.24, 0.16, 0.022) *
        min(embers.x, 1.35);
    color +=
        vec3(1.42, 0.54, 0.12) *
        min(embers.y, 1.0);

    outColor = vec4(color, 1.0);
}
`;

export { VERTEX_SHADER };
