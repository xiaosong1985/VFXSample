/**
 * Block 代码生成公共模块
 *
 * Initialize / Update / Output 三个模板共用的 GLSL 生成工具函数。
 * 粒子变量名 (particleVar) 参数化，消除 "particle" vs "p" 的差异。
 */

import type { IVfxBlockData } from "../../data/VfxTypes";
import { getAttributeType, getAttributeSpaceable } from "../../data/VfxOperatorDefs";
import type { VfxExprCompiler } from "../VfxExprCompiler";
import { genSetPositionShapeCode } from "./ShapePosition";

// ─── GLSL 类型映射（全局统一） ─────────────────────────

export const GLSL_TYPE: Record<string, string> = {
    vec3: "vec3",
    color: "vec3",
    float: "float",
    bool: "bool",
    uint: "uint",
};

// ─── 字面量工具 ─────────────────────────────────────────

/** 数值转 GLSL float 字面量 */
export function toFloat(v: any): string {
    const n = Number(v) || 0;
    const s = String(n);
    return (s.includes('.') || s.includes('e') || s.includes('E')) ? s : s + ".0";
}

/** 根据 attribute 类型和 _values 数据构造 GLSL 字面量 */
export function valueLiteral(attrType: string, vals: Record<string, any>, prefix: string): string {
    switch (attrType) {
        case "vec2":
            return `vec2(${toFloat(vals[prefix + "x"])}, ${toFloat(vals[prefix + "y"])})`;
        case "vec3":
            return `vec3(${toFloat(vals[prefix + "x"])}, ${toFloat(vals[prefix + "y"])}, ${toFloat(vals[prefix + "z"])})`;
        case "vec4":
            return `vec4(${toFloat(vals[prefix + "x"])}, ${toFloat(vals[prefix + "y"])}, ${toFloat(vals[prefix + "z"])}, ${toFloat(vals[prefix + "w"])})`;
        case "color":
            return `vec3(${toFloat(vals[prefix + "r"] ?? 1)}, ${toFloat(vals[prefix + "g"] ?? 1)}, ${toFloat(vals[prefix + "b"] ?? 1)})`;
        case "float":
            // IDE saves float to "value" field. Legacy VFX files may use "x".
            // Priority: value (IDE) > x (legacy) > 0
            return toFloat((prefix + "value") in vals && vals[prefix + "value"] !== undefined
                ? vals[prefix + "value"]
                : (vals[prefix + "x"] ?? 0));
        case "bool":
            return vals[prefix + "value"] ? "true" : "false";
        case "int":
        case "uint":
            return toFloat(vals[prefix + "value"] ?? vals[prefix + "x"] ?? 0);
        default:
            return "0.0";
    }
}

// ─── Gradient / Curve 分段插值 GLSL 生成 ────────────────

/**
 * 生成 float 曲线的分段插值 GLSL 片段（Hermite 三次样条，与 Unity AnimationCurve 一致）。
 * frames: [{time, value, inTangent?, outTangent?}] 按 time 升序。
 * 若 tangent 字段缺失则使用线性插值作为 fallback。
 * 返回：赋值语句序列（调用方已声明 outVar）。
 */
function genFloatCurveBranches(frames: { time: number; value: number; inTangent?: number; outTangent?: number }[], tVar: string, outVar: string): string[] {
    if (!frames || frames.length === 0) return [`    ${outVar} = 1.0;`];
    const sorted = frames.slice().sort((a, b) => a.time - b.time);
    const lines: string[] = [];
    if (sorted.length === 1) {
        return [`    ${outVar} = ${toFloat(sorted[0].value)};`];
    }
    lines.push(`    if (${tVar} <= ${toFloat(sorted[0].time)}) ${outVar} = ${toFloat(sorted[0].value)};`);
    for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i], b = sorted[i + 1];
        const span = Math.max(b.time - a.time, 1e-6);
        const p0 = toFloat(a.value);
        const p1 = toFloat(b.value);
        const m0 = a.outTangent !== undefined ? a.outTangent * span : 0;
        const m1 = b.inTangent !== undefined ? b.inTangent * span : 0;
        if (a.outTangent === undefined && b.inTangent === undefined) {
            // 无 tangent → 线性
            lines.push(`    else if (${tVar} < ${toFloat(b.time)}) ${outVar} = mix(${p0}, ${p1}, (${tVar} - ${toFloat(a.time)}) / ${toFloat(span)});`);
        } else {
            // Hermite: H(s) = (2s³-3s²+1)p₀ + (s³-2s²+s)m₀ + (-2s³+3s²)p₁ + (s³-s²)m₁
            lines.push(`    else if (${tVar} < ${toFloat(b.time)}) { float _s = (${tVar} - ${toFloat(a.time)}) / ${toFloat(span)}; float _s2 = _s*_s; float _s3 = _s2*_s; ${outVar} = (2.0*_s3 - 3.0*_s2 + 1.0) * ${p0} + (_s3 - 2.0*_s2 + _s) * ${toFloat(m0)} + (-2.0*_s3 + 3.0*_s2) * ${p1} + (_s3 - _s2) * ${toFloat(m1)}; }`);
        }
    }
    lines.push(`    else ${outVar} = ${toFloat(sorted[sorted.length - 1].value)};`);
    return lines;
}

/**
 * 生成 vec3 颜色渐变的分段线性插值 GLSL 片段。
 * colorKeys: [{color:{r,g,b}, time}] 按 time 升序。
 */
function genColorGradientBranches(colorKeys: { color: { r: number; g: number; b: number }; time: number }[], tVar: string, outVar: string): string[] {
    if (!colorKeys || colorKeys.length === 0) return [`    ${outVar} = vec3(1.0);`];
    const sorted = colorKeys.slice().sort((a, b) => a.time - b.time);
    const vec3Lit = (c: { r: number; g: number; b: number }) => `vec3(${toFloat(c.r)}, ${toFloat(c.g)}, ${toFloat(c.b)})`;
    if (sorted.length === 1) {
        return [`    ${outVar} = ${vec3Lit(sorted[0].color)};`];
    }
    const lines: string[] = [];
    lines.push(`    if (${tVar} <= ${toFloat(sorted[0].time)}) ${outVar} = ${vec3Lit(sorted[0].color)};`);
    for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i], b = sorted[i + 1];
        const span = Math.max(b.time - a.time, 1e-6);
        lines.push(`    else if (${tVar} < ${toFloat(b.time)}) ${outVar} = mix(${vec3Lit(a.color)}, ${vec3Lit(b.color)}, (${tVar} - ${toFloat(a.time)}) / ${toFloat(span)});`);
    }
    lines.push(`    else ${outVar} = ${vec3Lit(sorted[sorted.length - 1].color)};`);
    return lines;
}

// ─── 随机值生成 ─────────────────────────────────────────

/** 生成 Per Component 随机 mix 表达式（使用有状态 Rand） */
export function genPerComponentMix(attrType: string, vals: Record<string, any>, particleVar: string): string {
    if (attrType === "vec3") {
        return `vec3(\n` +
            `            mix(${toFloat(vals.x)}, ${toFloat(vals.b_x)}, Rand(${particleVar}.seed)),\n` +
            `            mix(${toFloat(vals.y)}, ${toFloat(vals.b_y)}, Rand(${particleVar}.seed)),\n` +
            `            mix(${toFloat(vals.z)}, ${toFloat(vals.b_z)}, Rand(${particleVar}.seed))\n` +
            `        )`;
    }
    if (attrType === "color") {
        return `vec3(\n` +
            `            mix(${toFloat(vals.r ?? 1)}, ${toFloat(vals.b_r ?? 1)}, Rand(${particleVar}.seed)),\n` +
            `            mix(${toFloat(vals.g ?? 1)}, ${toFloat(vals.b_g ?? 1)}, Rand(${particleVar}.seed)),\n` +
            `            mix(${toFloat(vals.b ?? 1)}, ${toFloat(vals.b_b ?? 1)}, Rand(${particleVar}.seed))\n` +
            `        )`;
    }
    // float
    return `mix(${toFloat(vals.value)}, ${toFloat(vals.b_value)}, Rand(${particleVar}.seed))`;
}

// ─── 赋值组合模式 ───────────────────────────────────────

/** 生成赋值语句（根据 composition 模式） */
export function applyComposition(
    lines: string[],
    attrName: string,
    valueExpr: string,
    composition: string,
    vals: Record<string, any>,
    indent: string,
    particleVar: string,
): void {
    switch (composition) {
        case "Add":
            lines.push(`${indent}${particleVar}.${attrName} += ${valueExpr};`);
            break;
        case "Multiply":
            lines.push(`${indent}${particleVar}.${attrName} *= ${valueExpr};`);
            break;
        case "Blend":
            lines.push(`${indent}${particleVar}.${attrName} = mix(${particleVar}.${attrName}, ${valueExpr}, ${toFloat(vals.blend ?? 0.5)});`);
            break;
        default: // Overwrite
            lines.push(`${indent}${particleVar}.${attrName} = ${valueExpr};`);
            break;
    }
}

/**
 * 带 channels mask 的赋值（对齐 Unity SetAttribute.channels 位掩码）。
 * channels: 7=XYZ all (default), 6=YZ, 5=XZ, 3=XY, 1=X, 2=Y, 4=Z
 * vec3/color attribute + channels != 7 时按 swizzle 选择性写分量；
 * float/int/uint/bool 或 channels=7 时退回全分量赋值（applyComposition）。
 *
 * blockIdHint：临时变量名后缀 hint，避免同 ctx 多个 setAttribute 同 attrName 时变量重定义
 */
export function applyCompositionWithChannels(
    lines: string[],
    attrName: string,
    attrType: string,
    valueExpr: string,
    composition: string,
    vals: Record<string, any>,
    indent: string,
    particleVar: string,
    channels: number,
    blockIdHint: number = 0,
): void {
    const isVecLike = attrType === "vec3" || attrType === "color" || attrType === "vec2" || attrType === "vec4";
    if (channels === 7 || !isVecLike) {
        applyComposition(lines, attrName, valueExpr, composition, vals, indent, particleVar);
        return;
    }
    // 构造 swizzle string by bit (X=1, Y=2, Z=4)
    const components = ["x", "y", "z"];
    let swiz = "";
    for (let bit = 0; bit < 3; bit++) if (channels & (1 << bit)) swiz += components[bit];
    if (!swiz) return;   // 没有 channel 可写
    // 临时变量 hold valueExpr 让 swizzle 读取（valueExpr 可能是 inline literal 或子表达式）
    // 加 blockIdHint 防止同 ctx 多个 setAttribute 同 attrName 时 _chanV_xxx 变量名重复 redefinition
    const tmpVar = `_chanV_${attrName}_${blockIdHint}`;
    const gtype = attrType === "color" ? "vec3" : (attrType === "vec2" ? "vec2" : attrType === "vec4" ? "vec4" : "vec3");
    lines.push(`${indent}${gtype} ${tmpVar} = ${valueExpr};`);
    switch (composition) {
        case "Add":
            lines.push(`${indent}${particleVar}.${attrName}.${swiz} += ${tmpVar}.${swiz};`);
            break;
        case "Multiply":
            lines.push(`${indent}${particleVar}.${attrName}.${swiz} *= ${tmpVar}.${swiz};`);
            break;
        case "Blend":
            lines.push(`${indent}${particleVar}.${attrName}.${swiz} = mix(${particleVar}.${attrName}.${swiz}, ${tmpVar}.${swiz}, ${toFloat(vals.blend ?? 0.5)});`);
            break;
        default:
            lines.push(`${indent}${particleVar}.${attrName}.${swiz} = ${tmpVar}.${swiz};`);
            break;
    }
}

// ─── Seed 检测 ──────────────────────────────────────────

/**
 * 检测 blocks 中是否需要 seed（随机 setAttribute 或 setPositionShape）
 * 不检查 enabled，因为 block 可能通过 enabled 输入端口在运行时动态启用
 * @param includeShape 是否包含 setPositionShape 的检测（Initialize/Update 为 true，Output 为 false）
 */
export function blocksNeedSeed(blocks: IVfxBlockData[], includeShape: boolean = true, operators?: { typeId: string }[]): boolean {
    // 只算启用的 block — disabled block 不生成 GLSL，但若仍计入 needSeed 会导致
    // shader prelude 写入 p.seed 操作，而 attribute scanner 没把 seed 注入 struct → seed undeclared
    const blockNeed = blocks.some(b =>
        b.enabled !== false && (
            (includeShape && b.typeId === "setPositionShape")
            || (b.typeId === "setAttribute"
                && b.props?.source !== "Source"
                && b.props?.random && b.props.random !== "Off")
            || (b.typeId === "velNewDirection"
                && b.props?.speedMode === "Random")
            || (b.typeId === "velRandom")
            || (b.typeId === "velSpherical"
                && b.props?.speedMode === "Random")
            || (b.typeId === "velAlongVelocity"
                && b.props?.speedMode === "Random")
            || (b.typeId === "setAttributeCurve"
                && (b.props?.sampleMode === "Random" || b.props?.sampleMode === "RandomConstantPerParticle"))
            || (b.typeId === "setPositionMesh")
        )
    );
    if (blockNeed) return true;
    // 也扫 operators —— randomNumber 等 op emit Rand(p.seed)，即使没 random setAttribute
    // 仍需在 init 阶段写 particle.seed = WangHash(particleIndex ...)，否则 seed 永远 0 → Rand 永返同值
    if (operators) {
        for (const op of operators) {
            if (op.typeId === "randomNumber") return true;
        }
    }
    return false;
}

// ─── 空间转换 ───────────────────────────────────────────

/** 生成 inline 值的空间转换表达式（blockSpace → simulateSpace） */
export function wrapInlineSpaceConvert(expr: string, attrName: string, blockSpace: string, simulateSpace: string): string {
    if (!blockSpace || blockSpace === simulateSpace) return expr;
    const spaceable = getAttributeSpaceable(attrName);
    if (!spaceable) return expr;
    const matrix = blockSpace === "World" ? "u_InvEmitterWorldMatrix" : "u_EmitterWorldMatrix";
    if (spaceable === "direction") return `normalize(mat3(${matrix}) * ${expr})`;
    if (spaceable === "vector") return `(mat3(${matrix}) * ${expr})`;
    return `transformPosition(${matrix}, ${expr})`;
}

// ─── genBlockCode 统一入口 ─────────────────────────────────

/** genBlockCode 配置选项 */
export interface IGenBlockCodeOptions {
    /** 粒子变量名 ("particle" in Initialize, "p" in Update/Output) */
    particleVar: string;
    /** 是否支持 Source 数据源 */
    supportSource?: boolean;
    /** Source 不可用时的注释 */
    sourceUnavailableComment?: string;
    /** 是否处理 setPositionShape block（Output 为 false） */
    includeShape?: boolean;
    /** 系统是否 strip(useStripRingBuffer)。传给 setPositionShape 的 perStripRand:非 strip 退化用 spawnIndex。 */
    hasStripIndex?: boolean;
}

/**
 * 根据 context 内的 blocks 生成 GLSL 代码（setAttribute + setPositionShape）。
 * Initialize / Update / Output 三个模板共用。
 */
export function genBlockCode(
    blocks: IVfxBlockData[],
    opts: IGenBlockCodeOptions,
    contextId?: number,
    compiler?: VfxExprCompiler,
    simulateSpace?: string,
): string {
    if (!blocks?.length) return "";
    const { particleVar, supportSource, sourceUnavailableComment, includeShape = true, hasStripIndex } = opts;

    const lines: string[] = [];

    for (const block of blocks) {
        // ── setPositionShape ──
        if (includeShape && block.typeId === "setPositionShape") {
            if (!block.enabled) continue;
            lines.push("");
            lines.push(...genSetPositionShapeCode(block, particleVar, "    ", simulateSpace, contextId, compiler, hasStripIndex));
            continue;
        }

        // ── customGlslBlock ──
        // Unity CustomHLSL Block 对齐：直接 inline 用户 GLSL，约定 $p 别名引用 particle
        if (block.typeId === "customGlslBlock") {
            if (!block.enabled) continue;
            const userCode = String(block.props?.code || "").replace(/\$p\b/g, particleVar);
            if (userCode.trim()) {
                lines.push("    // [customGlslBlock]");
                // 按行 indent 4 空格
                for (const ln of userCode.split("\n")) {
                    lines.push("    " + ln);
                }
            }
            continue;
        }

        // ── linearDrag ──
        if (block.typeId === "linearDrag") {
            const result = genLinearDragCode(block, { particleVar });
            if (result) lines.push(...result);
            continue;
        }

        // ── colorOverLife ──
        if (block.typeId === "colorOverLife") {
            if (!block.enabled) continue;
            const cp = block.props || {};
            const comp = (cp.composition as string) || "Multiply";
            const gradient = cp.gradient as any;
            // 多色 gradient（Unity 真实数据，>= 2 colorKeys）优先：Unity 转换的 vfx 同时带 gradient.colorKeys
            // 和 colorA/B fallback，editor 双色模式的 colorA/B 是 IDE auto-fill 默认值不是用户意图
            const hasGradient = gradient && Array.isArray(gradient.colorKeys) && gradient.colorKeys.length >= 2;
            const hasSimpleColors = cp.colorA !== undefined && cp.colorB !== undefined;
            lines.push("");
            lines.push(`    // colorOverLife`);
            lines.push(`    {`);
            lines.push(`        float _colT = clamp(${particleVar}.normalizedAge, 0.0, 1.0);`);

            if (!hasGradient && hasSimpleColors) {
                // 双色模式（Inspector 显示 Color A / Color B 时）
                const cA = cp.colorA || { r: 1, g: 0.5, b: 0 };
                const cB = cp.colorB || { r: 0.2, g: 0.7, b: 1 };
                const t = toFloat(cp.transition ?? 0.5);
                const s = toFloat(cp.smoothness ?? 0.05);
                lines.push(`        float _colMix = smoothstep(${t} - ${s}, ${t} + ${s}, _colT);`);
                lines.push(`        vec3 _lifeColor = mix(vec3(${toFloat(cA.r)}, ${toFloat(cA.g)}, ${toFloat(cA.b)}), vec3(${toFloat(cB.r)}, ${toFloat(cB.g)}, ${toFloat(cB.b)}), _colMix);`);
                if (comp === "Multiply") {
                    lines.push(`        ${particleVar}.color *= _lifeColor;`);
                } else {
                    lines.push(`        ${particleVar}.color = _lifeColor;`);
                }
            } else {
                // 多色渐变 + alpha 渐变（Unity Gradient 兼容）
                lines.push(`        vec3 _lifeColor;`);
                for (const s of genColorGradientBranches(gradient.colorKeys, "_colT", "_lifeColor")) lines.push(`    ${s}`);

                const alphaKeys = Array.isArray(gradient.alphaKeys) && gradient.alphaKeys.length > 0
                    ? gradient.alphaKeys.map((k: any) => ({ time: k.time, value: k.alpha }))
                    : [{ time: 0, value: 1 }];
                lines.push(`        float _lifeAlpha;`);
                for (const s of genFloatCurveBranches(alphaKeys, "_colT", "_lifeAlpha")) lines.push(`    ${s}`);
                // alpha 作为 HDR 衰减乘入 color（黑背景下视觉等价于 alpha 淡出）
                if (comp === "Multiply") {
                    lines.push(`        ${particleVar}.color *= _lifeColor * _lifeAlpha;`);
                } else {
                    lines.push(`        ${particleVar}.color = _lifeColor * _lifeAlpha;`);
                }
            }
            lines.push(`    }`);
            continue;
        }

        // ── sizeOverLife ──
        if (block.typeId === "sizeOverLife") {
            if (!block.enabled) continue;
            const sp = block.props || {};
            const comp = (sp.composition as string) || "Multiply";
            const curve = sp.curve as any;
            const frames = curve && Array.isArray(curve.frames) ? curve.frames : null;
            if (!frames || frames.length === 0) continue;
            lines.push("");
            lines.push(`    // sizeOverLife`);
            lines.push(`    {`);
            lines.push(`        float _sizeT = clamp(${particleVar}.normalizedAge, 0.0, 1.0);`);
            lines.push(`        float _sizeVal;`);
            for (const s of genFloatCurveBranches(frames, "_sizeT", "_sizeVal")) lines.push(`    ${s}`);
            if (comp === "Multiply") {
                lines.push(`        ${particleVar}.size *= _sizeVal;`);
            } else {
                lines.push(`        ${particleVar}.size = _sizeVal;`);
            }
            lines.push(`    }`);
            continue;
        }

        // ── alphaOverLife ──
        if (block.typeId === "alphaOverLife") {
            if (!block.enabled) continue;
            const ap = block.props || {};
            const fadeIn = toFloat(ap.fadeInEnd ?? 0);
            const fadeOut = toFloat(ap.fadeOutStart ?? 0.8);
            lines.push("");
            lines.push(`    // alphaOverLife`);
            lines.push(`    {`);
            lines.push(`        float _fadeAlpha = 1.0;`);
            if (Number(ap.fadeInEnd) > 0) {
                lines.push(`        _fadeAlpha *= smoothstep(0.0, ${fadeIn}, ${particleVar}.normalizedAge);`);
            }
            lines.push(`        _fadeAlpha *= 1.0 - smoothstep(${fadeOut}, 1.0, ${particleVar}.normalizedAge);`);
            lines.push(`        ${particleVar}.alpha *= _fadeAlpha;`);
            lines.push(`    }`);
            continue;
        }

        // ── attributeFromMap ──
        if (block.typeId === "attributeFromMap") {
            const result = genAttributeFromMapCode(block, { particleVar, compiler });
            if (result) lines.push(...result);
            continue;
        }

        // ── collision ──
        if (block.typeId === "collisionCone") {
            const result = genCollisionConeCode(block, { particleVar });
            if (result) lines.push(...result);
            continue;
        }
        if (block.typeId === "collisionTorus") {
            const result = genCollisionTorusCode(block, { particleVar });
            if (result) lines.push(...result);
            continue;
        }
        if (block.typeId === "collisionPlane" || block.typeId === "collisionSphere" || block.typeId === "collisionAABox") {
            const result = genCollisionCode(block, { particleVar });
            if (result) lines.push(...result);
            continue;
        }

        // ── kill ──
        if (block.typeId === "killSphere" || block.typeId === "killAABox" || block.typeId === "killPlane" || block.typeId === "killCone" || block.typeId === "killTorus" || block.typeId === "killOrientedBox") {
            const result = genKillCode(block, { particleVar });
            if (result) lines.push(...result);
            continue;
        }

        // ── attractorAABox (Unity AttractorAABox 对齐) ──
        if (block.typeId === "attractorAABox") {
            const result = genAttractorAABoxCode(block, { particleVar });
            if (result) lines.push(...result);
            continue;
        }

        // ── turbulence ──
        if (block.typeId === "turbulence") {
            const result = genTurbulenceCode(block, { particleVar, compiler, contextId, simulateSpace: simulateSpace ?? "Local" });
            if (result) lines.push(...result);
            continue;
        }

        // ── vectorFieldForce (Unity VectorFieldForce.cs) ──
        if (block.typeId === "vectorFieldForce") {
            const result = genVectorFieldForceCode(block, { particleVar, compiler });
            if (result) lines.push(...result);
            continue;
        }

        // ── linearDrag (对齐 Unity Drag.cs: velocity *= exp(-(dragCoefficient * dt) / mass)) ──
        if (block.typeId === "linearDrag") {
            if (!block.enabled) continue;
            const dp = block.props || {};
            const dragCoeff = toFloat(dp.dragCoefficient ?? 0.5);
            lines.push("");
            lines.push(`    // linearDrag (Unity: velocity *= exp(-(dragCoefficient * dt) / mass))`);
            lines.push(`    {`);
            lines.push(`        float _dragMass = ${particleVar}.mass > 0.0 ? ${particleVar}.mass : 1.0;`);
            lines.push(`        ${particleVar}.velocity *= exp(-(${dragCoeff} * u_DeltaTime) / _dragMass);`);
            lines.push(`    }`);
            continue;
        }

        // ── setPositionShape (Sphere) — matches Unity PositionSphere.cs ──
        if (block.typeId === "setPositionShape") {
            if (!block.enabled) continue;
            const sp = block.props || {};
            const shape = (sp.shape as string) || "Sphere";
            const posMode = (sp.positionMode as string) || "Surface";
            const comp = (sp.composition as string) || "Overwrite";
            const assignOp = comp === "Add" ? "+=" : "=";

            if (shape === "Sphere") {
                const radius = toFloat(sp.radius ?? 1);
                // Surface mode: volumeFactor = 1 (no interior), Volume: volumeFactor = 0
                const volumeFactor = posMode === "Volume" ? "0.0" : "1.0";
                lines.push("");
                lines.push(`    // setPositionShape (Sphere, ${posMode}) — Unity PositionSphere.cs`);
                lines.push(`    {`);
                lines.push(`        uint _spSeed = WangHash(particleIndex ^ uint(u_SystemSeed) ^ 0x5A3Cu);`);
                lines.push(`        float _spCosPhi = 2.0 * Rand(_spSeed) - 1.0;`);
                lines.push(`        float _spTheta = 6.28318530718 * Rand(_spSeed);`);
                lines.push(`        float _spRNorm = pow(${volumeFactor} + (1.0 - ${volumeFactor}) * Rand(_spSeed), 1.0 / 3.0);`);
                lines.push(`        float _spSinTheta = sin(_spTheta);`);
                lines.push(`        float _spCosTheta = cos(_spTheta);`);
                lines.push(`        float _spSinPhi = sqrt(1.0 - _spCosPhi * _spCosPhi);`);
                lines.push(`        vec3 _spDir = vec3(_spSinTheta * _spSinPhi, _spCosTheta * _spSinPhi, _spCosPhi);`);
                lines.push(`        vec3 _spPos = _spDir * _spRNorm * ${radius};`);
                lines.push(`        ${particleVar}.position ${assignOp} _spPos;`);
                lines.push(`        ${particleVar}.direction = _spDir;`);
                lines.push(`    }`);
            } else if (shape === "Cone") {
                // Unity PositionCone.cs — cone from baseRadius to topRadius over height
                const baseRadius = toFloat(sp.baseRadius ?? 1);
                const topRadius = toFloat(sp.topRadius ?? 0);
                const height = toFloat(sp.height ?? 1);
                const heightMode = (sp.heightMode as string) || "Volume";
                const volumeFactor = posMode === "Volume" ? "0.0" : "1.0";
                lines.push("");
                lines.push(`    // setPositionShape (Cone, ${posMode}, ${heightMode}) — Unity PositionCone.cs`);
                lines.push(`    {`);
                lines.push(`        uint _cpSeed = WangHash(particleIndex ^ uint(u_SystemSeed) ^ 0x7B2Du);`);
                lines.push(`        float _cpTheta = 6.28318530718 * Rand(_cpSeed);`);
                lines.push(`        float _cpRNorm = sqrt(${volumeFactor} + (1.0 - ${volumeFactor}) * Rand(_cpSeed));`);
                lines.push(`        float _cpSinT = sin(_cpTheta);`);
                lines.push(`        float _cpCosT = cos(_cpTheta);`);
                lines.push(`        vec2 _cpPos2D = vec2(_cpSinT, _cpCosT) * _cpRNorm;`);
                if (heightMode === "Base") {
                    lines.push(`        float _cpH = 0.0;`);
                } else {
                    lines.push(`        float _cpH = Rand(_cpSeed);`);
                }
                lines.push(`        vec3 _cpPos = mix(vec3(_cpPos2D * ${baseRadius}, 0.0), vec3(_cpPos2D * ${topRadius}, ${height}), _cpH);`);
                lines.push(`        float _cpSlope = atan(${topRadius} - ${baseRadius}, ${height});`);
                lines.push(`        vec3 _cpDir = normalize(vec3(_cpPos2D * sin(_cpSlope), cos(_cpSlope)));`);
                lines.push(`        _cpPos = vec3(_cpPos.x, _cpPos.z, _cpPos.y);`); // xzy swizzle
                lines.push(`        _cpDir = vec3(_cpDir.x, _cpDir.z, _cpDir.y);`);
                lines.push(`        ${particleVar}.position ${assignOp} _cpPos;`);
                lines.push(`        ${particleVar}.direction = _cpDir;`);
                lines.push(`    }`);
            } else if (shape === "Box") {
                // Unity PositionAABox.cs — oriented box (supports rotation via angle)
                // Schema: sp.orientedBox = { center, angle, size }；老格式 fallback 到 sp.center/size
                const ob = sp.orientedBox || {};
                const center = ob.center || sp.center || { x: 0, y: 0, z: 0 };
                const size = ob.size || sp.size || { x: 1, y: 1, z: 1 };
                const angle = ob.angle || { x: 0, y: 0, z: 0 };
                const hasRotation = Number(angle.x) !== 0 || Number(angle.y) !== 0 || Number(angle.z) !== 0;
                lines.push("");
                lines.push(`    // setPositionShape (Box) — Unity PositionAABox.cs`);
                lines.push(`    {`);
                lines.push(`        uint _bxSeed = WangHash(particleIndex ^ uint(u_SystemSeed) ^ 0x3C7Au);`);
                if (posMode === "Volume") {
                    lines.push(`        vec3 _bxPos = vec3(Rand(_bxSeed) - 0.5, Rand(_bxSeed) - 0.5, Rand(_bxSeed) - 0.5);`);
                    lines.push(`        _bxPos *= vec3(${toFloat(size.x)}, ${toFloat(size.y)}, ${toFloat(size.z)});`);
                } else {
                    // Surface: pick a random face, then random position on that face
                    lines.push(`        float _bxFace = Rand(_bxSeed) * 6.0;`);
                    lines.push(`        float _bxU = Rand(_bxSeed) - 0.5;`);
                    lines.push(`        float _bxV = Rand(_bxSeed) - 0.5;`);
                    lines.push(`        vec3 _bxPos;`);
                    lines.push(`        if (_bxFace < 1.0) _bxPos = vec3(0.5, _bxU, _bxV);`);
                    lines.push(`        else if (_bxFace < 2.0) _bxPos = vec3(-0.5, _bxU, _bxV);`);
                    lines.push(`        else if (_bxFace < 3.0) _bxPos = vec3(_bxU, 0.5, _bxV);`);
                    lines.push(`        else if (_bxFace < 4.0) _bxPos = vec3(_bxU, -0.5, _bxV);`);
                    lines.push(`        else if (_bxFace < 5.0) _bxPos = vec3(_bxU, _bxV, 0.5);`);
                    lines.push(`        else _bxPos = vec3(_bxU, _bxV, -0.5);`);
                    lines.push(`        _bxPos *= vec3(${toFloat(size.x)}, ${toFloat(size.y)}, ${toFloat(size.z)});`);
                }
                // 旋转 orientedBox（angle 为度数，YXZ 顺序，与 LayaAir 约定一致）
                if (hasRotation) {
                    lines.push(`        {`);
                    lines.push(`            vec3 _bxEuler = radians(vec3(${toFloat(angle.x)}, ${toFloat(angle.y)}, ${toFloat(angle.z)}));`);
                    lines.push(`            float _bxCx = cos(_bxEuler.x); float _bxSx = sin(_bxEuler.x);`);
                    lines.push(`            float _bxCy = cos(_bxEuler.y); float _bxSy = sin(_bxEuler.y);`);
                    lines.push(`            float _bxCz = cos(_bxEuler.z); float _bxSz = sin(_bxEuler.z);`);
                    lines.push(`            mat3 _bxR = mat3(`);
                    lines.push(`                _bxCy*_bxCz + _bxSy*_bxSx*_bxSz,   _bxCx*_bxSz,                        _bxCy*_bxSx*_bxSz - _bxSy*_bxCz,`);
                    lines.push(`                _bxSy*_bxSx*_bxCz - _bxCy*_bxSz,   _bxCx*_bxCz,                        _bxCy*_bxSx*_bxCz + _bxSy*_bxSz,`);
                    lines.push(`                _bxSy*_bxCx,                       -_bxSx,                             _bxCy*_bxCx);`);
                    lines.push(`            _bxPos = _bxR * _bxPos;`);
                    lines.push(`        }`);
                }
                lines.push(`        _bxPos += vec3(${toFloat(center.x)}, ${toFloat(center.y)}, ${toFloat(center.z)});`);
                lines.push(`        ${particleVar}.position ${assignOp} _bxPos;`);
                lines.push(`        ${particleVar}.direction = normalize(_bxPos - vec3(${toFloat(center.x)}, ${toFloat(center.y)}, ${toFloat(center.z)}));`);
                lines.push(`    }`);
            } else if (shape === "Circle") {
                // Unity PositionCircle.cs — circle edge/disc
                const radius = toFloat(sp.radius ?? 1);
                const volumeFactor = posMode === "Volume" ? "0.0" : "1.0";
                lines.push("");
                lines.push(`    // setPositionShape (Circle, ${posMode}) — Unity PositionCircle.cs`);
                lines.push(`    {`);
                // 种子用全局递增 spawn 索引，不能只用 particleIndex：
                // particleIndex 来自 DeadList 回收槽位，稳态只复用 ~5-6 个槽 → 只算出 ~5-6 个固定角度反复用
                // → emitter 聚成簇。Unity 用 per-spawn 递增种子，每次生成都是新角 → 随时间铺满整圈。
                // initialize 阶段用 id + u_TotalSpawnedCount；output/update 阶段没有 id，改读 spawnIndex。
                const _ccSpawnId = particleVar === "particle" ? "id + uint(u_TotalSpawnedCount)" : `${particleVar}.spawnIndex`;
                lines.push(`        uint _ccSeed = WangHash((${_ccSpawnId}) ^ uint(u_SystemSeed) ^ 0x9F1Bu);`);
                lines.push(`        float _ccTheta = 6.28318530718 * Rand(_ccSeed);`);
                lines.push(`        float _ccRNorm = sqrt(${volumeFactor} + (1.0 - ${volumeFactor}) * Rand(_ccSeed));`);
                lines.push(`        vec3 _ccDir = vec3(sin(_ccTheta), cos(_ccTheta), 0.0);`);
                lines.push(`        vec3 _ccPos = _ccDir * _ccRNorm * ${radius};`);
                lines.push(`        ${particleVar}.position ${assignOp} _ccPos;`);
                lines.push(`        ${particleVar}.direction = _ccDir;`);
                lines.push(`    }`);
            } else if (shape === "Line") {
                // Unity PositionLine.cs — random point on line
                const start = sp.start || { x: 0, y: 0, z: 0 };
                const end = sp.end || { x: 0, y: 1, z: 0 };
                lines.push("");
                lines.push(`    // setPositionShape (Line) — Unity PositionLine.cs`);
                lines.push(`    {`);
                lines.push(`        uint _lnSeed = WangHash(particleIndex ^ uint(u_SystemSeed) ^ 0xD42Eu);`);
                lines.push(`        vec3 _lnStart = vec3(${toFloat(start.x)}, ${toFloat(start.y)}, ${toFloat(start.z)});`);
                lines.push(`        vec3 _lnEnd = vec3(${toFloat(end.x)}, ${toFloat(end.y)}, ${toFloat(end.z)});`);
                lines.push(`        vec3 _lnPos = mix(_lnStart, _lnEnd, Rand(_lnSeed));`);
                lines.push(`        ${particleVar}.position ${assignOp} _lnPos;`);
                lines.push(`        ${particleVar}.direction = normalize(_lnEnd - _lnStart);`);
                lines.push(`    }`);
            } else if (shape === "Torus") {
                // Unity PositionTorus.cs (simplified — no transform)
                const majorR = toFloat(sp.majorRadius ?? 1);
                const minorR = toFloat(sp.minorRadius ?? 0.3);
                const volumeFactor = posMode === "Volume" ? "0.0" : "1.0";
                lines.push("");
                lines.push(`    // setPositionShape (Torus, ${posMode}) — Unity PositionTorus.cs`);
                lines.push(`    {`);
                lines.push(`        uint _trSeed = WangHash(particleIndex ^ uint(u_SystemSeed) ^ 0xE71Fu);`);
                lines.push(`        float _trPhi = 6.28318530718 * Rand(_trSeed);`);
                lines.push(`        float _trTheta = 6.28318530718 * Rand(_trSeed);`);
                lines.push(`        float _trR = sqrt(${volumeFactor} + (1.0 - ${volumeFactor}) * Rand(_trSeed)) * ${minorR};`);
                lines.push(`        vec3 _trPos = vec3((${majorR} + _trR * cos(_trTheta)) * cos(_trPhi), _trR * sin(_trTheta), (${majorR} + _trR * cos(_trTheta)) * sin(_trPhi));`);
                lines.push(`        vec3 _trCenter = vec3(${majorR} * cos(_trPhi), 0.0, ${majorR} * sin(_trPhi));`);
                lines.push(`        ${particleVar}.position ${assignOp} _trPos;`);
                lines.push(`        ${particleVar}.direction = normalize(_trPos - _trCenter);`);
                lines.push(`    }`);
            }
            continue;
        }

        // ── conformToAABox (Unity ConformToAABox.cs 对齐) ──
        //   用 _aaboxClosestSurface 求最近表面点，粒子朝该点运动
        if (block.typeId === "conformToAABox") {
            if (!block.enabled) continue;
            const cs = block.props || {};
            const center = cs.center || { x: 0, y: 0, z: 0 };
            const sizeVal = cs.size || { x: 1, y: 1, z: 1 };
            const attractionSpeed = toFloat(cs.attractionSpeed ?? 5);
            const attractionForce = toFloat(cs.attractionForce ?? 20);
            const stickDistance = toFloat(cs.stickDistance ?? 0.1);
            const stickForce = toFloat(cs.stickForce ?? 50);
            lines.push("");
            lines.push(`    // conformToAABox — Unity ConformToAABox.cs`);
            lines.push(`    {`);
            lines.push(`        vec3 _cfBC = vec3(${toFloat(center.x)}, ${toFloat(center.y)}, ${toFloat(center.z)});`);
            lines.push(`        vec3 _cfBS = vec3(${toFloat(sizeVal.x)}, ${toFloat(sizeVal.y)}, ${toFloat(sizeVal.z)});`);
            lines.push(`        vec3 _cfSurf = _aaboxClosestSurface(${particleVar}.position, _cfBC, _cfBS);`);
            lines.push(`        vec3 _cfDir = _cfSurf - ${particleVar}.position;`);
            lines.push(`        float _cfDist = length(_cfDir);`);
            lines.push(`        if (_cfDist > 1e-5) {`);
            lines.push(`            _cfDir /= _cfDist;`);
            lines.push(`            float _cfSpdN = dot(_cfDir, ${particleVar}.velocity);`);
            lines.push(`            float _cfRatio = smoothstep(0.0, ${stickDistance} * 2.0, _cfDist);`);
            lines.push(`            float _cfTgtSpd = ${attractionSpeed} * _cfRatio;`);
            lines.push(`            float _cfDeltaSpd = _cfTgtSpd - _cfSpdN;`);
            lines.push(`            float _cfMass = ${particleVar}.mass > 0.0 ? ${particleVar}.mass : 1.0;`);
            lines.push(`            ${particleVar}.velocity += sign(_cfDeltaSpd) * min(abs(_cfDeltaSpd), u_DeltaTime * mix(${stickForce}, ${attractionForce}, _cfRatio)) * _cfDir / _cfMass;`);
            lines.push(`        }`);
            lines.push(`    }`);
            continue;
        }

        // ── conformToOrientedBox (OBB local 变换 + _aaboxClosestSurface) ──
        if (block.typeId === "conformToOrientedBox") {
            if (!block.enabled) continue;
            const cs = block.props || {};
            const center = cs.center || { x: 0, y: 0, z: 0 };
            const angleVal = cs.angle || { x: 0, y: 0, z: 0 };
            const sizeVal = cs.size || { x: 1, y: 1, z: 1 };
            const attractionSpeed = toFloat(cs.attractionSpeed ?? 5);
            const attractionForce = toFloat(cs.attractionForce ?? 20);
            const stickDistance = toFloat(cs.stickDistance ?? 0.1);
            const stickForce = toFloat(cs.stickForce ?? 50);
            lines.push("");
            lines.push(`    // conformToOrientedBox — Unity ConformToOrientedBox`);
            lines.push(`    {`);
            lines.push(`        vec3 _coBC = vec3(${toFloat(center.x)}, ${toFloat(center.y)}, ${toFloat(center.z)});`);
            lines.push(`        vec3 _coBA = vec3(${toFloat(angleVal.x)}, ${toFloat(angleVal.y)}, ${toFloat(angleVal.z)});`);
            lines.push(`        vec3 _coBS = vec3(${toFloat(sizeVal.x)}, ${toFloat(sizeVal.y)}, ${toFloat(sizeVal.z)});`);
            // 到 OBB local 找最近表面点，再变换回世界
            lines.push(`        vec3 _coBLocal = _applyEulerInverse(${particleVar}.position - _coBC, _coBA);`);
            lines.push(`        vec3 _coBLocalSurf = _aaboxClosestSurface(_coBLocal, vec3(0.0), _coBS);`);
            lines.push(`        vec3 _coBSurf = _applyEulerForward(_coBLocalSurf, _coBA) + _coBC;`);
            lines.push(`        vec3 _coBDir = _coBSurf - ${particleVar}.position;`);
            lines.push(`        float _coBDist = length(_coBDir);`);
            lines.push(`        if (_coBDist > 1e-5) {`);
            lines.push(`            _coBDir /= _coBDist;`);
            lines.push(`            float _coBSpdN = dot(_coBDir, ${particleVar}.velocity);`);
            lines.push(`            float _coBRatio = smoothstep(0.0, ${stickDistance} * 2.0, _coBDist);`);
            lines.push(`            float _coBTgtSpd = ${attractionSpeed} * _coBRatio;`);
            lines.push(`            float _coBDeltaSpd = _coBTgtSpd - _coBSpdN;`);
            lines.push(`            float _coBMass = ${particleVar}.mass > 0.0 ? ${particleVar}.mass : 1.0;`);
            lines.push(`            ${particleVar}.velocity += sign(_coBDeltaSpd) * min(abs(_coBDeltaSpd), u_DeltaTime * mix(${stickForce}, ${attractionForce}, _coBRatio)) * _coBDir / _coBMass;`);
            lines.push(`        }`);
            lines.push(`    }`);
            continue;
        }

        // ── conformToCone (cone 表面吸附) ──
        if (block.typeId === "conformToCone") {
            if (!block.enabled) continue;
            const cs = block.props || {};
            const center = cs.center || { x: 0, y: 0, z: 0 };
            const axisRaw = cs.axis;
            const axisVal = (axisRaw && axisRaw.direction) ? axisRaw.direction : (axisRaw || { x: 0, y: 1, z: 0 });
            const height = toFloat(cs.height ?? 1);
            const baseR = toFloat(cs.baseRadius ?? 1);
            const attractionSpeed = toFloat(cs.attractionSpeed ?? 5);
            const attractionForce = toFloat(cs.attractionForce ?? 20);
            const stickDistance = toFloat(cs.stickDistance ?? 0.1);
            const stickForce = toFloat(cs.stickForce ?? 50);
            const axLen = Math.hypot(Number(axisVal.x), Number(axisVal.y), Number(axisVal.z)) || 1;
            const nax = Number(axisVal.x) / axLen, nay = Number(axisVal.y) / axLen, naz = Number(axisVal.z) / axLen;
            lines.push("");
            lines.push(`    // conformToCone — Unity ConformToCone`);
            lines.push(`    {`);
            lines.push(`        vec3 _ccA = vec3(${toFloat(nax)}, ${toFloat(nay)}, ${toFloat(naz)});`);
            lines.push(`        vec3 _ccOff = ${particleVar}.position - vec3(${toFloat(center.x)}, ${toFloat(center.y)}, ${toFloat(center.z)});`);
            lines.push(`        float _ccH = clamp(dot(_ccOff, _ccA), 0.0, ${height});`);  // 沿 axis 投影并 clamp 到 cone 高度
            lines.push(`        vec3 _ccR = _ccOff - _ccA * _ccH;`);  // 垂直 axis 分量
            lines.push(`        float _ccRLen = length(_ccR);`);
            lines.push(`        float _ccRadAtH = ${baseR} * (_ccH / ${height});`);  // cone 在 h 处允许半径
            // cone 表面点 = apex + axis*h + normalize(R)*radAtH
            lines.push(`        vec3 _ccRDir = _ccRLen > 1e-6 ? _ccR / _ccRLen : vec3(1.0, 0.0, 0.0);`);
            lines.push(`        vec3 _ccSurf = vec3(${toFloat(center.x)}, ${toFloat(center.y)}, ${toFloat(center.z)}) + _ccA * _ccH + _ccRDir * _ccRadAtH;`);
            lines.push(`        vec3 _ccDir = _ccSurf - ${particleVar}.position;`);
            lines.push(`        float _ccDist = length(_ccDir);`);
            lines.push(`        if (_ccDist > 1e-5) {`);
            lines.push(`            _ccDir /= _ccDist;`);
            lines.push(`            float _ccSpdN = dot(_ccDir, ${particleVar}.velocity);`);
            lines.push(`            float _ccRatio = smoothstep(0.0, ${stickDistance} * 2.0, _ccDist);`);
            lines.push(`            float _ccTgtSpd = ${attractionSpeed} * _ccRatio;`);
            lines.push(`            float _ccDeltaSpd = _ccTgtSpd - _ccSpdN;`);
            lines.push(`            float _ccMass = ${particleVar}.mass > 0.0 ? ${particleVar}.mass : 1.0;`);
            lines.push(`            ${particleVar}.velocity += sign(_ccDeltaSpd) * min(abs(_ccDeltaSpd), u_DeltaTime * mix(${stickForce}, ${attractionForce}, _ccRatio)) * _ccDir / _ccMass;`);
            lines.push(`        }`);
            lines.push(`    }`);
            continue;
        }

        // ── collisionOrientedBox (简化 Unity CollisionOrientedBox.cs) ──
        //   变换粒子到 OBB local space，做 AABox 碰撞，再变换法线/速度回世界
        if (block.typeId === "collisionOrientedBox") {
            if (!block.enabled) continue;
            const cs = block.props || {};
            const center = cs.center || { x: 0, y: 0, z: 0 };
            const angleVal = cs.angle || { x: 0, y: 0, z: 0 };
            const sizeVal = cs.size || { x: 2, y: 2, z: 2 };
            const bounce = toFloat(cs.bounce ?? 0.1);
            const friction = toFloat(cs.friction ?? 0);
            const lifetimeLoss = toFloat(cs.lifetimeLoss ?? 0);
            const mode = (cs.mode as string) || "Solid";
            lines.push("");
            lines.push(`    // collisionOrientedBox (${mode}) — Unity CollisionOrientedBox.cs`);
            lines.push(`    {`);
            lines.push(`        vec3 _coC = vec3(${toFloat(center.x)}, ${toFloat(center.y)}, ${toFloat(center.z)});`);
            lines.push(`        vec3 _coAngle = vec3(${toFloat(angleVal.x)}, ${toFloat(angleVal.y)}, ${toFloat(angleVal.z)});`);
            lines.push(`        vec3 _coSize = vec3(${toFloat(sizeVal.x)}, ${toFloat(sizeVal.y)}, ${toFloat(sizeVal.z)});`);
            lines.push(`        vec3 _coNextWorld = ${particleVar}.position + ${particleVar}.velocity * u_DeltaTime;`);
            lines.push(`        vec3 _coNextLocal = _applyEulerInverse(_coNextWorld - _coC, _coAngle);`);
            lines.push(`        vec3 _coHalf = _coSize * 0.5;`);
            if (mode === "Inverted") {
                // Inverted: 粒子需要留在 box 内 → 外部 → 推回
                lines.push(`        vec3 _coAbsL = abs(_coNextLocal);
        bool _coInside = _coAbsL.x < _coHalf.x && _coAbsL.y < _coHalf.y && _coAbsL.z < _coHalf.z;`);
                lines.push(`        if (!_coInside) {`);
                lines.push(`            vec3 _coN = _aaboxOutwardNormal(_coNextLocal, vec3(0.0), _coSize);`);
                lines.push(`            vec3 _coClamp = clamp(_coNextLocal, -_coHalf, _coHalf);`);
                lines.push(`            vec3 _coLocalPos = _coClamp;`);
                lines.push(`            vec3 _coWorldN = _applyEulerForward(-_coN, _coAngle);`); // 法线指向内部
                lines.push(`            ${particleVar}.position = _applyEulerForward(_coLocalPos, _coAngle) + _coC;`);
                lines.push(`            float _coProjVel = dot(_coWorldN, ${particleVar}.velocity);`);
                lines.push(`            if (_coProjVel < 0.0) {`);
                lines.push(`                ${particleVar}.velocity -= ((1.0 + ${bounce}) * _coProjVel) * _coWorldN;`);
                lines.push(`            }`);
            } else {
                // Solid: 粒子需要留在 box 外 → 内部 → 推回
                lines.push(`        vec3 _coAbsL = abs(_coNextLocal);
        bool _coInside = _coAbsL.x < _coHalf.x && _coAbsL.y < _coHalf.y && _coAbsL.z < _coHalf.z;`);
                lines.push(`        if (_coInside) {`);
                lines.push(`            vec3 _coN = _aaboxOutwardNormal(_coNextLocal, vec3(0.0), _coSize);`);
                // 推到最近表面
                lines.push(`            vec3 _coDiff = _coHalf - abs(_coNextLocal);`);
                lines.push(`            vec3 _coLocalPos = _coNextLocal;`);
                lines.push(`            if (_coDiff.x <= _coDiff.y && _coDiff.x <= _coDiff.z) _coLocalPos.x = sign(_coNextLocal.x) * _coHalf.x;`);
                lines.push(`            else if (_coDiff.y <= _coDiff.z) _coLocalPos.y = sign(_coNextLocal.y) * _coHalf.y;`);
                lines.push(`            else _coLocalPos.z = sign(_coNextLocal.z) * _coHalf.z;`);
                lines.push(`            vec3 _coWorldN = _applyEulerForward(_coN, _coAngle);`);
                lines.push(`            ${particleVar}.position = _applyEulerForward(_coLocalPos, _coAngle) + _coC;`);
                lines.push(`            float _coProjVel = dot(_coWorldN, ${particleVar}.velocity);`);
                lines.push(`            if (_coProjVel < 0.0) {`);
                lines.push(`                ${particleVar}.velocity -= ((1.0 + ${bounce}) * _coProjVel) * _coWorldN;`);
                lines.push(`            }`);
            }
            if (Number(cs.friction) > 0) {
                lines.push(`            vec3 _coTangentVel = ${particleVar}.velocity - _coProjVel * _coWorldN;`);
                lines.push(`            ${particleVar}.velocity -= ${friction} * _coTangentVel;`);
            }
            if (Number(cs.lifetimeLoss) > 0) {
                lines.push(`            ${particleVar}.age += ${lifetimeLoss} * ${particleVar}.lifetime;`);
            }
            lines.push(`        }`);
            lines.push(`    }`);
            continue;
        }

        // ── conformToSphere — 1:1 跟 Unity ConformToSphere.cs 公式 ──
        // Unity source:
        //   float3 dir = (Sphere_center - position);
        //   float distToCenter = length(dir);
        //   float distToSurface = distToCenter - Sphere_radius;
        //   dir /= max(VFX_EPSILON, distToCenter);
        //   float spdNormal = dot(dir, velocity);
        //   float ratio = smoothstep(0.0, stickDistance * 2.0, abs(distToSurface));
        //   float tgtSpeed = sign(distToSurface) * attractionSpeed * ratio;
        //   float deltaSpeed = tgtSpeed - spdNormal;
        //   velocity += sign(deltaSpeed) * min(abs(deltaSpeed), deltaTime * lerp(stickForce, attractionForce, ratio)) * dir / mass;
        if (block.typeId === "conformToSphere") {
            if (!block.enabled) continue;
            const cs = block.props || {};
            const center = cs.center || { x: 0, y: 0, z: 0 };
            const radius = toFloat(cs.radius ?? 1);
            const attractionSpeed = toFloat(cs.attractionSpeed ?? 5);
            const attractionForce = toFloat(cs.attractionForce ?? 20);
            const stickDistance = toFloat(cs.stickDistance ?? 0.1);
            const stickForce = toFloat(cs.stickForce ?? 50);
            lines.push("");
            lines.push(`    // conformToSphere — Unity ConformToSphere.cs (1:1 公式)`);
            lines.push(`    {`);
            lines.push(`        vec3 _cfDir = vec3(${toFloat(center.x)}, ${toFloat(center.y)}, ${toFloat(center.z)}) - ${particleVar}.position;`);
            lines.push(`        float _cfDist = length(_cfDir);`);
            lines.push(`        float _cfDistSurf = _cfDist - ${radius};`);
            lines.push(`        _cfDir /= max(0.00001, _cfDist);`);
            lines.push(`        float _cfSpdN = dot(_cfDir, ${particleVar}.velocity);`);
            lines.push(`        float _cfRatio = smoothstep(0.0, ${stickDistance} * 2.0, abs(_cfDistSurf));`);
            lines.push(`        float _cfTgtSpd = sign(_cfDistSurf) * ${attractionSpeed} * _cfRatio;`);
            lines.push(`        float _cfDeltaSpd = _cfTgtSpd - _cfSpdN;`);
            lines.push(`        ${particleVar}.velocity += sign(_cfDeltaSpd) * min(abs(_cfDeltaSpd), u_DeltaTime * mix(${stickForce}, ${attractionForce}, _cfRatio)) * _cfDir / ${particleVar}.mass;`);
            lines.push(`    }`);
            continue;
        }

        // ── collisionPlane (matches Unity CollisionPlane.cs + CollisionBase.cs) ──
        if (block.typeId === "collisionPlane") {
            if (!block.enabled) continue;
            const cp = block.props || {};
            const planePos = cp.position || { x: 0, y: 0, z: 0 };
            const planeNorm = cp.normal || { x: 0, y: 1, z: 0 };
            const bounce = toFloat(cp.bounce ?? 0.1);
            const friction = toFloat(cp.friction ?? 0);
            const lifetimeLoss = toFloat(cp.lifetimeLoss ?? 0);
            const radius = toFloat(cp.radius ?? 0);
            lines.push("");
            lines.push(`    // collisionPlane — Unity CollisionPlane.cs`);
            lines.push(`    {`);
            lines.push(`        vec3 _cpN = normalize(vec3(${toFloat(planeNorm.x)}, ${toFloat(planeNorm.y)}, ${toFloat(planeNorm.z)}));`);
            lines.push(`        float _cpW = dot(vec3(${toFloat(planePos.x)}, ${toFloat(planePos.y)}, ${toFloat(planePos.z)}), _cpN);`);
            lines.push(`        vec3 _cpNextPos = ${particleVar}.position + ${particleVar}.velocity * u_DeltaTime;`);
            lines.push(`        float _cpDist = dot(_cpNextPos, _cpN) - _cpW - ${radius};`);
            lines.push(`        if (_cpDist < 0.0) {`);
            lines.push(`            ${particleVar}.position -= _cpN * _cpDist;`);
            lines.push(`            float _cpProjVel = dot(_cpN, ${particleVar}.velocity);`);
            lines.push(`            if (_cpProjVel < 0.0) {`);
            lines.push(`                ${particleVar}.velocity -= ((1.0 + ${bounce}) * _cpProjVel) * _cpN;`);
            lines.push(`            }`);
            if (Number(cp.friction) > 0) {
                lines.push(`            vec3 _cpTangentVel = ${particleVar}.velocity - _cpProjVel * _cpN;`);
                lines.push(`            ${particleVar}.velocity -= ${friction} * _cpTangentVel;`);
            }
            if (Number(cp.lifetimeLoss) > 0) {
                lines.push(`            ${particleVar}.age += ${lifetimeLoss} * ${particleVar}.lifetime;`);
            }
            lines.push(`        }`);
            lines.push(`    }`);
            continue;
        }

        // ── collisionSphere (simplified Unity CollisionSphere.cs) ──
        if (block.typeId === "collisionSphere") {
            if (!block.enabled) continue;
            const cs = block.props || {};
            const center = cs.center || { x: 0, y: 0, z: 0 };
            const radius = toFloat(cs.sphereRadius ?? 1);
            const bounce = toFloat(cs.bounce ?? 0.1);
            const friction = toFloat(cs.friction ?? 0);
            const lifetimeLoss = toFloat(cs.lifetimeLoss ?? 0);
            const particleRadius = toFloat(cs.radius ?? 0);
            const mode = (cs.mode as string) || "Solid"; // Solid = outside, Inverted = inside
            const sign = mode === "Inverted" ? "-1.0" : "1.0";
            lines.push("");
            lines.push(`    // collisionSphere (${mode}) — Unity CollisionSphere.cs`);
            lines.push(`    {`);
            lines.push(`        vec3 _csCenter = vec3(${toFloat(center.x)}, ${toFloat(center.y)}, ${toFloat(center.z)});`);
            lines.push(`        vec3 _csNextPos = ${particleVar}.position + ${particleVar}.velocity * u_DeltaTime;`);
            lines.push(`        vec3 _csDelta = _csNextPos - _csCenter;`);
            lines.push(`        float _csDist = length(_csDelta);`);
            lines.push(`        float _csEffRadius = ${radius} + ${particleRadius} * ${sign};`);
            lines.push(`        if (${sign} * _csDist <= ${sign} * _csEffRadius && _csDist > 0.001) {`);
            lines.push(`            vec3 _csN = ${sign} * _csDelta / _csDist;`);
            lines.push(`            ${particleVar}.position = _csCenter + _csN * _csEffRadius;`);
            lines.push(`            float _csProjVel = dot(_csN, ${particleVar}.velocity);`);
            lines.push(`            if (_csProjVel < 0.0) {`);
            lines.push(`                ${particleVar}.velocity -= ((1.0 + ${bounce}) * _csProjVel) * _csN;`);
            lines.push(`            }`);
            if (Number(cs.friction) > 0) {
                lines.push(`            vec3 _csTangentVel = ${particleVar}.velocity - _csProjVel * _csN;`);
                lines.push(`            ${particleVar}.velocity -= ${friction} * _csTangentVel;`);
            }
            if (Number(cs.lifetimeLoss) > 0) {
                lines.push(`            ${particleVar}.age += ${lifetimeLoss} * ${particleVar}.lifetime;`);
            }
            lines.push(`        }`);
            lines.push(`    }`);
            continue;
        }

        // ── vortex (Unity VortexForceField 对齐) ──
        // Vortex Plane: center + normal (swirl axis)
        // 3 curves sampled by radial distance: Channel/Gravity/Vortex
        //   Channel = 沿 axis 方向 force
        //   Gravity = 径向 radial direction force (-值朝内)
        //   Vortex  = 切向 tangent direction force (swirl)
        // Drag dampening: velocity *= exp(-drag * dt / mass)
        if (block.typeId === "vortex") {
            if (!block.enabled) continue;
            const vp = block.props || {};
            const plane = vp.vortexPlane || vp.plane || { position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 } };
            const pos = plane.position || { x: 0, y: 0, z: 0 };
            const nrm = plane.normal || { x: 0, y: 1, z: 0 };
            const drag = toFloat(vp.drag ?? 0);
            // 1:1 对齐 Unity 编译产物 HLSL（UNI Vortex.vfxblock 子图）：
            //   target = normalize(cross(relN,N))*Vortex(d) + normalize(cross(tan,N))*Gravity(d) + N*Channel(d)
            //   · 切向/径向必须是【单位向量】，不带 d 模长（带模长会让近轴切向→0、远轴过强，轨迹形态错）
            //   · 三条曲线按径向距离 d 采样（SampleCurve 自带域映射+clamp）
            //   · 切向 cross 是伪向量：LHS→RHS 镜像须翻号，Unity cross(rel,N) → Laya cross(N,rel)
            const regCurve = (c: any, ofs: number) => (compiler && c && Array.isArray(c.frameData) && c.frameData.length >= 7)
                ? compiler.registerInlineCurve(ofs + (block.id || 0), c.frameData) : null;
            const chCurve = regCurve(vp.channelDistance, 300000);
            const gvCurve = regCurve(vp.gravityDistance, 400000);
            const vxCurve = regCurve(vp.vortexDistance, 500000);

            lines.push("");
            lines.push(`    // vortex — 1:1 Unity 编译产物公式 (切向/径向单位化; 手性已翻 cross(N,rel))`);
            lines.push(`    {`);
            lines.push(`        vec3 _vxAxis = normalize(vec3(${toFloat(nrm.x)}, ${toFloat(nrm.y)}, ${toFloat(nrm.z)}));`);
            lines.push(`        vec3 _vxRel = ${particleVar}.position - vec3(${toFloat(pos.x)}, ${toFloat(pos.y)}, ${toFloat(pos.z)});`);
            lines.push(`        float _vxAxialLen = dot(_vxRel, _vxAxis);`);
            lines.push(`        vec3 _vxRadialVec = _vxRel - _vxAxialLen * _vxAxis;`);          // 径向向量(向外, 模长=d)
            lines.push(`        float _vxD = length(_vxRadialVec);`);
            lines.push(`        vec3 _vxTanRaw = cross(_vxAxis, _vxRel);`);                     // 切向(伪向量镜像翻号后)
            lines.push(`        vec3 _vxTan = _vxTanRaw / max(length(_vxTanRaw), 1e-8);`);      // 单位化
            lines.push(`        vec3 _vxRadIn = -_vxRadialVec / max(_vxD, 1e-8);`);             // 单位向心
            lines.push(`        float _vxVortex = ${vxCurve ? `SampleCurve(u_VfxBakedTex, ${vxCurve}, _vxD)` : "0.0"};`);
            lines.push(`        float _vxGravity = ${gvCurve ? `SampleCurve(u_VfxBakedTex, ${gvCurve}, _vxD)` : "0.0"};`);
            lines.push(`        float _vxChannel = ${chCurve ? `SampleCurve(u_VfxBakedTex, ${chCurve}, _vxD)` : "0.0"};`);
            lines.push(`        vec3 _vxTarget = _vxTan * _vxVortex + _vxRadIn * _vxGravity + _vxAxis * _vxChannel;`);
            lines.push(`        float _vxMass = ${particleVar}.mass > 0.0 ? ${particleVar}.mass : 1.0;`);
            // Force(Mode=Relative): 速度收敛到有界 target, 不加性累积→不炸开
            lines.push(`        ${particleVar}.velocity += (_vxTarget - ${particleVar}.velocity) * min(1.0, ${drag} * u_DeltaTime / _vxMass);`);
            lines.push(`    }`);
            continue;
        }

        // ── force (general) ──
        if (block.typeId === "force") {
            const result = genForceCode(block, { particleVar, compiler, contextId, simulateSpace: simulateSpace ?? "Local" });
            if (result) lines.push(...result);
            continue;
        }

        // ── attractorSphere ──
        if (block.typeId === "attractorSphere") {
            const result = genAttractorSphereCode(block, { particleVar });
            if (result) lines.push(...result);
            continue;
        }

        // ── cameraFade ──
        if (block.typeId === "cameraFade") {
            const result = genCameraFadeCode(block, { particleVar });
            if (result) lines.push(...result);
            continue;
        }

        // ── positionSequential ──
        if (block.typeId === "positionSequential") {
            const result = genPositionSequentialCode(block, { particleVar, compiler, contextId });
            if (result) lines.push(...result);
            continue;
        }

        // ── connectTarget ──
        if (block.typeId === "connectTarget") {
            const result = genConnectTargetCode(block, { particleVar });
            if (result) lines.push(...result);
            continue;
        }

        // ── flipbookPlay ──
        if (block.typeId === "flipbookPlay") {
            const result = genFlipbookPlayCode(block, { particleVar });
            if (result) lines.push(...result);
            continue;
        }

        // ── screenSpaceSize ──
        if (block.typeId === "screenSpaceSize") {
            const result = genScreenSpaceSizeCode(block, { particleVar });
            if (result) lines.push(...result);
            continue;
        }

        // ── incrementStripIndex ──
        if (block.typeId === "incrementStripIndex") {
            if (!block.enabled) continue;
            const step = Math.max(1, Math.floor(Number((block.props || {}).step) || 1));
            lines.push("");
            lines.push(`    // incrementStripIndex`);
            lines.push(`    ${particleVar}.stripIndex = ${particleVar}.stripIndex + ${step}u;`);
            continue;
        }

        // ── subpixelAA — 编译器端无逻辑，实际由 shader FS 侧 SUBPIXEL_AA define 实现 ──
        if (block.typeId === "subpixelAA") {
            continue;
        }

        // ── triggerEventShape — 复用 killShape 形状判定：粒子进入形状立即 alive=false
        //    配套 OnDie triggerEvent 可自动发射 GPU Event（正确的 Unity 对齐路径）
        if (block.typeId === "triggerEventShape") {
            if (!block.enabled) continue;
            const p = block.props || {};
            const shape = (p.shape as string) || "Sphere";
            const isSolid = (p.mode as string) !== "Inverted";
            const cRaw = p.center;
            const c = (cRaw && cRaw.pos) ? cRaw.pos : (cRaw || { x: 0, y: 0, z: 0 });
            lines.push("");
            lines.push(`    // triggerEventShape (${shape}) — kill-in-shape, pair with OnDie triggerEvent`);
            lines.push(`    {`);
            lines.push(`        vec3 _tec = ${particleVar}.position - vec3(${toFloat(c.x)}, ${toFloat(c.y)}, ${toFloat(c.z)});`);
            if (shape === "AABox") {
                const sz = p.size || { x: 2, y: 2, z: 2 };
                lines.push(`        vec3 _teh = vec3(${toFloat(sz.x)}, ${toFloat(sz.y)}, ${toFloat(sz.z)}) * 0.5;`);
                lines.push(`        vec3 _tea = abs(_tec);`);
                if (isSolid) {
                    lines.push(`        if (_tea.x < _teh.x && _tea.y < _teh.y && _tea.z < _teh.z) ${particleVar}.alive = false;`);
                } else {
                    lines.push(`        if (_tea.x > _teh.x || _tea.y > _teh.y || _tea.z > _teh.z) ${particleVar}.alive = false;`);
                }
            } else {
                const r = toFloat(p.radius ?? 1);
                lines.push(`        float _ted = dot(_tec, _tec);`);
                if (isSolid) {
                    lines.push(`        if (_ted <= ${r} * ${r}) ${particleVar}.alive = false;`);
                } else {
                    lines.push(`        if (_ted >= ${r} * ${r}) ${particleVar}.alive = false;`);
                }
            }
            lines.push(`    }`);
            continue;
        }

        // ── setPositionDepthBuffer — 粒子吸附到场景表面（贴花/雨滴）
        if (block.typeId === "setPositionDepthBuffer") {
            if (!block.enabled) continue;
            if (compiler) {
                (compiler as any)._needsCamera = true;
                (compiler as any)._propertyUniforms.set("CameraDepthTexture_INJECT2", { type: "Texture2D", _rawUniformName: "u_CameraDepthTexture" });
                (compiler as any)._propertyUniforms.set("VfxViewProjection_INJECT2", { _rawUniformName: "u_VfxViewProjection", _glslType: "mat4" });
                (compiler as any)._propertyUniforms.set("VfxInvViewProjection_INJECT2", { _rawUniformName: "u_VfxInvViewProjection", _glslType: "mat4" });
            }
            const p = block.props || {};
            const offset = toFloat(p.offset ?? 0.01);
            const space = simulateSpace ?? "Local";
            lines.push("");
            lines.push(`    // setPositionDepthBuffer`);
            lines.push(`    {`);
            if (space === "Local") {
                lines.push(`        vec3 _spdWorld = (u_EmitterWorldMatrix * vec4(${particleVar}.position, 1.0)).xyz;`);
            } else {
                lines.push(`        vec3 _spdWorld = ${particleVar}.position;`);
            }
            lines.push(`        vec4 _spdClip = u_VfxViewProjection * vec4(_spdWorld, 1.0);`);
            lines.push(`        if (_spdClip.w > 0.0) {`);
            lines.push(`            vec3 _spdNdc = _spdClip.xyz / _spdClip.w;`);
            lines.push(`            vec2 _spdUV = _spdNdc.xy * 0.5 + 0.5;`);
            lines.push(`            if (_spdUV.x >= 0.0 && _spdUV.x <= 1.0 && _spdUV.y >= 0.0 && _spdUV.y <= 1.0) {`);
            lines.push(`                float _spdDepth = textureLod(u_CameraDepthTexture, _spdUV, 0.0).r;`);
            lines.push(`                if (_spdDepth < 0.9999) {`);
            lines.push(`                    vec4 _spdSC = vec4(_spdNdc.x, _spdNdc.y, _spdDepth, 1.0);`);
            lines.push(`                    vec4 _spdW4 = u_VfxInvViewProjection * _spdSC;`);
            lines.push(`                    vec3 _spdSurf = _spdW4.xyz / _spdW4.w;`);
            // 沿相机→表面方向偏移一点避免 Z-fight
            lines.push(`                    vec3 _spdOff = normalize(_spdSurf - u_VfxCameraParams.xyz) * (-${offset});`);
            if (space === "Local") {
                lines.push(`                    ${particleVar}.position = (u_InvEmitterWorldMatrix * vec4(_spdSurf + _spdOff, 1.0)).xyz;`);
            } else {
                lines.push(`                    ${particleVar}.position = _spdSurf + _spdOff;`);
            }
            lines.push(`                }`);
            lines.push(`            }`);
            lines.push(`        }`);
            lines.push(`    }`);
            continue;
        }

        // ── collisionDepthBuffer (reconstruct scene world pos from depth, compare with particle)
        //    对齐 Unity VFX Graph Collide (Depth Buffer)
        //    时序：compute 在 render 前跑，读上一帧深度（1 帧 lag 对碰撞可接受）
        if (block.typeId === "collisionDepthBuffer") {
            if (!block.enabled) continue;
            // 触发 needsCamera 让 VfxShaderGen 注入 u_VfxCameraParams* uniforms
            if (compiler) {
                (compiler as any)._needsCamera = true;
                // 经由 _propertyUniforms 注入 depth texture + VP 矩阵 uniform（绕过模板缓存）
                (compiler as any)._propertyUniforms.set("CameraDepthTexture_INJECT", { type: "Texture2D", _rawUniformName: "u_CameraDepthTexture" });
                (compiler as any)._propertyUniforms.set("VfxViewProjection_INJECT", { _rawUniformName: "u_VfxViewProjection", _glslType: "mat4" });
                (compiler as any)._propertyUniforms.set("VfxInvViewProjection_INJECT", { _rawUniformName: "u_VfxInvViewProjection", _glslType: "mat4" });
            }
            const p = block.props || {};
            const mode = (p.mode as string) || "Kill";
            const radius = toFloat(p.radius ?? 0.05);
            const bounce = toFloat(p.bounce ?? 0.5);
            const friction = toFloat(p.friction ?? 0.2);
            const space = simulateSpace ?? "Local";
            lines.push("");
            lines.push(`    // collisionDepthBuffer (${mode})`);
            lines.push(`    {`);
            // 粒子世界坐标（若 Local 空间则经 EmitterWorldMatrix 变换）
            if (space === "Local") {
                lines.push(`        vec3 _cdbWorld = (u_EmitterWorldMatrix * vec4(${particleVar}.position, 1.0)).xyz;`);
            } else {
                lines.push(`        vec3 _cdbWorld = ${particleVar}.position;`);
            }
            // 投影到 NDC / 屏幕 UV
            lines.push(`        vec4 _cdbClip = u_VfxViewProjection * vec4(_cdbWorld, 1.0);`);
            lines.push(`        if (_cdbClip.w > 0.0) {`);
            lines.push(`            vec3 _cdbNdc = _cdbClip.xyz / _cdbClip.w;`);
            lines.push(`            vec2 _cdbUV = _cdbNdc.xy * 0.5 + 0.5;`);
            // 屏幕内检查
            lines.push(`            if (_cdbUV.x >= 0.0 && _cdbUV.x <= 1.0 && _cdbUV.y >= 0.0 && _cdbUV.y <= 1.0) {`);
            lines.push(`                float _cdbSceneDepth = textureLod(u_CameraDepthTexture, _cdbUV, 0.0).r;`);
            // 重建场景 world 位置
            lines.push(`                vec4 _cdbSceneClip = vec4(_cdbNdc.x, _cdbNdc.y, _cdbSceneDepth, 1.0);`);
            lines.push(`                vec4 _cdbSceneW4 = u_VfxInvViewProjection * _cdbSceneClip;`);
            lines.push(`                vec3 _cdbSceneW = _cdbSceneW4.xyz / _cdbSceneW4.w;`);
            // 用相机方向向量判断粒子是否在场景表面后方（跨平台稳定，不依赖 NDC.z 方向）
            lines.push(`                vec3 _cdbViewDir = normalize(_cdbWorld - u_VfxCameraParams.xyz);`);
            lines.push(`                float _cdbPartView = dot(_cdbWorld - u_VfxCameraParams.xyz, _cdbViewDir);`);
            lines.push(`                float _cdbSceneView = dot(_cdbSceneW - u_VfxCameraParams.xyz, _cdbViewDir);`);
            // 粒子到相机距离 >= 场景距离 - radius → 已抵达或穿越表面（单边判定，高速粒子不漏）
            // sceneDepth < 0.9999 排除天空 / 远平面像素
            lines.push(`                bool _cdbHit = _cdbSceneDepth < 0.9999 && _cdbPartView >= _cdbSceneView - ${radius};`);
            lines.push(`                if (_cdbHit) {`);
            if (mode === "Bounce") {
                // 直接反转速度（简化法线推导；对地面/墙的常见碰撞足够）
                // 沿速度反方向推离表面防穿透
                lines.push(`                    vec3 _cdbV = ${particleVar}.velocity;`);
                lines.push(`                    float _cdbSpeed = length(_cdbV);`);
                lines.push(`                    if (_cdbSpeed > 1e-5) {`);
                lines.push(`                        vec3 _cdbVDir = _cdbV / _cdbSpeed;`);
                lines.push(`                        ${particleVar}.position = ${particleVar}.position - _cdbVDir * ${radius} * 2.0;`);
                lines.push(`                        ${particleVar}.velocity = -_cdbV * ${bounce} * (1.0 - ${friction});`);
                lines.push(`                    }`);
            } else {
                lines.push(`                    ${particleVar}.alive = false;`);
            }
            lines.push(`                }`);
            lines.push(`            }`);
            lines.push(`        }`);
            lines.push(`    }`);
            continue;
        }

        // ── collisionSDF — SDF 纹理碰撞（对齐 Unity VFX Collide SDF）
        if (block.typeId === "collisionSDF") {
            if (!block.enabled) continue;
            const p = block.props || {};
            const texUuid = p.texture as string;
            const mode = (p.mode as string) || "Bounce";
            // P1: 对齐 Unity CollisionBase 默认值 (bounce 0.1, friction 0.0)
            const bounce = toFloat(p.bounce ?? 0.1);
            const friction = toFloat(p.friction ?? 0.0);
            const radius = toFloat(p.radius ?? 0.01);
            const centerRaw = p.center;
            const c = (centerRaw && centerRaw.pos) ? centerRaw.pos : (centerRaw || { x: 0, y: 0, z: 0 });
            const s = p.size || { x: 1, y: 1, z: 1 };
            const propName = `SDF_${block.id}`;
            const uniformName = `u_VfxProp_${propName}`;
            // 对齐 sampleTexture3D/vectorFieldForce：无条件注册 uniform，
            // texUuid 为空时允许运行时通过 setTexture 绑定（否则 shader 引用未声明 uniform 会崩）
            if (compiler) {
                (compiler as any)._propertyUniforms.set(propName, { type: "Texture3D", textureProp: texUuid || "" });
            }
            lines.push("");
            lines.push(`    // collisionSDF (${mode}) — 对齐 Unity VFX CollisionSDF + CollisionBase`);
            lines.push(`    {`);
            lines.push(`        vec3 _sdfCenter = vec3(${toFloat(c.x)}, ${toFloat(c.y)}, ${toFloat(c.z)});`);
            lines.push(`        vec3 _sdfSize = vec3(${toFloat(s.x)}, ${toFloat(s.y)}, ${toFloat(s.z)});`);
            // P0: 用 nextPos 预测碰撞（防高速粒子穿透 tunneling）
            lines.push(`        vec3 _sdfNextPos = ${particleVar}.position + ${particleVar}.velocity * u_DeltaTime;`);
            lines.push(`        vec3 _sdfUVW = (_sdfNextPos - _sdfCenter) / max(_sdfSize, vec3(1e-4)) + vec3(0.5);`);
            lines.push(`        if (all(greaterThanEqual(_sdfUVW, vec3(0.0))) && all(lessThanEqual(_sdfUVW, vec3(1.0)))) {`);
            lines.push(`            float _sdfDist = textureLod(${uniformName}, _sdfUVW, 0.0).r;`);
            lines.push(`            if (_sdfDist < ${radius}) {`);
            // P1: 固定 UVW 步长 0.01（对齐 Unity SampleSDFDerivatives 的 kStep）
            lines.push(`                const float _sdfStepH = 0.01;`);
            lines.push(`                vec3 _sdfGrad = vec3(`);
            lines.push(`                    textureLod(${uniformName}, _sdfUVW + vec3(_sdfStepH, 0, 0), 0.0).r - textureLod(${uniformName}, _sdfUVW - vec3(_sdfStepH, 0, 0), 0.0).r,`);
            lines.push(`                    textureLod(${uniformName}, _sdfUVW + vec3(0, _sdfStepH, 0), 0.0).r - textureLod(${uniformName}, _sdfUVW - vec3(0, _sdfStepH, 0), 0.0).r,`);
            lines.push(`                    textureLod(${uniformName}, _sdfUVW + vec3(0, 0, _sdfStepH), 0.0).r - textureLod(${uniformName}, _sdfUVW - vec3(0, 0, _sdfStepH), 0.0).r`);
            lines.push(`                );`);
            // P0: safe normalize（移除原 +X bias，长度过小时退化为 up 向量）
            lines.push(`                float _sdfGradLen = length(_sdfGrad);`);
            lines.push(`                vec3 _sdfNormal = _sdfGradLen > 1e-6 ? _sdfGrad / _sdfGradLen : vec3(0.0, 1.0, 0.0);`);
            if (mode === "Bounce") {
                lines.push(`                vec3 _sdfV = ${particleVar}.velocity;`);
                lines.push(`                float _sdfVn = dot(_sdfV, _sdfNormal);`);
                lines.push(`                if (_sdfVn < 0.0) {`);
                // P0: 对齐 Unity CollisionBase — 法向反射 + 切向摩擦（friction 不作用于法向）
                lines.push(`                    vec3 _sdfVt = _sdfV - _sdfVn * _sdfNormal;`);
                lines.push(`                    ${particleVar}.velocity = _sdfV - (1.0 + ${bounce}) * _sdfVn * _sdfNormal - ${friction} * _sdfVt;`);
                lines.push(`                    ${particleVar}.position += _sdfNormal * (${radius} - _sdfDist);`);
                lines.push(`                }`);
            } else {
                lines.push(`                ${particleVar}.alive = false;`);
            }
            lines.push(`            }`);
            lines.push(`        }`);
            lines.push(`    }`);
            continue;
        }

        // ── attractorShapeSDF — SDF 吸附力场（对齐 Unity VFX ConformToSDF）
        //    算法：bounds 外拉向 center；bounds 内梯度方向（外侧反向指向表面）；
        //    smoothstep 过渡：近表面 stickForce，远表面 attractionForce；
        //    目标速度 = attractionSpeed * ratio；加速度 = lerp(stickForce, attractionForce, ratio)。
        if (block.typeId === "attractorShapeSDF") {
            if (!block.enabled) continue;
            const p = block.props || {};
            const texUuid = p.texture as string;
            const attractionSpeed = toFloat(p.attractionSpeed ?? 5);
            const attractionForce = toFloat(p.attractionForce ?? 20);
            const stickDistance = toFloat(p.stickDistance ?? 0.1);
            const stickForce = toFloat(p.stickForce ?? 50);
            const centerRaw = p.center;
            const c = (centerRaw && centerRaw.pos) ? centerRaw.pos : (centerRaw || { x: 0, y: 0, z: 0 });
            const s = p.size || { x: 1, y: 1, z: 1 };
            const propName = `SDFAttr_${block.id}`;
            const uniformName = `u_VfxProp_${propName}`;
            // 对齐 sampleTexture3D/vectorFieldForce：无条件注册 uniform，
            // texUuid 为空时允许运行时通过 setTexture 绑定
            if (compiler) {
                (compiler as any)._propertyUniforms.set(propName, { type: "Texture3D", textureProp: texUuid || "" });
            }
            lines.push("");
            lines.push(`    // attractorShapeSDF — Unity ConformToSDF 对齐`);
            lines.push(`    {`);
            lines.push(`        vec3 _saCenter = vec3(${toFloat(c.x)}, ${toFloat(c.y)}, ${toFloat(c.z)});`);
            lines.push(`        vec3 _saSize = vec3(${toFloat(s.x)}, ${toFloat(s.y)}, ${toFloat(s.z)});`);
            lines.push(`        float _saScaling = max(_saSize.x, max(_saSize.y, _saSize.z));`);
            // 世界 → 归一化本地 [-0.5, 0.5]；UVW saturate 防越界
            lines.push(`        vec3 _saTPos = (${particleVar}.position - _saCenter) / max(_saSize, vec3(1e-4));`);
            lines.push(`        vec3 _saCoord = clamp(_saTPos + vec3(0.5), vec3(0.0), vec3(1.0));`);
            lines.push(`        float _saDist = textureLod(${uniformName}, _saCoord, 0.0).r;`);
            lines.push(`        vec3 _saAbs = abs(_saTPos);`);
            lines.push(`        float _saOut = max(_saAbs.x, max(_saAbs.y, _saAbs.z));`);
            lines.push(`        vec3 _saDir;`);
            lines.push(`        if (_saOut > 0.5) {`);
            // bounds 外：dist += (outDist - 0.5)，方向指向 center
            lines.push(`            _saDist += _saOut - 0.5;`);
            lines.push(`            vec3 _saToC = _saCenter - ${particleVar}.position;`);
            lines.push(`            float _saTcL = length(_saToC);`);
            lines.push(`            _saDir = _saTcL > 1e-6 ? _saToC / _saTcL : vec3(0.0, 1.0, 0.0);`);
            lines.push(`        } else {`);
            // bounds 内：3-tap 正向梯度（对齐 Unity SampleSDFDerivativesFast，kStep=0.01）
            lines.push(`            const float _saH = 0.01;`);
            lines.push(`            vec3 _saGrad = vec3(`);
            lines.push(`                textureLod(${uniformName}, _saCoord + vec3(_saH, 0, 0), 0.0).r - _saDist,`);
            lines.push(`                textureLod(${uniformName}, _saCoord + vec3(0, _saH, 0), 0.0).r - _saDist,`);
            lines.push(`                textureLod(${uniformName}, _saCoord + vec3(0, 0, _saH), 0.0).r - _saDist`);
            lines.push(`            );`);
            // dist > 0（外侧）时反向，让方向始终指向表面
            lines.push(`            if (_saDist > 0.0) _saGrad = -_saGrad;`);
            lines.push(`            float _saGL = length(_saGrad);`);
            lines.push(`            _saDir = _saGL > 1e-6 ? _saGrad / _saGL : vec3(0.0, 1.0, 0.0);`);
            lines.push(`        }`);
            // |distToSurface| 世界单位
            lines.push(`        float _saDts = abs(_saDist) * _saScaling;`);
            lines.push(`        float _saSpdN = dot(_saDir, ${particleVar}.velocity);`);
            // ratio ∈ [0,1]：0 = 贴表面用 stickForce，1 = 远距用 attractionForce
            lines.push(`        float _saRatio = smoothstep(0.0, ${toFloat(stickDistance)} * 2.0, _saDts);`);
            lines.push(`        float _saTgtSpd = sign(_saDts) * ${toFloat(attractionSpeed)} * _saRatio;`);
            lines.push(`        float _saDeltaSpd = _saTgtSpd - _saSpdN;`);
            lines.push(`        float _saAccLim = mix(${toFloat(stickForce)}, ${toFloat(attractionForce)}, _saRatio);`);
            // 加速度限制：单帧速度变化不超过 acc * dt（防数值爆炸）
            lines.push(`        float _saStep = sign(_saDeltaSpd) * min(abs(_saDeltaSpd), u_DeltaTime * _saAccLim);`);
            lines.push(`        ${particleVar}.velocity += _saStep * _saDir / max(${particleVar}.mass, 1e-6);`);
            lines.push(`    }`);
            continue;
        }

        // ── positionSDF — 粒子初始位置投影到 SDF 表面（对齐 Unity PositionSDF.cs）
        //    算法：球体内随机点 → Newton 迭代投影到 d=0 表面（Volume 模式支持 thickness 壳）
        if (block.typeId === "positionSDF") {
            if (!block.enabled) continue;
            const p = block.props || {};
            const texUuid = p.texture as string;
            const centerRaw = p.center;
            const c = (centerRaw && centerRaw.pos) ? centerRaw.pos : (centerRaw || { x: 0, y: 0, z: 0 });
            const s = p.size || { x: 1, y: 1, z: 1 };
            const positionMode = (p.positionMode as string) || "Surface";
            const thickness = toFloat(p.thickness ?? 0.1);
            const nSteps = Math.max(1, Math.min(8, Math.floor((p.projectionSteps as number) ?? 2)));
            const compP = (p.composition as string) || "Overwrite";
            const assignOpP = compP === "Add" ? "+=" : "=";
            const effThickness = positionMode === "Volume" ? thickness : 0;
            const propNameP = `PosSDF_${block.id}`;
            const uniformNameP = `u_VfxProp_${propNameP}`;
            if (compiler) {
                (compiler as any)._propertyUniforms.set(propNameP, { type: "Texture3D", textureProp: texUuid || "" });
            }
            lines.push("");
            lines.push(`    // positionSDF (${positionMode}, steps=${nSteps}) — Unity PositionSDF.cs`);
            lines.push(`    {`);
            lines.push(`        vec3 _psdCenter = vec3(${toFloat(c.x)}, ${toFloat(c.y)}, ${toFloat(c.z)});`);
            lines.push(`        vec3 _psdSize = vec3(${toFloat(s.x)}, ${toFloat(s.y)}, ${toFloat(s.z)});`);
            lines.push(`        float _psdScaling = max(_psdSize.x, max(_psdSize.y, _psdSize.z));`);
            lines.push(`        float _psdThickness = ${toFloat(effThickness)};`);
            // 球面方向 + 球体内半径随机（对齐 setPositionShape Sphere Volume 的分布）
            lines.push(`        uint _psdSeed = WangHash(particleIndex ^ uint(u_SystemSeed) ^ 0x5DF1u);`);
            lines.push(`        float _psdCosPhi = 2.0 * Rand(_psdSeed) - 1.0;`);
            lines.push(`        float _psdTheta = 6.28318530718 * Rand(_psdSeed);`);
            lines.push(`        float _psdSinPhi = sqrt(1.0 - _psdCosPhi * _psdCosPhi);`);
            lines.push(`        vec3 _psdDir = vec3(sin(_psdTheta) * _psdSinPhi, cos(_psdTheta) * _psdSinPhi, _psdCosPhi);`);
            // tPos 在 [-0.5, 0.5] 归一化空间的球体内随机
            lines.push(`        vec3 _psdTPos = _psdDir * (pow(Rand(_psdSeed), 1.0/3.0) * 0.5);`);
            lines.push(`        vec3 _psdCoord = _psdTPos + vec3(0.5);`);
            // Newton 投影迭代
            for (let i = 0; i < nSteps; i++) {
                lines.push(`        {`);
                lines.push(`            float _psdD = textureLod(${uniformNameP}, _psdCoord, 0.0).r;`);
                // 3-tap 正向差分梯度（kStep 0.05 跨 ~3 voxel 让复杂 SDF gradient 数值稳定）
                lines.push(`            const float _psdH = 0.05;`);
                lines.push(`            vec3 _psdG = vec3(`);
                lines.push(`                textureLod(${uniformNameP}, _psdCoord + vec3(_psdH, 0, 0), 0.0).r - _psdD,`);
                lines.push(`                textureLod(${uniformNameP}, _psdCoord + vec3(0, _psdH, 0), 0.0).r - _psdD,`);
                lines.push(`                textureLod(${uniformNameP}, _psdCoord + vec3(0, 0, _psdH), 0.0).r - _psdD`);
                lines.push(`            );`);
                lines.push(`            float _psdGL = length(_psdG);`);
                // 法线指向表面内部（-梯度归一化），safe fallback up
                lines.push(`            vec3 _psdN = _psdGL > 1e-6 ? -_psdG / _psdGL : vec3(0.0, 1.0, 0.0);`);
                lines.push(`            float _psdDw = _psdD * _psdScaling;`);
                // delta: 外部(d>0) 拉向表面；内部(d<0) 若超出 thickness 壳则拉回壳外沿
                lines.push(`            vec3 _psdDelta = _psdDw > 0.0 ? (_psdDw * _psdN) : (min(_psdDw + _psdThickness, 0.0) * _psdN);`);
                // 世界坐标更新 → 回归一化 coord
                lines.push(`            vec3 _psdWp = _psdTPos * _psdSize + _psdCenter + _psdDelta;`);
                lines.push(`            _psdTPos = (_psdWp - _psdCenter) / max(_psdSize, vec3(1e-4));`);
                lines.push(`            _psdCoord = _psdTPos + vec3(0.5);`);
                lines.push(`        }`);
            }
            // 最终世界位置写入 particle
            // 最终世界位置写入 particle
            lines.push(`        vec3 _psdFinal = _psdTPos * _psdSize + _psdCenter;`);
            lines.push(`        ${particleVar}.position ${assignOpP} _psdFinal;`);
            lines.push(`    }`);
            continue;
        }

        // ── transformPosition: 用注册骨骼/Transform 的世界矩阵变换当前 position
        //    (SkinnedMeshTransform): position = boneWorldMatrix * position
        //    引擎 setTransformSource(name, node) 注入骨骼,_updateTransformSources 每帧绑 Mat4 uniform
        //    → bolts/sparks 跟随该骨骼动画(Unity 真机制,对齐 [Bolts] Init 的 mul(uniform_k,...))
        if (block.typeId === "transformPosition") {
            if (!block.enabled) continue;
            const p = block.props || {};
            const tsrc = (p.transformSource as string) || "";
            if (!tsrc) continue;
            if (compiler) {
                (compiler as any).propertyUniforms.set(`VfxTransform_${tsrc}`, { type: "Mat4", transformSource: tsrc });
            }
            const uni = `u_VfxProp_VfxTransform_${tsrc}`;
            lines.push("");
            lines.push(`    // transformPosition (${tsrc}) — 骨骼世界矩阵驱动,跟随动画`);
            lines.push(`    ${particleVar}.position = (${uni} * vec4(${particleVar}.position, 1.0)).xyz;`);
            continue;
        }

        // ── setPositionMesh (Point Cache)
        //    Vertex: 采 mesh 顶点 (count = vertexCount)
        //    Surface: 按三角形面积加权采样 N 个表面点 (pre-bake)
        //    Volume: AABB 内 rejection sampling 烘焙 N 个内部点 (ray-tri intersection)
        //    三种模式底层都是 Texture2D point cache + shader random idx textureFetch
        if (block.typeId === "setPositionMesh") {
            if (!block.enabled) continue;
            const p = block.props || {};
            const composition = (p.composition as string) || "Overwrite";
            const rawMode = (p.sampleMode as string) || "Vertex";
            // "Random" 旧值兼容映射到 Vertex
            const mode = (rawMode === "Random") ? "Vertex" : rawMode;

            // SkinnedMesh 路径：sourceMesh=SkinnedMeshRenderer，复用 _compileSampleSkinnedMesh 的 helper function
            //   注册 4 张共享 sourceName 的 RGBA32F 纹理（pos/idx/weight/bones）
            //   shader 端调用 helper `_sampleSkinnedMeshPos_<src>(idx)` 拿 skinned 后的 vertex 位置
            //   runtime 通过 effect.setSkinnedMeshSource(name, smr) 注入 SkinnedMeshRenderer
            const skinnedSrc = (p.skinnedMeshSource as string) || "";
            if (skinnedSrc) {
                if (compiler) {
                    const c = compiler as any;
                    const posPropName = `SkinnedMeshPos_${skinnedSrc}`;
                    const idxPropName = `SkinnedMeshIdx_${skinnedSrc}`;
                    const wgtPropName = `SkinnedMeshWeight_${skinnedSrc}`;
                    const bonesPropName = `SkinnedMeshBones_${skinnedSrc}`;
                    c.propertyUniforms.set(posPropName, { type: "Texture2D", skinnedMeshSource: skinnedSrc, skinnedMeshRole: "position" });
                    c.propertyUniforms.set(idxPropName, { type: "Texture2D", skinnedMeshSource: skinnedSrc, skinnedMeshRole: "indices" });
                    c.propertyUniforms.set(wgtPropName, { type: "Texture2D", skinnedMeshSource: skinnedSrc, skinnedMeshRole: "weights" });
                    c.propertyUniforms.set(bonesPropName, { type: "Texture2D", skinnedMeshSource: skinnedSrc, skinnedMeshRole: "bones" });
                    c.skinnedMeshSources.add(skinnedSrc + "|position");
                }
                lines.push("");
                lines.push(`    // setPositionMesh (SkinnedMesh, ${mode})`);
                lines.push(`    {`);
                // SkinnedMesh 顶点数从烘焙纹理宽度读，用 Random per particle 的 vertex idx
                lines.push(`        int _smCount = textureSize(u_VfxProp_SkinnedMeshPos_${skinnedSrc}, 0).x;`);
                lines.push(`        if (_smCount > 0) {`);
                lines.push(`            int _smIdx = int(float(_smCount) * Rand(${particleVar}.seed));`);
                lines.push(`            _smIdx = clamp(_smIdx, 0, _smCount - 1);`);
                lines.push(`            vec3 _smPos = _sampleSkinnedMeshPos_${skinnedSrc}(_smIdx);`);
                if (composition === "Add") {
                    lines.push(`            ${particleVar}.position += _smPos;`);
                } else {
                    lines.push(`            ${particleVar}.position = _smPos;`);
                }
                lines.push(`        }`);
                lines.push(`    }`);
                continue;
            }

            // Mesh 路径：用 mesh 烘焙的 point cache
            // IDE auto-fill 可能塞 mesh:0 (number) 而非 res:// UUID — 严格校验后再走 mesh 路径，
            // 否则 String(0)="0" 会 truthy 让代码引用未注册 uniform 并把 position 错误重写为空 mesh 默认值
            const rawMesh = p.mesh;
            const meshUuid = (typeof rawMesh === "string" && rawMesh.trim() && rawMesh !== "0") ? rawMesh : "";
            const pointCount = Math.max(16, Math.min(8192, Number(p.pointCount) || 1024));
            // mesh 点云顶点缩放(转换器按 mesh fileScale 注入,缺省 1.0):cm-unit/fileScale 未应用的
            // mesh(Ellen.fbx=0.01 / AlienStatue=0.2)缩回世界尺度;内置 mesh 用 1.0。替代引擎硬编码 ×0.01。
            const meshScale = Number(p.meshScale) > 0 ? Number(p.meshScale) : 1;
            const meshRole = mode === "Surface" ? "surfacePoints"
                : mode === "Volume" ? "volumePoints"
                : "position";
            const propName = `MeshPC_${block.id}_${mode}`;
            const uniformName = `u_VfxProp_${propName}`;
            if (meshUuid && compiler) {
                (compiler as any)._propertyUniforms.set(propName, {
                    type: "Texture2D",
                    meshProp: meshUuid,
                    meshRole,
                    pointCount,
                    meshScale,
                });
            }
            lines.push("");
            lines.push(`    // setPositionMesh (Point Cache, Random)`);
            if (meshUuid) {
                lines.push(`    {`);
                lines.push(`        int _mvCount = textureSize(${uniformName}, 0).x;`);
                lines.push(`        if (_mvCount > 0) {`);
                lines.push(`            int _mvIdx = int(float(_mvCount) * Rand(${particleVar}.seed));`);
                lines.push(`            _mvIdx = clamp(_mvIdx, 0, _mvCount - 1);`);
                lines.push(`            vec3 _mvPos = texelFetch(${uniformName}, ivec2(_mvIdx, 0), 0).xyz;`);
                if (composition === "Add") {
                    lines.push(`            ${particleVar}.position += _mvPos;`);
                } else {
                    lines.push(`            ${particleVar}.position = _mvPos;`);
                }
                lines.push(`        }`);
                lines.push(`    }`);
            } else {
                lines.push(`    // (no mesh assigned)`);
            }
            continue;
        }

        // ── setSpawnTime ──
        if (block.typeId === "setSpawnTime") {
            if (!block.enabled) continue;
            lines.push("");
            lines.push(`    // setSpawnTime`);
            lines.push(`    ${particleVar}.spawnTime = u_TotalTime;`);
            continue;
        }

        // ── calculateMassFromVolume ──
        // Unity VFX Graph: 根据基础形状（Box/Sphere/Cylinder/Cone）+ density 计算粒子 mass
        if (block.typeId === "calculateMassFromVolume") {
            if (!block.enabled) continue;
            const props = block.props || {};
            const density = toFloat(props.density ?? 1);
            const shape = (props.shape as string) || "Box";
            const composition = (props.composition as string) || "Overwrite";
            // V = volExpr，mass = V * density
            const sx = `${particleVar}.scale.x`;
            const sy = `${particleVar}.scale.y`;
            const sz = `${particleVar}.scale.z`;
            let volExpr: string;
            switch (shape) {
                case "Sphere":
                    // (4/3)π × (sx/2)^3 — sx 视为直径
                    volExpr = `(4.18879020479) * pow(${sx} * 0.5, 3.0)`;
                    break;
                case "Cylinder":
                    // π × (sx/2)^2 × sy — sx 直径, sy 高
                    volExpr = `(3.14159265359) * (${sx} * 0.5) * (${sx} * 0.5) * ${sy}`;
                    break;
                case "Cone":
                    // (1/3)π × (sx/2)^2 × sy
                    volExpr = `(1.04719755120) * (${sx} * 0.5) * (${sx} * 0.5) * ${sy}`;
                    break;
                case "Box":
                default:
                    volExpr = `${sx} * ${sy} * ${sz}`;
                    break;
            }
            const newVal = `(${volExpr}) * ${density}`;
            lines.push("");
            lines.push(`    // calculateMassFromVolume (${shape}, density=${density}, ${composition})`);
            switch (composition) {
                case "Add":
                    lines.push(`    ${particleVar}.mass += ${newVal};`);
                    break;
                case "Multiply":
                    lines.push(`    ${particleVar}.mass *= ${newVal};`);
                    break;
                default: // Overwrite
                    lines.push(`    ${particleVar}.mass = ${newVal};`);
                    break;
            }
            continue;
        }

        // ── gravity ──
        if (block.typeId === "gravity") {
            const result = genGravityCode(block, { particleVar, compiler, contextId, simulateSpace: simulateSpace ?? "Local" });
            if (result) lines.push(...result);
            continue;
        }

        // ── tileWarpPositions ──
        if (block.typeId === "tileWarpPositions") {
            if (!block.enabled) continue;
            const tw = block.props || {};
            const centerRaw = tw.center;
            const centerVal = (centerRaw && centerRaw.pos) ? centerRaw.pos : (centerRaw || { x: 0, y: 0, z: 0 });
            const sizeVal = tw.size || { x: 10, y: 10, z: 10 };
            lines.push("");
            lines.push(`    // tileWarpPositions`);
            lines.push(`    {`);
            lines.push(`        vec3 _twCenter = vec3(${toFloat(centerVal.x)}, ${toFloat(centerVal.y)}, ${toFloat(centerVal.z)});`);
            lines.push(`        vec3 _twSize = vec3(${toFloat(sizeVal.x)}, ${toFloat(sizeVal.y)}, ${toFloat(sizeVal.z)});`);
            lines.push(`        vec3 _twHalf = _twSize * 0.5;`);
            lines.push(`        ${particleVar}.position = _twCenter + fract((${particleVar}.position - _twCenter + _twHalf) / _twSize) * _twSize - _twHalf;`);
            lines.push(`    }`);
            continue;
        }

        // ── velocity variants ──
        if (block.typeId === "velTangent") {
            const result = genVelocityTangentCode(block, { particleVar, compiler, contextId });
            if (result) lines.push(...result);
            continue;
        }
        if (block.typeId === "velSpeed") {
            const result = genVelocitySpeedCode(block, { particleVar, compiler, contextId });
            if (result) lines.push(...result);
            continue;
        }
        if (block.typeId === "velRandom" || block.typeId === "velSpherical" || block.typeId === "velAlongVelocity") {
            const result = genVelocityVariantCode(block, { particleVar, compiler, contextId });
            if (result) lines.push(...result);
            continue;
        }

        // ── velocityFromDirection ──
        if (block.typeId === "velNewDirection") {
            const result = genVelocityFromDirectionCode(block, {
                particleVar,
                compiler,
                contextId,
            });
            if (result) lines.push(...result);
            continue;
        }

        // ── setAttributeCurve ──
        if (block.typeId === "setAttributeCurve") {
            const result = genSetAttributeCurveCode(block, {
                particleVar,
                compiler,
                contextId,
            });
            if (result) lines.push(...result);
            continue;
        }

        if (block.typeId !== "setAttribute") continue;

        const result = genSetAttributeBlockCode(block, {
            particleVar,
            compiler,
            contextId,
            simulateSpace,
            supportSource,
            sourceUnavailableComment,
        });
        if (result) lines.push(...result);
    }

    return lines.join("\n");
}

// ─── setAttribute Block 代码生成 ─────────────────────────

export interface ISetAttributeCodeOptions {
    /** 粒子变量名 */
    particleVar: string;
    /** 编译器实例 */
    compiler?: VfxExprCompiler;
    /** Context ID */
    contextId?: number;
    /** 模拟空间 */
    simulateSpace?: string;
    /** 是否支持 Source 数据源（Initialize: true, Update/Output: false） */
    supportSource?: boolean;
    /** Source 不可用时的注释（Update 用） */
    sourceUnavailableComment?: string;
}

/**
 * 为单个 setAttribute block 生成 GLSL 代码行。
 * 返回 null 表示该 block 应跳过。
 */
export function genSetAttributeBlockCode(
    block: IVfxBlockData,
    opts: ISetAttributeCodeOptions,
): string[] | null {
    const { particleVar, compiler, contextId, simulateSpace } = opts;

    // ── enabled 输入端口：运行时条件控制 ──
    let enabledExpr: string | null = null;
    let enabledStmts: string[] = [];
    if (compiler && contextId != null) {
        const enabledResult = compiler.compileBlockInput(contextId, `block_${block.id}_enabled`);
        if (enabledResult) {
            enabledExpr = enabledResult.expr;
            enabledStmts = enabledResult.stmts;
        }
    }
    // 无连接且静态禁用 → 编译期跳过
    if (!enabledExpr && !block.enabled) return null;

    const p = block.props || {};
    const attrName = (p.attribute as string) || "position";
    const attrType = getAttributeType(attrName);
    const composition = (p.composition as string) || "Overwrite";
    const source = (p.source as string) || "Slot";
    const random = (p.random as string) || "Off";
    const vals = p._values || {};
    const blockSpace = (p._space as string) || "Local";
    const simSpace = simulateSpace ?? "Local";
    // Unity SetAttribute.channels 位掩码（X=1, Y=2, Z=4），决定 vec3 哪些分量被写
    // 7 (默认)=全 xyz, 6=yz, 5=xz, 3=xy, 1=只 x, 2=只 y, 4=只 z
    const channels = (typeof p.channels === "number") ? p.channels : 7;

    // 基础缩进：有 enabled 条件时多缩进一层
    const indent = enabledExpr ? "        " : "    ";

    /** 包裹 inline 值的空间转换 */
    const wrapSpace = (expr: string) => wrapInlineSpaceConvert(expr, attrName, blockSpace, simSpace);

    // 收集 block 代码到临时数组
    const blockLines: string[] = [];
    /** 选择性按 channels mask 赋值（vec3/color attr + channels != 7 时走 swizzle 路径） */
    const applyAssign = (expr: string) => applyCompositionWithChannels(blockLines, attrName, attrType, expr, composition, vals, indent, particleVar, channels, block.id);

    if (source === "Source") {
        if (opts.supportSource) {
            applyAssign(`src.${attrName}`);
        } else if (opts.sourceUnavailableComment) {
            blockLines.push(`${indent}// ${opts.sourceUnavailableComment}`);
        } else {
            return null; // Output 阶段直接跳过
        }
    } else if (source === "SpawnIndex") {
        // ⭐ vec 类属性(如 color 逐蜡烛蜡池色写 .b 通道)必须把标量 spawnIndex 广播成对应 vec 类型,
        //    否则 applyCompositionWithChannels 生成 `vec3 _chanV = float(id)`(标量赋 vec3)编译报错。
        const _isVec = attrType === "vec3" || attrType === "color" || attrType === "vec2" || attrType === "vec4";
        if (_isVec) {
            const _gt = attrType === "vec2" ? "vec2" : (attrType === "vec4" ? "vec4" : "vec3");
            applyAssign(`${_gt}(float(id))`);
        } else {
            applyAssign((attrType === "uint" || attrType === "int") ? "id" : "float(id)");
        }
    } else if (compiler && contextId != null) {
        // 尝试从 Operator 连线编译表达式
        const compiled = compiler.compileSetAttributeValue(contextId, block.id, attrType, vals);
        if (compiled && random !== "Off" && attrType !== "bool") {
            // op 驱动 MinMax random（如 getProperty(vec2MinMax) .x→A .y→B）：
            // 必须 mix(A, B, Rand)，不能拿 A 链当常量（否则全部粒子同值，随机失效）。
            // B 无链接时退化 inline b_ 值。
            // ⚠不能用 { } 包裹 op 语句：编译器对 op 声明做跨块缓存，后续 block 复用同一 op
            // 时只引用不再声明——声明若在花括号作用域里，复用处直接 undeclared。
            // 变量唯一性靠 block.id 后缀保证。
            const compiledB = compiler.compileSetAttributeValue(contextId, block.id, attrType, vals, "b_value");
            const storageT = attrType === "color" ? "vec3" : attrType;
            const gt = GLSL_TYPE[storageT] || "float";
            const vA = `_rndA_${block.id}`, vB = `_rndB_${block.id}`, vV = `_rndV_${block.id}`;
            for (const s of compiled.stmts) blockLines.push(`${indent}${s}`);
            blockLines.push(`${indent}${gt} ${vA} = ${compiled.expr};`);
            if (compiledB) for (const s of compiledB.stmts) blockLines.push(`${indent}${s}`);
            blockLines.push(`${indent}${gt} ${vB} = ${compiledB ? compiledB.expr : valueLiteral(attrType, vals, "b_")};`);
            const comps = storageT === "vec2" ? ["x", "y"]
                : (storageT === "vec3" ? ["x", "y", "z"]
                : (storageT === "vec4" ? ["x", "y", "z", "w"] : []));
            let mixExpr: string;
            if (random === "Uniform" || comps.length === 0) {
                blockLines.push(`${indent}float _rndT_${block.id} = Rand(${particleVar}.seed);`);
                mixExpr = comps.length === 0 ? `mix(${vA}, ${vB}, _rndT_${block.id})` : `mix(${vA}, ${vB}, ${gt}(_rndT_${block.id}))`;
            } else {
                // Per Component: 每分量独立 Rand
                mixExpr = `${gt}(${comps.map(c => `mix(${vA}.${c}, ${vB}.${c}, Rand(${particleVar}.seed))`).join(", ")})`;
            }
            blockLines.push(`${indent}${gt} ${vV} = ${mixExpr};`);
            applyAssign(vV);
        } else if (compiled) {
            // 编译器已处理空间转换
            for (const s of compiled.stmts) blockLines.push(`${indent}${s}`);
            applyAssign(compiled.expr);
        } else if (random !== "Off" && attrType !== "bool") {
            _genRandomCode(blockLines, attrType, vals, random, wrapSpace, composition, attrName, indent, particleVar);
        } else {
            applyAssign(wrapSpace(valueLiteral(attrType, vals, "")));
        }
    } else if (random !== "Off" && attrType !== "bool") {
        _genRandomCode(blockLines, attrType, vals, random, wrapSpace, composition, attrName, indent, particleVar);
    } else {
        applyAssign(wrapSpace(valueLiteral(attrType, vals, "")));
    }

    // 输出到结果，含 enabled 条件包裹
    const lines: string[] = [];
    lines.push("");
    lines.push(`    // setAttribute: ${attrName}`);
    if (enabledExpr) {
        for (const s of enabledStmts) lines.push(`    ${s}`);
        lines.push(`    if (${enabledExpr}) {`);
        lines.push(...blockLines);
        lines.push(`    }`);
    } else {
        lines.push(...blockLines);
    }

    return lines;
}

// ─── velocityFromDirection Block 代码生成 ─────────────

interface IVelocityFromDirOptions {
    particleVar: string;
    compiler?: VfxExprCompiler;
    contextId?: number;
}

/**
 * Velocity from Direction & Speed (New Direction) block
 * velocity = normalize(mix(particle.direction, inputDirection, blendDirection)) * speed
 */
function genVelocityFromDirectionCode(
    block: IVfxBlockData,
    opts: IVelocityFromDirOptions,
): string[] | null {
    const { particleVar, compiler, contextId } = opts;

    // ── enabled 输入端口 ──
    let enabledExpr: string | null = null;
    let enabledStmts: string[] = [];
    if (compiler && contextId != null) {
        const enabledResult = compiler.compileBlockInput(contextId, `block_${block.id}_enabled`);
        if (enabledResult) {
            enabledExpr = enabledResult.expr;
            enabledStmts = enabledResult.stmts;
        }
    }
    if (!enabledExpr && !block.enabled) return null;

    const p = block.props || {};
    const composition = (p.composition as string) || "Overwrite";
    const speedMode = (p.speedMode as string) || "Constant";
    const blendDir = toFloat(p.blendDirection ?? 1);

    const indent = enabledExpr ? "        " : "    ";
    const blockLines: string[] = [];

    // direction 输入：从 operator 连线或回退到属性值
    // direction 是 spaceable 复合类型，数据结构为 { direction: { x, y, z } }
    const dirRaw = p.direction;
    const dirVal = (dirRaw && dirRaw.direction) ? dirRaw.direction : (dirRaw || { x: 0, y: 1, z: 0 });
    let dirExpr = `vec3(${toFloat(dirVal.x)}, ${toFloat(dirVal.y)}, ${toFloat(dirVal.z)})`;
    if (compiler && contextId != null) {
        const dirResult = compiler.compileBlockInput(contextId, `block_${block.id}_direction`);
        if (dirResult) {
            for (const s of dirResult.stmts) blockLines.push(`${indent}${s}`);
            dirExpr = dirResult.expr;
        }
    }

    // blend direction: mix(particle.direction, inputDirection, blendDirection)
    // particle.direction is set by PositionShape (sphere normal) or defaults to (0,0,1)
    blockLines.push(`${indent}vec3 _blendedDir = normalize(mix(${particleVar}.direction, ${dirExpr}, ${blendDir}));`);

    // speed 输入：从 operator 连线或回退到属性值
    let speedExpr: string;
    let speedCompiled = false;
    if (compiler && contextId != null) {
        const speedResult = compiler.compileBlockInput(contextId, `block_${block.id}_speed`);
        if (speedResult) {
            for (const s of speedResult.stmts) blockLines.push(`${indent}${s}`);
            speedExpr = speedResult.expr;
            speedCompiled = true;
        }
    }
    if (!speedCompiled) {
        if (speedMode === "Random") {
            blockLines.push(`${indent}float _speed = mix(${toFloat(p.minSpeed ?? 0)}, ${toFloat(p.maxSpeed ?? 1)}, Rand(${particleVar}.seed));`);
            speedExpr = "_speed";
        } else {
            speedExpr = toFloat(p.speed ?? 1);
        }
    }

    // velocity = direction * speed
    const valueExpr = `_blendedDir * ${speedExpr}`;
    // applyComposition 的 Blend 模式读取 vals.blend，映射 blendVelocity → blend
    const compVals = { ...p, blend: p.blendVelocity ?? 0.5 };
    applyComposition(blockLines, "velocity", valueExpr, composition, compVals, indent, particleVar);

    // 输出
    const lines: string[] = [];
    lines.push("");
    lines.push(`    // velocityFromDirection`);
    if (enabledExpr) {
        for (const s of enabledStmts) lines.push(`    ${s}`);
        lines.push(`    if (${enabledExpr}) {`);
        lines.push(...blockLines);
        lines.push(`    }`);
    } else {
        lines.push(...blockLines);
    }

    return lines;
}

// ─── Velocity Variant Blocks 代码生成 ─────────────────────────

/**
 * velRandom: velocity = normalize(RAND3*2-1) * speed
 * velSpherical: velocity = normalize(position - center) * speed
 * velAlongVelocity: velocity = normalize(velocity) * speed
 */
function genVelocityVariantCode(
    block: IVfxBlockData,
    opts: IVelocityFromDirOptions,
): string[] | null {
    const { particleVar, compiler, contextId } = opts;
    if (!block.enabled) return null;

    const p = block.props || {};
    const composition = (p.composition as string) || "Overwrite";
    const speedMode = (p.speedMode as string) || "Constant";
    const indent = "    ";
    const blockLines: string[] = [];

    // direction
    let dirExpr: string;
    if (block.typeId === "velRandom") {
        blockLines.push(`${indent}vec3 _randDir = normalize(vec3(Rand(${particleVar}.seed), Rand(${particleVar}.seed), Rand(${particleVar}.seed)) * 2.0 - 1.0);`);
        dirExpr = "_randDir";
    } else if (block.typeId === "velSpherical") {
        const centerRaw = p.center;
        const centerVal = (centerRaw && centerRaw.pos) ? centerRaw.pos : (centerRaw || { x: 0, y: 0, z: 0 });
        const centerExpr = `vec3(${toFloat(centerVal.x)}, ${toFloat(centerVal.y)}, ${toFloat(centerVal.z)})`;
        const blendDir = toFloat(p.blendDirection ?? 1);
        blockLines.push(`${indent}vec3 _sphereDir = normalize(${particleVar}.position - ${centerExpr});`);
        blockLines.push(`${indent}vec3 _blendedDir = normalize(mix(${particleVar}.direction, _sphereDir, ${blendDir}));`);
        dirExpr = "_blendedDir";
    } else {
        // velAlongVelocity
        blockLines.push(`${indent}vec3 _velDir = normalize(${particleVar}.velocity);`);
        dirExpr = "_velDir";
    }

    // speed
    let speedExpr: string;
    if (speedMode === "Random") {
        blockLines.push(`${indent}float _speed = mix(${toFloat(p.minSpeed ?? 0)}, ${toFloat(p.maxSpeed ?? 1)}, Rand(${particleVar}.seed));`);
        speedExpr = "_speed";
    } else {
        speedExpr = toFloat(p.speed ?? 1);
    }

    const valueExpr = `${dirExpr} * ${speedExpr}`;
    const compVals = { ...p, blend: p.blendVelocity ?? 0.5 };
    applyComposition(blockLines, "velocity", valueExpr, composition, compVals, indent, particleVar);

    const lines: string[] = [];
    lines.push("");
    lines.push(`    // ${block.typeId}`);
    lines.push(...blockLines);
    return lines;
}

// ─── Linear Drag Block 代码生成 ─────────────────────────────

// ─── Attribute from Map Block 代码生成 ─────────────────────

function genAttributeFromMapCode(
    block: IVfxBlockData,
    opts: { particleVar: string; compiler?: VfxExprCompiler },
): string[] | null {
    if (!block.enabled) return null;
    const { particleVar, compiler } = opts;
    const p = block.props || {};
    const attrName = (p.attribute as string) || "color";
    const composition = (p.composition as string) || "Overwrite";
    const sampleMode = (p.sampleMode as string) || "RandomConstantPerParticle";
    const texUniform = `u_VfxAttrMap_${block.id}`;
    // 注册 texture uniform 到 ShaderGen 的 propertyUniforms（VfxShaderGen 会生成 sampler2D 声明 + 绑定 ShaderData）
    // textureProp 是 res://uuid 形式的资源引用，runtime 会解析为 Texture2D 对象
    const texPropName = (p.texture as string) || "";
    // 没设 texture 时整个 block 跳过 — 不能生成引用未声明 uniform 的 GLSL（'u_VfxAttrMap_<id>' undeclared）
    if (!texPropName) return null;
    if (compiler) {
        compiler.propertyUniforms.set(texUniform, { type: "Texture2D", textureProp: texPropName } as any);
    }

    const lines: string[] = [];
    lines.push("");
    lines.push(`    // attributeFromMap: ${attrName} (${sampleMode})`);
    lines.push(`    {`);

    // UV calculation based on sample mode
    let uvExpr: string;
    switch (sampleMode) {
        case "Random":
            lines.push(`        vec2 _mapUV = vec2(Rand(${particleVar}.seed), Rand(${particleVar}.seed));`);
            uvExpr = "_mapUV";
            break;
        case "RandomConstantPerParticle":
            // Deterministic hash from particleId
            lines.push(`        vec2 _mapUV = vec2(fract(float(${particleVar}.particleId) * 0.6180339887), fract(float(${particleVar}.particleId) * 0.3819660113));`);
            uvExpr = "_mapUV";
            break;
        case "Sequential":
            lines.push(`        vec2 _mapUV = vec2(fract(float(${particleVar}.particleId) / 256.0), 0.5);`);
            uvExpr = "_mapUV";
            break;
        case "Sample2DLOD":
        default: {
            const uvVal = p.uvChannel || { x: 0, y: 0 };
            uvExpr = `vec2(${toFloat(uvVal.x)}, ${toFloat(uvVal.y)})`;
            break;
        }
    }

    const lod = toFloat(p.lod ?? 0);
    lines.push(`        vec4 _mapSample = textureLod(${texUniform}, ${uvExpr}, ${lod});`);

    // Assign to attribute based on type
    // 注意: color 在 Particle struct 里存为 vec3 (RGB)，alpha 是独立 float 字段
    // 所以 color 也要用 .xyz 提取 RGB 三分量
    const attrType = getAttributeType(attrName);
    let valueExpr: string;
    switch (attrType) {
        case "float": valueExpr = "_mapSample.x"; break;
        case "vec2": valueExpr = "_mapSample.xy"; break;
        case "vec3": valueExpr = "_mapSample.xyz"; break;
        case "color": valueExpr = "_mapSample.xyz"; break;
        case "vec4": valueExpr = "_mapSample"; break;
        default: valueExpr = "_mapSample.xyz"; break;
    }

    applyComposition(lines, attrName, valueExpr, composition, p, "        ", particleVar);
    lines.push(`    }`);
    return lines;
}

// ─── Collision Block 代码生成 ─────────────────────────────

/**
 * Collision response (shared): decompose velocity into normal/tangent,
 * apply bounce reflection + friction + lifetime loss.
 */
function collisionResponse(lines: string[], p: Record<string, any>, particleVar: string, indent: string): void {
    const bounce = toFloat(p.bounce ?? 0.1);
    const friction = toFloat(p.friction ?? 0);
    const lifetimeLoss = toFloat(p.lifetimeLoss ?? 0);
    lines.push(`${indent}float _projVel = dot(_n, ${particleVar}.velocity);`);
    lines.push(`${indent}vec3 _normalVel = _projVel * _n;`);
    lines.push(`${indent}vec3 _tangentVel = ${particleVar}.velocity - _normalVel;`);
    lines.push(`${indent}if (_projVel < 0.0) ${particleVar}.velocity -= (1.0 + ${bounce}) * _projVel * _n;`);
    if (Number(p.friction) > 0) {
        lines.push(`${indent}${particleVar}.velocity -= ${friction} * _tangentVel;`);
    }
    if (Number(p.lifetimeLoss) > 0) {
        lines.push(`${indent}${particleVar}.age += ${lifetimeLoss} * ${particleVar}.lifetime;`);
    }
}

function genCollisionCode(
    block: IVfxBlockData,
    opts: { particleVar: string },
): string[] | null {
    if (!block.enabled) return null;
    const { particleVar } = opts;
    const p = block.props || {};
    const isSolid = (p.mode as string) !== "Inverted";
    const sign = isSolid ? "1.0" : "-1.0";
    const lines: string[] = [];
    lines.push("");
    lines.push(`    // ${block.typeId}`);
    lines.push(`    {`);

    const indent = "        ";

    if (block.typeId === "collisionPlane") {
        const posRaw = p.planePosition;
        const posVal = (posRaw && posRaw.pos) ? posRaw.pos : (posRaw || { x: 0, y: 0, z: 0 });
        const normRaw = p.planeNormal;
        const normVal = (normRaw && normRaw.direction) ? normRaw.direction : (normRaw || { x: 0, y: 1, z: 0 });
        lines.push(`${indent}vec3 _planeN = ${sign} * vec3(${toFloat(normVal.x)}, ${toFloat(normVal.y)}, ${toFloat(normVal.z)});`);
        lines.push(`${indent}vec3 _planeP = vec3(${toFloat(posVal.x)}, ${toFloat(posVal.y)}, ${toFloat(posVal.z)});`);
        lines.push(`${indent}float _planeW = dot(_planeP, _planeN);`);
        lines.push(`${indent}vec3 _nextPos = ${particleVar}.position + ${particleVar}.velocity * u_DeltaTime;`);
        lines.push(`${indent}float _dist = dot(_nextPos, _planeN) - _planeW;`);
        lines.push(`${indent}if (_dist < 0.0) {`);
        lines.push(`${indent}    ${particleVar}.position -= _planeN * _dist;`);
        lines.push(`${indent}    vec3 _n = _planeN;`);
        collisionResponse(lines, p, particleVar, indent + "    ");
        lines.push(`${indent}}`);
    } else if (block.typeId === "collisionSphere") {
        const centerRaw = p.center;
        const centerVal = (centerRaw && centerRaw.pos) ? centerRaw.pos : (centerRaw || { x: 0, y: 0, z: 0 });
        const radius = toFloat(p.radius ?? 1);
        const cSign = isSolid ? "1.0" : "-1.0";
        lines.push(`${indent}vec3 _sphCenter = vec3(${toFloat(centerVal.x)}, ${toFloat(centerVal.y)}, ${toFloat(centerVal.z)});`);
        lines.push(`${indent}vec3 _nextPos = ${particleVar}.position + ${particleVar}.velocity * u_DeltaTime;`);
        lines.push(`${indent}vec3 _toCenter = _nextPos - _sphCenter;`);
        lines.push(`${indent}float _dist = length(_toCenter);`);
        lines.push(`${indent}float _signedDist = ${cSign} * (_dist - ${radius});`);
        lines.push(`${indent}if (_signedDist < 0.0) {`);
        lines.push(`${indent}    vec3 _n = ${cSign} * _toCenter / max(_dist, 0.0001);`);
        lines.push(`${indent}    ${particleVar}.position -= _n * _signedDist;`);
        collisionResponse(lines, p, particleVar, indent + "    ");
        lines.push(`${indent}}`);
    } else if (block.typeId === "collisionAABox") {
        const centerRaw = p.center;
        const centerVal = (centerRaw && centerRaw.pos) ? centerRaw.pos : (centerRaw || { x: 0, y: 0, z: 0 });
        const sizeVal = p.size || { x: 2, y: 2, z: 2 };
        lines.push(`${indent}vec3 _boxCenter = vec3(${toFloat(centerVal.x)}, ${toFloat(centerVal.y)}, ${toFloat(centerVal.z)});`);
        lines.push(`${indent}vec3 _boxHalf = vec3(${toFloat(sizeVal.x)}, ${toFloat(sizeVal.y)}, ${toFloat(sizeVal.z)}) * 0.5;`);
        lines.push(`${indent}vec3 _nextPos = ${particleVar}.position + ${particleVar}.velocity * u_DeltaTime;`);
        lines.push(`${indent}vec3 _localP = _nextPos - _boxCenter;`);
        if (isSolid) {
            // Solid: push out if inside box
            lines.push(`${indent}vec3 _absP = abs(_localP);`);
            lines.push(`${indent}vec3 _penetration = _boxHalf - _absP;`);
            lines.push(`${indent}bool _inside = _penetration.x > 0.0 && _penetration.y > 0.0 && _penetration.z > 0.0;`);
            lines.push(`${indent}if (_inside) {`);
            lines.push(`${indent}    float _minPen = min(_penetration.x, min(_penetration.y, _penetration.z));`);
            lines.push(`${indent}    vec3 _n = vec3(0.0);`);
            lines.push(`${indent}    if (_minPen == _penetration.x) _n.x = sign(_localP.x);`);
            lines.push(`${indent}    else if (_minPen == _penetration.y) _n.y = sign(_localP.y);`);
            lines.push(`${indent}    else _n.z = sign(_localP.z);`);
            lines.push(`${indent}    ${particleVar}.position += _n * _minPen;`);
            collisionResponse(lines, p, particleVar, indent + "    ");
            lines.push(`${indent}}`);
        } else {
            // Inverted: push in if outside box
            lines.push(`${indent}vec3 _clamped = clamp(_localP, -_boxHalf, _boxHalf);`);
            lines.push(`${indent}vec3 _diff = _localP - _clamped;`);
            lines.push(`${indent}bool _outside = _diff.x != 0.0 || _diff.y != 0.0 || _diff.z != 0.0;`);
            lines.push(`${indent}if (_outside) {`);
            lines.push(`${indent}    float _diffLen = length(_diff);`);
            lines.push(`${indent}    vec3 _n = (_diffLen > 1e-6) ? -_diff / _diffLen : vec3(0.0, 1.0, 0.0);`);
            lines.push(`${indent}    ${particleVar}.position = _boxCenter + _clamped;`);
            collisionResponse(lines, p, particleVar, indent + "    ");
            lines.push(`${indent}}`);
        }
    }

    lines.push(`    }`);
    return lines;
}

// ─── Kill Block 代码生成（position 流放方案）─────────────────
// 根因：laya WGSL 下，writeParticle 里 `vec4(p.vec3, alive ? 1 : 0)` 的 ternary 在 divergent
//   warp 下被 naga 错误地把分支结果污染同 vec4 slot 的 vec3 分量，导致粒子 position 被破坏。
//   验证过 `float(bool)` / `select()` 等各种 bool→float 转换仍然触发同 bug。
// 解决：不改 alive 字段，通过无分支 step+mix 把 kill 粒子的 position 流放到 (1e20,1e20,1e20)
//   视锥外。粒子仍占粒子池但渲染时被裁剪不可见，视觉等价 alive=false。
//   代价：粒子池容量需略大（kill 粒子占位直到自然寿命终），对大多数场景可接受。

function genKillCode(
    block: IVfxBlockData,
    opts: { particleVar: string },
): string[] | null {
    if (!block.enabled) return null;
    const { particleVar } = opts;
    const p = block.props || {};
    const isSolid = (p.mode as string) !== "Inverted";
    const lines: string[] = [];
    lines.push("");
    lines.push(`    // ${block.typeId} (branchless position-exile — kill-bool writeback workaround)`);

    // 公共尾部：mask (1=kill, 0=keep) → position 被 mix 到 (1e20, 1e20, 1e20) 视锥外
    const emitExile = (insideExpr: string) => {
        const maskExpr = isSolid ? insideExpr : `(1.0 - ${insideExpr})`;
        lines.push(`        float _killMask = ${maskExpr};`);
        lines.push(`        ${particleVar}.position = mix(${particleVar}.position, vec3(1e20), _killMask);`);
    };

    if (block.typeId === "killSphere") {
        const centerRaw = p.center;
        const centerVal = (centerRaw && centerRaw.pos) ? centerRaw.pos : (centerRaw || { x: 0, y: 0, z: 0 });
        const rSq = Number(p.radius ?? 1) ** 2;
        lines.push(`    {`);
        lines.push(`        vec3 _kc = ${particleVar}.position - vec3(${toFloat(centerVal.x)}, ${toFloat(centerVal.y)}, ${toFloat(centerVal.z)});`);
        lines.push(`        float _kd = dot(_kc, _kc);`);
        emitExile(`step(_kd, ${toFloat(rSq)})`);
        lines.push(`    }`);
    } else if (block.typeId === "killAABox") {
        const centerRaw = p.center;
        const centerVal = (centerRaw && centerRaw.pos) ? centerRaw.pos : (centerRaw || { x: 0, y: 0, z: 0 });
        const sizeVal = p.size || { x: 2, y: 2, z: 2 };
        const hx = Number(sizeVal.x) * 0.5, hy = Number(sizeVal.y) * 0.5, hz = Number(sizeVal.z) * 0.5;
        lines.push(`    {`);
        lines.push(`        vec3 _kp = abs(${particleVar}.position - vec3(${toFloat(centerVal.x)}, ${toFloat(centerVal.y)}, ${toFloat(centerVal.z)}));`);
        emitExile(`step(_kp.x, ${toFloat(hx)}) * step(_kp.y, ${toFloat(hy)}) * step(_kp.z, ${toFloat(hz)})`);
        lines.push(`    }`);
    } else if (block.typeId === "killPlane") {
        const posRaw = p.position;
        const posVal = (posRaw && posRaw.pos) ? posRaw.pos : (posRaw || { x: 0, y: 0, z: 0 });
        const normRaw = p.normal;
        const normVal = (normRaw && normRaw.direction) ? normRaw.direction : (normRaw || { x: 0, y: 1, z: 0 });
        const isBelow = (p.mode as string) !== "Above";
        const nLen = Math.hypot(Number(normVal.x), Number(normVal.y), Number(normVal.z)) || 1;
        const nx = Number(normVal.x) / nLen, ny = Number(normVal.y) / nLen, nz = Number(normVal.z) / nLen;
        lines.push(`    {`);
        lines.push(`        vec3 _kpOff = ${particleVar}.position - vec3(${toFloat(posVal.x)}, ${toFloat(posVal.y)}, ${toFloat(posVal.z)});`);
        lines.push(`        float _kpD = dot(_kpOff, vec3(${toFloat(nx)}, ${toFloat(ny)}, ${toFloat(nz)}));`);
        // Below: kill _kpD<=0 → step(_kpD, 0) = 1 iff 0>=_kpD
        // Above: kill _kpD>=0 → 1 - step(_kpD, 0)
        const insideExpr = isBelow ? `step(_kpD, 0.0)` : `(1.0 - step(_kpD, 0.0))`;
        // killPlane 不走 Solid/Inverted，直接写 mask
        lines.push(`        float _killMask = ${insideExpr};`);
        lines.push(`        ${particleVar}.position = mix(${particleVar}.position, vec3(1e20), _killMask);`);
        lines.push(`    }`);
    } else if (block.typeId === "killCone") {
        const centerRaw = p.center;
        const centerVal = (centerRaw && centerRaw.pos) ? centerRaw.pos : (centerRaw || { x: 0, y: 0, z: 0 });
        const axisRaw = p.axis;
        const axisVal = (axisRaw && axisRaw.direction) ? axisRaw.direction : (axisRaw || { x: 0, y: 1, z: 0 });
        const height = toFloat(p.height ?? 1);
        const baseR = toFloat(p.baseRadius ?? 1);
        const axLen = Math.hypot(Number(axisVal.x), Number(axisVal.y), Number(axisVal.z)) || 1;
        const nax = Number(axisVal.x) / axLen, nay = Number(axisVal.y) / axLen, naz = Number(axisVal.z) / axLen;
        lines.push(`    {`);
        lines.push(`        vec3 _kcOff = ${particleVar}.position - vec3(${toFloat(centerVal.x)}, ${toFloat(centerVal.y)}, ${toFloat(centerVal.z)});`);
        lines.push(`        vec3 _kcA = vec3(${toFloat(nax)}, ${toFloat(nay)}, ${toFloat(naz)});`);
        lines.push(`        float _kcH = dot(_kcOff, _kcA);`);
        lines.push(`        vec3 _kcR = _kcOff - _kcA * _kcH;`);
        lines.push(`        float _kcRadSq = dot(_kcR, _kcR);`);
        lines.push(`        float _kcMax = ${baseR} * clamp(_kcH / ${height}, 0.0, 1.0);`);
        lines.push(`        float _kcMaxSq = _kcMax * _kcMax;`);
        emitExile(`step(0.0, _kcH) * step(_kcH, ${height}) * step(_kcRadSq, _kcMaxSq)`);
        lines.push(`    }`);
    } else if (block.typeId === "killTorus") {
        const centerRaw = p.center;
        const centerVal = (centerRaw && centerRaw.pos) ? centerRaw.pos : (centerRaw || { x: 0, y: 0, z: 0 });
        const majR = Number(p.majorRadius ?? 1);
        const minR = Number(p.minorRadius ?? 0.3);
        const outerSq = (majR + minR) ** 2;
        const innerDelta = Math.max(0, majR - minR);
        const innerSq = innerDelta * innerDelta;
        const minorSq = minR * minR;
        lines.push(`    {`);
        lines.push(`        vec3 _ktOff = ${particleVar}.position - vec3(${toFloat(centerVal.x)}, ${toFloat(centerVal.y)}, ${toFloat(centerVal.z)});`);
        lines.push(`        float _ktXZSq = _ktOff.x * _ktOff.x + _ktOff.z * _ktOff.z;`);
        lines.push(`        float _ktYSq = _ktOff.y * _ktOff.y;`);
        emitExile(`step(_ktXZSq, ${toFloat(outerSq)}) * step(${toFloat(innerSq)}, _ktXZSq) * step(_ktYSq, ${toFloat(minorSq)})`);
        lines.push(`    }`);
    } else if (block.typeId === "killOrientedBox") {
        const centerRaw = p.center;
        const centerVal = (centerRaw && centerRaw.pos) ? centerRaw.pos : (centerRaw || { x: 0, y: 0, z: 0 });
        const angleVal = p.angle || { x: 0, y: 0, z: 0 };
        const sizeVal = p.size || { x: 2, y: 2, z: 2 };
        const d2r = Math.PI / 180;
        const ax = Number(angleVal.x) * d2r, ay = Number(angleVal.y) * d2r, az = Number(angleVal.z) * d2r;
        const cx = Math.cos(ax), sx = Math.sin(ax);
        const cy = Math.cos(ay), sy = Math.sin(ay);
        const cz = Math.cos(az), sz = Math.sin(az);
        const m00 = cz, m01 = -sz, m02 = 0;
        const m10 = cx * sz, m11 = cx * cz, m12 = -sx;
        const m20 = sx * sz, m21 = sx * cz, m22 = cx;
        const f00 = cy * m00 + sy * m20, f01 = cy * m01 + sy * m21, f02 = cy * m02 + sy * m22;
        const f10 = m10, f11 = m11, f12 = m12;
        const f20 = -sy * m00 + cy * m20, f21 = -sy * m01 + cy * m21, f22 = -sy * m02 + cy * m22;
        const inv00 = f00, inv01 = f10, inv02 = f20;
        const inv10 = f01, inv11 = f11, inv12 = f21;
        const inv20 = f02, inv21 = f12, inv22 = f22;
        const hx = Number(sizeVal.x) * 0.5, hy = Number(sizeVal.y) * 0.5, hz = Number(sizeVal.z) * 0.5;
        lines.push(`    {`);
        lines.push(`        vec3 _koDelta = ${particleVar}.position - vec3(${toFloat(centerVal.x)}, ${toFloat(centerVal.y)}, ${toFloat(centerVal.z)});`);
        lines.push(`        float _koAX = abs(${toFloat(inv00)} * _koDelta.x + ${toFloat(inv01)} * _koDelta.y + ${toFloat(inv02)} * _koDelta.z);`);
        lines.push(`        float _koAY = abs(${toFloat(inv10)} * _koDelta.x + ${toFloat(inv11)} * _koDelta.y + ${toFloat(inv12)} * _koDelta.z);`);
        lines.push(`        float _koAZ = abs(${toFloat(inv20)} * _koDelta.x + ${toFloat(inv21)} * _koDelta.y + ${toFloat(inv22)} * _koDelta.z);`);
        emitExile(`step(_koAX, ${toFloat(hx)}) * step(_koAY, ${toFloat(hy)}) * step(_koAZ, ${toFloat(hz)})`);
        lines.push(`    }`);
    }

    return lines;
}

// ─── Attractor AABox Block 代码生成 ─────────────────────────────

function genAttractorAABoxCode(
    block: IVfxBlockData,
    opts: { particleVar: string },
): string[] | null {
    if (!block.enabled) return null;
    const { particleVar } = opts;
    const p = block.props || {};
    const centerRaw = p.center;
    const centerVal = (centerRaw && centerRaw.pos) ? centerRaw.pos : (centerRaw || { x: 0, y: 0, z: 0 });
    const sizeVal = p.size || { x: 2, y: 2, z: 2 };
    const attractionSpeed = toFloat(p.attractionSpeed ?? 5);
    const stickDistance = toFloat(p.stickDistance ?? 0.1);
    const stickForce = toFloat(p.stickForce ?? 10);

    const lines: string[] = [];
    lines.push("");
    lines.push(`    // attractorAABox`);
    lines.push(`    {`);
    lines.push(`        vec3 _aabC = vec3(${toFloat(centerVal.x)}, ${toFloat(centerVal.y)}, ${toFloat(centerVal.z)});`);
    lines.push(`        vec3 _aabS = vec3(${toFloat(sizeVal.x)}, ${toFloat(sizeVal.y)}, ${toFloat(sizeVal.z)});`);
    lines.push(`        vec3 _aabSurf = _aaboxClosestSurface(${particleVar}.position, _aabC, _aabS);`);
    lines.push(`        vec3 _aabDir = _aabSurf - ${particleVar}.position;`);
    lines.push(`        float _aabDist = length(_aabDir);`);
    lines.push(`        if (_aabDist > 1e-5) {`);
    lines.push(`            vec3 _aabDirN = _aabDir / _aabDist;`);
    lines.push(`            float _aabRatio = smoothstep(0.0, ${stickDistance} * 2.0, _aabDist);`);
    lines.push(`            float _aabTgtSpd = ${attractionSpeed} * _aabRatio;`);
    lines.push(`            float _aabForce = mix(${stickForce}, ${attractionSpeed}, _aabRatio);`);
    lines.push(`            ${particleVar}.velocity += _aabDirN * (_aabTgtSpd - dot(${particleVar}.velocity, _aabDirN)) * min(1.0, _aabForce * u_DeltaTime);`);
    lines.push(`        }`);
    lines.push(`    }`);
    return lines;
}

// ─── Turbulence Block 代码生成 ─────────────────────────────

function genTurbulenceCode(
    block: IVfxBlockData,
    opts: { particleVar: string; compiler?: VfxExprCompiler; contextId?: number; simulateSpace: string },
): string[] | null {
    if (!block.enabled) return null;
    const { particleVar, compiler, contextId, simulateSpace } = opts;
    const p = block.props || {};
    const noiseType = (p.noiseType as string) || "Perlin";
    const mode = (p.mode as string) || "Absolute";
    // intensity 优先用接 op 链（让 Unity dynamic intensity = multiply(sampleCurve(stripRatio), -2) 等表达式生效）
    // 没接 op 时 fallback 到 props.intensity 内联值
    let intensity = toFloat(p.intensity ?? 1);
    const intensityStmts: string[] = [];
    if (compiler && contextId != null) {
        const ir = compiler.compileBlockInput(contextId, `block_${block.id}_intensity`, "float");
        if (ir) {
            intensityStmts.push(...ir.stmts);
            intensity = ir.expr;
        }
    }
    const freq = toFloat(p.frequency ?? 1);
    const octaves = String(Math.max(1, Math.min(8, Math.round(Number(p.octaves ?? 3)))));
    const roughness = toFloat(p.roughness ?? 0.5);
    const lacunarity = toFloat(p.lacunarity ?? 2);

    const curlFunc = `Generate${noiseType}CurlNoise`;

    // ── FieldTransform: full TRS matrix (matches Unity VFX Turbulence) ──
    const fieldTransform = p.fieldTransform as any;
    const ftPos = fieldTransform?.position || { x: 0, y: 0, z: 0 };
    const ftAng = fieldTransform?.angles || { x: 0, y: 0, z: 0 };
    const ftScl = fieldTransform?.scale || { x: 1, y: 1, z: 1 };

    // Check if FieldTransform is non-identity
    const hasPos = Number(ftPos.x) !== 0 || Number(ftPos.y) !== 0 || Number(ftPos.z) !== 0;
    const hasAng = Number(ftAng.x) !== 0 || Number(ftAng.y) !== 0 || Number(ftAng.z) !== 0;
    const hasScl = Number(ftScl.x) !== 1 || Number(ftScl.y) !== 1 || Number(ftScl.z) !== 1;

    // Check for operator connection to FieldTransform.position (whole or per-component)
    let ftPosExpr: string | null = null;
    const ftPosStmts: string[] = [];
    if (compiler && contextId != null) {
        // Try whole vec3 connection first
        const ftResult = compiler.compileBlockInput(contextId, `block_${block.id}_fieldTransform_position`);
        if (ftResult) {
            ftPosStmts.push(...ftResult.stmts);
            ftPosExpr = ftResult.expr;
        } else {
            // Try per-component connections (x, y, z)
            const comps = ["x", "y", "z"];
            const compExprs: (string | null)[] = [null, null, null];
            let anyConnected = false;
            for (let ci = 0; ci < 3; ci++) {
                const cr = compiler.compileBlockInput(contextId, `block_${block.id}_fieldTransform_position_${comps[ci]}`, "float");
                if (cr) {
                    ftPosStmts.push(...cr.stmts);
                    compExprs[ci] = cr.expr;
                    anyConnected = true;
                }
            }
            if (anyConnected) {
                const px = compExprs[0] ?? toFloat(ftPos.x);
                const py = compExprs[1] ?? toFloat(ftPos.y);
                const pz = compExprs[2] ?? toFloat(ftPos.z);
                ftPosExpr = `vec3(${px}, ${py}, ${pz})`;
            }
        }
    }

    const hasFieldTransform = hasPos || hasAng || hasScl || ftPosExpr != null;

    const lines: string[] = [];
    lines.push("");
    lines.push(`    // turbulence (${noiseType}, ${mode}) — FieldTransform + CurlNoise (Unity VFX compatible)`);
    lines.push(`    {`);

    // Emit intensity op statements (sampleCurve / multiply / etc 链)
    for (const s of intensityStmts) lines.push(`        ${s}`);

    if (hasFieldTransform) {
        // Emit operator statements for FieldTransform position
        for (const s of ftPosStmts) lines.push(`        ${s}`);

        // Build FieldTransform position (from operator or static props)
        const posExpr = ftPosExpr
            ?? `vec3(${toFloat(ftPos.x)}, ${toFloat(ftPos.y)}, ${toFloat(ftPos.z)})`;
        const angExpr = `vec3(${toFloat(ftAng.x)}, ${toFloat(ftAng.y)}, ${toFloat(ftAng.z)})`;
        const sclExpr = `vec3(${toFloat(ftScl.x)}, ${toFloat(ftScl.y)}, ${toFloat(ftScl.z)})`;

        // Build TRS matrix and inverse (BuildTRS 角度参数是弧度, 同 ShapePosition 约定)
        lines.push(`        mat4 _ftMatrix = BuildTRS(${posExpr}, radians(${angExpr}), ${sclExpr});`);
        lines.push(`        mat4 _ftInvMatrix = _inverseTRS(_ftMatrix);`);

        // Transform position to field space (Unity: mul(InvFieldTransform, float4(pos, 1.0)).xyz)
        lines.push(`        vec3 _fieldCoord = (_ftInvMatrix * vec4(${particleVar}.position, 1.0)).xyz;`);

        // Sample noise at field coordinate + 0.5 offset (Unity convention)
        lines.push(`        vec3 _noiseVal = ${curlFunc}(_fieldCoord + vec3(0.5), ${freq}, ${octaves}, ${roughness}, ${lacunarity});`);

        // Transform noise back to world space (direction only: w=0) and apply intensity
        lines.push(`        vec3 _turbForce = (_ftMatrix * vec4(_noiseVal, 0.0)).xyz * ${intensity};`);
    } else {
        // No FieldTransform: identity transform, sample at particle position + 0.5
        lines.push(`        vec3 _turbForce = ${curlFunc}(${particleVar}.position + vec3(0.5), ${freq}, ${octaves}, ${roughness}, ${lacunarity}) * ${intensity};`);
    }

    // Apply force to velocity
    if (mode === "Relative") {
        const drag = toFloat(p.drag ?? 1);
        lines.push(`        float _tm = ${particleVar}.mass > 0.0 ? ${particleVar}.mass : 1.0;`);
        lines.push(`        ${particleVar}.velocity += (_turbForce - ${particleVar}.velocity) * min(1.0, ${drag} * u_DeltaTime / _tm);`);
    } else {
        lines.push(`        ${particleVar}.velocity += _turbForce * u_DeltaTime;`);
    }
    lines.push(`    }`);
    return lines;
}

// ─── Force Block 代码生成 ─────────────────────────────────

/**
 * General Force block — Absolute: velocity += (Force/mass)*dt, Relative: velocity += (target-velocity)*min(1,drag*dt/mass)
 */
function genForceCode(
    block: IVfxBlockData,
    opts: { particleVar: string; compiler?: VfxExprCompiler; contextId?: number; simulateSpace: string },
): string[] | null {
    if (!block.enabled) return null;
    const { particleVar, compiler, contextId, simulateSpace } = opts;
    const p = block.props || {};
    const mode = (p.mode as string) || "Absolute";
    const forceSpace = (p._space_force as string) || "World";

    const forceRaw = p.force;
    const forceVal = (forceRaw && forceRaw.vector) ? forceRaw.vector : (forceRaw || { x: 0, y: 0, z: 0 });
    let forceExpr = `vec3(${toFloat(forceVal.x)}, ${toFloat(forceVal.y)}, ${toFloat(forceVal.z)})`;

    const blockLines: string[] = [];

    // force 输入：从 operator 连线（整体 vec3 或 .x/.y/.z 分量）或回退到属性值
    // 对齐 Unity 设计：force vector inline 是 direction，op chain 输出 magnitude（标量或被 broadcast）。
    // Unity 节点图把 multiply(scalar*scalar*scalar) 链接到 vec3 force input 时，IDE 编译器会
    // broadcast vec3(s,s,s) 让方向朝 (1,1,1)。我们的策略：
    //   - 上游 srcType=float（明确 scalar） → magnitude × inline_direction
    //   - 上游 srcType=vec3 但 inline force 非零（用户配置了方向）→ 用 length(vec3) 当 magnitude × inline_direction
    //     这处理了"multiply 输出 vec3 但实际是 broadcast scalar"的情况
    //   - 上游 srcType=vec3 且 inline force = (0,0,0) → 直接用 vec3 表达式（用户真想用 op chain 当 direction）
    const inlineNonZero = forceVal.x !== 0 || forceVal.y !== 0 || forceVal.z !== 0;
    if (compiler && contextId != null) {
        const directKey = `${contextId}:block_${block.id}_force`;
        const directSrc = (compiler as any)._reverseIndex?.get(directKey);
        if (directSrc) {
            const srcType = (compiler as any)._getSourceSlotType?.(directSrc);
            const scalarResult = compiler.compileBlockInput(contextId, `block_${block.id}_force`, "float");
            const fullResult = compiler.compileBlockInput(contextId, `block_${block.id}_force`);
            if (srcType === "float" && scalarResult) {
                for (const s of scalarResult.stmts) blockLines.push(`    ${s}`);
                forceExpr = `(vec3(${toFloat(forceVal.x)}, ${toFloat(forceVal.y)}, ${toFloat(forceVal.z)}) * (${scalarResult.expr}))`;
            } else if (inlineNonZero && scalarResult) {
                // Inline 配了方向 + 上游能转 float（broadcast scalar 的标志）→ 用 magnitude × inline_direction
                for (const s of scalarResult.stmts) blockLines.push(`    ${s}`);
                forceExpr = `(vec3(${toFloat(forceVal.x)}, ${toFloat(forceVal.y)}, ${toFloat(forceVal.z)}) * (${scalarResult.expr}))`;
            } else if (fullResult) {
                for (const s of fullResult.stmts) blockLines.push(`    ${s}`);
                forceExpr = fullResult.expr;
            }
        } else {
            const comps = ["x", "y", "z"];
            const compExprs: string[] = [toFloat(forceVal.x), toFloat(forceVal.y), toFloat(forceVal.z)];
            let anyConnected = false;
            for (let ci = 0; ci < 3; ci++) {
                const cr = compiler.compileBlockInput(contextId, `block_${block.id}_force_${comps[ci]}`, "float");
                if (cr) {
                    for (const s of cr.stmts) blockLines.push(`    ${s}`);
                    compExprs[ci] = cr.expr;
                    anyConnected = true;
                }
            }
            if (anyConnected) {
                forceExpr = `vec3(${compExprs[0]}, ${compExprs[1]}, ${compExprs[2]})`;
            }
        }
    }

    if (forceSpace !== simulateSpace) {
        const matrix = forceSpace === "World" ? "u_InvEmitterWorldMatrix" : "u_EmitterWorldMatrix";
        forceExpr = `(mat3(${matrix}) * ${forceExpr})`;
    }

    const lines: string[] = [];
    lines.push("");
    lines.push(`    // force (${mode})`);
    lines.push(...blockLines);
    if (mode === "Relative") {
        const drag = toFloat(p.drag ?? 1);
        lines.push(`    ${particleVar}.velocity += (${forceExpr} - ${particleVar}.velocity) * min(1.0, ${drag} * u_DeltaTime / ${particleVar}.mass);`);
    } else {
        lines.push(`    ${particleVar}.velocity += (${forceExpr} / ${particleVar}.mass) * u_DeltaTime;`);
    }
    return lines;
}

// ─── Attractor Sphere Block 代码生成 ─────────────────────────

function genAttractorSphereCode(
    block: IVfxBlockData,
    opts: { particleVar: string },
): string[] | null {
    if (!block.enabled) return null;
    const { particleVar } = opts;
    const p = block.props || {};
    const centerRaw = p.center;
    const centerVal = (centerRaw && centerRaw.pos) ? centerRaw.pos : (centerRaw || { x: 0, y: 0, z: 0 });
    const radius = toFloat(p.radius ?? 1);
    const attractionSpeed = toFloat(p.attractionSpeed ?? 5);
    const stickDistance = toFloat(p.stickDistance ?? 0.1);
    const stickForce = toFloat(p.stickForce ?? 10);

    const lines: string[] = [];
    lines.push("");
    lines.push(`    // attractorSphere`);
    lines.push(`    {`);
    lines.push(`        vec3 _attrCenter = vec3(${toFloat(centerVal.x)}, ${toFloat(centerVal.y)}, ${toFloat(centerVal.z)});`);
    lines.push(`        vec3 _toCenter = _attrCenter - ${particleVar}.position;`);
    lines.push(`        float _distToCenter = length(_toCenter);`);
    lines.push(`        float _distToSurface = _distToCenter - ${radius};`);
    lines.push(`        vec3 _dir = _distToCenter > 0.0001 ? _toCenter / _distToCenter : vec3(0.0, 1.0, 0.0);`);
    lines.push(`        float _ratio = smoothstep(0.0, ${stickDistance} * 2.0, abs(_distToSurface));`);
    lines.push(`        float _tgtSpeed = sign(_distToSurface) * ${attractionSpeed} * _ratio;`);
    lines.push(`        float _force = mix(${stickForce}, ${attractionSpeed}, _ratio);`);
    lines.push(`        ${particleVar}.velocity += _dir * (_tgtSpeed - dot(${particleVar}.velocity, _dir)) * min(1.0, _force * u_DeltaTime);`);
    lines.push(`    }`);
    return lines;
}

// ─── Camera Fade Block 代码生成 ─────────────────────────────

function genCameraFadeCode(
    block: IVfxBlockData,
    opts: { particleVar: string },
): string[] | null {
    if (!block.enabled) return null;
    const { particleVar } = opts;
    const p = block.props || {};
    const nearDist = toFloat(p.nearFadeDistance ?? 0.5);
    const farDist = toFloat(p.farFadeDistance ?? 50);

    const lines: string[] = [];
    lines.push("");
    lines.push(`    // cameraFade`);
    lines.push(`    {`);
    lines.push(`        float _camDist = length(u_OrientCameraPos - ${particleVar}.position);`);
    lines.push(`        float _fadeFactor = smoothstep(0.0, ${nearDist}, _camDist) * (1.0 - smoothstep(${farDist} * 0.8, ${farDist}, _camDist));`);
    lines.push(`        ${particleVar}.alpha *= _fadeFactor;`);
    lines.push(`    }`);
    return lines;
}

// ─── Linear Drag Block 代码生成 ─────────────────────────────

function genLinearDragCode(
    block: IVfxBlockData,
    opts: { particleVar: string },
): string[] | null {
    if (!block.enabled) return null;

    const { particleVar } = opts;
    const p = block.props || {};
    const dragCoeff = toFloat(p.dragCoefficient ?? 1);
    const useSize = !!p.useParticleSize;

    const lines: string[] = [];
    lines.push("");
    lines.push(`    // linearDrag (对齐 Unity Drag.cs: velocity *= exp(-(dragCoefficient * dt) / mass))`);
    if (useSize) {
        lines.push(`    vec2 _dragSide = ${particleVar}.size * vec2(${particleVar}.scale.x, ${particleVar}.scale.y);`);
        lines.push(`    float _dragCoeff = ${dragCoeff} * _dragSide.x * _dragSide.y;`);
        lines.push(`    ${particleVar}.velocity *= exp(-(_dragCoeff * u_DeltaTime) / ${particleVar}.mass);`);
    } else {
        lines.push(`    ${particleVar}.velocity *= exp(-(${dragCoeff} * u_DeltaTime) / ${particleVar}.mass);`);
    }
    return lines;
}

// ─── Gravity Block 代码生成 ─────────────────────────────────

function genGravityCode(
    block: IVfxBlockData,
    opts: { particleVar: string; compiler?: VfxExprCompiler; contextId?: number; simulateSpace: string },
): string[] | null {
    const { particleVar, compiler, contextId, simulateSpace } = opts;

    // enabled 输入端口
    let enabledExpr: string | null = null;
    let enabledStmts: string[] = [];
    if (compiler && contextId != null) {
        const enabledResult = compiler.compileBlockInput(contextId, `block_${block.id}_enabled`);
        if (enabledResult) {
            enabledExpr = enabledResult.expr;
            enabledStmts = enabledResult.stmts;
        }
    }
    if (!enabledExpr && !block.enabled) return null;

    const p = block.props || {};
    const indent = enabledExpr ? "        " : "    ";
    const blockLines: string[] = [];

    // force 输入：从 operator 连线或回退到属性值
    const forceSpace = (p._space_force as string) || "World";
    const forceRaw = p.force;
    const forceVal = (forceRaw && forceRaw.vector) ? forceRaw.vector : (forceRaw || { x: 0, y: -9.81, z: 0 });
    let forceExpr = `vec3(${toFloat(forceVal.x)}, ${toFloat(forceVal.y)}, ${toFloat(forceVal.z)})`;

    if (compiler && contextId != null) {
        const forceResult = compiler.compileBlockInput(contextId, `block_${block.id}_force`);
        if (forceResult) {
            for (const s of forceResult.stmts) blockLines.push(`${indent}${s}`);
            forceExpr = forceResult.expr;
        } else {
            const comps = ["x", "y", "z"];
            const compExprs: string[] = [toFloat(forceVal.x), toFloat(forceVal.y), toFloat(forceVal.z)];
            let anyConnected = false;
            for (let ci = 0; ci < 3; ci++) {
                const cr = compiler.compileBlockInput(contextId, `block_${block.id}_force_${comps[ci]}`, "float");
                if (cr) {
                    for (const s of cr.stmts) blockLines.push(`${indent}${s}`);
                    compExprs[ci] = cr.expr;
                    anyConnected = true;
                }
            }
            if (anyConnected) {
                forceExpr = `vec3(${compExprs[0]}, ${compExprs[1]}, ${compExprs[2]})`;
            }
        }
    }

    // 空间转换：force 是 vector 类型（缩放/旋转，不含平移）
    if (forceSpace !== simulateSpace) {
        const matrix = forceSpace === "World" ? "u_InvEmitterWorldMatrix" : "u_EmitterWorldMatrix";
        forceExpr = `(mat3(${matrix}) * ${forceExpr})`;
    }

    // velocity += force * deltaTime
    blockLines.push(`${indent}${particleVar}.velocity += ${forceExpr} * u_DeltaTime;`);

    // 输出
    const lines: string[] = [];
    lines.push("");
    lines.push(`    // gravity`);
    if (enabledExpr) {
        for (const s of enabledStmts) lines.push(`    ${s}`);
        lines.push(`    if (${enabledExpr}) {`);
        lines.push(...blockLines);
        lines.push(`    }`);
    } else {
        lines.push(...blockLines);
    }

    return lines;
}

// ─── setAttributeCurve Block 代码生成 ──────────────────

interface ISetAttributeCurveOptions {
    particleVar: string;
    compiler?: VfxExprCompiler;
    contextId?: number;
}

/**
 * Set Attribute (Curve) block — 通过曲线采样设置粒子属性。
 * sampleMode 决定 t 的计算方式。
 */
function genSetAttributeCurveCode(
    block: IVfxBlockData,
    opts: ISetAttributeCurveOptions,
): string[] | null {
    const { particleVar, compiler, contextId } = opts;

    // enabled 检查
    let enabledExpr: string | null = null;
    let enabledStmts: string[] = [];
    if (compiler && contextId != null) {
        const enabledResult = compiler.compileBlockInput(contextId, `block_${block.id}_enabled`);
        if (enabledResult) {
            enabledExpr = enabledResult.expr;
            enabledStmts = enabledResult.stmts;
        }
    }
    if (!enabledExpr && !block.enabled) return null;

    const p = block.props || {};
    const attrName = (p.attribute as string) || "size";
    const sampleMode = (p.sampleMode as string) || "OverLife";
    const composition = (p.composition as string) || "Overwrite";

    const indent = enabledExpr ? "        " : "    ";
    const blockLines: string[] = [];

    // attribute=color 走 gradient 路径（对齐 Unity SetColor block）
    // 优先用 block.props.gradient（IDE 内嵌 Gradient editor），fallback 到 curve 灰度路径
    const isColorWithGradient = attrName === "color" && p.gradient && (p.gradient as any).stops;

    // 编译 curve 输入（curveData vec4 uniform）
    // 优先用外接 operator 连线，无连线时用 block 内嵌 curve property
    let curveExpr = "vec4(0.0)";
    if (!isColorWithGradient && compiler && contextId != null) {
        const curveResult = compiler.compileBlockInput(contextId, `block_${block.id}_curve`, "curve");
        if (curveResult) {
            for (const s of curveResult.stmts) blockLines.push(`${indent}${s}`);
            curveExpr = curveResult.expr;
        } else {
            // 使用 block 内嵌 curve property
            const curveVal = p.curve as any;
            const frameData: number[] = curveVal?.frameData || [0, 0, 0, 1, 0.333, 0.333, 0, 1, 1, 0, 1, 0.333, 0.333, 0];
            curveExpr = compiler.registerInlineCurve(block.id, frameData);
        }
    }

    // gradient 路径：注册 propertyUniform 让 IDE 烘焙 256x1 gradient 纹理（跟 sampleGradient op 同机制）
    let gradientUniformName = "";
    if (isColorWithGradient && compiler) {
        gradientUniformName = `u_VfxGradient_block_${block.id}`;
        compiler.propertyUniforms.set(gradientUniformName, { type: "Texture2D", gradientData: p.gradient });
    }

    blockLines.push(`${indent}{`);
    const inner = indent + "    ";

    // 生成 t 计算代码
    switch (sampleMode) {
        case "OverLife":
            blockLines.push(`${inner}float _curveT = ${particleVar}.age / max(${particleVar}.lifetime, 0.0001);`);
            break;
        case "BySpeed": {
            const minSpeed = toFloat(p.minSpeed ?? 0);
            const maxSpeed = toFloat(p.maxSpeed ?? 1);
            blockLines.push(`${inner}float _speed = length(${particleVar}.velocity);`);
            blockLines.push(`${inner}float _curveT = clamp((_speed - ${minSpeed}) / max(${maxSpeed} - ${minSpeed}, 0.0001), 0.0, 1.0);`);
            break;
        }
        case "Random":
            blockLines.push(`${inner}float _curveT = Rand(${particleVar}.seed);`);
            break;
        case "RandomConstantPerParticle":
            // 使用固定 seed 偏移以区分不同 block —— 用 uint literal 避免 uint+float 混合
            // (particle.seed 是 uint, toFloat 会生成 "319.0" 让 GLSL "uint + float" 编译错)
            // 函数名是 FixedRand 不是 VfxFixedRand（VFXUtils.glsl 定义见 VFXCommon.ts:313）
            blockLines.push(`${inner}float _curveT = FixedRand(${particleVar}.seed + ${Math.abs(block.id)}u);`);
            break;
        case "Custom": {
            // 从 value 输入编译
            let customT = "0.0";
            if (compiler && contextId != null) {
                const valueResult = compiler.compileBlockInput(contextId, `block_${block.id}_value`, "float");
                if (valueResult) {
                    for (const s of valueResult.stmts) blockLines.push(`${inner}${s}`);
                    customT = valueResult.expr;
                }
            }
            blockLines.push(`${inner}float _curveT = ${customT};`);
            break;
        }
    }

    if (isColorWithGradient) {
        // gradient 路径：sample 256x1 gradient 纹理 → vec4(rgb, a) → 写到 color (vec3)
        // 跟 sampleGradient op 同机制（textureLod + clamp t 防 wrap）
        // 只写 color (vec3)，不写 alpha — 因为 particle struct 不一定含 alpha 字段
        // (attribute usage 没含 alpha 时 GLSL 编译会报 'no such field alpha')
        // 用户需要 alpha 变化时可单独加 setAttributeCurve(attribute=alpha) block
        blockLines.push(`${inner}vec4 _gradVal = textureLod(${gradientUniformName}, vec2(clamp(_curveT, 0.0, 1.0), 0.5), 0.0);`);
        blockLines.push(`${inner}vec3 _curveVal = _gradVal.rgb;`);
        applyComposition(blockLines, "color", "_curveVal", composition, p, inner, particleVar);
    } else {
        // curve 路径（原逻辑）：标量 curve → 按 attribute 类型 broadcast
        const _curveAttrType = getAttributeType(attrName);
        const pAny = p as any;
        // vec3 属性 per-channel 三曲线（curve=X + curveY/curveZ，对齐 Unity AttributeFromCurve Scale_x/y/z）。
        // 仅 block 内嵌 curve（无外接连线）时支持；缺省通道 broadcast 主 curve。
        // 派生 curve id 用大偏移避开 graph 节点 id 空间（autoID 远小于 100000）。
        const _hasPerChannel = _curveAttrType === "vec3" && compiler != null
            && ((pAny.curveY && pAny.curveY.frameData) || (pAny.curveZ && pAny.curveZ.frameData));
        // channels 掩码(X=1,Y=2,Z=4,默认 7=全部)：Unity AttributeFromCurve channels 子集
        // 只写所选分量、不碰其他分量（整体 Overwrite 会把前序 setAttribute 的分量值抹掉）。
        const _chMask = (typeof pAny.channels === "number") ? pAny.channels : 7;
        if (_hasPerChannel) {
            const cy = (pAny.curveY && pAny.curveY.frameData)
                ? compiler.registerInlineCurve(100000 + block.id, pAny.curveY.frameData) : curveExpr;
            const cz = (pAny.curveZ && pAny.curveZ.frameData)
                ? compiler.registerInlineCurve(200000 + block.id, pAny.curveZ.frameData) : curveExpr;
            blockLines.push(`${inner}vec3 _curveVal = vec3(`
                + `SampleCurve(u_VfxBakedTex, ${curveExpr}, _curveT), `
                + `SampleCurve(u_VfxBakedTex, ${cy}, _curveT), `
                + `SampleCurve(u_VfxBakedTex, ${cz}, _curveT));`);
            applyCompositionWithChannels(blockLines, attrName, _curveAttrType, "_curveVal", composition, p, inner, particleVar, _chMask, block.id);
        } else {
            const _sampleExpr = `SampleCurve(u_VfxBakedTex, ${curveExpr}, _curveT)`;
            let _curveValExpr = _sampleExpr;
            if (_curveAttrType === "vec3" || _curveAttrType === "color") {
                _curveValExpr = `vec3(${_sampleExpr})`;
            } else if (_curveAttrType === "vec4") {
                _curveValExpr = `vec4(${_sampleExpr})`;
            } else if (_curveAttrType === "vec2") {
                _curveValExpr = `vec2(${_sampleExpr})`;
            }
            blockLines.push(`${inner}${GLSL_TYPE[_curveAttrType] || "float"} _curveVal = ${_curveValExpr};`);
            // 应用到属性（channels 掩码逐通道）
            applyCompositionWithChannels(blockLines, attrName, _curveAttrType, "_curveVal", composition, p, inner, particleVar, _chMask, block.id);
        }
    }

    blockLines.push(`${indent}}`);

    // 输出
    const lines: string[] = [];
    lines.push("");
    lines.push(`    // setAttributeCurve: ${attrName} (${sampleMode})`);
    if (enabledExpr) {
        for (const s of enabledStmts) lines.push(`    ${s}`);
        lines.push(`    if (${enabledExpr}) {`);
        lines.push(...blockLines);
        lines.push(`    }`);
    } else {
        lines.push(...blockLines);
    }

    return lines;
}

/** 生成随机值代码（Uniform / Per Component） */
function _genRandomCode(
    blockLines: string[],
    attrType: string,
    vals: Record<string, any>,
    random: string,
    wrapSpace: (expr: string) => string,
    composition: string,
    attrName: string,
    indent: string,
    particleVar: string,
): void {
    const glslT = GLSL_TYPE[attrType] || "float";
    blockLines.push(`${indent}{`);
    if (random === "Uniform") {
        blockLines.push(`${indent}    float t = Rand(${particleVar}.seed);`);
        if (attrType === "float" || attrType === "bool") {
            // float uniform: _values stores { x: min, y: max }
            blockLines.push(`${indent}    ${glslT} value = mix(${toFloat(vals.x ?? vals.value ?? 0)}, ${toFloat(vals.y ?? vals.b_value ?? 1)}, t);`);
        } else {
            blockLines.push(`${indent}    ${glslT} value = mix(${valueLiteral(attrType, vals, "")}, ${valueLiteral(attrType, vals, "b_")}, t);`);
        }
    } else {
        blockLines.push(`${indent}    ${glslT} value = ${genPerComponentMix(attrType, vals, particleVar)};`);
    }
    applyComposition(blockLines, attrName, wrapSpace("value"), composition, vals, indent + "    ", particleVar);
    blockLines.push(`${indent}}`);
}

// ─── Phase C: New Block Code Generators ─────────────────

function genVelocityTangentCode(
    block: IVfxBlockData,
    opts: { particleVar: string; compiler?: VfxExprCompiler; contextId?: number },
): string[] | null {
    if (!block.enabled) return null;
    const p = block.props || {};
    const { particleVar } = opts;
    const centerVal = p.center?.pos || p.center || { x: 0, y: 0, z: 0 };
    const axisVal = p.axis || { x: 0, y: 1, z: 0 };
    const speedMode = (p.speedMode as string) || "Constant";
    const composition = (p.composition as string) || "Add";

    const lines: string[] = [];
    lines.push("");
    lines.push(`    // velTangent`);
    lines.push(`    {`);
    lines.push(`        vec3 _vtCenter = vec3(${toFloat(centerVal.x)}, ${toFloat(centerVal.y)}, ${toFloat(centerVal.z)});`);
    lines.push(`        vec3 _vtAxis = normalize(vec3(${toFloat(axisVal.x)}, ${toFloat(axisVal.y)}, ${toFloat(axisVal.z)}));`);
    lines.push(`        vec3 _vtRadial = ${particleVar}.position - _vtCenter;`);
    lines.push(`        _vtRadial -= dot(_vtRadial, _vtAxis) * _vtAxis;`);
    lines.push(`        vec3 _vtTangent = cross(_vtAxis, normalize(_vtRadial + vec3(1e-6)));`);
    if (speedMode === "Random") {
        lines.push(`        float _vtSpeed = mix(${toFloat(p.minSpeed ?? 0)}, ${toFloat(p.maxSpeed ?? 1)}, Rand(${particleVar}.seed));`);
    } else {
        lines.push(`        float _vtSpeed = ${toFloat(p.speed ?? 1)};`);
    }
    lines.push(`        vec3 _vtVel = _vtTangent * _vtSpeed;`);
    if (composition === "Overwrite") {
        lines.push(`        ${particleVar}.velocity = _vtVel;`);
    } else if (composition === "Add") {
        lines.push(`        ${particleVar}.velocity += _vtVel;`);
    } else if (composition === "Multiply") {
        lines.push(`        ${particleVar}.velocity *= _vtVel;`);
    } else {
        lines.push(`        ${particleVar}.velocity = mix(${particleVar}.velocity, _vtVel, ${toFloat(p.blendVelocity ?? 0.5)});`);
    }
    lines.push(`    }`);
    return lines;
}

function genVelocitySpeedCode(
    block: IVfxBlockData,
    opts: { particleVar: string; compiler?: VfxExprCompiler; contextId?: number },
): string[] | null {
    if (!block.enabled) return null;
    const p = block.props || {};
    const { particleVar } = opts;
    const speedMode = (p.speedMode as string) || "Constant";
    const composition = (p.composition as string) || "Overwrite";

    const lines: string[] = [];
    lines.push("");
    lines.push(`    // velSpeed`);
    lines.push(`    {`);
    if (speedMode === "Random") {
        lines.push(`        float _vsSpeed = mix(${toFloat(p.minSpeed ?? 0)}, ${toFloat(p.maxSpeed ?? 1)}, Rand(${particleVar}.seed));`);
    } else {
        lines.push(`        float _vsSpeed = ${toFloat(p.speed ?? 1)};`);
    }
    lines.push(`        vec3 _vsDir = length(${particleVar}.direction) > 0.0 ? normalize(${particleVar}.direction) : vec3(0.0, 1.0, 0.0);`);
    lines.push(`        vec3 _vsVel = _vsDir * _vsSpeed;`);
    if (composition === "Overwrite") {
        lines.push(`        ${particleVar}.velocity = _vsVel;`);
    } else if (composition === "Add") {
        lines.push(`        ${particleVar}.velocity += _vsVel;`);
    } else if (composition === "Multiply") {
        lines.push(`        ${particleVar}.velocity *= _vsVel;`);
    } else {
        lines.push(`        ${particleVar}.velocity = mix(${particleVar}.velocity, _vsVel, ${toFloat(p.blendVelocity ?? 0.5)});`);
    }
    lines.push(`    }`);
    return lines;
}

function genCollisionTorusCode(
    block: IVfxBlockData,
    opts: { particleVar: string },
): string[] | null {
    if (!block.enabled) return null;
    const p = block.props || {};
    const { particleVar } = opts;
    const centerVal = p.center?.pos || p.center || { x: 0, y: 0, z: 0 };
    const majorR = toFloat(p.majorRadius ?? 1);
    const minorR = toFloat(p.minorRadius ?? 0.3);
    const bounce = toFloat(p.bounce ?? 0.1);
    const friction = toFloat(p.friction ?? 0);
    const lifetimeLoss = toFloat(p.lifetimeLoss ?? 0);
    const inverted = (p.mode as string) === "Inverted";

    const lines: string[] = [];
    lines.push("");
    lines.push(`    // collisionTorus (${inverted ? "Inverted" : "Solid"}) — SDF bounce`);
    lines.push(`    {`);
    lines.push(`        vec3 _ctCenter = vec3(${toFloat(centerVal.x)}, ${toFloat(centerVal.y)}, ${toFloat(centerVal.z)});`);
    lines.push(`        vec3 _ctPos = ${particleVar}.position - _ctCenter;`);
    lines.push(`        vec2 _ctXZ = vec2(_ctPos.x, _ctPos.z);`);
    lines.push(`        float _ctR = length(_ctXZ);`);
    lines.push(`        float _ctRingD = _ctR - ${majorR};`);  // 到环中线水平距离（内负外正）
    lines.push(`        vec2 _ctQ = vec2(_ctRingD, _ctPos.y);`);
    lines.push(`        float _ctSDF = length(_ctQ) - ${minorR};`);  // torus SDF（内负外正）
    const cond = inverted ? "_ctSDF > 0.0" : "_ctSDF < 0.0";
    lines.push(`        if (${cond}) {`);
    // 外向法向：qN 是环截面圆的法向，映射回 world 用 xz 方向基
    lines.push(`            vec2 _ctXZDir = _ctR > 1e-6 ? _ctXZ / _ctR : vec2(1.0, 0.0);`);
    lines.push(`            float _ctQLen = length(_ctQ);`);
    lines.push(`            vec2 _ctQN = _ctQLen > 1e-6 ? _ctQ / _ctQLen : vec2(1.0, 0.0);`);
    lines.push(`            vec3 _ctNorm = ${inverted ? "-" : ""}vec3(_ctQN.x * _ctXZDir.x, _ctQN.y, _ctQN.x * _ctXZDir.y);`);
    // SDF 绝对值 = 穿透深度；沿法向推出
    lines.push(`            ${particleVar}.position += _ctNorm * abs(_ctSDF);`);
    lines.push(`            vec3 _ctVn = dot(${particleVar}.velocity, _ctNorm) * _ctNorm;`);
    lines.push(`            vec3 _ctVt = ${particleVar}.velocity - _ctVn;`);
    lines.push(`            ${particleVar}.velocity = _ctVt * (1.0 - ${friction}) - _ctVn * ${bounce};`);
    if (Number(p.lifetimeLoss) > 0) {
        lines.push(`            ${particleVar}.age += ${particleVar}.lifetime * ${lifetimeLoss};`);
    }
    lines.push(`        }`);
    lines.push(`    }`);
    return lines;
}

function genCollisionConeCode(
    block: IVfxBlockData,
    opts: { particleVar: string },
): string[] | null {
    if (!block.enabled) return null;
    const p = block.props || {};
    const { particleVar } = opts;
    const centerVal = p.center?.pos || p.center || { x: 0, y: 0, z: 0 };
    const baseR = toFloat(p.baseRadius ?? 1);
    const topR = toFloat(p.topRadius ?? 0);
    const height = toFloat(p.height ?? 2);
    const bounce = toFloat(p.bounce ?? 0);
    const friction = toFloat(p.friction ?? 0);
    const lifetimeLoss = toFloat(p.lifetimeLoss ?? 0);
    const inverted = (p.mode as string) === "Inverted";

    const lines: string[] = [];
    lines.push("");
    lines.push(`    // collisionCone`);
    lines.push(`    {`);
    lines.push(`        vec3 _ccBase = vec3(${toFloat(centerVal.x)}, ${toFloat(centerVal.y)}, ${toFloat(centerVal.z)});`);
    lines.push(`        vec3 _ccPos = ${particleVar}.position - _ccBase;`);
    lines.push(`        float _ccH = clamp(_ccPos.y, 0.0, ${height});`);
    lines.push(`        float _ccR = mix(${baseR}, ${topR}, _ccH / max(${height}, 1e-6));`);
    lines.push(`        vec2 _ccXZ = _ccPos.xz;`);
    lines.push(`        float _ccDist = length(_ccXZ) - _ccR;`);
    const cond = inverted ? "_ccDist > 0.0 && _ccPos.y >= 0.0 && _ccPos.y <= " + height : "_ccDist < 0.0 && _ccPos.y >= 0.0 && _ccPos.y <= " + height;
    lines.push(`        if (${cond}) {`);
    lines.push(`            vec3 _ccNorm = ${inverted ? "-" : ""}normalize(vec3(_ccXZ.x, 0.0, _ccXZ.y));`);
    lines.push(`            ${particleVar}.position += _ccNorm * ${inverted ? "-" : ""}(-_ccDist);`);
    lines.push(`            vec3 _ccVn = dot(${particleVar}.velocity, _ccNorm) * _ccNorm;`);
    lines.push(`            vec3 _ccVt = ${particleVar}.velocity - _ccVn;`);
    lines.push(`            ${particleVar}.velocity = _ccVt * (1.0 - ${friction}) - _ccVn * ${bounce};`);
    if (Number(p.lifetimeLoss) > 0) {
        lines.push(`            ${particleVar}.age += ${particleVar}.lifetime * ${lifetimeLoss};`);
    }
    lines.push(`        }`);
    lines.push(`    }`);
    return lines;
}

function genPositionSequentialCode(
    block: IVfxBlockData,
    opts: { particleVar: string; compiler?: VfxExprCompiler; contextId?: number },
): string[] | null {
    if (!block.enabled) return null;
    const p = block.props || {};
    const { particleVar, compiler, contextId } = opts;
    const mode = (p.mode as string) || "Line";

    // 收集 operator 编译产生的 stmts（变量声明等），最后统一插入到 block 主体前
    const opStmts: string[] = [];
    const tryResolve = (slotName: string, glslType: "float" | "vec3", fallbackLiteral: string): string => {
        if (compiler && contextId != null) {
            const result = compiler.compileBlockInput(contextId, `block_${block.id}_${slotName}`, glslType);
            if (result) {
                opStmts.push(...result.stmts);
                return result.expr;
            }
        }
        return fallbackLiteral;
    };

    const countFallback = toFloat(p.countPerLine ?? 16);
    const countExpr = tryResolve("countPerLine", "float", countFallback);

    const posComp = (p.composition as string) || "Overwrite";
    const assignOp = posComp === "Add" ? "+=" : "=";

    // 各模式下的输入解析（先做，stmts 会累积到 opStmts）
    let bodyLines: string[] = [];
    if (mode === "Line") {
        const startVal = p.start?.pos || p.start || { x: -1, y: 0, z: 0 };
        const endVal = p.end?.pos || p.end || { x: 1, y: 0, z: 0 };
        const startLit = `vec3(${toFloat(startVal.x)}, ${toFloat(startVal.y)}, ${toFloat(startVal.z)})`;
        const endLit = `vec3(${toFloat(endVal.x)}, ${toFloat(endVal.y)}, ${toFloat(endVal.z)})`;
        const startExpr = tryResolve("start", "vec3", startLit);
        const endExpr = tryResolve("end", "vec3", endLit);
        bodyLines.push(`        vec3 _psStart = ${startExpr};`);
        bodyLines.push(`        vec3 _psEnd = ${endExpr};`);
        bodyLines.push(`        ${particleVar}.position ${assignOp} mix(_psStart, _psEnd, _psT);`);
    } else if (mode === "Circle") {
        const centerVal = p.center?.pos || p.center || { x: 0, y: 0, z: 0 };
        const axisRaw = p.axis;
        const axisVal = (axisRaw && axisRaw.direction) ? axisRaw.direction : (axisRaw || { x: 0, y: 1, z: 0 });
        const radiusFallback = toFloat(p.radius ?? 1);

        const centerLit = `vec3(${toFloat(centerVal.x)}, ${toFloat(centerVal.y)}, ${toFloat(centerVal.z)})`;
        const axisLit = `vec3(${toFloat(axisVal.x)}, ${toFloat(axisVal.y)}, ${toFloat(axisVal.z)})`;

        const centerExpr = tryResolve("center", "vec3", centerLit);
        const axisExpr = tryResolve("axis", "vec3", axisLit);
        const radiusExpr = tryResolve("radius", "float", radiusFallback);

        // axis 决定圆面朝向：Unity Normal 字段对应 Laya axis（圆面法向量）。
        // 由于 axis/center/radius 都可能是 operator 动态输入，T1/T2 正交基必须在
        // GLSL runtime 计算（不能在 JS 编译时求值）。
        bodyLines.push(`        vec3 _psCenter = ${centerExpr};`);
        bodyLines.push(`        vec3 _psAxis = ${axisExpr};`);
        bodyLines.push(`        float _psRadius = ${radiusExpr};`);
        bodyLines.push(`        vec3 _psN = length(_psAxis) > 1e-6 ? normalize(_psAxis) : vec3(0.0, 1.0, 0.0);`);
        // Up 选择：axis 接近 Y → 用 Z 当 up；否则用 Y（避免与 axis 共线）
        bodyLines.push(`        vec3 _psUp = abs(_psN.y) > 0.99 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);`);
        bodyLines.push(`        vec3 _psT1 = normalize(_psUp - dot(_psUp, _psN) * _psN);`);
        bodyLines.push(`        vec3 _psT2 = cross(_psN, _psT1);`);
        bodyLines.push(`        float _psAngle = _psT * 6.28318530718;`);
        bodyLines.push(`        vec3 _psRadial = cos(_psAngle) * _psT1 + sin(_psAngle) * _psT2;`);
        bodyLines.push(`        ${particleVar}.position ${assignOp} _psCenter + _psRadial * _psRadius;`);
        bodyLines.push(`        ${particleVar}.direction = _psRadial;`);
    } else {
        // Unity Sequential3D 公式（VFXOperatorUtility.cs Sequential3D, line 663）：
        //   z = index % countZ
        //   y = (index / countZ) % countY
        //   x = index / (countY * countZ)
        //   dt = (x,y,z) / max(count-1, 1)         [0, 1]
        //   dt = dt * 2 - 1                          [-1, 1]
        //   pos = origin + dt.x*axisX + dt.y*axisY + dt.z*axisZ
        // axisX/Y/Z 默认 (1,0,0)/(0,1,0)/(0,0,1)，让 grid 分布在 [-1, 1]^3 立方体内
        // 之前 Laya 实现 pos = origin + (i%cX, ..., ...) * step 输出 [0, count) — 跟 Unity 完全不一致
        const originVal = p.origin || { x: 0, y: 0, z: 0 };
        const originLit = `vec3(${toFloat(originVal.x)}, ${toFloat(originVal.y)}, ${toFloat(originVal.z)})`;
        const originExpr = tryResolve("origin", "vec3", originLit);

        // axisX/Y/Z（Unity 真值 input slot）— 默认单位轴，可被 op 接入覆盖
        const axisXLit = `vec3(1.0, 0.0, 0.0)`;
        const axisYLit = `vec3(0.0, 1.0, 0.0)`;
        const axisZLit = `vec3(0.0, 0.0, 1.0)`;
        const axisXExpr = tryResolve("axisX", "vec3", axisXLit);
        const axisYExpr = tryResolve("axisY", "vec3", axisYLit);
        const axisZExpr = tryResolve("axisZ", "vec3", axisZLit);

        const fallbackCnt = Math.max(1, Math.round(Number(p.countPerLine) || 16));
        const cntXFallback = String(Math.max(1, Math.round(Number(p.countX ?? fallbackCnt))));
        const cntYFallback = String(Math.max(1, Math.round(Number(p.countY ?? fallbackCnt))));
        const cntZFallback = String(Math.max(1, Math.round(Number(p.countZ ?? 1))));
        const cntXExpr = tryResolve("countX", "float", cntXFallback);
        const cntYExpr = tryResolve("countY", "float", cntYFallback);
        const cntZExpr = tryResolve("countZ", "float", cntZFallback);

        bodyLines.push(`        int _psI = int(_psId);`);
        bodyLines.push(`        vec3 _psOrigin = ${originExpr};`);
        bodyLines.push(`        vec3 _psAxisX = ${axisXExpr};`);
        bodyLines.push(`        vec3 _psAxisY = ${axisYExpr};`);
        bodyLines.push(`        vec3 _psAxisZ = ${axisZExpr};`);
        bodyLines.push(`        float _cX = max(${cntXExpr}, 1.0);`);
        bodyLines.push(`        float _cY = max(${cntYExpr}, 1.0);`);
        bodyLines.push(`        float _cZ = max(${cntZExpr}, 1.0);`);
        // Unity index 顺序：z = idx % cZ, y = (idx/cZ) % cY, x = idx / (cY*cZ)
        bodyLines.push(`        float _psZf = mod(float(_psI), _cZ);`);
        bodyLines.push(`        float _psYf = mod(float(_psI) / _cZ, _cY);`);
        bodyLines.push(`        float _psXf = float(_psI) / (_cY * _cZ);`);
        bodyLines.push(`        vec3 _psVolSize = max(vec3(_cX, _cY, _cZ) - vec3(1.0), vec3(1.0));`);
        bodyLines.push(`        vec3 _psScaleAxis = clamp(vec3(_cX, _cY, _cZ) - vec3(1.0), vec3(0.0), vec3(1.0));`);
        bodyLines.push(`        vec3 _psDt = vec3(_psXf, _psYf, _psZf) / _psVolSize * 2.0 - vec3(1.0);`);
        bodyLines.push(`        vec3 _psPos = _psOrigin + _psDt.x * _psScaleAxis.x * _psAxisX + _psDt.y * _psScaleAxis.y * _psAxisY + _psDt.z * _psScaleAxis.z * _psAxisZ;`);
        bodyLines.push(`        ${particleVar}.position ${assignOp} _psPos;`);
    }

    const lines: string[] = [];
    lines.push("");
    lines.push(`    // positionSequential (${mode}) — operator inputs override static props`);
    lines.push(`    {`);
    // operator 编译产生的临时变量声明（如 _opNN）必须先于使用
    for (const s of opStmts) lines.push(`        ${s}`);
    // spawn 序号：initialize 阶段 particleVar==="particle"，线程索引 id 可用；
    //   用 id + u_TotalSpawnedCount 得全局 spawn 序号（否则 fractional spawn 下 id 恒为 0，粒子全塌缩到第 0 位）。
    // output/update 阶段 particleVar==="p"，没有 id，改读粒子已存的 spawnIndex
    //   （单次 burst 系统里二者相等；此前 output 上下文误用 id 会导致 "undeclared identifier" 编译失败）。
    const _psSpawnId = particleVar === "particle" ? "id + uint(u_TotalSpawnedCount)" : `${particleVar}.spawnIndex`;
    lines.push(`        uint _psId = ${_psSpawnId};`);
    lines.push(`        float _psCount = ${countExpr};`);
    lines.push(`        float _psSeg = mod(float(_psId), max(_psCount, 1.0));`);
    // Unity VFXOperatorUtility.SequentialCircle 用 dt/count（angle ∈ [0, 2π)，无重复位置）；
    // SequentialLine 用 dt/(count-1)（端点包含，0..1 inclusive）。
    if (mode === "Circle") {
        lines.push(`        float _psT = _psSeg / max(_psCount, 1.0);`);
    } else {
        lines.push(`        float _psT = _psSeg / max(_psCount - 1.0, 1.0);`);
    }
    lines.push(...bodyLines);

    lines.push(`    }`);
    return lines;
}

function genConnectTargetCode(
    block: IVfxBlockData,
    opts: { particleVar: string },
): string[] | null {
    if (!block.enabled) return null;
    const p = block.props || {};
    const { particleVar } = opts;
    const mode = (p.mode as string) || "Position";

    const lines: string[] = [];
    lines.push("");
    lines.push(`    // connectTarget — 粒子 Y 轴指向 target，沿 Y 拉伸到 target 长度`);
    lines.push(`    {`);
    if (mode === "Position") {
        const targetVal = p.targetPosition?.pos || p.targetPosition || { x: 0, y: 1, z: 0 };
        lines.push(`        vec3 _ctTarget = vec3(${toFloat(targetVal.x)}, ${toFloat(targetVal.y)}, ${toFloat(targetVal.z)});`);
        lines.push(`        ${particleVar}.targetPosition = _ctTarget;`);
    } else {
        lines.push(`        ${particleVar}.targetPosition = ${particleVar}.position + normalize(${particleVar}.direction) * ${particleVar}.size;`);
    }
    lines.push(`        vec3 _ctDir = ${particleVar}.targetPosition - ${particleVar}.position;`);
    lines.push(`        float _ctLen = length(_ctDir);`);
    lines.push(`        if (_ctLen > 1e-6) {`);
    lines.push(`            vec3 _ctY = _ctDir / _ctLen;`);
    lines.push(`            // 构造正交基：Y 指向 target，X/Z 垂直于 Y`);
    lines.push(`            vec3 _ctRef = abs(_ctY.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);`);
    lines.push(`            vec3 _ctX = normalize(cross(_ctRef, _ctY));`);
    lines.push(`            vec3 _ctZ = cross(_ctX, _ctY);`);
    lines.push(`            ${particleVar}.axisX = _ctX;`);
    lines.push(`            ${particleVar}.axisY = _ctY;`);
    lines.push(`            ${particleVar}.axisZ = _ctZ;`);
    lines.push(`            // finalScale.y = size * scale.y，所以补偿 size 让 Y 最终拉伸 _ctLen`);
    lines.push(`            float _ctS = max(${particleVar}.size, 1e-4);`);
    lines.push(`            ${particleVar}.scale.y = _ctLen / _ctS;`);
    lines.push(`            // pivot.y = -0.5：让 Quad 底边在 spawn 位置，顶边在 target`);
    lines.push(`            ${particleVar}.pivot.y = -0.5;`);
    lines.push(`        }`);
    lines.push(`    }`);
    return lines;
}

function genFlipbookPlayCode(
    block: IVfxBlockData,
    opts: { particleVar: string },
): string[] | null {
    if (!block.enabled) return null;
    const p = block.props || {};
    const { particleVar } = opts;
    const mode = (p.mode as string) || "Constant";
    const frameCount = toFloat(p.frameCount ?? 16);

    const lines: string[] = [];
    lines.push("");
    lines.push(`    // flipbookPlay`);
    lines.push(`    {`);
    if (mode === "OverLife") {
        lines.push(`        ${particleVar}.texIndex = ${particleVar}.normalizedAge * (${frameCount} - 1.0);`);
    } else if (mode === "BySpeed") {
        lines.push(`        float _fbSpeed = length(${particleVar}.velocity);`);
        lines.push(`        ${particleVar}.texIndex = fract(_fbSpeed * ${particleVar}.age) * (${frameCount} - 1.0);`);
    } else {
        const frameRate = toFloat(p.frameRate ?? 30);
        lines.push(`        ${particleVar}.texIndex = fract(${particleVar}.age * ${frameRate} / ${frameCount}) * (${frameCount} - 1.0);`);
    }
    lines.push(`    }`);
    return lines;
}

function genScreenSpaceSizeCode(
    block: IVfxBlockData,
    opts: { particleVar: string },
): string[] | null {
    if (!block.enabled) return null;
    const p = block.props || {};
    const { particleVar } = opts;
    const refSize = toFloat(p.referenceSize ?? 10);

    const lines: string[] = [];
    lines.push("");
    lines.push(`    // screenSpaceSize`);
    lines.push(`    {`);
    lines.push(`        float _ssDist = length(u_OrientCameraPos - ${particleVar}.position);`);
    lines.push(`        float _ssFactor = _ssDist * ${refSize} * 0.001;`);
    lines.push(`        ${particleVar}.size *= _ssFactor;`);
    lines.push(`    }`);
    return lines;
}

// ─── vectorFieldForce (Unity VectorFieldForce.cs) ─────────
// 从 3D 纹理（sampler3D）按粒子位置采样向量场，作为力作用到 velocity
// Absolute: velocity = fieldVec * intensity
// Relative: velocity += (fieldVec * intensity - velocity * drag) * deltaTime
function genVectorFieldForceCode(
    block: IVfxBlockData,
    opts: { particleVar: string; compiler?: VfxExprCompiler },
): string[] | null {
    if (!block.enabled) return null;
    const { particleVar, compiler } = opts;
    const p = block.props || {};
    const mode = (p.mode as string) || "Absolute";
    const intensity = toFloat(p.intensity ?? 1);
    const drag = toFloat(p.drag ?? 1);
    const texUuid = (p.texture as string) || "";
    // 未绑纹理时整个 block 失效（否则会声明 sampler3D uniform 但无资源 → WebGPU 崩）
    if (!texUuid) return null;
    const center = p.fieldCenter || { x: 0, y: 0, z: 0 };
    const size = p.fieldSize || { x: 2, y: 2, z: 2 };
    const cx = toFloat(center.x), cy = toFloat(center.y), cz = toFloat(center.z);
    const sx = toFloat(size.x), sy = toFloat(size.y), sz = toFloat(size.z);

    // 注册 Texture3D uniform 到 compiler（若可用），让 VfxShaderGen 注入到 uniformMap
    // Uniform 最终命名为 u_VfxProp_<propName>，这里 propName = VectorField_<blockId>
    const propName = `VectorField_${block.id}`;
    const uniformName = `u_VfxProp_${propName}`;
    if (compiler) {
        (compiler as any)._propertyUniforms.set(propName, {
            type: "Texture3D",
            textureProp: texUuid,
        });
    }

    const lines: string[] = [];
    lines.push("");
    lines.push(`    // vectorFieldForce (${mode}) — sample 3D texture as velocity field`);
    lines.push(`    {`);
    // UVW = (position - center) / size + 0.5 → 映射到 [0,1]^3
    lines.push(`        vec3 _vfCenter = vec3(${cx}, ${cy}, ${cz});`);
    lines.push(`        vec3 _vfSize = vec3(${sx}, ${sy}, ${sz});`);
    lines.push(`        vec3 _vfUVW = (${particleVar}.position - _vfCenter) / max(_vfSize, vec3(1e-4)) + vec3(0.5);`);
    lines.push(`        if (all(greaterThanEqual(_vfUVW, vec3(0.0))) && all(lessThanEqual(_vfUVW, vec3(1.0)))) {`);
    // sampler3D 采样（.rgb 是向量场数据，通常 [-1,1] 范围）
    lines.push(`            vec3 _vfVec = textureLod(${uniformName}, _vfUVW, 0.0).xyz;`);
    lines.push(`            vec3 _vfForce = _vfVec * ${intensity};`);
    if (mode === "Absolute") {
        lines.push(`            ${particleVar}.velocity = _vfForce;`);
    } else {
        lines.push(`            ${particleVar}.velocity += (_vfForce - ${particleVar}.velocity * ${drag}) * u_DeltaTime;`);
    }
    lines.push(`        }`);
    lines.push(`    }`);
    return lines;
}