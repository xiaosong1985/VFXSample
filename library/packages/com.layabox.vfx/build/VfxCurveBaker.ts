/**
 * 曲线烘焙模块 — 将 AnimationCurve 离散化为纹理数据
 *
 * 每条曲线采样 128 个点，4 条曲线共享纹理 1 行（分占 RGBA 通道）。
 * 纹理格式为 RGBAHalf (R16G16B16A16_SFloat)。
 *
 * 参照 Unity VFX Graph 的 curve baking 架构。
 */

// ─── 常量 ──────────────────────────────────────────

export const CURVE_TEXTURE_WIDTH = 128;
const FRAME_STRIDE = 7;   // frameData 每关键帧 7 个 float
const DEFAULT_WEIGHT = 1 / 3;

// ─── 导出接口 ──────────────────────────────────────

export interface ICurveTextureResult {
    /** 纹理宽度（固定 128） */
    width: number;
    /** 纹理高度 = ceil(curveCount / 4) */
    height: number;
    /** RGBA float 数据，长度 = width * height * 4 */
    data: Float32Array;
}

export interface ICurveUniform {
    opId: number;
    /** shader uniform 名称，如 "u_VfxCurve_42" */
    uniform: string;
    /** [1/scaleU, -startU/scaleU, vCoord, intBitsToFloat(channelIndex)] */
    curveData: [number, number, number, number];
}

// ─── 关键帧结构 ────────────────────────────────────

interface Keyframe {
    time: number;
    value: number;
    inTangent: number;
    outTangent: number;
    inWeight: number;
    outWeight: number;
    weightedMode: number;
}

// ─── 公共 API ──────────────────────────────────────

/**
 * 将多条曲线烘焙为一张 RGBA 纹理 + 对应的 curveData uniforms。
 * @param entries  opId → frameData 映射（按 opId 排序分配 curveIndex）
 * @returns 纹理数据 + 每条曲线的 uniform 元数据
 */
export function bakeCurves(entries: Map<number, number[]>): {
    texture: ICurveTextureResult;
    uniforms: ICurveUniform[];
} {
    const sortedIds = [...entries.keys()].sort((a, b) => a - b);
    const curveCount = sortedIds.length;
    const height = Math.max(1, Math.ceil(curveCount / 4));
    const data = new Float32Array(CURVE_TEXTURE_WIDTH * height * 4); // RGBA

    const uniforms: ICurveUniform[] = [];

    for (let ci = 0; ci < curveCount; ci++) {
        const opId = sortedIds[ci];
        const frameData = entries.get(opId)!;
        const keys = parseKeyframes(frameData);

        const rowIndex = ci >> 2;
        const channel = ci & 3;

        // 采样 128 个点
        const samples = bakeSingleCurve(keys);

        // 写入纹理对应行/通道
        for (let x = 0; x < CURVE_TEXTURE_WIDTH; x++) {
            const texelOffset = (rowIndex * CURVE_TEXTURE_WIDTH + x) * 4;
            data[texelOffset + channel] = samples[x];
        }

        // 计算 curveData uniform
        const startU = keys.length > 0 ? keys[0].time : 0;
        const endU = keys.length > 0 ? keys[keys.length - 1].time : 1;
        const scaleU = endU - startU;
        const safeScale = Math.abs(scaleU) < 1e-8 ? 1 : scaleU;

        const f32 = new Float32Array(1);
        const i32 = new Int32Array(f32.buffer);
        i32[0] = channel;
        const channelAsFloat = f32[0];

        uniforms.push({
            opId,
            uniform: `u_VfxCurve_${opId}`,
            curveData: [
                1.0 / safeScale,
                -startU / safeScale,
                (0.5 + rowIndex) / height,
                channelAsFloat,
            ],
        });
    }

    // ── DEBUG: 打印烘焙结果 ──
    for (let ci = 0; ci < curveCount; ci++) {
        const opId = sortedIds[ci];
        const row = ci >> 2;
        const ch = ci & 3;
        const samples: number[] = [];
        for (let x = 0; x < CURVE_TEXTURE_WIDTH; x++) {
            samples.push(data[(row * CURVE_TEXTURE_WIDTH + x) * 4 + ch]);
        }
        // 打印首尾和几个中间采样点
        const pick = [0, 16, 32, 48, 64, 80, 96, 112, 127];
        const vals = pick.map(i => `[${i}]=${samples[i].toFixed(4)}`).join(", ");
        console.log(`[VfxCurveBaker] curve opId=${opId} row=${row} ch=${"RGBA"[ch]}: ${vals}`);
        console.log(`[VfxCurveBaker] curveData:`, uniforms.find(u => u.opId === opId)?.curveData);
    }

    return {
        texture: { width: CURVE_TEXTURE_WIDTH, height, data },
        uniforms,
    };
}

// ─── 内部实现 ──────────────────────────────────────

function parseKeyframes(frameData: number[]): Keyframe[] {
    if (!frameData || frameData.length < FRAME_STRIDE) return [];
    const count = Math.floor(frameData.length / FRAME_STRIDE);
    const keys: Keyframe[] = [];
    for (let i = 0; i < count; i++) {
        const off = i * FRAME_STRIDE;
        keys.push({
            time: frameData[off],
            value: frameData[off + 1],
            inTangent: frameData[off + 2],
            outTangent: frameData[off + 3],
            inWeight: frameData[off + 4] || DEFAULT_WEIGHT,
            outWeight: frameData[off + 5] || DEFAULT_WEIGHT,
            weightedMode: frameData[off + 6] || 0,
        });
    }
    keys.sort((a, b) => a.time - b.time);
    return keys;
}

function bakeSingleCurve(keys: Keyframe[]): Float32Array {
    const result = new Float32Array(CURVE_TEXTURE_WIDTH);
    if (keys.length === 0) return result;
    if (keys.length === 1) {
        result.fill(keys[0].value);
        return result;
    }

    const startU = keys[0].time;
    const endU = keys[keys.length - 1].time;
    const scaleU = endU - startU;

    for (let i = 0; i < CURVE_TEXTURE_WIDTH; i++) {
        // clamp 模式：采样点覆盖 [startU, endU] 两端
        const t = startU + (scaleU * i) / (CURVE_TEXTURE_WIDTH - 1);
        result[i] = evaluateCurve(keys, t);
    }
    return result;
}

/**
 * 加权 Hermite 插值求值，匹配 AnimationCurve 行为。
 */
function evaluateCurve(keys: Keyframe[], t: number): number {
    // clamp 到关键帧范围
    if (t <= keys[0].time) return keys[0].value;
    if (t >= keys[keys.length - 1].time) return keys[keys.length - 1].value;

    // 二分查找区间
    let lo = 0;
    let hi = keys.length - 1;
    while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (keys[mid].time <= t) lo = mid;
        else hi = mid;
    }

    const k0 = keys[lo];
    const k1 = keys[hi];
    const dt = k1.time - k0.time;
    if (dt < 1e-10) return k0.value;

    const localT = (t - k0.time) / dt;

    // 检查是否使用加权切线
    const WM_OUT = 2;
    const WM_IN = 1;
    const useWeightedOut = (k0.weightedMode & WM_OUT) !== 0;
    const useWeightedIn = (k1.weightedMode & WM_IN) !== 0;

    if (useWeightedOut || useWeightedIn) {
        return evaluateWeightedHermite(k0, k1, localT, dt, useWeightedOut, useWeightedIn);
    }

    // 标准 Hermite 插值
    return hermite(k0.value, k0.outTangent * dt, k1.value, k1.inTangent * dt, localT);
}

/** 标准三次 Hermite 插值 */
function hermite(p0: number, m0: number, p1: number, m1: number, t: number): number {
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p0
        + (t3 - 2 * t2 + t) * m0
        + (-2 * t3 + 3 * t2) * p1
        + (t3 - t2) * m1;
}

/**
 * 加权 Hermite 插值 — 通过贝塞尔控制点迭代求解。
 * 当关键帧使用自定义权重时，标准 Hermite 参数化不再均匀，
 * 需要先求解贝塞尔参数 s（对应目标时间 t），再用 s 求值。
 */
function evaluateWeightedHermite(
    k0: Keyframe, k1: Keyframe, localT: number, dt: number,
    useWeightedOut: boolean, useWeightedIn: boolean,
): number {
    const outWeight = useWeightedOut ? k0.outWeight : DEFAULT_WEIGHT;
    const inWeight = useWeightedIn ? k1.inWeight : DEFAULT_WEIGHT;

    // 贝塞尔控制点（时间轴）
    const t0 = 0;
    const t1 = outWeight;
    const t2 = 1 - inWeight;
    const t3 = 1;

    // 牛顿法求解 s 使得 bezier(s).x = localT
    let s = localT; // 初始猜测
    for (let iter = 0; iter < 10; iter++) {
        const bezT = cubicBezier(t0, t1, t2, t3, s);
        const err = bezT - localT;
        if (Math.abs(err) < 1e-6) break;
        const deriv = cubicBezierDerivative(t0, t1, t2, t3, s);
        if (Math.abs(deriv) < 1e-10) break;
        s -= err / deriv;
        s = Math.max(0, Math.min(1, s));
    }

    // 贝塞尔控制点（值轴）
    const v0 = k0.value;
    const v1 = k0.value + k0.outTangent * dt * outWeight;
    const v2 = k1.value - k1.inTangent * dt * inWeight;
    const v3 = k1.value;

    return cubicBezier(v0, v1, v2, v3, s);
}

function cubicBezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function cubicBezierDerivative(p0: number, p1: number, p2: number, p3: number, t: number): number {
    const u = 1 - t;
    return 3 * u * u * (p1 - p0) + 6 * u * t * (p2 - p1) + 3 * t * t * (p3 - p2);
}
