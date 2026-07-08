/**
 * VFX Operator Graph → GLSL Expression Compiler
 *
 * 将 Operator 节点图（连线）编译为 GLSL 表达式代码。
 * 核心流程：从目标 Block 输入 slot 反向遍历 Operator 连线，
 * 拓扑排序（DFS + memoization），为每个 Operator 生成临时变量。
 */

import type { IVfxOperatorData, IVfxOperatorTypeDef, IVfxPropertyDef } from "../data/VfxTypes";
import { VFX_OPERATOR_DEFS, getAttributeType, getAttributeSpaceable, getSpaceableType, isSpaceableType, getCompositeTypeInfo, TYPE_COMPONENTS, typeDim } from "../data/VfxOperatorDefs";

// ─── 反向索引 key: "nodeId:slotId" ──────────────────

interface ISourceInfo {
    opId: number;
    outSlotId: string;
}

/** 编译结果 */
export interface IExprResult {
    /** 新增的 GLSL 语句（临时变量声明），需插入到表达式使用位置之前 */
    stmts: string[];
    /** 最终的 GLSL 表达式（变量名或字面量） */
    expr: string;
}

// ─── GLSL 工具函数 ──────────────────────────────────

/** 基础类型 → GLSL 类型映射（复合类型从 COMPOSITE_TYPE_INFO 自动获取） */
const GLSL_TYPES_PRIM: Record<string, string> = {
    float: "float", int: "int", uint: "uint",
    bool: "bool", any: "float", curve: "vec4",
};

function glslType(vfxType: string): string {
    const prim = GLSL_TYPES_PRIM[vfxType];
    if (prim) return prim;
    // case-insensitive fallback: VFX schema 用大写 "Curve" / "Float" 之类（properties 字段），
    // operator slot 用小写 "curve" / "float"。两边混用让 glslType("Curve") fallback 到 "float"
    // 让 getProperty(Curve) 输出被声明成 float，sampleCurve 拿到非 vec4 输入 → no matching overload.
    const primLower = GLSL_TYPES_PRIM[vfxType.toLowerCase()];
    if (primLower) return primLower;
    const info = getCompositeTypeInfo(vfxType);
    if (info) return info.glslType;
    return "float";
}

/** 数值转 GLSL float 字面量 */
function toFloat(v: any): string {
    const n = Number(v) || 0;
    const s = String(n);
    return (s.includes('.') || s.includes('e') || s.includes('E')) ? s : s + ".0";
}

/** 数值转类型化 GLSL 字面量 */
function toLiteral(v: any, type: string): string {
    if (type === "bool") return (v === true || v === "true" || v === 1) ? "true" : "false";
    const n = Number(v) || 0;
    if (type === "int") return String(Math.round(n));
    if (type === "uint") return String(Math.max(0, Math.round(n))) + "u";
    // 标量 widen 到 vec/mat 类型（polymorphic op 输入用单值时必需）
    // 例: lerp _type=vec3 但 input x 是 inline scalar 0 → 必须输出 vec3(0.0) 而非 "0.0",
    //     否则 mix(0.0, vec3, vec3) GLSL 编译失败 'no matching overload'
    if (type === "vec2") return `vec2(${toFloat(n)})`;
    if (type === "vec3") return `vec3(${toFloat(n)})`;
    if (type === "vec4") return `vec4(${toFloat(n)})`;
    return toFloat(n);
}

/** 递归构建任意类型的 GLSL 字面量（由 COMPOSITE_TYPE_INFO + TYPE_COMPONENTS 驱动） */
function _buildLiteral(val: any, type: string): string {
    const info = getCompositeTypeInfo(type);
    if (info) {
        const components = TYPE_COMPONENTS[type];
        if (components) {
            const obj = (typeof val === "object" && val) ? val : {};
            const fieldExprs = components.map(comp => _buildLiteral(obj[comp.id], comp.type));
            return info.construct(fieldExprs);
        }
        return info.zero;
    }
    // 标量 / 简单向量
    if (val != null) {
        if (typeof val === "object") {
            // vec literal — 判断是 xyzw 还是 rgba
            const v = val as Record<string, number>;
            if ("r" in v) return `vec4(${toFloat(v.r ?? 1)}, ${toFloat(v.g ?? 1)}, ${toFloat(v.b ?? 1)}, ${toFloat(v.a ?? 1)})`;
            if ("w" in v) return `vec4(${toFloat(v.x)}, ${toFloat(v.y)}, ${toFloat(v.z)}, ${toFloat(v.w)})`;
            if ("z" in v) return `vec3(${toFloat(v.x)}, ${toFloat(v.y)}, ${toFloat(v.z)})`;
            if ("y" in v) return `vec2(${toFloat(v.x)}, ${toFloat(v.y)})`;
            return toFloat(v.x ?? 0);
        }
        return toLiteral(val, type);
    }
    return zeroLiteral(type);
}

/** 类型对应的零值字面量 */
function zeroLiteral(type: string): string {
    const info = getCompositeTypeInfo(type);
    if (info) return info.zero;
    switch (type) {
        case "int": return "0";
        case "uint": return "0u";
        case "bool": return "false";
        case "curve": return "vec4(0.0)";   // curveData 是 vec4 (texU 编码)，零值用 vec4(0)
        case "vec2": return "vec2(0.0)";
        case "vec3": return "vec3(0.0)";
        case "vec4": return "vec4(0.0)";
        case "color": return "vec3(0.0)";   // color 在 Particle struct 里存为 vec3
        default: return "0.0";
    }
}

// ─── Operator → GLSL 表达式映射 ─────────────────────

type ExprGen = string | ((inputs: Record<string, string>, type: string) => string);

const GLSL_EXPRS: Record<string, ExprGen> = {
    // 二元算术
    add: "({a} + {b})",
    subtract: "({a} - {b})",
    multiply: "({a} * {b})",
    divide: "({a} / {b})",
    power: "pow({a}, {b})",

    // 一元
    absolute: "abs({x})",
    negate: "(-{x})",
    sign: "sign({x})",
    squareRoot: "sqrt({x})",
    fractional: "fract({x})",

    // 三元
    lerp: "mix({x}, {y}, {s})",
    smoothstep: "smoothstep({x}, {y}, {s})",
    step: "step({threshold}, {value})",

    // Logic
    branch: (inputs) => `(${inputs.predicate} ? ${inputs.trueVal} : ${inputs.falseVal})`,
    logicAnd: "({a} && {b})",
    logicOr: "({a} || {b})",
    logicNot: "(!{a})",
    logicNand: "!({a} && {b})",
    logicNor: "!({a} || {b})",

    // Wave
    sawtoothWave: (inputs) => `mix(${inputs.min}, ${inputs.max}, fract(${inputs.x} * ${inputs.frequency}))`,
    triangleWave: (inputs) => `mix(${inputs.min}, ${inputs.max}, 1.0 - abs(fract(${inputs.x} * ${inputs.frequency}) * 2.0 - 1.0))`,
    squareWave: (inputs) => `mix(${inputs.min}, ${inputs.max}, step(0.5, fract(${inputs.x} * ${inputs.frequency})))`,
    // 对齐 Unity SineWave: (1 - cos(F*2π*x))/2 = sin²(F*π*x), 不是 sin(...)*0.5+0.5
    // 两者周期相同但 wave shape 不同：Unity squared sin 在 x=0 时 = 0 ramp up; Laya sin 在 x=0 时 = 0.5 mid
    sineWave: (inputs) => `mix(${inputs.min}, ${inputs.max}, (1.0 - cos(${inputs.x} * ${inputs.frequency} * 6.28318530718)) * 0.5)`,

    // Color
    colorLuma: (inputs) => `dot(${inputs.color}, vec3(0.2126, 0.7152, 0.0722))`,
    hsvToRgb: (inputs) => {
        // HSV to RGB: standard algorithm using mix/fract/clamp
        return `(vec3(${inputs.v}) * mix(vec3(1.0), clamp(abs(fract(vec3(${inputs.h}) + vec3(1.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0), vec3(${inputs.s})))`;
    },
    rgbToHsv: (inputs) => {
        // RGB to HSV: uses VFX helper (injected via VFXCommon)
        return `VFXRGBtoHSV(${inputs.rgb})`;
    },

    // Exp
    exp: "exp({x})",
    log: "log({x})",

    // Constants
    epsilon: () => "1.175494e-38",
    pi: () => "3.14159265358979",

    // Remap
    // remap divider 用 max(_, 1e-6) 保护 0/0 退化（防 const fold 出 NaN，naga 转 WGSL 不支持 NaN literal 让 shader 编译失败）
    remap: (inputs) => `mix(${inputs.newMin}, ${inputs.newMax}, clamp((${inputs.x} - ${inputs.oldMin}) / max(${inputs.oldMax} - ${inputs.oldMin}, 1e-6), 0.0, 1.0))`,

    // Geometry
    distance: "distance({a}, {b})",
    crossProduct: "cross({a}, {b})",
    dotProduct: "dot({a}, {b})",
    length: "length({x})",
    normalize: "normalize({x})",
    reflect: "reflect({i}, {n})",
    refract: "refract({i}, {n}, {eta})",
    squaredLength: (inputs) => `dot(${inputs.x}, ${inputs.x})`,
    squaredDistance: (inputs) => { const d = `(${inputs.a} - ${inputs.b})`; return `dot(${d}, ${d})`; },
    rotate2D: (inputs) => `(mat2(cos(${inputs.angle}), sin(${inputs.angle}), -sin(${inputs.angle}), cos(${inputs.angle})) * ${inputs.x})`,
    rotate3D: (inputs) => {
        // Unity Rotate3D 围绕 center 点旋转：rotate(pos - center, axis, angle) + center
        return `(_rotate3D(${inputs.position} - ${inputs.center}, ${inputs.axis}, ${inputs.angle}) + ${inputs.center})`;
    },
    lookAt: (inputs) => `_lookAt(${inputs.eye}, ${inputs.target}, ${inputs.up})`,

    // Distance
    distanceToLine: (inputs) => `_distanceToLine(${inputs.point}, ${inputs.start}, ${inputs.end})`,
    distanceToPlane: (inputs) => `dot(${inputs.point} - ${inputs.planePos}, ${inputs.planeNormal})`,
    distanceToSphere: (inputs) => `(distance(${inputs.point}, ${inputs.center}) - ${inputs.radius})`,
    distanceToAABox: (inputs) => `_distanceToAABox(${inputs.point}, ${inputs.center}, ${inputs.size})`,
    distanceToOrientedBox: (inputs) => `_distanceToOrientedBox(${inputs.point}, (${inputs.box}).center, (${inputs.box}).angle, (${inputs.box}).size)`,
    distanceToTorus: (inputs) => `_distanceToTorus(${inputs.point}, ${inputs.center}, ${inputs.majorRadius}, ${inputs.minorRadius})`,
    distanceToCone: (inputs) => `_distanceToCone(${inputs.point}, ${inputs.center}, ${inputs.axis}, ${inputs.height}, ${inputs.baseRadius})`,
    distanceToCylinder: (inputs) => `_distanceToCylinder(${inputs.point}, ${inputs.center}, ${inputs.axis}, ${inputs.height}, ${inputs.radius})`,
    inverseMatrix: (inputs) => `inverse(${inputs.matrix})`,
    // Unity Sequential operators — index/count → vec3 in pattern
    // mode (inputs._mode = "Wrap" | "Clamp" | "Mirror") 对齐 Unity ApplyAddressingMode：
    //   Wrap: idx % count（无限循环，loop 多了 particleId 累计后取模）
    //   Clamp: min(idx, count-1)（饱和，超出后停在最后一格）
    //   Mirror: 在 [0, count-1] 来回反射
    // 之前硬编码 Clamp 让 P4 Net10000 loop 2+ 粒子全堆 grid 末格（particleId 9999 一点）
    sequentialLine: (inputs) => {
        const cnt = `max(int(${inputs.count}), 1)`;
        const mode = inputs._mode || "Clamp";
        const idx = mode === "Wrap"
            ? `(int(${inputs.index}) % (${cnt}))`
            : mode === "Mirror"
                ? `_seqMirror(int(${inputs.index}), ${cnt})`
                : `min(int(${inputs.index}), (${cnt}) - 1)`;
        return `mix(${inputs.start}, ${inputs.end}, float(${idx}) / max(float(${cnt}) - 1.0, 1.0))`;
    },
    sequentialCircle: (inputs) => {
        const cnt = `max(int(${inputs.count}), 1)`;
        const mode = inputs._mode || "Clamp";
        // Wrap 时 countForAddressing = count（直接取模），Clamp/Mirror 用 count + 1（包含 0 和 1 两端）
        const idx = mode === "Wrap"
            ? `(int(${inputs.index}) % (${cnt}))`
            : mode === "Mirror"
                ? `_seqMirror(int(${inputs.index}), ${cnt} + 1)`
                : `min(int(${inputs.index}), ${cnt})`;
        const t = `(float(${idx}) / max(float(${cnt}), 1.0))`;
        return `(${inputs.center} + (cos(6.28318530718 * ${t}) * ${inputs.up} + sin(6.28318530718 * ${t}) * normalize(cross(${inputs.normal}, ${inputs.up}))) * ${inputs.radius})`;
    },
    sequential3D: (inputs) => {
        const cX = `max(int(${inputs.countX}), 1)`;
        const cY = `max(int(${inputs.countY}), 1)`;
        const cZ = `max(int(${inputs.countZ}), 1)`;
        const total = `((${cX}) * (${cY}) * (${cZ}))`;
        const mode = inputs._mode || "Clamp";
        const idx = mode === "Wrap"
            ? `(int(${inputs.index}) % (${total}))`
            : mode === "Mirror"
                ? `_seqMirror(int(${inputs.index}), ${total})`
                : `min(int(${inputs.index}), (${total}) - 1)`;
        const fx = `float((${idx}) / ((${cY}) * (${cZ})))`;
        const fy = `float(((${idx}) / (${cZ})) % (${cY}))`;
        const fz = `float((${idx}) % (${cZ}))`;
        const cnt = `vec3(float(${cX}), float(${cY}), float(${cZ}))`;
        const vs = `max(${cnt} - vec3(1.0), vec3(1.0))`;
        const sc = `clamp(${cnt} - vec3(1.0), vec3(0.0), vec3(1.0))`;
        const dt = `(vec3(${fx}, ${fy}, ${fz}) / (${vs}) * 2.0 - vec3(1.0))`;
        return `(${inputs.origin} + (${dt}).x * (${sc}).x * ${inputs.axisX} + (${dt}).y * (${sc}).y * ${inputs.axisY} + (${dt}).z * (${sc}).z * ${inputs.axisZ})`;
    },

    // Coordinate conversions
    polarToRectangular: (inputs) => `(${inputs.distance} * vec2(cos(${inputs.angle}), sin(${inputs.angle})))`,
    rectangularToPolar: (inputs) => `vec2(length(${inputs.xy}), atan(${inputs.xy}.y, ${inputs.xy}.x))`,
    sphericalToRectangular: (inputs) => `(${inputs.distance} * vec3(sin(${inputs.theta}) * cos(${inputs.phi}), cos(${inputs.theta}), sin(${inputs.theta}) * sin(${inputs.phi})))`,
    rectangularToSpherical: (inputs) => {
        return `vec3(length(${inputs.xyz}), acos(clamp(${inputs.xyz}.y / max(length(${inputs.xyz}), 1e-6), -1.0, 1.0)), atan(${inputs.xyz}.z, ${inputs.xyz}.x))`;
    },
    cylindricalToRectangular: (inputs) => `vec3(${inputs.distance} * cos(${inputs.angle}), ${inputs.height}, ${inputs.distance} * sin(${inputs.angle}))`,
    rectangularToCylindrical: (inputs) => `vec3(length(${inputs.xyz}.xz), atan(${inputs.xyz}.z, ${inputs.xyz}.x), ${inputs.xyz}.y)`,

    // Vector Append (construct larger from smaller)
    appendFloat2: (inputs) => `vec2(${inputs.a}, ${inputs.b})`,
    appendFloat3: (inputs) => `vec3(${inputs.a}, ${inputs.b}, ${inputs.c})`,
    appendFloat4: (inputs) => `vec4(${inputs.a}, ${inputs.b}, ${inputs.c}, ${inputs.d})`,
    appendVec2Float: (inputs) => `vec3(${inputs.a}, ${inputs.b})`,
    appendVec3Float: (inputs) => `vec4(${inputs.a}, ${inputs.b})`,
    appendVec2Vec2: (inputs) => `vec4(${inputs.a}, ${inputs.b})`,

    // Component Mask (multiply per channel with 0/1 flag)
    componentMaskVec3: (inputs) => `(${inputs.a} * vec3(${inputs.mx}, ${inputs.my}, ${inputs.mz}))`,
    componentMaskVec4: (inputs) => `(${inputs.a} * vec4(${inputs.mx}, ${inputs.my}, ${inputs.mz}, ${inputs.mw}))`,

    // Volume / Area
    aaBoxVolume: (inputs) => `(${inputs.size}.x * ${inputs.size}.y * ${inputs.size}.z)`,
    orientedBoxVolume: (inputs) => `((${inputs.box}).size.x * (${inputs.box}).size.y * (${inputs.box}).size.z)`,
    sphereVolume: (inputs) => `(4.18879020479 * ${inputs.radius} * ${inputs.radius} * ${inputs.radius})`,
    coneVolume: (inputs) => `(1.0471975512 * ${inputs.height} * (${inputs.baseRadius} * ${inputs.baseRadius} + ${inputs.baseRadius} * ${inputs.topRadius} + ${inputs.topRadius} * ${inputs.topRadius}))`,
    torusVolume: (inputs) => `(19.7392088022 * ${inputs.majorRadius} * ${inputs.minorRadius} * ${inputs.minorRadius})`,
    circleArea: (inputs) => `(3.14159265359 * ${inputs.radius} * ${inputs.radius})`,

    // Viewport
    worldToViewport: (inputs) => `_worldToViewport(${inputs.position}, ${inputs.viewProj})`,
    viewportToWorld: (inputs) => `_viewportToWorld(${inputs.position}, ${inputs.invViewProj})`,

    // SampleBezier — 三次贝塞尔曲线求值：P(t) = (1-t)^3 A + 3(1-t)^2 t B + 3(1-t) t^2 C + t^3 D
    sampleBezier: (inputs) => {
        const t = `(${inputs.t})`;
        const omt = `(1.0 - ${t})`;
        return `(${inputs.a} * ${omt} * ${omt} * ${omt} + ${inputs.b} * 3.0 * ${omt} * ${omt} * ${t} + ${inputs.c} * 3.0 * ${omt} * ${t} * ${t} + ${inputs.d} * ${t} * ${t} * ${t})`;
    },
    // probabilitySampling 和 voroNoise2D 在 router 里单独处理（需要设 _needsNoise 以注入辅助函数）

    // Transform
    transformPosition: (inputs) => `(${inputs.matrix} * vec4(${inputs.position}, 1.0)).xyz`,
    transformDirection: (inputs) => `normalize(mat3(${inputs.matrix}) * ${inputs.direction})`,
    transformVector: (inputs) => `(mat3(${inputs.matrix}) * ${inputs.vector})`,
    transformVector4: (inputs) => `(${inputs.matrix} * ${inputs.vec})`,
    transformMatrix: (inputs) => `(${inputs.matrix} * ${inputs.m})`,
    constructMatrix: (inputs) => `BuildTRS(${inputs.position}, ${inputs.rotation}, ${inputs.scale})`,
    transposeMatrix: (inputs) => `transpose(${inputs.matrix})`,
    inverseTRSMatrix: (inputs) => `_inverseTRS(${inputs.matrix})`,

    // Misc
    ageOverLifetime: (inputs) => `(${inputs.age} / max(${inputs.lifetime}, 1e-6))`,

    // Color space conversion (per-channel approximation pow 2.2)
    gammaToLinear: (inputs) => `pow(max(${inputs.x}, vec3(0.0)), vec3(2.2))`,
    linearToGamma: (inputs) => `pow(max(${inputs.x}, vec3(0.0)), vec3(1.0 / 2.2))`,

    // Trigonometry
    sine: "sin({x})",
    cosine: "cos({x})",
    tangent: "tan({x})",
    arcsine: "asin({x})",
    arccosine: "acos({x})",
    arctangent2: "atan({y}, {x})",

    // Clamp
    ceiling: "ceil({x})",
    clamp: "clamp({x}, {min}, {max})",
    discretize: (inputs) => `(floor(${inputs.x} / ${inputs.step}) * ${inputs.step})`,
    floor: "floor({x})",
    maximum: "max({a}, {b})",
    minimum: "min({a}, {b})",
    round: "round({x})",
    saturate: "clamp({x}, 0.0, 1.0)",
    // Unity RemapToZeroOne: input [-1, 1] → [0, 1]，公式 input * 0.5 + 0.5
    linearRemap: "({x} * 0.5 + 0.5)",

    // 位运算
    bitwiseAnd: "({a} & {b})",
    bitwiseOr: "({a} | {b})",
    bitwiseLeftShift: "({a} << {b})",
    bitwiseRightShift: "({a} >> {b})",
    bitwiseComplement: "(~{a})",
    bitwiseXor: "({a} ^ {b})",

    // 类型敏感
    oneMinus: (inputs, type) => {
        if (type === "int") return `(1 - ${inputs.x})`;
        if (type === "uint") return `(1u - ${inputs.x})`;
        return `(1.0 - ${inputs.x})`;
    },
    modulo: (inputs, type) => {
        if (type === "int" || type === "uint") return `(${inputs.a} % ${inputs.b})`;
        return `mod(${inputs.a}, ${inputs.b})`;
    },
    reciprocal: (inputs, type) => {
        if (type === "int") return `(1 / ${inputs.x})`;
        if (type === "uint") return `(1u / ${inputs.x})`;
        return `(1.0 / ${inputs.x})`;
    },
    inverseLerp: (inputs) => {
        return `clamp((${inputs.s} - ${inputs.x}) / (${inputs.y} - ${inputs.x}), 0.0, 1.0)`;
    },
};

// ─── 分量 swizzle 映射 ─────────────────────────────

const COMPONENT_SWIZZLE: Record<string, string> = {
    out_x: ".x", out_y: ".y", out_z: ".z", out_w: ".w",
    // getAttribute op 输出 slot 命名是 "value"，vec2/vec3/vec4 attribute 的子分量是 value_x/y/z/w
    // 之前漏这套映射让 P4 lineSequencer ← getAttribute(sequential).value_x 编译时取整个 vec2
    // 而非 .x，最终走 _wrapTypeConvert vec2→float narrow 取 .x。但 arcSequencer ← .value_y
    // 在 _reverseIndex 中跟 .value_x 同 key（仅 master "value"），后写覆盖前写让 arcSequencer
    // 没取到任何 link 用静态默认 0
    value_x: ".x", value_y: ".y", value_z: ".z", value_w: ".w",
    x: ".x", y: ".y", z: ".z", w: ".w",
    r: ".r", g: ".g", b: ".b", a: ".a",
};

// ─── 编译器 ─────────────────────────────────────────

export class VfxExprCompiler {
    private _opMap: Map<number, IVfxOperatorData>;
    private _defMap: Map<string, IVfxOperatorTypeDef>;
    private _reverseIndex: Map<string, ISourceInfo>;
    private _compiled: Map<number, string>; // opId → varName
    private _visiting: Set<number>;         // 环路检测
    private _statements: string[];
    private _particleVar: string;
    private _propertyUniforms: Map<string, string>; // propName → glslType
    private _curveEntries: Map<number, number[]>;  // opId → frameData (曲线烘焙数据)
    private _graphProperties: IVfxPropertyDef[];
    private _simulateSpace: string;
    private _spaceMap: Map<number, string>; // opId → "Local" | "World"
    private _needsCamera: boolean;          // 是否需要 camera uniforms
    private _needsNoise: boolean;           // 是否需要噪声库
    private _needsSeqMirror: boolean = false;   // sequential* Mirror 模式需要 helper
    private _skinnedMeshSources: Set<string>;   // "sourceName|position" / "sourceName|normal" 标记需要的 helper
    private _customCodeFunctions: Map<number, string>;   // opId → 用户 GLSL 代码（包装为函数后注入 shader prelude）
    private _stage: string;   // "init" | "update" | "output" — 用于 stage 相关 codegen（如 update 阶段 rotate3D dt 归一）

    constructor(
        operators: IVfxOperatorData[],
        particleVar: string,
        graphProperties?: IVfxPropertyDef[],
        simulateSpace?: string,
        stage?: string,
    ) {
        this._particleVar = particleVar;
        this._graphProperties = graphProperties || [];
        this._simulateSpace = simulateSpace || "Local";
        this._stage = stage || "";
        this._statements = [];
        this._compiled = new Map();
        this._visiting = new Set();
        this._spaceMap = new Map();
        this._propertyUniforms = new Map();
        this._curveEntries = new Map();
        this._needsCamera = false;
        this._needsNoise = false;
        this._skinnedMeshSources = new Set();
        this._customCodeFunctions = new Map();

        // Operator ID 查找表
        this._opMap = new Map();
        for (const op of operators) {
            this._opMap.set(op.id, op);
        }

        // 类型定义查找表
        this._defMap = new Map();
        for (const def of VFX_OPERATOR_DEFS) {
            this._defMap.set(def.typeId, def);
        }

        // 反向索引：target (nodeId:slotId) → source (opId, outSlotId)
        this._reverseIndex = new Map();
        for (const op of operators) {
            if (!op.output) continue;
            for (const [outSlotId, info] of Object.entries(op.output)) {
                for (const conn of info.infoArr) {
                    const key = `${conn.nodeId}:${conn.slotId}`;
                    this._reverseIndex.set(key, { opId: op.id, outSlotId });
                }
            }
        }
    }

    /** 获取编译过程中收集到的 Property uniform 声明 */
    get propertyUniforms(): Map<string, string> {
        return this._propertyUniforms;
    }

    /** 是否需要注入 camera uniforms */
    get needsCamera(): boolean {
        return this._needsCamera;
    }

    /** 是否需要注入噪声库 */
    get needsNoise(): boolean {
        return this._needsNoise;
    }

    /** 是否需要注入 _seqMirror helper（sequential* Mirror 模式） */
    get needsSeqMirror(): boolean {
        return this._needsSeqMirror;
    }

    /** sampleSkinnedMesh 用到的 sourceName + role 集合（"sourceName|position" / "sourceName|normal"），ShaderGen 据此注入 helper function */
    get skinnedMeshSources(): Set<string> {
        return this._skinnedMeshSources;
    }

    /** customGlsl 用户代码（opId → 函数体），ShaderGen 按 stage 注入对应函数定义 */
    get customCodeFunctions(): Map<number, string> {
        return this._customCodeFunctions;
    }

    /** 获取编译过程中收集到的曲线数据 (opId → frameData) */
    get curveEntries(): Map<number, number[]> {
        return this._curveEntries;
    }

    /** 注册内嵌曲线（block 自带 curve property，无外接时使用） */
    registerInlineCurve(id: number, frameData: number[]): string {
        this._curveEntries.set(id, frameData);
        return `u_VfxCurve_${id}`;
    }

    /**
     * 编译 Block 输入端口的 Operator 子图。
     * @param contextId 父 Context 的 ID（连接数据中的 nodeId）
     * @param compositeSlotId 复合 slot ID，如 "block_5_value"
     * @returns 编译结果，或 null（无 Operator 连接）
     */
    compileBlockInput(contextId: number, compositeSlotId: string, expectedType?: string): IExprResult | null {
        const key = `${contextId}:${compositeSlotId}`;
        const source = this._reverseIndex.get(key);
        if (!source) return null;

        const prevLen = this._statements.length;
        let expr = this._compileOutput(source.opId, source.outSlotId);
        const srcType = this._getSourceSlotType(source);

        // ── Block 边界空间转换：转为 simulateSpace ──
        const srcSpace = this._getSourceSpace(source);
        if (srcSpace && srcSpace !== this._simulateSpace) {
            expr = this._wrapSpaceConvert(expr, srcType, this._simulateSpace);
        }

        // ── 类型转换 ──
        if (expectedType && srcType !== expectedType) {
            expr = this._wrapTypeConvert(expr, srcType, expectedType);
        }

        return { stmts: this._statements.slice(prevLen), expr };
    }

    /**
     * 编译 setAttribute 的完整 value 表达式。
     * 支持整体连接和分量级连接，未连接的分量使用 _values 字面量。
     * @returns 编译结果，或 null（完全无 Operator 连接）
     */
    compileSetAttributeValue(
        contextId: number,
        blockId: number,
        attrType: string,
        vals: Record<string, any>,
        slotBase: string = "value",
    ): IExprResult | null {
        // color attribute 存储为 vec3 (RGB)，alpha 是独立属性
        const storageType = attrType === "color" ? "vec3" : attrType;

        // 对齐 Unity SetAttribute slot tree 语义：sub-slot link 优先于 master link 对应通道。
        // Unity 行为：master 连接提供 vec3 默认值；sub-slot 连接覆盖对应通道。
        // 之前 master 全胜让 sampleTexture2D.x → color.x 这种 logo 采样链被 sampleGradient master 屏蔽 →
        // P4 Net10000 拿不到 Unity logo 的 R 通道而 全用 gradient 颜色（红→青渐变），丢失 logo 形状
        // slotBase: "value"=A(随机下限/单值), "b_value"=B(随机上限, Unity SetAttribute Random 槽)
        const comps = _getComponents(attrType);
        const wholeResult = this.compileBlockInput(contextId, `block_${blockId}_${slotBase}`, storageType);

        // 标量 attribute (float/int/uint/bool)：没 sub-slot 概念，直接走 master / fallback
        if (comps.length === 0) {
            return wholeResult;
        }

        // 检查 sub-slot 是否有任何 link
        const subResults: (IExprResult | null)[] = comps.map(comp =>
            this.compileBlockInput(contextId, `block_${blockId}_${slotBase}_${comp}`, "float")
        );
        const anyComp = subResults.some(r => r != null);

        // 没 sub-slot link → 直接用 master / null
        if (!anyComp) return wholeResult;

        // 有 sub-slot link → 构造 vec(sub_x ?? master.x ?? default, sub_y ?? master.y ?? default, ...)
        const stmts: string[] = [];
        let masterVar: string | null = null;
        if (wholeResult) {
            stmts.push(...wholeResult.stmts);
            const gt = glslType(storageType);
            masterVar = slotBase === "value" ? `_setAttrMaster_${blockId}` : `_setAttrMaster_${blockId}_b`;
            stmts.push(`${gt} ${masterVar} = ${wholeResult.expr};`);
        }
        const defaultVal = attrType === "color" ? 1 : 0;
        const valPrefix = slotBase === "value" ? "" : "b_";
        const compExprs: string[] = [];
        for (let i = 0; i < comps.length; i++) {
            const r = subResults[i];
            if (r) {
                stmts.push(...r.stmts);
                compExprs.push(r.expr);
            } else if (masterVar) {
                compExprs.push(`${masterVar}.${comps[i]}`);
            } else {
                compExprs.push(toFloat(vals[`${valPrefix}${comps[i]}`] ?? vals[comps[i]] ?? defaultVal));
            }
        }
        const gt = glslType(storageType);
        return { stmts, expr: `${gt}(${compExprs.join(", ")})` };
    }

    // ─── 内部编译逻辑 ───────────────────────────────

    /** 编译 Operator 的某个输出端口，返回 GLSL 表达式 */
    private _compileOutput(opId: number, outSlotId: string): string {
        // 分量 swizzle (.x, .y, .z, .w, .r, .g, .b, .a)
        const swizzle = COMPONENT_SWIZZLE[outSlotId];
        if (swizzle) return this._compileOperator(opId) + swizzle;

        // noise 多输出: "out" → .x (value), "out_derivatives" → .yzw
        {
            const op = this._opMap.get(opId);
            if (op?.typeId === "noise") {
                if (outSlotId === "out") return this._compileOperator(opId) + ".x";
                if (outSlotId === "out_derivatives") return this._compileOperator(opId) + ".yzw";
            }
            // SpawnState 多输出 — 每个 output slot 对应一个 spawner uniform（Initialize stage 注入）
            if (op?.typeId === "spawnState") {
                switch (outSlotId) {
                    case "out_newLoop": return "(u_NewLoop != 0)";
                    case "out_loopState": return "u_LoopState";
                    case "out_loopIndex": return "u_LoopIndex";
                    case "out_spawnCount": return "u_SpawnCount";
                    case "out_spawnDeltaTime": return "u_SpawnDeltaTime";
                    case "out_spawnTotalTime": return "u_SpawnTotalTime";
                    case "out_loopDuration": return "u_LoopDuration";
                    case "out_loopCount": return "u_LoopCount";
                    case "out_delayBeforeLoop": return "u_DelayBeforeLoop";
                    case "out_delayAfterLoop": return "u_DelayAfterLoop";
                }
            }
        }

        // 复合类型分量输出 (out_<componentId>) — 由 COMPOSITE_TYPE_INFO 驱动
        if (outSlotId.startsWith("out_")) {
            const componentId = outSlotId.substring(4);
            const op = this._opMap.get(opId);
            if (op) {
                const def = this._defMap.get(op.typeId);
                if (def) {
                    const outputType = this._resolveType(op, def);
                    const components = TYPE_COMPONENTS[outputType];
                    const typeInfo = getCompositeTypeInfo(outputType);
                    if (components && typeInfo) {
                        const comp = components.find(c => c.id === componentId);
                        if (comp) {
                            // 自定义提取（transform → mat4 分解, position → pass-through）
                            const extractor = typeInfo.extractComponent?.[componentId];
                            if (extractor) {
                                // Inline 优化: "value" 未连接时直接解析分量输入，避免构建再拆解
                                if (op.typeId.startsWith("inline")) {
                                    const hasValueInput = def.inputs.some(i => i.id === "value");
                                    if (!hasValueInput || !this._hasConnection(op, "value")) {
                                        const matchingInput = def.inputs.find(i => i.id === componentId);
                                        if (matchingInput) {
                                            return this._resolveInput(op, def, componentId, comp.type);
                                        }
                                    }
                                }
                                return extractor(this._compileOperator(opId));
                            }
                            // 结构体字段访问 (默认)
                            return `${this._compileOperator(opId)}.${componentId}`;
                        }
                    }
                }
            }
        }

        // 主输出
        return this._compileOperator(opId);
    }

    /** 编译 Operator 节点，返回其临时变量名 */
    private _compileOperator(opId: number): string {
        // 记忆化
        if (this._compiled.has(opId)) return this._compiled.get(opId)!;

        // 环路检测
        if (this._visiting.has(opId)) {
            console.warn(`[VfxExprCompiler] Cycle detected at operator ${opId}`);
            const cycleOp = this._opMap.get(opId);
            const cycleDef = cycleOp ? this._defMap.get(cycleOp.typeId) : undefined;
            const cycleType = (cycleOp && cycleDef) ? this._resolveType(cycleOp, cycleDef) : "float";
            return zeroLiteral(cycleType);
        }

        const op = this._opMap.get(opId);
        if (!op) return zeroLiteral("float");
        const def = this._defMap.get(op.typeId);
        if (!def) return zeroLiteral("float");

        this._visiting.add(opId);

        const resolvedType = this._resolveType(op, def);
        const varName = `_op${opId}`;

        // 按类别分派编译
        let expr: string;
        if (op.typeId === "getAttribute") {
            expr = this._compileGetAttribute(op);
        } else if (op.typeId === "getProperty") {
            expr = this._compileGetProperty(op);
        } else if (op.typeId === "getCustomAttribute") {
            expr = this._compileGetCustomAttribute(op);
        } else if (op.typeId === "getMainCamera") {
            expr = this._compileGetMainCamera();
        } else if (op.typeId === "curve") {
            expr = this._compileCurve(op);
        } else if (op.typeId === "sampleCurve") {
            expr = this._compileSampleCurve(op, def);
        } else if (op.typeId === "sampleTexture2D" || op.typeId === "sampleTexture3D") {
            expr = this._compileSampleTexture(op, def);
        } else if (op.typeId === "sampleTexture2DArray") {
            expr = this._compileSampleTexture2DArray(op, def);
        } else if (op.typeId === "loadTexture2D" || op.typeId === "loadTexture3D") {
            expr = this._compileLoadTexture(op, def);
        } else if (op.typeId === "loadTexture2DArray") {
            expr = this._compileLoadTexture2DArray(op, def);
        } else if (op.typeId === "sampleTextureCube") {
            expr = this._compileSampleTextureCube(op, def);
        } else if (op.typeId === "periodicTotalTime") {
            expr = this._compilePeriodicTotalTime(op, def);
        } else if (op.typeId === "textureDimensions2D" || op.typeId === "textureDimensions3D") {
            expr = this._compileTextureDimensions(op, def);
        } else if (op.typeId === "sampleGradient" || op.typeId === "colorize") {
            expr = this._compileSampleGradient(op, def);
        } else if (op.typeId === "noise" || op.typeId === "curlNoise" || op.typeId === "worleyNoise") {
            expr = this._compileNoise(op, def);
        } else if (op.typeId === "voroNoise2D") {
            expr = this._compileVoroNoise2D(op, def);
        } else if (op.typeId === "perParticleTotalTime") {
            expr = `${this._particleVar}.age`;
        } else if (op.typeId === "ratioOverStrip") {
            // Unity: ParticleIndexInStrip / (ParticleCountInStrip - 1)
            // 仅在 OutputStrip/OutputTrail context 有效（stripRatio 是 OutputStrip.ts 注入的局部变量）
            expr = "stripRatio";
        } else if (op.typeId === "sampleMeshPosition" || op.typeId === "sampleMeshNormal"
            || op.typeId === "sampleMeshTangent" || op.typeId === "sampleMeshUV"
            || op.typeId === "sampleMeshColor" || op.typeId === "sampleMeshIndex") {
            expr = this._compileSampleMesh(op, def);
        } else if (op.typeId === "samplePointCache") {
            expr = this._compileSamplePointCache(op, def);
        } else if (op.typeId === "sampleSkinnedMeshPosition" || op.typeId === "sampleSkinnedMeshNormal") {
            expr = this._compileSampleSkinnedMesh(op, def);
        } else if (op.typeId === "customGlsl") {
            expr = this._compileCustomGlsl(op, def);
        } else if (op.typeId === "probabilitySampling") {
            // ProbabilitySample4 helper lives in VFXNoise.ts (与 noise 库同文件注入）
            this._needsNoise = true;
            const w = this._resolveInput(op, def, "weights", "vec4");
            expr = `ProbabilitySample4(${w}, Rand(${this._particleVar}.seed))`;
        } else if (op.typeId === "compare") {
            expr = this._compileCompare(op, def);
        } else if (op.typeId === "squaredLength" || op.typeId === "squaredDistance") {
            expr = this._compileWithInputType(op, def);
        } else if (op.typeId === "switchOp") {
            expr = this._compileSwitch(op, def, resolvedType);
        } else if (op.typeId === "randomNumber") {
            expr = this._compileRandomNumber(op, def);
        } else if (op.typeId === "swizzle") {
            expr = this._compileSwizzle(op, def, resolvedType);
        } else if (op.typeId === "weightedSelector") {
            expr = this._compileWeightedSelector(op, def, resolvedType);
        } else if (op.typeId === "sampleSDF") {
            expr = this._compileSampleSDF(op, def);
        } else if (op.typeId === "sampleGraphicsBuffer") {
            expr = this._compileSampleGraphicsBuffer(op, def);
        } else if (op.typeId === "meshVertexCount") {
            expr = this._compileMeshVertexCount(op, def);
        } else if (op.typeId === "meshIndexCount") {
            expr = this._compileMeshIndexOrTriCount(op, def, false);
        } else if (op.typeId === "meshTriangleCount") {
            expr = this._compileMeshIndexOrTriCount(op, def, true);
        } else if (op.typeId === "bufferCount") {
            expr = this._compileBufferCount(op, def);
        } else if (op.typeId === "sampleCameraBuffer") {
            expr = this._compileSampleCameraBuffer(op, def);
        } else if (op.typeId === "loadCameraBuffer") {
            expr = this._compileLoadCameraBuffer(op, def);
        } else if (op.typeId === "changeSpace") {
            expr = this._compileChangeSpace(op, def);
        } else if (op.typeId === "loadTextureCube") {
            expr = this._compileLoadTextureCube(op, def);
        } else if (op.typeId === "textureDimensionsCube") {
            expr = this._compileTextureDimensionsCube(op, def);
        } else if (op.typeId.startsWith("builtin")) {
            expr = this._compileBuiltin(op);
        } else if (op.typeId.startsWith("inline")) {
            expr = this._compileInline(op, def, resolvedType);
        } else {
            expr = this._compileMathOp(op, def, resolvedType);
        }

        // 生成临时变量声明
        const gt = glslType(resolvedType);
        this._statements.push(`${gt} ${varName} = ${expr};`);
        this._compiled.set(opId, varName);
        this._visiting.delete(opId);

        // ── 空间推断 ──
        const space = this._inferSpace(op, def, resolvedType);
        if (space) this._spaceMap.set(opId, space);

        return varName;
    }

    /** 推断 operator 输出的坐标空间 */
    private _inferSpace(op: IVfxOperatorData, def: IVfxOperatorTypeDef, resolvedType: string): string | null {
        // getAttribute: 粒子属性在模拟空间中
        if (op.typeId === "getAttribute") {
            const attrName = (op.props?.attribute as string) || "position";
            // spaceable 属性（position 等）在模拟空间中
            if (getAttributeSpaceable(attrName)) return this._simulateSpace;
            return null;
        }

        // getProperty: 标量属性无空间语义
        if (op.typeId === "getProperty") return null;

        // getMainCamera: camera transform 在世界空间
        if (op.typeId === "getMainCamera") return "World";

        // inline spaceable 节点: 读 _space 元数据
        if (op.typeId.startsWith("inline")) {
            if (isSpaceableType(resolvedType)) {
                return (op.props?._space as string) || "Local";
            }
            return null;
        }

        // 数学运算节点: 输出类型若 spaceable, 取 max(输入 spaces)
        // 当前 supportedTypes 不含 spaceable 类型，此分支预留
        if (isSpaceableType(resolvedType)) {
            let maxSpace: string | null = null;
            for (const inputDef of def.inputs) {
                const key = `${op.id}:${inputDef.id}`;
                const source = this._reverseIndex.get(key);
                if (source) {
                    const srcSpace = this._spaceMap.get(source.opId);
                    if (srcSpace) {
                        if (!maxSpace || srcSpace === "World") maxSpace = srcSpace;
                    }
                }
            }
            return maxSpace;
        }

        return null;
    }

    /** getAttribute → p.attrName 或 src.attrName */
    private _compileGetAttribute(op: IVfxOperatorData): string {
        let attrName = (op.props?.attribute as string) || "position";
        // Unity attribute alias 到 Laya 实际字段：
        //   spawnIndexInStrip = "strip 内 spawn batch 内 index" — 对 SingleBurst→strip 等价于 particleIndexInStrip
        //   (Unity 文档：Different particles created at the same time can have the same value)
        if (attrName === "spawnIndexInStrip") attrName = "particleIndexInStrip";
        const location = (op.props?.location as string) || "Current";
        if (location === "Source") return `src.${attrName}`;
        return `${this._particleVar}.${attrName}`;
    }

    /** getCustomAttribute → p.<customName>，类型由 props._type 驱动（走 _resolveType 路径） */
    private _compileGetCustomAttribute(op: IVfxOperatorData): string {
        const raw = (op.props?.name as string) || "";
        // 清洗成合法 GLSL 标识符（字母/数字/下划线，首字符不可为数字）
        let name = raw.replace(/[^A-Za-z0-9_]/g, "_");
        if (name === "" || /^[0-9]/.test(name)) name = "_" + name;
        return `${this._particleVar}.${name}`;
    }

    /** getProperty → exposed: uniform, non-exposed: 常量内联 */
    private _compileGetProperty(op: IVfxOperatorData): string {
        const propName = (op.props?.property as string) || "";
        const propDef = this._graphProperties.find(p => p.name === propName);
        const propType = propDef?.type || "number";
        const gt = glslType(propType === "number" ? "float" : propType);

        // Curve property 特殊路径：把 default.frames 烘焙到共享 curve atlas，
        // 让 sampleCurve(getProperty(Curve)) 走 vec4 curveData uniform 路径。
        // ⚠️ 不走 u_VfxProp_<name> uniform 因为 runtime 端没 Curve property type 支持。
        // 限制：当前 inline 化（用 default.frames），不支持运行时动态修改 Curve property。
        if (propType.toLowerCase() === "curve") {
            const frames = (propDef?.default as any)?.frames;
            if (Array.isArray(frames) && frames.length > 0) {
                const frameData: number[] = [];
                for (const f of frames) {
                    frameData.push(
                        Number(f.time) || 0,
                        Number(f.value) || 0,
                        Number(f.inTangent) || 0,
                        Number(f.outTangent) || 0,
                        Number(f.inWeight) || 1 / 3,
                        Number(f.outWeight) || 1 / 3,
                        Number(f.weightedMode) || 0,
                    );
                }
                this._curveEntries.set(op.id, frameData);
                return `u_VfxCurve_${op.id}`;
            }
            // 没 frames 兜底 default linear 0→1
            this._curveEntries.set(op.id, [0, 0, 0, 1, 0.333, 0.333, 0, 1, 1, 1, 0, 0.333, 0.333, 0]);
            return `u_VfxCurve_${op.id}`;
        }

        // non-exposed → 内联常量
        if (propDef && !propDef.exposed) {
            const val = propDef.default;
            if (val != null && typeof val === "object") return this._vecLiteral(val as Record<string, number>, gt);
            return toLiteral(val ?? 0, gt);
        }

        const uniformName = `u_VfxProp_${propName}`;
        // bool property：std140 uniform 只能按 Float 声明（uniformMaps 无 Bool），
        // 表达式端用比较还原 bool（直接赋值 float→bool 是 GLSL 编译错误）
        if (gt === "bool") {
            this._propertyUniforms.set(propName, "float");
            return `(${uniformName} != 0.0)`;
        }
        this._propertyUniforms.set(propName, gt);
        return uniformName;
    }

    /** 检查 operator 的指定输入是否有连接 */
    private _hasConnection(op: IVfxOperatorData, inputSlotId: string): boolean {
        return this._reverseIndex.has(`${op.id}:${inputSlotId}`);
    }

    /** getMainCamera → 从 camera uniforms 构造 VFXCamera */
    /** Sample Texture2D/3D — generates textureLod() call, registers texture uniform */
    private _compileSampleTexture(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const texPropName = (op.props?.texture as string) || "";
        const uniformName = `u_VfxTex_${op.id}`;
        // Register texture uniform (runtime will bind the actual texture)
        if (op.typeId === "sampleTexture2D") {
            this._propertyUniforms.set(uniformName, { type: "Texture2D", textureProp: texPropName });
            const uv = this._resolveInput(op, def, "uv", "vec2");
            const mip = this._resolveInput(op, def, "mipLevel", "float");
            // Unity OpenGL convention uv (0,0) 在 bottom-left；WebGPU/D3D 在 top-left。
            // Laya 跑 WebGPU 时 sampleTexture2D 用 uv.y 反转对齐 Unity。
            return `textureLod(${uniformName}, vec2((${uv}).x, 1.0 - (${uv}).y), ${mip})`;
        } else {
            this._propertyUniforms.set(uniformName, { type: "Texture3D", textureProp: texPropName });
            const uvw = this._resolveInput(op, def, "uvw", "vec3");
            const mip = this._resolveInput(op, def, "mipLevel", "float");
            return `textureLod(${uniformName}, ${uvw}, ${mip})`;
        }
    }

    /** Load Texture2D/3D — 对齐 Unity LoadTexture2D/3D.cs：
     *  整数坐标 + mipLevel 精确读取，无插值（GLSL texelFetch → WGSL textureLoad） */
    private _compileLoadTexture(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const texPropName = (op.props?.texture as string) || "";
        const uniformName = `u_VfxTex_${op.id}`;
        if (op.typeId === "loadTexture2D") {
            this._propertyUniforms.set(uniformName, { type: "Texture2D", textureProp: texPropName });
            const x = this._resolveInput(op, def, "x", "float");
            const y = this._resolveInput(op, def, "y", "float");
            const mip = this._resolveInput(op, def, "mipLevel", "float");
            return `texelFetch(${uniformName}, ivec2(int(${x}), int(${y})), int(${mip}))`;
        } else {
            this._propertyUniforms.set(uniformName, { type: "Texture3D", textureProp: texPropName });
            const x = this._resolveInput(op, def, "x", "float");
            const y = this._resolveInput(op, def, "y", "float");
            const z = this._resolveInput(op, def, "z", "float");
            const mip = this._resolveInput(op, def, "mipLevel", "float");
            return `texelFetch(${uniformName}, ivec3(int(${x}), int(${y}), int(${z})), int(${mip}))`;
        }
    }

    /** Sample Texture2DArray — 对齐 Unity SampleTexture2DArray.cs：texture array 按 (uv, slice, mip) 采样 */
    private _compileSampleTexture2DArray(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const texPropName = (op.props?.texture as string) || "";
        const uniformName = `u_VfxTex_${op.id}`;
        this._propertyUniforms.set(uniformName, { type: "Texture2DArray", textureProp: texPropName });
        const uv = this._resolveInput(op, def, "uv", "vec2");
        const slice = this._resolveInput(op, def, "slice", "float");
        const mip = this._resolveInput(op, def, "mipLevel", "float");
        // sampler2DArray: textureLod 第二参数是 vec3(uv.x, uv.y, slice)
        return `textureLod(${uniformName}, vec3(${uv}, ${slice}), ${mip})`;
    }

    /** Load Texture2DArray — 对齐 Unity LoadTexture2DArray.cs：整数 (x, y, slice) + mip 精确读取 */
    private _compileLoadTexture2DArray(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const texPropName = (op.props?.texture as string) || "";
        const uniformName = `u_VfxTex_${op.id}`;
        this._propertyUniforms.set(uniformName, { type: "Texture2DArray", textureProp: texPropName });
        const x = this._resolveInput(op, def, "x", "float");
        const y = this._resolveInput(op, def, "y", "float");
        const slice = this._resolveInput(op, def, "slice", "float");
        const mip = this._resolveInput(op, def, "mipLevel", "float");
        return `texelFetch(${uniformName}, ivec3(int(${x}), int(${y}), int(${slice})), int(${mip}))`;
    }

    /** Sample TextureCube — 对齐 Unity SampleTextureCube.cs：Cubemap 采样（环境光/反射常用）*/
    private _compileSampleTextureCube(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const texPropName = (op.props?.texture as string) || "";
        const uniformName = `u_VfxTex_${op.id}`;
        this._propertyUniforms.set(uniformName, { type: "TextureCube", textureProp: texPropName });
        const uvw = this._resolveInput(op, def, "uvw", "vec3");
        const mip = this._resolveInput(op, def, "mipLevel", "float");
        return `textureLod(${uniformName}, ${uvw}, ${mip})`;
    }

    /** Periodic Total Time — 对齐 Unity PeriodicTotalTime.cs：
     *  lerp(range.x, range.y, fract(totalTime / period))，period=0 保护 */
    private _compilePeriodicTotalTime(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const period = this._resolveInput(op, def, "period", "float");
        const range = this._resolveInput(op, def, "range", "vec2");
        return `mix((${range}).x, (${range}).y, fract(u_TotalTime / max(${period}, 0.001)))`;
    }

    /** Texture Dimensions — 对齐 Unity TextureDimensions.cs：
     *  textureSize(sampler, mip) 返回 ivec2/ivec3，cast 成 vec2/vec3 便于下游使用 */
    private _compileTextureDimensions(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const texPropName = (op.props?.texture as string) || "";
        const uniformName = `u_VfxTex_${op.id}`;
        const mip = this._resolveInput(op, def, "mipLevel", "float");
        if (op.typeId === "textureDimensions2D") {
            this._propertyUniforms.set(uniformName, { type: "Texture2D", textureProp: texPropName });
            return `vec2(textureSize(${uniformName}, int(${mip})))`;
        } else {
            this._propertyUniforms.set(uniformName, { type: "Texture3D", textureProp: texPropName });
            return `vec3(textureSize(${uniformName}, int(${mip})))`;
        }
    }

    /** Sample Gradient — 支持两种来源：
     *  1. 内联关键帧（props.gradient）：运行时烘焙到 u_VfxGradient_<opId>
     *  2. 图级 Gradient property（props.property = propName）：绑定到 u_VfxProp_<propName>，
     *     由 VisualEffect 在 init 时烘焙该属性。
     */
    private _compileSampleGradient(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const t = this._resolveInput(op, def, "t", "float");
        const propName = (op.props?.property as string) || "";
        if (propName) {
            const propDef = this._graphProperties.find(p => p.name === propName);
            if (propDef && (propDef.type === "Gradient" || propDef.type === "gradient")) {
                this._propertyUniforms.set(propName, { type: "Texture2D", graphGradient: propName });
                return `textureLod(u_VfxProp_${propName}, vec2(clamp(${t}, 0.0, 1.0), 0.5), 0.0)`;
            }
        }
        const uniformName = `u_VfxGradient_${op.id}`;
        this._propertyUniforms.set(uniformName, { type: "Texture2D", gradientData: op.props?.gradient });
        return `textureLod(${uniformName}, vec2(clamp(${t}, 0.0, 1.0), 0.5), 0.0)`;
    }

    /** Change Space — 对齐 Unity ChangeSpace.cs：Local↔World 切换
     *  props: fromSpace / toSpace ∈ {Local, World}, mode ∈ {Position, Direction} */
    private _compileChangeSpace(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const input = this._resolveInput(op, def, "input", "vec3");
        const from = (op.props?.fromSpace as string) || "Local";
        const to = (op.props?.toSpace as string) || "World";
        const mode = (op.props?.mode as string) || "Position";
        if (from === to) return `(${input})`;
        const mat = (from === "Local" && to === "World") ? "u_EmitterWorldMatrix" : "u_InvEmitterWorldMatrix";
        if (mode === "Direction") return `(mat3(${mat}) * (${input}))`;
        return `(${mat} * vec4(${input}, 1.0)).xyz`;
    }

    /** Load Texture Cube — 对齐 Unity LoadTextureCube.cs
     *  GLSL 无 texelFetch cube，用 textureLod (dir, mip) 等效访问 */
    private _compileLoadTextureCube(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const texPropName = (op.props?.texture as string) || "";
        const uniformName = `u_VfxTex_${op.id}`;
        this._propertyUniforms.set(uniformName, { type: "TextureCube", textureProp: texPropName });
        const dir = this._resolveInput(op, def, "direction", "vec3");
        const mip = this._resolveInput(op, def, "mipLevel", "float");
        return `textureLod(${uniformName}, ${dir}, ${mip})`;
    }

    /** Texture Cube Dimensions — 对齐 Unity TextureDimensions.cs cube 版 */
    private _compileTextureDimensionsCube(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const texPropName = (op.props?.texture as string) || "";
        const uniformName = `u_VfxTex_${op.id}`;
        this._propertyUniforms.set(uniformName, { type: "TextureCube", textureProp: texPropName });
        const mip = this._resolveInput(op, def, "mipLevel", "float");
        return `vec2(textureSize(${uniformName}, int(${mip})))`;
    }

    /** VoroNoise 2D — Inigo Quilez blended voronoi（辅助函数在 VFX_NOISE_GLSL） */
    private _compileVoroNoise2D(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        this._needsNoise = true;
        const coord = this._resolveInput(op, def, "coord", "vec2");
        const u = this._resolveInput(op, def, "u", "float");
        const v = this._resolveInput(op, def, "v", "float");
        return `GenerateVoroNoise2D(${coord}, ${u}, ${v})`;
    }

    /** Noise / Curl Noise operator */
    private _compileNoise(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        this._needsNoise = true;
        // worleyNoise 固定 Cellular 类型（Unity Worley = Cellular F1）
        const noiseType = op.typeId === "worleyNoise" ? "Cellular" : ((op.props?.noiseType as string) || "Perlin");
        const coord = this._resolveInput(op, def, "coord", "vec3");
        const freq = this._resolveInput(op, def, "frequency", "float");
        const octaves = this._resolveInput(op, def, "octaves", "int");
        const roughness = this._resolveInput(op, def, "roughness", "float");
        const lacunarity = this._resolveInput(op, def, "lacunarity", "float");
        // 对齐 Unity CurlNoise.cs / Noise.cs: BuildExpression 末尾 `result * amplitude`
        // amplitude 默认 1.0; 接 op 链时让 noise 输出整体缩放 (sample 用 sampleCurve(stripRatio) * 0.15 让漂移随 lifetime 渐变)
        const amplitude = this._resolveInput(op, def, "amplitude", "float");
        if (op.typeId === "curlNoise") {
            return `(Generate${noiseType}CurlNoise(${coord}, ${freq}, ${octaves}, ${roughness}, ${lacunarity}) * ${amplitude})`;
        }
        // noise: returns vec4(value, derivatives) — output swizzle 取 .x(value) / .yzw(derivatives)
        const _nexpr = `Generate${noiseType}Noise(${coord}, ${freq}, ${octaves}, ${roughness}, ${lacunarity})`;
        // 对齐 Unity Noise.cs: 用 range(vec2) 缩放 —— value=Fit(n.x,[rawMin,1],range), derivatives*=(range.y-range.x)。
        // 转换器把 Unity noise 的 range 写进 _inputs.range；旧逻辑只乘 amplitude(默认1)忽略 range → 噪声/导数放大~500倍
        // → trail 位移漂移过大甩飞粒子(Gateway Bronze VFX10 乱线)。range 存在则走 Unity 缩放，否则回退 amplitude。
        if (op.props?._inputs && op.props._inputs.range != null) {
            const range = this._resolveInput(op, def, "range", "vec2");
            const rawMin = (noiseType === "Perlin") ? "-1.0" : "0.0";
            return `_applyNoiseRange(${_nexpr}, ${range}, ${rawMin})`;
        }
        return `(${_nexpr} * ${amplitude})`;
    }

    /** Compare 运算符 — 需要读取 settings 中的比较方式 */
    private _compileCompare(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        // 输入类型由 supportedTypes 决定，输出始终是 bool
        const t = op.props?._type as string;
        const inputType = (t && def.supportedTypes?.includes(t)) ? t : (def.supportedTypes?.[0] || "float");
        const a = this._resolveInput(op, def, "a", inputType);
        const b = this._resolveInput(op, def, "b", inputType);
        const cmpOp = (op.props?.operator as string) || "Less";
        const ops: Record<string, string> = {
            Equal: "==", NotEqual: "!=",
            Less: "<", LessOrEqual: "<=",
            Greater: ">", GreaterOrEqual: ">=",
        };
        return `(${a} ${ops[cmpOp] || "<"} ${b})`;
    }

    /** Operators with supportedTypes for inputs but fixed output type (e.g. squaredLength → float) */
    private _compileWithInputType(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const t = op.props?._type as string;
        const inputType = (t && def.supportedTypes?.includes(t)) ? t : (def.supportedTypes?.[0] || "float");
        const inputs: Record<string, string> = {};
        for (const inputDef of def.inputs) {
            inputs[inputDef.id] = this._resolveInput(op, def, inputDef.id, inputType);
        }
        const gen = GLSL_EXPRS[op.typeId];
        if (!gen) return "0.0";
        if (typeof gen === "function") return gen(inputs, inputType);
        return gen.replace(/\{(\w+)\}/g, (_, name) => inputs[name] || "0.0");
    }

    /** Swizzle — 读取 props.pattern (如 "xyzw" / "yxz") 从 vec4 输入生成任意 vec2/3/4 */
    private _compileSwizzle(op: IVfxOperatorData, def: IVfxOperatorTypeDef, resolvedType: string): string {
        const input = this._resolveInput(op, def, "a", "vec4");
        const raw = ((op.props?.pattern as string) || "xyzw").toLowerCase();
        // 只保留合法字符 (xyzw/rgba)
        const valid = raw.replace(/[^xyzwrgba]/g, "");
        const normalized = valid.replace(/r/g, "x").replace(/g/g, "y").replace(/b/g, "z").replace(/a/g, "w");
        // 按 resolvedType 截断/补齐长度
        const needLen = resolvedType === "vec2" ? 2 : resolvedType === "vec3" ? 3 : resolvedType === "vec4" ? 4 : 1;
        let sw = normalized.slice(0, needLen);
        if (sw.length < needLen) sw = sw.padEnd(needLen, sw.charAt(sw.length - 1) || "x");
        return `${input}.${sw}`;
    }

    /** WeightedSelector — 按权重随机选一个输入；用累积阈值 + step/mix 链 */
    private _compileWeightedSelector(op: IVfxOperatorData, def: IVfxOperatorTypeDef, resolvedType: string): string {
        const count = Math.max(2, Math.min(8, Number(op.props?.count) || 2));
        const weights: string[] = [];
        const values: string[] = [];
        for (let i = 0; i < count; i++) {
            weights.push(this._resolveInput(op, def, `weight${i}`, "float"));
            values.push(this._resolveInput(op, def, `value${i}`, resolvedType));
        }
        // 缓存 rand 到局部变量，避免多次 Rand 调用破坏分布
        const randVar = `_wsR${op.id}`;
        const totalExpr = `max(${weights.map(w => `(${w})`).join(" + ")}, 1e-6)`;
        this._statements.push(`float ${randVar} = Rand(${this._particleVar}.seed) * ${totalExpr};`);
        // 构造阈值链：mix(..., mix(v0, v1, step(w0, r)), step(w0+w1, r)) ...
        let acc = `(${weights[0]})`;
        let expr = `mix(${values[0]}, ${values[1]}, step(${acc}, ${randVar}))`;
        for (let i = 2; i < count; i++) {
            acc = `${acc} + (${weights[i - 1]})`;
            expr = `mix(${expr}, ${values[i]}, step(${acc}, ${randVar}))`;
        }
        return expr;
    }

    /** sampleSDF — 采样 3D SDF 纹理，返回有符号距离（正=外部，负=内部） */
    private _compileSampleSDF(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const texPropName = (op.props?.texture as string) || "";
        const uniformName = `u_VfxTex_${op.id}`;
        this._propertyUniforms.set(uniformName, { type: "Texture3D", textureProp: texPropName });

        const pos = this._resolveInput(op, def, "position", "vec3");
        const center = op.props?.center || { x: 0, y: 0, z: 0 };
        const size = op.props?.size || { x: 1, y: 1, z: 1 };
        const cx = toFloat(center.x), cy = toFloat(center.y), cz = toFloat(center.z);
        const sx = toFloat(size.x), sy = toFloat(size.y), sz = toFloat(size.z);

        // UVW = (position - center) / size + 0.5 → [0,1]^3
        return `textureLod(${uniformName}, (${pos} - vec3(${cx}, ${cy}, ${cz})) / max(vec3(${sx}, ${sy}, ${sz}), vec3(1e-4)) + vec3(0.5), 0.0).r`;
    }

    /** sampleMesh{Position/Normal/Tangent/UV/Color} — 从烘焙的 Mesh 属性 texture 读指定顶点的属性
     *  runtime 根据 meshRole 烘焙对应属性到 RGBA32F 1D 纹理，shader 用 index 采样 */
    private _compileSampleMesh(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const meshUuid = (op.props?.mesh as string) || "";
        const roleMap: Record<string, { role: string; swizzle: string }> = {
            sampleMeshPosition: { role: "position", swizzle: ".xyz" },
            sampleMeshNormal: { role: "normal", swizzle: ".xyz" },
            sampleMeshTangent: { role: "tangent", swizzle: "" },      // vec4
            sampleMeshUV: { role: "uv", swizzle: ".xy" },
            sampleMeshColor: { role: "color", swizzle: "" },           // vec4
            sampleMeshIndex: { role: "index", swizzle: ".x" },         // float .x → 外层 cast int
        };
        const info = roleMap[op.typeId] || roleMap.sampleMeshPosition;
        const propName = `MeshAttr_${op.id}_${info.role}`;
        const uniformName = `u_VfxProp_${propName}`;
        this._propertyUniforms.set(propName, {
            type: "Texture2D",
            meshProp: meshUuid,
            meshRole: info.role,
        });
        const idx = this._resolveInput(op, def, "index", "int");
        // texture 是 N×1，横向取样，中心 0.5：u = (index + 0.5) / width
        // 用 textureLod(tex, vec2(u, 0.5), 0) 读取（避免 derivative 非 uniform 问题）
        // 用 mod(idx, width) 让 idx 超出顶点数时回环，否则 textureLod 默认 clamp 会让超出的全堆到最后一个顶点
        const widthExpr = `float(textureSize(${uniformName}, 0).x)`;
        const rawSample = `textureLod(${uniformName}, vec2((mod(float(${idx}), ${widthExpr}) + 0.5) / ${widthExpr}, 0.5), 0.0)${info.swizzle}`;
        // index / uv / color / tangent: 不应用 transform (跟空间无关)
        // position / normal: apply transform.position + rotate(localPos * transform.scale)
        if (op.typeId === "sampleMeshIndex") return `int(${rawSample})`;
        if (op.typeId !== "sampleMeshPosition" && op.typeId !== "sampleMeshNormal") return rawSample;
        const tr = (op.props as any)?._inputs?.transform;
        if (!tr || typeof tr !== "object") return rawSample;
        const pos = tr.position || { x: 0, y: 0, z: 0 };
        const ang = tr.angles || { x: 0, y: 0, z: 0 };
        const scl = tr.scale || { x: 1, y: 1, z: 1 };
        const noTransform = pos.x === 0 && pos.y === 0 && pos.z === 0
            && ang.x === 0 && ang.y === 0 && ang.z === 0
            && scl.x === 1 && scl.y === 1 && scl.z === 1;
        if (noTransform) return rawSample;
        // Euler ZXY (Unity convention) → 单位 degree
        const dx = (ang.x * Math.PI / 180), dy = (ang.y * Math.PI / 180), dz = (ang.z * Math.PI / 180);
        const cx = Math.cos(dx), sx = Math.sin(dx);
        const cy = Math.cos(dy), sy = Math.sin(dy);
        const cz = Math.cos(dz), sz = Math.sin(dz);
        // Unity rotation matrix Y * X * Z (yaw, pitch, roll)
        const m00 = cy * cz + sy * sx * sz, m01 = -cy * sz + sy * sx * cz, m02 = sy * cx;
        const m10 = cx * sz, m11 = cx * cz, m12 = -sx;
        const m20 = -sy * cz + cy * sx * sz, m21 = sy * sz + cy * sx * cz, m22 = cy * cx;
        const f = (n: number) => n.toFixed(6);
        // local = rawSample * scale; world = mat * local + pos
        const matScale = `mat3(vec3(${f(m00 * scl.x)},${f(m10 * scl.x)},${f(m20 * scl.x)}),vec3(${f(m01 * scl.y)},${f(m11 * scl.y)},${f(m21 * scl.y)}),vec3(${f(m02 * scl.z)},${f(m12 * scl.z)},${f(m22 * scl.z)}))`;
        // sampleMeshNormal: 只 rotate (不 translate, scale 应该 inverse-transpose 但近似用 mat3*normal)
        if (op.typeId === "sampleMeshNormal") {
            const matRot = `mat3(vec3(${f(m00)},${f(m10)},${f(m20)}),vec3(${f(m01)},${f(m11)},${f(m21)}),vec3(${f(m02)},${f(m12)},${f(m22)}))`;
            return `(${matRot} * (${rawSample}))`;
        }
        // sampleMeshPosition
        return `((${matScale}) * (${rawSample}) + vec3(${f(pos.x)},${f(pos.y)},${f(pos.z)}))`;
    }

    /** sampleSkinnedMesh{Position,Normal} — 从 SkinnedMeshRenderer 按 vertex index 读 skinned 后的属性
     *  烘焙 mesh 顶点 + boneIdx + boneWeight 到 3 张 RGBA32F 1D 纹理（每个 sourceName 一组）
     *  bones uniform 每帧由 runtime 写入 mat4 array (skinningMatrix = bone.worldMatrix * inverseBindPose)
     *  shader 端调用 helper function 做 4 骨骼 skinning（helper 由 ShaderGen 按 sourceName 注入） */
    private _compileSampleSkinnedMesh(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const sourceName = String(op.props?.sourceName || "default").replace(/[^A-Za-z0-9_]/g, "_") || "default";
        const isPosition = op.typeId === "sampleSkinnedMeshPosition";

        // 共享 sourceName 的 4 个 uniform（多 operator 共用同一组烘焙 + bones）
        // pos / idx / weight 三张 vertex 属性 texture 始终注册（runtime 必须烘焙才能 skinning）
        const posPropName = `SkinnedMeshPos_${sourceName}`;
        const idxPropName = `SkinnedMeshIdx_${sourceName}`;
        const wgtPropName = `SkinnedMeshWeight_${sourceName}`;
        const bonesPropName = `SkinnedMeshBones_${sourceName}`;

        this._propertyUniforms.set(posPropName, { type: "Texture2D", skinnedMeshSource: sourceName, skinnedMeshRole: "position" });
        this._propertyUniforms.set(idxPropName, { type: "Texture2D", skinnedMeshSource: sourceName, skinnedMeshRole: "indices" });
        this._propertyUniforms.set(wgtPropName, { type: "Texture2D", skinnedMeshSource: sourceName, skinnedMeshRole: "weights" });
        // bones 也走 Texture2D（256×1 RGBA32F，64 mat4 × 4 vec4），shader helper 拼装 mat4
        this._propertyUniforms.set(bonesPropName, { type: "Texture2D", skinnedMeshSource: sourceName, skinnedMeshRole: "bones" });

        // 标记 sourceName + role 让 ShaderGen 在 prelude 注入对应 helper function
        if (!this._skinnedMeshSources) this._skinnedMeshSources = new Set();
        this._skinnedMeshSources.add(sourceName + "|position");
        if (!isPosition) {
            const normalPropName = `SkinnedMeshNormal_${sourceName}`;
            this._propertyUniforms.set(normalPropName, { type: "Texture2D", skinnedMeshSource: sourceName, skinnedMeshRole: "normal" });
            this._skinnedMeshSources.add(sourceName + "|normal");
        }

        const idx = this._resolveInput(op, def, "index", "int");
        const fnName = isPosition ? `_sampleSkinnedMeshPos_${sourceName}` : `_sampleSkinnedMeshNormal_${sourceName}`;
        return `${fnName}(${idx})`;
    }

    /** customGlsl — 用户写一段 GLSL 函数体，编译时包装为函数注入 shader prelude
     *  函数签名固定：vec4 _userCustom_<id>(vec4 a, vec4 b, vec4 c, vec4 d)
     *  expression 调用 `_userCustom_<id>(a_expr, b_expr, c_expr, d_expr)` */
    private _compileCustomGlsl(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const code = String(op.props?.code || "return a;");
        this._customCodeFunctions.set(op.id, code);
        const a = this._resolveInput(op, def, "a", "vec4");
        const b = this._resolveInput(op, def, "b", "vec4");
        const c = this._resolveInput(op, def, "c", "vec4");
        const d = this._resolveInput(op, def, "d", "vec4");
        return `_userCustom_${op.id}(${a}, ${b}, ${c}, ${d})`;
    }

    /** samplePointCache — 从 .pcache JSON 资源按 index 读指定 attribute
     *  runtime 用 fetch 加载 JSON，按 attribute name 取 number[][] 数组烘焙到 RGBA32F 1×N 纹理 */
    private _compileSamplePointCache(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const pcachePath = String(op.props?.pcache || "");
        const attrName = String(op.props?.attribute || "position").trim() || "position";
        // attribute name 带到 textureType 里，Runtime 用正则匹配出来
        // attrName 仅做基本 sanitize：只保留字母/数字/下划线，避免在 textureType 字符串里出问题
        const safeAttr = attrName.replace(/[^A-Za-z0-9_]/g, "_");
        const propName = `PointCache_${op.id}_${safeAttr}`;
        const uniformName = `u_VfxProp_${propName}`;
        this._propertyUniforms.set(propName, {
            type: "Texture2D",
            pcacheProp: pcachePath,
            pcacheAttr: safeAttr,
        });
        const idx = this._resolveInput(op, def, "index", "int");
        const widthExpr = `float(textureSize(${uniformName}, 0).x)`;
        return `textureLod(${uniformName}, vec2((mod(float(${idx}), ${widthExpr}) + 0.5) / ${widthExpr}, 0.5), 0.0)`;
    }

    /** meshVertexCount — 读 Mesh 顶点数。复用 MeshPos 烘焙纹理：runtime 烘焙 mesh 顶点到
     *  RGBA32F 1D 纹理（宽=顶点数），shader textureSize 读取宽度 = 顶点数 */
    private _compileMeshVertexCount(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const meshUuid = (op.props?.mesh as string) || "";
        if (!meshUuid) return "0";
        const propName = `MeshVtxCount_${op.id}`;
        const uniformName = `u_VfxProp_${propName}`;
        this._propertyUniforms.set(propName, {
            type: "Texture2D",
            meshProp: meshUuid,
            meshRole: "position",
        });
        return `textureSize(${uniformName}, 0).x`;
    }

    /** meshIndexCount / meshTriangleCount — 复用 sampleMeshIndex 的 MeshIndex 烘焙纹理
     *  textureSize.x = mesh.getIndices().length；triangleCount = indexCount / 3 */
    private _compileMeshIndexOrTriCount(op: IVfxOperatorData, def: IVfxOperatorTypeDef, isTriangle: boolean): string {
        const meshUuid = (op.props?.mesh as string) || "";
        if (!meshUuid) return "0";
        const propName = `MeshIdxCount_${op.id}`;
        const uniformName = `u_VfxProp_${propName}`;
        this._propertyUniforms.set(propName, {
            type: "Texture2D",
            meshProp: meshUuid,
            meshRole: "index",
        });
        return isTriangle
            ? `(textureSize(${uniformName}, 0).x / 3)`
            : `textureSize(${uniformName}, 0).x`;
    }

    /** bufferCount — 读 StorageBuffer 的 runtime array 元素数。GLSL 4.3+ 的 .length() 方法，
     *  naga 转 WGSL 时变成 arrayLength(&buf.data) */
    private _compileBufferCount(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const propName = (op.props?.property as string) || "";
        if (!propName) return "0";
        const bufferName = `VfxProp_${propName}`;
        this._propertyUniforms.set(`buf_${propName}`, {
            _rawUniformName: bufferName,
            _bufferProperty: propName,
            type: "StorageBuffer",
        });
        return `int(${bufferName}.data.length())`;
    }

    /** sampleGraphicsBuffer — 从用户绑定的 StorageBuffer 读取 vec4 */
    private _compileSampleGraphicsBuffer(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const propName = (op.props?.property as string) || "";
        if (!propName) return "vec4(0.0)";
        const index = this._resolveInput(op, def, "index", "int");
        const bufferName = `VfxProp_${propName}`;
        // 注册 storage buffer uniform — 走 _rawUniformName 机制（bufferType 标记）
        this._propertyUniforms.set(`buf_${propName}`, {
            _rawUniformName: bufferName,
            _bufferProperty: propName,
            type: "StorageBuffer",
        });
        return `${bufferName}.data[${index}]`;
    }

    /** sampleCameraBuffer — 采样相机深度 / 颜色 buffer。
     *  约束：仅在 output context（fragment shader）可用，因 u_CameraDepthTexture /
     *  u_CameraOpaqueTexture 由 Laya 渲染管线为 fragment shader 注入；compute shader
     *  没有这些 binding，使用后会导致 shader 编译失败或值为 0。
     *  depth 输出为纹理原始值（非线性 eye-space），用户如需 eye-space 自行用 Camera 投影矩阵换算。
     */
    private _compileSampleCameraBuffer(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const uv = this._resolveInput(op, def, "uv", "vec2");
        const buffer = (op.props?.buffer as string) || "Depth";
        if (buffer === "Color") {
            return `texture2D(u_CameraOpaqueTexture, ${uv})`;
        }
        return `texture2D(u_CameraDepthTexture, ${uv}).r`;
    }

    /** loadCameraBuffer — sampleCameraBuffer 的整数像素坐标版（texelFetch，无插值）。
     *  同样仅在 output context（fragment shader）可用。
     */
    private _compileLoadCameraBuffer(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const x = this._resolveInput(op, def, "x", "float");
        const y = this._resolveInput(op, def, "y", "float");
        const mip = this._resolveInput(op, def, "mipLevel", "float");
        const buffer = (op.props?.buffer as string) || "Depth";
        if (buffer === "Color") {
            return `texelFetch(u_CameraOpaqueTexture, ivec2(int(${x}), int(${y})), int(${mip}))`;
        }
        return `texelFetch(u_CameraDepthTexture, ivec2(int(${x}), int(${y})), int(${mip})).r`;
    }

    /** Switch — 多路选择器，根据 index 选择输入 */
    private _compileSwitch(op: IVfxOperatorData, def: IVfxOperatorTypeDef, resolvedType: string): string {
        const index = this._resolveInput(op, def, "index", "int");
        const count = Number(op.props?.count) || 4;
        let result = this._resolveInput(op, def, "input0", resolvedType);
        for (let i = count - 1; i >= 1; i--) {
            const val = this._resolveInput(op, def, `input${i}`, resolvedType);
            result = `(${index} == ${i} ? ${val} : ${result})`;
        }
        return result;
    }

    /** Random Number — 使用 Rand(seed) 生成随机值，mix(min, max, rand) */
    private _compileRandomNumber(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const resolvedType = this._resolveType(op, def);
        const minExpr = this._resolveInput(op, def, "min", resolvedType);
        const maxExpr = this._resolveInput(op, def, "max", resolvedType);
        const dim = typeDim(resolvedType);
        // PerParticleStrip: 用 stripIndex 派生 hash 作 seed，让一条 strip 内所有粒子用同一 random 值
        // (对齐 Unity Random Float (Per Particle Strip) — 同 stripIndex 同值)
        const seedMode = (op.props as any)?.seed as string;
        const inlineSeed = Number((op.props as any)?._inputs?.seed) || 0;
        // Unity constant=true (Per Particle): 每粒子固定一次随机值、跨帧稳定。
        // 必须用 FixedRand(无状态纯函数) 而非 Rand(推进 seed → 每帧/每次调用重roll)，否则
        // update 阶段每帧读到不同值（如 rotate3D 轨道角速度逐帧抖动）。op.id 区分不同 operator。
        const isConstant = (op.props as any)?.constant === true;
        const opOffset = (Number((op as any).id) || 0) >>> 0;
        const seedExpr = seedMode === "PerParticleStrip"
            ? `WangHash(${this._particleVar}.stripIndex + ${inlineSeed >>> 0}u)`
            : `${this._particleVar}.seed`;
        if (dim <= 1) {
            // PerParticleStrip 的 Rand 不能用 stateful seed (Rand 推进 seed 让每次调用值不同)
            // 而 PerParticleStrip 期望同 stripIndex 永远同值 — 用 PerParticleStrip 时直接用 hash 转 [0,1)
            if (seedMode === "PerParticleStrip") {
                return `mix(${minExpr}, ${maxExpr}, float(${seedExpr}) / 4294967295.0)`;
            }
            if (isConstant) {
                return `mix(${minExpr}, ${maxExpr}, FixedRand(${this._particleVar}.seed + ${opOffset}u))`;
            }
            return `mix(${minExpr}, ${maxExpr}, Rand(${this._particleVar}.seed))`;
        }
        // 多维：每个分量独立随机
        if (seedMode === "PerParticleStrip") {
            const comps = [];
            for (let i = 0; i < dim; i++) {
                comps.push(`(float(WangHash(${this._particleVar}.stripIndex + ${(inlineSeed + i * 0x9E3779B9) >>> 0}u)) / 4294967295.0)`);
            }
            const randType = dim === 2 ? "vec2" : dim === 3 ? "vec3" : "vec4";
            return `mix(${minExpr}, ${maxExpr}, ${randType}(${comps.join(", ")}))`;
        }
        const comps = [];
        for (let i = 0; i < dim; i++) {
            comps.push(isConstant
                ? `FixedRand(${this._particleVar}.seed + ${(opOffset + i * 0x9E3779B9) >>> 0}u)`
                : `Rand(${this._particleVar}.seed)`);
        }
        const randType = dim === 2 ? "vec2" : dim === 3 ? "vec3" : "vec4";
        return `mix(${minExpr}, ${maxExpr}, ${randType}(${comps.join(", ")}))`;
    }

    /** Built-in 常量/Uniform 直接引用 */
    private _compileBuiltin(op: IVfxOperatorData): string {
        switch (op.typeId) {
            case "builtinDeltaTime": return "u_DeltaTime";
            case "builtinTotalTime": return "u_TotalTime";
            case "builtinSystemSeed": return "u_SystemSeed";
            case "builtinLocalToWorld": return "u_EmitterWorldMatrix";
            case "builtinWorldToLocal": return "u_InvEmitterWorldMatrix";
            case "builtinLoopIndex": return "u_LoopIndex";
            default: return "0.0";
        }
    }

    private _compileGetMainCamera(): string {
        this._needsCamera = true;
        return "VFXCamera(BuildTRS(u_VfxCameraParams.xyz, u_VfxCameraParams2.xyz, vec3(1.0)), u_VfxCameraParams.w, u_VfxCameraParams2.w, u_VfxCameraParams3.x, u_VfxCameraParams3.y, u_VfxCameraParams3.z, u_VfxCameraParams3.w)";
    }

    /** curve 数据节点 → 注册曲线并返回 curveData uniform 占位符 */
    private _compileCurve(op: IVfxOperatorData): string {
        const curveVal = op.props?.curve as any;
        const frameData: number[] = curveVal?.frameData || [0, 0, 0, 1, 0.333, 0.333, 0, 1, 1, 0, 1, 0.333, 0.333, 0];
        this._curveEntries.set(op.id, frameData);
        return `u_VfxCurve_${op.id}`;
    }

    /** sampleCurve 节点 → SampleCurve(bakedTex, curveData, t) */
    private _compileSampleCurve(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        const tExpr = this._resolveInput(op, def, "t", "float");
        // 强制注册一个 curve entry 让 hasCurves=true，触发 ShaderGen 在 uniformMaps 声明
        // u_VfxBakedTex（共享）+ u_VfxCurve_<opId>。否则独立 sampleCurve op 用 u_VfxBakedTex
        // 但模板没声明 → preprocess 'u_VfxBakedTex' undeclared identifier
        // 优先用 op.props.curve.frameData (Unity 转过来的真实曲线)，
        // fallback default linear 0→1 (跟 setAttributeCurve 的 fallback 一致)
        if (!this._curveEntries.has(op.id)) {
            const inlineFrameData = (op as any).props?.curve?.frameData;
            const frameData = Array.isArray(inlineFrameData) && inlineFrameData.length >= 7
                ? inlineFrameData
                : [0, 0, 0, 1, 0.333, 0.333, 0, 1, 1, 1, 0, 0.333, 0.333, 0];
            this._curveEntries.set(op.id, frameData);
        }
        // curve 输入未连接时必须 fallback 到本 op 自己的 curve uniform，而不是 vec4(0.0)
        // (vec4(0.0) 让 SampleCurve uNorm = t*0+0 = 0，所有 t 采样同一起点 → 整条曲线塌成常数)
        const curveExpr = this._hasConnection(op, "curve")
            ? this._resolveInput(op, def, "curve", "curve")
            : `u_VfxCurve_${op.id}`;
        return `SampleCurve(u_VfxBakedTex, ${curveExpr}, ${tExpr})`;
    }

    /** inline* 常量/构造器节点 — 由 COMPOSITE_TYPE_INFO + TYPE_COMPONENTS 驱动 */
    private _compileInline(op: IVfxOperatorData, def: IVfxOperatorTypeDef, resolvedType: string): string {
        // inlineMatrix4x4 — 4 个 vec4 行构造 mat4（GLSL 的 mat4 构造按列，这里用 transpose 把行转列）
        if (op.typeId === "inlineMatrix4x4") {
            const r0 = this._resolveInput(op, def, "row0", "vec4");
            const r1 = this._resolveInput(op, def, "row1", "vec4");
            const r2 = this._resolveInput(op, def, "row2", "vec4");
            const r3 = this._resolveInput(op, def, "row3", "vec4");
            return `transpose(mat4(${r0}, ${r1}, ${r2}, ${r3}))`;
        }
        const info = getCompositeTypeInfo(resolvedType);
        if (info) {
            // "value" 整体输入
            if (this._hasConnection(op, "value"))
                return this._resolveInput(op, def, "value", resolvedType);
            // 从 TYPE_COMPONENTS 自动展开分量输入
            const components = TYPE_COMPONENTS[resolvedType];
            if (components) {
                const fieldExprs = components.map(comp =>
                    this._resolveInput(op, def, comp.id, comp.type));
                return info.construct(fieldExprs);
            }
        }
        // 标量类型 (float/int/uint)
        return this._resolveInput(op, def, "value", resolvedType);
    }

    /** 数学运算节点：使用 GLSL_EXPRS 映射 */
    private _compileMathOp(op: IVfxOperatorData, def: IVfxOperatorTypeDef, resolvedType: string): string {
        // 多态节点（add/multiply/lerp 等带 supportedTypes）才用 resolvedType 广播 input；
        // 固定类型节点（constructMatrix/transformPosition 等）按 def 里写的 input type 解析，
        // 否则会把 vec3 输入广播成 transform/mat4，BuildTRS 找不到匹配
        const isPolymorphic = !!def.supportedTypes?.length;
        const inputs: Record<string, string> = {};
        for (const inputDef of def.inputs) {
            const inputType = isPolymorphic
                ? ((inputDef.type === "bool" || inputDef.type === "int" || inputDef.type === "uint")
                    ? inputDef.type
                    : resolvedType)
                : inputDef.type;
            inputs[inputDef.id] = this._resolveInput(op, def, inputDef.id, inputType);
        }
        // sequential3D / sequentialLine / sequentialCircle 用 op.props.mode (Unity ApplyAddressingMode)
        // 注入到 inputs._mode 让 GLSL_EXPRS 模板按 Wrap/Clamp/Mirror 生成不同 idx 处理
        if (op.typeId === "sequential3D" || op.typeId === "sequentialLine" || op.typeId === "sequentialCircle") {
            const m = (op.props?.mode as string);
            if (m === "Wrap" || m === "Mirror") {
                inputs._mode = m;
                if (m === "Mirror") this._needsSeqMirror = true;
            }
        }

        // N-ary multiply/add 支持：Unity multiply/add 可以接 a/b/c/d 多个 inputs，
        // 但 Laya IDE def 只声明 a/b。检测 reverseIndex 里 op.id 是否还有 c/d 等额外 input link
        // 或 props._inputs 里有对应字段的 inline 值（如 multiply 3-input a*b*c 用 c=-0.05 inline 常数）
        // 之前只检查 link 让 inline c/d/... 被静默丢弃 (P4 Net10000 noise * direction * -0.05 丢了 -0.05 →
        // 位移从 5cm 变成 1m 把 cylinder 完全淹没)
        if ((op.typeId === "multiply" || op.typeId === "add") && isPolymorphic) {
            const extras: string[] = [];
            const inlineInputs = (op.props?._inputs as Record<string, any>) || {};
            for (const id of ["c", "d", "e", "f", "g", "h"]) {
                const key = `${op.id}:${id}`;
                const hasLink = this._reverseIndex.has(key);
                const hasInline = inlineInputs[id] !== undefined;
                if (hasLink || hasInline) {
                    const inputType = (resolvedType === "bool" || resolvedType === "int" || resolvedType === "uint") ? resolvedType : resolvedType;
                    extras.push(this._resolveInput(op, def, id, inputType));
                } else {
                    break; // 第一个空就停（cascade 必须连续）
                }
            }
            if (extras.length > 0) {
                const operator = op.typeId === "multiply" ? "*" : "+";
                let cascade = `(${inputs.a} ${operator} ${inputs.b})`;
                for (const e of extras) cascade = `(${cascade} ${operator} ${e})`;
                return cascade;
            }
        }

        // rotate3D 在 update 阶段作累积旋转时 angle 是 per-frame 增量、帧率相关；而 gravity 等是 dt 归一。
        // Laya 预览帧率远低于 Unity 编辑器 → 公转被拖慢、被 gravity 垂直漂移压倒 → strip 不水平转、直接上升。
        // dt 归一让公转角速度 = angle * ORBIT_FPS rad/s 与帧率解耦、恢复水平公转。仅 update 阶段。
        // 注意：ORBIT_FPS 只影响 strip(rotate3D 公转)，不影响 disc 环(disc 靠 _MainTextureOffset UV 滚动旋转)。
        // Unity 源码确认 Rotate3D 无 dt(逐帧累积)+ EulerIntegration 有 dt → orbit 速度本就依赖 Unity 运行帧率，
        // 没有源码常量可对，ORBIT_FPS 是匹配 Unity 帧率的经验值。实测：60 太慢→被 gravity 压成直刺；360→弧太长 sprawl。
        // 取值逼近"用户 Unity 参考帧率"，需与 gravity 上升平衡成"边绕边升"的螺旋：
        //   180(82°/s)→ orbit 太弱被 gravity 压成竖直尖刺；300(137°/s)→ orbit 太强压平成贴 rim 大弧。
        //   Unity 参考是中等 pitch 上升螺旋 → 取中间 240(109°/s)：水平绕圈与垂直上升平衡。
        // VFX14 共用同一 -0.008 orbit，会同步变更协调。
        if (op.typeId === "rotate3D" && this._stage === "update" && inputs.angle) {
            const ORBIT_FPS = 240.0;
            inputs.angle = `((${inputs.angle}) * u_DeltaTime * ${ORBIT_FPS})`;
        }

        const gen = GLSL_EXPRS[op.typeId];
        if (!gen) {
            console.warn(`[VfxExprCompiler] No GLSL mapping for operator '${op.typeId}'`);
            return zeroLiteral(resolvedType);
        }

        if (typeof gen === "function") {
            return gen(inputs, resolvedType);
        }

        // 模板替换: "{a}" → inputs.a
        return gen.replace(/\{(\w+)\}/g, (_, name) => inputs[name] || zeroLiteral(resolvedType));
    }

    /** 解析单个输入：优先使用连接的 Operator，否则使用默认值 */
    private _resolveInput(op: IVfxOperatorData, def: IVfxOperatorTypeDef, inputSlotId: string, resolvedType: string): string {
        // 检查该输入是否有连接
        const key = `${op.id}:${inputSlotId}`;
        const source = this._reverseIndex.get(key);

        // ── composite type inline default + sub-slot link 合并 ──
        // 转换器写 _inputs.matrix = {position, angles/rotation, scale} 给 transformPosition 的 transform input,
        // _vecLiteral 不支持 composite type 走 default case 让 val.x undefined → 0.0 → matrix=0 让 position=0.
        // 同时 Unity branch op output 可能接到 transform sub-slot (e.g. matrix_angles_y), 此时需要 inline default
        // 跟 sub-slot link 合并: BuildTRS(inline_pos, vec3(0, branch_output, 0), inline_scale).
        // (Unity field name "angles" 跟 IDE "rotation" 不一致, 兜底)
        if (!source) {
            const compInfo = getCompositeTypeInfo(resolvedType);
            const compComps = (TYPE_COMPONENTS as any)[resolvedType];
            if (compInfo && compComps) {
                const inputs = op.props?._inputs as Record<string, any> | undefined;
                let inputVal = inputs?.[inputSlotId];
                if (resolvedType === "transform" && inputVal && inputVal.angles != null && inputVal.rotation == null) {
                    inputVal = { ...inputVal, rotation: inputVal.angles };
                }
                // 收集每个 composite 子分量 (e.g. transform.position/rotation/scale 各 vec3) 的 expr —
                // 优先 sub-slot link, fallback inline default, 最终 zero
                const fieldExprs: string[] = [];
                let hasAnySubLink = false;
                for (const comp of compComps) {
                    // 子分量本身可能含嵌套 sub-slot (e.g. matrix_angles_y for transform.angles vec3),
                    // 这里递归调用 _resolveInput 让 vec3 sub-slot detection 路径处理
                    const subKey = `${inputSlotId}_${comp.id.toLowerCase()}`;
                    // 检查 sub-slot 直接 link 或子分量 link (e.g. matrix_angles_y 存在)
                    const directLink = this._reverseIndex.get(`${op.id}:${subKey}`);
                    const childLinks = ["x", "y", "z", "w"].some(c => this._reverseIndex.get(`${op.id}:${subKey}_${c}`));
                    if (directLink || childLinks) hasAnySubLink = true;
                    // 把子分量 inline default 临时塞进 _inputs 让递归 _resolveInput 拿到
                    const fakeOp = { ...op, props: { ...op.props,
                        _inputs: { ...inputs, [subKey]: inputVal?.[comp.id] } as any } } as IVfxOperatorData;
                    const fakeDef = { ...def, inputs: [{ id: subKey, name: subKey, type: comp.type }] } as any;
                    fieldExprs.push(this._resolveInput(fakeOp, fakeDef, subKey, comp.type));
                }
                if (hasAnySubLink || (inputVal != null && typeof inputVal === "object")) {
                    return compInfo.construct(fieldExprs);
                }
            }
        }

        // ── 子 slot 合并（Unity vec2 input 接子 slot .x/.y） ──
        // Unity vfx 拓扑常见：sampleTexture2D.uv.x ← OneMinus.out, sampleTexture2D.uv.y ← linearRemap.y
        // 转换器输出两条 link 接同一 master "uv" slot 让后写覆盖前写丢失 .x。
        // 检测：master slot 没接 OR _reverseIndex 含 inputSlotId_x/_y/_z 子 slot key → vec2(.x, .y) 拼接
        if (resolvedType === "vec2" || resolvedType === "vec3" || resolvedType === "vec4") {
            const xKey = `${op.id}:${inputSlotId}_x`;
            const yKey = `${op.id}:${inputSlotId}_y`;
            const zKey = `${op.id}:${inputSlotId}_z`;
            const wKey = `${op.id}:${inputSlotId}_w`;
            const sx = this._reverseIndex.get(xKey);
            const sy = this._reverseIndex.get(yKey);
            const sz = this._reverseIndex.get(zKey);
            const sw = this._reverseIndex.get(wKey);
            if (sx || sy || sz || sw) {
                // sub-slot fallback 应该读 inline default 子分量 (inputs.<slot>.x/.y/.z), 不能死 "0.0"
                // 否则部分 sub-slot link 让另外 inline 分量丢失 (e.g. transform.rotation.y ← branch 让
                // rotation.x=90 inline 变 0)
                const inlineVec = (op.props?._inputs as Record<string, any>)?.[inputSlotId];
                const inlineFallback = (axis: string): string => {
                    if (inlineVec && typeof inlineVec === "object" && inlineVec[axis] != null) {
                        return toFloat(Number(inlineVec[axis]) || 0);
                    }
                    return "0.0";
                };
                const compileSub = (s: ISourceInfo | undefined, fallback: string): string => {
                    if (!s) return fallback;
                    let e = this._compileOutput(s.opId, s.outSlotId);
                    const t = this._getSourceSlotType(s);
                    if (t !== "float") e = this._wrapTypeConvert(e, t, "float");
                    return e;
                };
                const xExpr = compileSub(sx, inlineFallback("x"));
                const yExpr = compileSub(sy, inlineFallback("y"));
                if (resolvedType === "vec2") return `vec2(${xExpr}, ${yExpr})`;
                const zExpr = compileSub(sz, inlineFallback("z"));
                if (resolvedType === "vec3") return `vec3(${xExpr}, ${yExpr}, ${zExpr})`;
                const wExpr = compileSub(sw, inlineFallback("w"));
                return `vec4(${xExpr}, ${yExpr}, ${zExpr}, ${wExpr})`;
            }
        }

        if (source) {
            // ── vec3 master 子 slot widen 处理 ──
            // Unity vfx 拓扑常见 RemapToZeroOne(vec3) 子 slot .y 接到 sampleTexture2D.uv (vec2)，
            // 期望取 master vec3 的 .xy widen 而不是 .y broadcast。
            // 检测：source.outSlotId 是 out_x/out_y/out_z 且 resolvedType 是 vec2/vec3 → 改用 master output
            // 配 wrapTypeConvert 自动 .xy/.xyz 截取（line 1604-1607）。
            const isSwizzleSlot = source.outSlotId === "out_x" || source.outSlotId === "out_y" || source.outSlotId === "out_z" || source.outSlotId === "out_w";
            const dstWantsVec = resolvedType === "vec2" || resolvedType === "vec3" || resolvedType === "vec4";
            let outSlotIdForCompile = source.outSlotId;
            if (isSwizzleSlot && dstWantsVec) {
                // 改用 master output 让 _compileOutput 返回上游 vec3/vec2，再走 wrapTypeConvert .xy 路径
                outSlotIdForCompile = "out";
            }
            let expr = this._compileOutput(source.opId, outSlotIdForCompile);

            // 重新计算 srcType（如果 widen 切换到 master）
            const widenSource = isSwizzleSlot && dstWantsVec
                ? { ...source, outSlotId: "out" }
                : source;
            const srcType = this._getSourceSlotType(widenSource);

            // ── 空间转换 ──
            const srcSpace = this._getSourceSpace(widenSource);
            const dstSpace = this._getExpectedSpace(op);
            if (srcSpace && dstSpace && srcSpace !== dstSpace) {
                expr = this._wrapSpaceConvert(expr, srcType, dstSpace);
            }

            // ── 类型转换 ──
            if (srcType !== resolvedType) {
                expr = this._wrapTypeConvert(expr, srcType, resolvedType);
            }

            return expr;
        }

        // 无连接：使用默认值
        return this._getDefaultValue(op, def, inputSlotId, resolvedType);
    }

    /** 获取上游 operator 输出的空间（非 spaceable 分量输出返回 null） */
    private _getSourceSpace(source: ISourceInfo): string | null {
        const slotType = this._getSourceSlotType(source);
        // 非 spaceable 类型（float, vec3, int 等）不携带空间语义
        if (!isSpaceableType(slotType)) return null;
        // spaceable 类型（position, transform, sphere 等）: 继承源 operator 空间
        return this._spaceMap.get(source.opId) || null;
    }

    /** 获取当前 operator 期望的输入空间 */
    private _getExpectedSpace(op: IVfxOperatorData): string | null {
        // spaceable operator: 期望自身空间
        const def = this._defMap.get(op.typeId);
        if (def) {
            const outType = this._resolveType(op, def);
            if (isSpaceableType(outType)) {
                return (op.props?._space as string) || this._spaceMap.get(op.id) || "Local";
            }
        }
        return null;
    }

    /** 获取上游输出 slot 的类型 — 由 TYPE_COMPONENTS 驱动 */
    private _getSourceSlotType(source: ISourceInfo): string {
        const op = this._opMap.get(source.opId);
        if (!op) return "float";
        const def = this._defMap.get(op.typeId);
        if (!def) return "float";

        const outSlotId = source.outSlotId;
        // swizzle 分量（.x, .y, .z, .w, .r, .g, .b, .a）
        if (COMPONENT_SWIZZLE[outSlotId]) return "float";

        // noise 多输出：与 _compileOutput 对齐
        //   "out" → .x (float)，"out_derivatives" → .yzw (vec3)
        if (op.typeId === "noise") {
            if (outSlotId === "out") return "float";
            if (outSlotId === "out_derivatives") return "vec3";
        }

        // 复合类型分量输出 (out_<componentId>)
        if (outSlotId.startsWith("out_")) {
            const componentId = outSlotId.substring(4);
            // componentId 本身是 spaceable 类型名 → 保留空间语义
            if (isSpaceableType(componentId)) return componentId;
            // position 类型的 "pos" 分量 → 语义上是 position
            if (componentId === "pos") return "position";
            // 通用查找
            const outputType = this._resolveType(op, def);
            const components = TYPE_COMPONENTS[outputType];
            if (components) {
                const comp = components.find(c => c.id === componentId);
                if (comp) return comp.type;
            }
        }
        // 主输出
        return this._resolveType(op, def);
    }

    /** 包装空间转换 GLSL 代码 */
    private _wrapSpaceConvert(expr: string, type: string, targetSpace: string): string {
        const matrix = targetSpace === "Local" ? "u_InvEmitterWorldMatrix" : "u_EmitterWorldMatrix";
        const spType = getSpaceableType(type);
        switch (spType) {
            case "position":
                return `transformPosition(${matrix}, ${expr})`;
            case "matrix":
                return `(${matrix} * ${expr})`;
            case "composite": {
                const info = getCompositeTypeInfo(type);
                if (info?.spaceConvertFn) return `${info.spaceConvertFn}(${matrix}, ${expr})`;
                return expr;
            }
            case "direction":
                return `normalize(mat3(${matrix}) * ${expr})`;
            case "vector":
                return `(mat3(${matrix}) * ${expr})`;
            default:
                return expr;
        }
    }

    /** 包装类型转换 GLSL 代码 */
    private _wrapTypeConvert(expr: string, srcType: string, dstType: string): string {
        if (srcType === dstType) return expr;
        const srcDim = typeDim(srcType);
        const dstDim = typeDim(dstType);
        const srcGlsl = glslType(srcType);
        const dstGlsl = glslType(dstType);

        // 相同 GLSL 类型（vec4↔vec4, position↔vec3 等）
        if (srcGlsl === dstGlsl) {
            // → direction: 归一化
            if (dstType === "direction") return `normalize(${expr})`;
            return expr;
        }

        // → direction: 转 vec3 + 归一化
        if (dstType === "direction") {
            if (srcDim > 3) return `normalize((${expr}).xyz)`;
            if (srcDim === 3) return `normalize(${expr})`;
            return expr; // blocked by canConvertType
        }

        // → color(vec4): 低维补 alpha=1
        if (dstType === "color") {
            if (srcDim === 1) {
                const f = srcGlsl === "float" ? expr : `float(${expr})`;
                return `vec4(vec3(${f}), 1.0)`;
            }
            if (srcDim === 2) return `vec4((${expr}).xy, 0.0, 1.0)`;
            if (srcDim === 3) return `vec4(${expr}, 1.0)`;
            return `${dstGlsl}(${expr})`; // vec4→color: same dim
        }

        // 标量 → 标量: cast
        if (srcDim === 1 && dstDim === 1) {
            return `${dstGlsl}(${expr})`;
        }

        // 标量 → 向量: 广播
        if (srcDim === 1) {
            const f = srcGlsl === "float" ? expr : `float(${expr})`;
            return `${dstGlsl}(${f})`;
        }

        // 向量 → 标量: 取首分量
        if (dstDim === 1) {
            const comp = (srcType === "color") ? ".r" : ".x";
            return dstGlsl === "float" ? `(${expr})${comp}` : `${dstGlsl}((${expr})${comp})`;
        }

        // 高维 → 低维: 截取
        if (srcDim > dstDim) {
            const sw = dstDim === 2 ? ".xy" : ".xyz";
            return `(${expr})${sw}`;
        }

        // 低维 → 高维：补 0（vec2 → vec3 / vec3 → vec4 等）
        // 之前 fallthrough return expr 让 GLSL 直接拿 vec2 给 vec3 op 编译失败。
        // 这是宽容兜底——精确语义需要在转换器侧把 inline vec2 拆成 2 个 inlineFloat 各接到不同 sub-slot
        // (subgraph caller↔sub 的 sub-slot 精确映射)，但那是大重构；先 vec2→vec3 补 0 让编译通过。
        if (srcDim < dstDim) {
            if (srcDim === 1) {
                // 标量已经在上面处理，不应到这里
                return `${dstGlsl}(${expr})`;
            }
            const padCount = dstDim - srcDim;
            const padZeros = Array(padCount).fill("0.0").join(", ");
            return `${dstGlsl}(${expr}, ${padZeros})`;
        }

        return expr;
    }

    /** 获取未连接输入的默认值 */
    private _getDefaultValue(op: IVfxOperatorData, def: IVfxOperatorTypeDef, inputSlotId: string, resolvedType: string): string {
        // 通用：props._inputs 里写的默认值（对所有 operator 生效，IDE 手动配置优先）
        const inputs = op.props?._inputs as Record<string, any> | undefined;
        const inputVal = inputs?.[inputSlotId];
        if (inputVal != null) {
            if (typeof inputVal === "object") return this._vecLiteral(inputVal, resolvedType);
            return toLiteral(inputVal, resolvedType);
        }

        // Helper attribute op：未连接时默认从 particle 当前属性读，否则 fallback 到 0 让公式废掉
        // (Unity 这些 op 在 IDE 端会自动连 ParticleAttribute 默认值。Laya 转换器目前没主动建这些隐式连接，
        // 必须在编译期补 — 否则 ageOverLifetime/sampleCurve 等 helper 全部退化成 0/0 让 position/Travel 等于 0)
        if (op.typeId === "ageOverLifetime") {
            if (inputSlotId === "age") return `${this._particleVar}.age`;
            if (inputSlotId === "lifetime") return `${this._particleVar}.lifetime`;
        }
        if (op.typeId === "sampleCurve") {
            if (inputSlotId === "t") return `${this._particleVar}.normalizedAge`;
        }
        if (op.typeId === "sampleGradient" || op.typeId === "colorize") {
            if (inputSlotId === "t") return `${this._particleVar}.normalizedAge`;
        }

        // supportedTypes 节点（compare/squaredLength 等）：无 _inputs 时返回零值
        if (def.supportedTypes?.length) {
            return zeroLiteral(resolvedType);
        }

        // Inline 节点：默认值来自 props 存储
        if (def.category === "Inline") {
            // 检查 props 中是否有存储值
            const propVal = op.props?.[inputSlotId];
            if (propVal != null) return _buildLiteral(propVal, resolvedType);
            // 检查 props.value 子对象中的分量值 (inlineColor 等复合类型 { value: {r,g,b,a} })
            const nestedVal = (typeof op.props?.value === "object" && op.props.value !== null)
                ? (op.props.value as Record<string, any>)[inputSlotId] : undefined;
            if (nestedVal != null) return _buildLiteral(nestedVal, resolvedType);
        }

        // 通用 fallback：input slot 定义的 default（对所有 operator 生效）
        const inputDef = def.inputs.find(i => i.id === inputSlotId);
        if (inputDef?.default != null) return _buildLiteral(inputDef.default, resolvedType);

        return zeroLiteral(resolvedType);
    }

    /** 解析 Operator 的实际输出 GLSL 类型 */
    private _resolveType(op: IVfxOperatorData, def: IVfxOperatorTypeDef): string {
        if (op.typeId === "curve") return "curve";
        if (op.typeId === "sampleCurve") return "float";
        // compare/squaredLength/squaredDistance: 输入类型跟 supportedTypes，但输出固定
        if (op.typeId === "compare") return "bool";
        if (op.typeId === "squaredLength" || op.typeId === "squaredDistance") return "float";
        // noise: 3D returns vec4(value, dx, dy, dz); curlNoise returns vec3
        if (op.typeId === "noise") return "vec4";
        if (op.typeId === "curlNoise") return "vec3";
        if (op.typeId === "getAttribute") {
            return getAttributeType((op.props?.attribute as string) || "position");
        }
        if (op.typeId === "getCustomAttribute") {
            return (op.props?._type as string) || "float";
        }
        if (op.typeId === "builtinLoopIndex") {
            return "int";
        }
        if (op.typeId === "sampleSDF") {
            return "float";
        }
        if (op.typeId === "sampleCameraBuffer") {
            return (op.props?.buffer as string) === "Color" ? "vec4" : "float";
        }
        if (op.typeId === "getProperty") {
            const propDef = this._graphProperties.find(p => p.name === (op.props?.property as string));
            const propType = propDef?.type || "number";
            return propType === "number" ? "float" : propType;
        }
        if (def.supportedTypes?.length) {
            const t = op.props?._type as string;
            if (t && def.supportedTypes.includes(t)) return t;
            return def.supportedTypes[0];
        }
        return def.outputs[0]?.type || "float";
    }

    /** 构造向量字面量 */
    private _vecLiteral(val: Record<string, number>, type: string): string {
        switch (type) {
            case "vec2": return `vec2(${toFloat(val.x)}, ${toFloat(val.y)})`;
            case "vec3": return `vec3(${toFloat(val.x)}, ${toFloat(val.y)}, ${toFloat(val.z)})`;
            case "vec4": return `vec4(${toFloat(val.x)}, ${toFloat(val.y)}, ${toFloat(val.z)}, ${toFloat(val.w)})`;
            case "color": return `vec4(${toFloat(val.r ?? 1)}, ${toFloat(val.g ?? 1)}, ${toFloat(val.b ?? 1)}, ${toFloat(val.a ?? 1)})`;
            default: return toFloat(val.x ?? 0);
        }
    }
}

/** 获取类型的分量名列表 */
function _getComponents(attrType: string): string[] {
    switch (attrType) {
        case "vec2": return ["x", "y"];
        case "vec3": return ["x", "y", "z"];
        case "vec4": return ["x", "y", "z", "w"];
        case "color": return ["r", "g", "b"];
        default: return [];
    }
}
