/**
 * Operator 类型定义 — 独立数据计算节点
 *
 * 添加新 Operator 类型只需在 VFX_OPERATOR_DEFS 数组中追加条目。
 */

import type { IVfxOperatorTypeDef } from "./VfxTypes";

// ─── 颜色常量 ──────────────────────────────────────

const C_INLINE = "#8B8B8B";
const C_ATTRIBUTE = "#5B8C6E";
const C_PROPERTY = "#4A7FB5";
const C_CURVE = "#B5784A";

// ─── Particle Attribute 定义 ──────────────────────────

export const VFX_PARTICLE_ATTRIBUTES = [
    { name: "position", type: "vec3", spaceable: "position" as SpaceableType },
    { name: "velocity", type: "vec3" },
    { name: "direction", type: "vec3" },
    { name: "color", type: "color" },
    { name: "alpha", type: "float" },
    { name: "age", type: "float" },
    { name: "lifetime", type: "float" },
    { name: "normalizedAge", type: "float", readonly: true },
    { name: "size", type: "float" },
    { name: "scale", type: "vec3" },
    { name: "angle", type: "vec3" },
    { name: "angularVelocity", type: "vec3" },
    { name: "mass", type: "float" },
    { name: "oldPosition", type: "vec3" },
    { name: "targetPosition", type: "vec3" },
    { name: "pivot", type: "vec3" },
    { name: "texIndex", type: "float" },
    { name: "axisX", type: "vec3", spaceable: "direction" as SpaceableType },
    { name: "axisY", type: "vec3", spaceable: "direction" as SpaceableType },
    { name: "axisZ", type: "vec3", spaceable: "direction" as SpaceableType },
    { name: "alive", type: "bool" },
    { name: "seed", type: "uint", readonly: true },
    { name: "particleId", type: "uint", readonly: true },
    { name: "spawnIndex", type: "uint", readonly: true },
    { name: "spawnCount", type: "float", readonly: true, sourceOnly: true },
    { name: "spawnTime", type: "float", readonly: true },
    { name: "stripIndex", type: "uint" },
    { name: "particleIndexInStrip", type: "uint", readonly: true },
    { name: "particleCountInStrip", type: "uint", readonly: true },
    // Unity 内置：碰撞 event 触发时存碰撞点 3D 坐标（GPU event 接收端 read source 用）
    // 之前不在表里让 fallback float → readSourceParticle 当 float 读 v.w 单分量 →
    // 下游访问 .x/.y 报 swizzle out of range 让 GPU init shader 编译失败
    { name: "collisionEventPosition", type: "vec3" },
] as const;

/** 可用于 setAttribute 的属性列表（排除 readonly） */
export const VFX_SETTABLE_ATTRIBUTES = VFX_PARTICLE_ATTRIBUTES.filter(a => !('readonly' in a && a.readonly));

/**
 * 编译期 custom attribute 类型注册表（per-compile session）。
 * VfxBuild.compile 入口处用 graphData.customAttributes 填，编译结束后清空。
 * 优先于 VFX_PARTICLE_ATTRIBUTES 让 Unity 用户自定义 Vector2/Vector3 attribute（如 P4 "Sequential" vec2）
 * 在 getAttributeType 调用处自动拿到正确类型，不用改所有调用点。
 */
let _customAttrTypeMap: Map<string, string> | null = null;
export function setCustomAttributeTypes(customAttrs: { name: string; type: string }[] | undefined | null): void {
    if (!customAttrs || customAttrs.length === 0) {
        _customAttrTypeMap = null;
        return;
    }
    _customAttrTypeMap = new Map();
    for (const a of customAttrs) {
        if (a && a.name) _customAttrTypeMap.set(a.name, a.type || "float");
    }
}

/** 根据 attribute 名称获取其类型 */
export function getAttributeType(attrName: string): string {
    if (_customAttrTypeMap && _customAttrTypeMap.has(attrName)) {
        return _customAttrTypeMap.get(attrName)!;
    }
    return VFX_PARTICLE_ATTRIBUTES.find(a => a.name === attrName)?.type || "float";
}

/** 根据 attribute 名称获取其 spaceable 标记（无空间语义返回 null） */
export function getAttributeSpaceable(attrName: string): SpaceableType | null {
    const attr = VFX_PARTICLE_ATTRIBUTES.find(a => a.name === attrName);
    return (attr && 'spaceable' in attr) ? (attr as any).spaceable : null;
}

// ─── 类型分量配置表 ──────────────────────────────────

type ComponentDef = { id: string; name: string; type: string };

const TYPE_COMPONENTS: Record<string, ComponentDef[]> = {
    vec2: [
        { id: "x", name: "x", type: "float" },
        { id: "y", name: "y", type: "float" },
    ],
    vec3: [
        { id: "x", name: "x", type: "float" },
        { id: "y", name: "y", type: "float" },
        { id: "z", name: "z", type: "float" },
    ],
    vec4: [
        { id: "x", name: "x", type: "float" },
        { id: "y", name: "y", type: "float" },
        { id: "z", name: "z", type: "float" },
        { id: "w", name: "w", type: "float" },
    ],
    color: [
        { id: "r", name: "r", type: "float" },
        { id: "g", name: "g", type: "float" },
        { id: "b", name: "b", type: "float" },
        { id: "a", name: "a", type: "float" },
    ],
    transform: [
        { id: "position", name: "position", type: "vec3" },
        { id: "rotation", name: "rotation", type: "vec3" },
        { id: "scale", name: "scale", type: "vec3" },
    ],
    sphere: [
        { id: "transform", name: "transform", type: "transform" },
        { id: "radius", name: "radius", type: "float" },
    ],
    arcSphere: [
        { id: "sphere", name: "sphere", type: "sphere" },
        { id: "arc", name: "arc", type: "float" },
    ],
    aaBox: [
        { id: "center", name: "center", type: "position" },
        { id: "size", name: "size", type: "vec3" },
    ],
    plane: [
        { id: "position", name: "position", type: "position" },
        { id: "normal", name: "normal", type: "direction" },
    ],
    orientedBox: [
        { id: "center", name: "center", type: "vec3" },
        { id: "angle", name: "angle", type: "vec3" },
        { id: "size", name: "size", type: "vec3" },
    ],
    cone: [
        { id: "transform", name: "transform", type: "transform" },
        { id: "baseRadius", name: "baseRadius", type: "float" },
        { id: "topRadius", name: "topRadius", type: "float" },
        { id: "height", name: "height", type: "float" },
    ],
    arcCone: [
        { id: "cone", name: "cone", type: "cone" },
        { id: "arc", name: "arc", type: "float" },
    ],
    torus: [
        { id: "transform", name: "transform", type: "transform" },
        { id: "majorRadius", name: "majorRadius", type: "float" },
        { id: "minorRadius", name: "minorRadius", type: "float" },
    ],
    arcTorus: [
        { id: "torus", name: "torus", type: "torus" },
        { id: "arc", name: "arc", type: "float" },
    ],
    circle: [
        { id: "transform", name: "transform", type: "transform" },
        { id: "radius", name: "radius", type: "float" },
    ],
    arcCircle: [
        { id: "circle", name: "circle", type: "circle" },
        { id: "arc", name: "arc", type: "float" },
    ],
    line: [
        { id: "start", name: "start", type: "vec3" },
        { id: "end", name: "end", type: "vec3" },
    ],
    position: [
        { id: "pos", name: "position", type: "vec3" },
    ],
    camera: [
        { id: "transform", name: "transform", type: "transform" },
        { id: "orthographic", name: "orthographic", type: "float" },
        { id: "fieldOfView", name: "fieldOfView", type: "float" },
        { id: "nearPlane", name: "nearPlane", type: "float" },
        { id: "farPlane", name: "farPlane", type: "float" },
        { id: "orthographicSize", name: "orthographicSize", type: "float" },
        { id: "aspectRatio", name: "aspectRatio", type: "float" },
    ],
};

/** 根据 attribute 类型返回分量输出定义 */
export function getAttributeComponents(attrType: string): ComponentDef[] {
    return TYPE_COMPONENTS[attrType] || [];
}

/** 获取类型的分量配置表（供外部引用） */
export { TYPE_COMPONENTS };

// ─── 复合类型注册表（编译器用） ──────────────────────────

/**
 * 复合类型编译信息。
 * 驱动 VfxExprCompiler 的 inline 构造、默认值生成、零值字面量、
 * 分量输出分发和空间转换，新增复合类型只需在此注册。
 */
export interface ICompositeTypeInfo {
    /** GLSL 类型名 */
    glslType: string;
    /** 从分量表达式构造 GLSL 表达式（参数顺序与 TYPE_COMPONENTS 一致） */
    construct: (fieldExprs: string[]) => string;
    /** 零值字面量 */
    zero: string;
    /** 空间转换 GLSL 函数名（用于 composite spaceable 类型） */
    spaceConvertFn?: string;
    /**
     * 分量是否可通过 struct 字段访问（默认 true）。
     * transform (mat4) 需要特殊的分量提取逻辑，设为 false。
     */
    structAccess?: boolean;
    /**
     * 自定义分量提取表达式（当 structAccess=false 时使用）。
     * key = 分量 id, value = (varName) => GLSL 表达式
     */
    extractComponent?: Record<string, (varName: string) => string>;
}

const COMPOSITE_TYPE_INFO: Record<string, ICompositeTypeInfo> = {
    // 基础向量类型
    vec2: { glslType: "vec2", construct: (f) => `vec2(${f.join(", ")})`, zero: "vec2(0.0)", structAccess: false },
    vec3: { glslType: "vec3", construct: (f) => `vec3(${f.join(", ")})`, zero: "vec3(0.0)", structAccess: false },
    vec4: { glslType: "vec4", construct: (f) => `vec4(${f.join(", ")})`, zero: "vec4(0.0)", structAccess: false },
    color: { glslType: "vec4", construct: (f) => `vec4(${f.join(", ")})`, zero: "vec4(1.0)", structAccess: false },
    // 复合类型
    transform: {
        glslType: "mat4",
        // Unity Transform.angles 是度数, BuildTRS 内部直接 cos/sin 当弧度.
        // _resolveInput composite type construct 时必须 radians() 转换, 否则 vec3(90,0,0) 当 90 rad ≈ 14 圈让 matrix 完全错.
        // (ShapePosition / Force block 等其他调用方在自己模板里已经 wrap radians 这里不会双重转换)
        construct: (f) => `BuildTRS(${f[0]}, radians(${f[1]}), ${f[2]})`,
        zero: "mat4(1.0)",
        structAccess: false,
        extractComponent: {
            position: (v) => `${v}[3].xyz`,
            rotation: (v) => `_extractEulerYXZ(${v})`,
            scale: (v) => `vec3(length(${v}[0].xyz), length(${v}[1].xyz), length(${v}[2].xyz))`,
        },
    },
    sphere: {
        glslType: "VFXSphere",
        construct: (f) => `VFXSphere(${f.join(", ")})`,
        zero: "VFXSphere(mat4(1.0), 1.0)",
        spaceConvertFn: "transformSphere",
    },
    arcSphere: {
        glslType: "VFXArcSphere",
        construct: (f) => `VFXArcSphere(${f.join(", ")})`,
        zero: "VFXArcSphere(VFXSphere(mat4(1.0), 1.0), 6.2831853)",
        spaceConvertFn: "transformArcSphere",
    },
    aaBox: {
        glslType: "VFXAABox",
        construct: (f) => `VFXAABox(${f.join(", ")})`,
        zero: "VFXAABox(vec3(0.0), vec3(1.0))",
        spaceConvertFn: "transformAABox",
    },
    plane: {
        glslType: "VFXPlane",
        construct: (f) => `VFXPlane(${f.join(", ")})`,
        zero: "VFXPlane(vec3(0.0), vec3(0.0, 1.0, 0.0))",
        spaceConvertFn: "transformPlane",
    },
    orientedBox: {
        glslType: "VFXOrientedBox",
        construct: (f) => `VFXOrientedBox(${f.join(", ")})`,
        zero: "VFXOrientedBox(vec3(0.0), vec3(0.0), vec3(1.0))",
        spaceConvertFn: "transformOrientedBox",
    },
    cone: {
        glslType: "VFXCone",
        construct: (f) => `VFXCone(${f.join(", ")})`,
        zero: "VFXCone(mat4(1.0), 1.0, 0.0, 1.0)",
        spaceConvertFn: "transformCone",
    },
    arcCone: {
        glslType: "VFXArcCone",
        construct: (f) => `VFXArcCone(${f.join(", ")})`,
        zero: "VFXArcCone(VFXCone(mat4(1.0), 1.0, 0.0, 1.0), 6.2831853)",
        spaceConvertFn: "transformArcCone",
    },
    torus: {
        glslType: "VFXTorus",
        construct: (f) => `VFXTorus(${f.join(", ")})`,
        zero: "VFXTorus(mat4(1.0), 1.0, 0.3)",
        spaceConvertFn: "transformTorus",
    },
    arcTorus: {
        glslType: "VFXArcTorus",
        construct: (f) => `VFXArcTorus(${f.join(", ")})`,
        zero: "VFXArcTorus(VFXTorus(mat4(1.0), 1.0, 0.3), 6.2831853)",
        spaceConvertFn: "transformArcTorus",
    },
    circle: {
        glslType: "VFXCircle",
        construct: (f) => `VFXCircle(${f.join(", ")})`,
        zero: "VFXCircle(mat4(1.0), 1.0)",
        spaceConvertFn: "transformCircle",
    },
    arcCircle: {
        glslType: "VFXArcCircle",
        construct: (f) => `VFXArcCircle(${f.join(", ")})`,
        zero: "VFXArcCircle(VFXCircle(mat4(1.0), 1.0), 6.2831853)",
        spaceConvertFn: "transformArcCircle",
    },
    line: {
        glslType: "VFXLine",
        construct: (f) => `VFXLine(${f.join(", ")})`,
        zero: "VFXLine(vec3(0.0), vec3(0.0, 1.0, 0.0))",
        spaceConvertFn: "transformLine",
    },
    camera: {
        glslType: "VFXCamera",
        construct: (f) => `VFXCamera(${f.join(", ")})`,
        zero: "VFXCamera(mat4(1.0), 0.0, 60.0, 0.3, 1000.0, 10.0, 1.778)",
    },
    // 别名类型（底层是 vec3，但带空间语义标记）
    position: {
        glslType: "vec3",
        construct: (f) => f[0],  // position 只有一个 vec3 分量
        zero: "vec3(0.0)",
        structAccess: false,
        extractComponent: { pos: (v) => v },
    },
    vector: {
        glslType: "vec3",
        construct: (f) => f[0],
        zero: "vec3(0.0)",
        structAccess: false,
        extractComponent: { vector: (v) => v },
    },
    direction: {
        glslType: "vec3",
        construct: (f) => f[0],
        zero: "vec3(0.0, 1.0, 0.0)",
        structAccess: false,
        extractComponent: { direction: (v) => v },
    },
};

/** 获取复合类型的编译信息 */
export function getCompositeTypeInfo(type: string): ICompositeTypeInfo | undefined {
    return COMPOSITE_TYPE_INFO[type];
}

// ─── Spaceable 类型系统 ──────────────────────────────

/**
 * 空间变换语义：
 * - position: mul(mat4, vec4(v, 1.0)).xyz — 受平移+旋转+缩放
 * - direction: normalize(mul(mat3, v))   — 仅旋转，归一化（未来）
 * - vector:    mul(mat3, v)              — 旋转+缩放，无平移（未来）
 * - matrix:    mat4 * mat4               — 完整矩阵乘法
 * - composite: 递归包含 spaceable 子类型
 */
export type SpaceableType = "position" | "direction" | "vector" | "matrix" | "composite";

/** 叶 spaceable 类型 → 变换方式 */
const SPACEABLE_LEAF: Record<string, SpaceableType> = {
    position: "position",
    direction: "direction",
    vector: "vector",
    transform: "matrix",
    orientedBox: "composite",
    cone: "composite",
    torus: "composite",
    circle: "composite",
    line: "composite",
};

/** 缓存递归检测结果 */
const _spaceableCache = new Map<string, SpaceableType | null>();

/**
 * 获取类型的 spaceable 语义（递归检测复合类型）。
 * 叶类型直接查 SPACEABLE_LEAF，复合类型若任一子分量 spaceable 则返回 "composite"。
 */
export function getSpaceableType(type: string): SpaceableType | null {
    if (_spaceableCache.has(type)) return _spaceableCache.get(type)!;

    // 防止递归死循环
    _spaceableCache.set(type, null);

    // 叶类型
    const leaf = SPACEABLE_LEAF[type];
    if (leaf) {
        _spaceableCache.set(type, leaf);
        return leaf;
    }

    // 递归检测 TYPE_COMPONENTS
    const components = TYPE_COMPONENTS[type];
    if (components) {
        for (const comp of components) {
            if (getSpaceableType(comp.type) != null) {
                _spaceableCache.set(type, "composite");
                return "composite";
            }
        }
    }

    return null;
}

/** 类型是否具有空间语义 */
export function isSpaceableType(type: string): boolean {
    return getSpaceableType(type) != null;
}

// ─── 类型转换系统 ──────────────────────────────────

/** 获取类型的维度 (标量=1, vec2=2, vec3/position/direction/vector=3, vec4/color=4, 复合=0) */
export function typeDim(type: string): number {
    switch (type) {
        case "float": case "int": case "uint": case "bool": return 1;
        case "vec2": return 2;
        case "vec3": case "position": case "direction": case "vector": return 3;
        case "vec4": case "color": return 4;
        default: return 0;
    }
}

/**
 * 检查源类型是否可隐式转换到目标类型。
 * 规则：标量互转、标量→向量广播、高维→低维截取、→color 补 alpha、→direction 归一化。
 */
export function canConvertType(srcType: string, dstType: string): boolean {
    if (srcType === dstType) return true;
    if (srcType === "any" || dstType === "any") return true;
    // curve 类型只能连接到 curve
    if (srcType === "curve" || dstType === "curve") return false;
    const srcDim = typeDim(srcType);
    const dstDim = typeDim(dstType);
    if (srcDim === 0 || dstDim === 0) return false;
    // direction 不接受标量（归一化标量无意义）
    if (dstType === "direction" && srcDim < 3) return false;
    // → color(vec4)：任意数值类型可转（低维补 alpha=1）
    if (dstType === "color") return true;
    // 相同维度 → 允许（含语义互转：position↔vec3, vec4↔color）
    if (srcDim === dstDim) return true;
    // 标量 → 向量：广播
    if (srcDim === 1) return true;
    // 高维 → 低维：截取
    if (srcDim > dstDim) return true;
    return false;
}

// ─── Property 类型 → 输出类型映射 ────────────────────

/** Property 定义中的 type → Operator 输出的 slot type */
export function getPropertyOutputType(propType: string): string {
    switch (propType) {
        case "number": return "float";
        case "int": return "int";
        case "bool": return "bool";
        default: return propType;
    }
}

/** Property 类型对应的分量输出 */
export function getPropertyComponents(propType: string): ComponentDef[] {
    return TYPE_COMPONENTS[propType] || [];
}

// ─── 支持类型集 ──────────────────────────────────────

/** float, int, uint, vec2, vec3, vec4 */
const TYPES_ALL_NUMERIC = ["float", "int", "uint", "vec2", "vec3", "vec4"];
/** float, vec2, vec3, vec4（不含 int/uint） */
const TYPES_FLOAT_VEC = ["float", "vec2", "vec3", "vec4"];

// ─── Operator 定义 ─────────────────────────────────

export const VFX_OPERATOR_DEFS: IVfxOperatorTypeDef[] = [
    {
        typeId: "builtinLoopIndex",
        title: "Get Loop Index",
        color: C_INLINE,
        category: "Builtin",
        inputs: [],
        outputs: [{ id: "out", name: "Loop Index", type: "int" }],
    },
    {
        typeId: "sampleSDF",
        title: "Sample SDF",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "position", name: "Position", type: "vec3" },
        ],
        outputs: [{ id: "out", name: "Distance", type: "float" }],
        properties: [
            { name: "texture", caption: "SDF Texture", type: "Texture3D" },
            { name: "center", caption: "Center", type: "vec3", default: { x: 0, y: 0, z: 0 } },
            { name: "size", caption: "Size", type: "vec3", default: { x: 1, y: 1, z: 1 } },
        ],
    },
    {
        typeId: "sampleGraphicsBuffer",
        title: "Sample Graphics Buffer",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "index", name: "Index", type: "int", default: 0 },
        ],
        outputs: [{ id: "out", name: "Value", type: "vec4" }],
        properties: [
            { name: "property", caption: "Buffer Property", type: "string", default: "" },
        ],
    },
    {
        typeId: "sampleCameraBuffer",
        title: "Sample Camera Buffer",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "uv", name: "Screen UV", type: "vec2", default: { x: 0.5, y: 0.5 } },
        ],
        outputs: [{ id: "out", name: "Value", type: "float" }],
        properties: [
            { name: "buffer", caption: "Buffer", type: "string", enumSource: ["Depth", "Color"], default: "Depth" },
        ],
    },
    {
        typeId: "loadCameraBuffer",
        title: "Load Camera Buffer",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "x", name: "X (pixel)", type: "float", default: 0 },
            { id: "y", name: "Y (pixel)", type: "float", default: 0 },
            { id: "mipLevel", name: "Mip Level", type: "float", default: 0 },
        ],
        outputs: [{ id: "out", name: "Value", type: "float" }],
        properties: [
            { name: "buffer", caption: "Buffer", type: "string", enumSource: ["Depth", "Color"], default: "Depth" },
        ],
    },
    {
        // MeshVertexCount：读 Mesh 资源的顶点数。复用 setPositionMesh 的 MeshPos 烘焙机制：
        // runtime 把 mesh 顶点打包进 RGBA32F 纹理（宽=顶点数，高=1），shader 用 textureSize().x 读
        typeId: "meshVertexCount",
        title: "Mesh Vertex Count",
        color: C_INLINE,
        category: "Sampling",
        inputs: [],
        outputs: [{ id: "out", name: "Count", type: "int" }],
        properties: [
            { name: "mesh", caption: "Mesh", type: "Mesh" },
        ],
    },
    {
        // MeshIndexCount：读 Mesh 资源的索引数。复用 sampleMeshIndex 的 MeshIndex 烘焙
        typeId: "meshIndexCount",
        title: "Mesh Index Count",
        color: C_INLINE,
        category: "Sampling",
        inputs: [],
        outputs: [{ id: "out", name: "Count", type: "int" }],
        properties: [
            { name: "mesh", caption: "Mesh", type: "Mesh" },
        ],
    },
    {
        // MeshTriangleCount：indexCount / 3
        typeId: "meshTriangleCount",
        title: "Mesh Triangle Count",
        color: C_INLINE,
        category: "Sampling",
        inputs: [],
        outputs: [{ id: "out", name: "Count", type: "int" }],
        properties: [
            { name: "mesh", caption: "Mesh", type: "Mesh" },
        ],
    },
    {
        // BufferCount：读 StorageBuffer 的元素数。GLSL 4.3+ 支持 runtime_array.length()，
        // 转 WGSL 时变成 arrayLength(&buf.data)
        typeId: "bufferCount",
        title: "Buffer Count",
        color: C_INLINE,
        category: "Sampling",
        inputs: [],
        outputs: [{ id: "out", name: "Count", type: "int" }],
        properties: [
            { name: "property", caption: "Buffer Property", type: "string", default: "" },
        ],
    },
    {
        typeId: "voroNoise2D",
        title: "Voro Noise 2D",
        color: C_INLINE,
        category: "Noise",
        inputs: [
            { id: "coord", name: "Coordinate", type: "vec2", default: { x: 0, y: 0 } },
            { id: "u", name: "Angle Offset", type: "float", default: 0.5 },
            { id: "v", name: "Cell Density", type: "float", default: 1 },
        ],
        outputs: [{ id: "out", name: "Noise", type: "float" }],
    },
    {
        typeId: "probabilitySampling",
        title: "Probability Sampling",
        color: C_INLINE,
        category: "Random",
        inputs: [
            { id: "weights", name: "Weights", type: "vec4", default: { x: 1, y: 1, z: 1, w: 1 } },
        ],
        outputs: [{ id: "out", name: "Index", type: "int" }],
    },
    {
        typeId: "sampleBezier",
        title: "Sample Bezier",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "a", name: "A (start)", type: "vec3", default: { x: 0, y: 0, z: 0 } },
            { id: "b", name: "B (ctrl1)", type: "vec3", default: { x: 0, y: 1, z: 0 } },
            { id: "c", name: "C (ctrl2)", type: "vec3", default: { x: 1, y: 1, z: 0 } },
            { id: "d", name: "D (end)", type: "vec3", default: { x: 1, y: 0, z: 0 } },
            { id: "t", name: "T", type: "float", default: 0 },
        ],
        outputs: [{ id: "out", name: "Position", type: "vec3" }],
    },
    {
        typeId: "getCustomAttribute",
        title: "Get Custom Attribute",
        color: C_ATTRIBUTE,
        category: "Attribute",
        inputs: [],
        outputs: [{ id: "out", name: "Value", type: "float" }],
        supportedTypes: ["float", "int", "uint", "bool", "vec2", "vec3", "vec4", "color"],
        properties: [
            { name: "name", caption: "Name", type: "string", default: "myAttribute" },
            { name: "_type", caption: "Type", type: "string", enumSource: ["float", "int", "uint", "bool", "vec2", "vec3", "vec4", "color"], default: "float" },
        ],
    },

    // ── Inline ──
    {
        typeId: "inlineFloat",
        title: "Float",
        color: C_INLINE,
        category: "Inline",
        inputs: [
            { id: "value", name: "Value", type: "float" },
        ],
        outputs: [{ id: "value", name: "Value", type: "float" }],
        properties: [
            { name: "value", caption: "Value", type: "number", default: 0 },
        ],
    },
    {
        typeId: "inlineInt",
        title: "Int",
        color: C_INLINE,
        category: "Inline",
        inputs: [
            { id: "value", name: "Value", type: "int" },
        ],
        outputs: [{ id: "value", name: "Value", type: "int" }],
        properties: [
            { name: "value", caption: "Value", type: "number", default: 0, step: 1 },
        ],
    },
    {
        typeId: "inlineUint",
        title: "Uint",
        color: C_INLINE,
        category: "Inline",
        inputs: [
            { id: "value", name: "Value", type: "uint" },
        ],
        outputs: [{ id: "value", name: "Value", type: "uint" }],
        properties: [
            { name: "value", caption: "Value", type: "number", default: 0, min: 0, step: 1 },
        ],
    },
    {
        typeId: "inlineBool",
        title: "Bool",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "bool" }],
        outputs: [{ id: "value", name: "Value", type: "bool" }],
        properties: [
            { name: "value", caption: "Value", type: "boolean", default: false },
        ],
    },
    {
        typeId: "inlineColor",
        title: "Color",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "color" }],
        outputs: [{ id: "value", name: "Value", type: "color" }],
        properties: [],
    },
    {
        typeId: "inlineMatrix4x4",
        title: "Matrix 4x4",
        color: C_INLINE,
        category: "Inline",
        inputs: [
            { id: "row0", name: "Row 0", type: "vec4", default: { x: 1, y: 0, z: 0, w: 0 } },
            { id: "row1", name: "Row 1", type: "vec4", default: { x: 0, y: 1, z: 0, w: 0 } },
            { id: "row2", name: "Row 2", type: "vec4", default: { x: 0, y: 0, z: 1, w: 0 } },
            { id: "row3", name: "Row 3", type: "vec4", default: { x: 0, y: 0, z: 0, w: 1 } },
        ],
        outputs: [{ id: "value", name: "Value", type: "transform" }],
        properties: [],
    },
    {
        typeId: "inlineVector2",
        title: "Vector2",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "vec2" }],
        outputs: [{ id: "value", name: "Value", type: "vec2" }],
        properties: [],
    },
    {
        typeId: "inlineVector3",
        title: "Vector3",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "vec3" }],
        outputs: [{ id: "value", name: "Value", type: "vec3" }],
        properties: [],
    },
    {
        typeId: "inlineVector4",
        title: "Vector4",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "vec4" }],
        outputs: [{ id: "value", name: "Value", type: "vec4" }],
        properties: [],
    },
    {
        typeId: "inlinePosition",
        title: "Position",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "position" }],
        outputs: [{ id: "value", name: "Value", type: "position" }],
        properties: [],
    },
    {
        typeId: "inlineVector",
        title: "Vector",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "vector" }],
        outputs: [{ id: "value", name: "Value", type: "vector" }],
        properties: [],
    },
    {
        typeId: "inlineDirection",
        title: "Direction",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "direction" }],
        outputs: [{ id: "value", name: "Value", type: "direction" }],
        properties: [],
    },
    {
        typeId: "inlineTransform",
        title: "Transform",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "transform" }],
        outputs: [{ id: "value", name: "Value", type: "transform" }],
        properties: [],
    },
    {
        typeId: "inlineSphere",
        title: "Sphere",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "sphere" }],
        outputs: [{ id: "value", name: "Value", type: "sphere" }],
        properties: [],
    },
    {
        typeId: "inlineArcSphere",
        title: "Arc Sphere",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "arcSphere" }],
        outputs: [{ id: "value", name: "Value", type: "arcSphere" }],
        properties: [],
    },
    {
        typeId: "inlineAABox",
        title: "AABox",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "aaBox" }],
        outputs: [{ id: "value", name: "Value", type: "aaBox" }],
        properties: [],
    },
    {
        typeId: "inlineOrientedBox",
        title: "Oriented Box",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "orientedBox" }],
        outputs: [{ id: "value", name: "Value", type: "orientedBox" }],
        properties: [],
    },
    {
        typeId: "inlineCone",
        title: "Cone",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "cone" }],
        outputs: [{ id: "value", name: "Value", type: "cone" }],
        properties: [],
    },
    {
        typeId: "inlineArcCone",
        title: "Arc Cone",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "arcCone" }],
        outputs: [{ id: "value", name: "Value", type: "arcCone" }],
        properties: [],
    },
    {
        typeId: "inlineTorus",
        title: "Torus",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "torus" }],
        outputs: [{ id: "value", name: "Value", type: "torus" }],
        properties: [],
    },
    {
        typeId: "inlineArcTorus",
        title: "Arc Torus",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "arcTorus" }],
        outputs: [{ id: "value", name: "Value", type: "arcTorus" }],
        properties: [],
    },
    {
        typeId: "inlineCircle",
        title: "Circle",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "circle" }],
        outputs: [{ id: "value", name: "Value", type: "circle" }],
        properties: [],
    },
    {
        typeId: "inlineArcCircle",
        title: "Arc Circle",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "arcCircle" }],
        outputs: [{ id: "value", name: "Value", type: "arcCircle" }],
        properties: [],
    },
    {
        typeId: "inlinePlane",
        title: "Plane",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "plane" }],
        outputs: [{ id: "value", name: "Value", type: "plane" }],
        properties: [],
    },
    {
        typeId: "inlineLine",
        title: "Line",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "line" }],
        outputs: [{ id: "value", name: "Value", type: "line" }],
        properties: [],
    },
    {
        typeId: "inlineCamera",
        title: "Camera",
        color: C_INLINE,
        category: "Inline",
        inputs: [{ id: "value", name: "Value", type: "camera" }],
        outputs: [{ id: "value", name: "Value", type: "camera" }],
        properties: [],
    },

    // ── Get Property ──
    {
        typeId: "getProperty",
        title: "Get Property",
        color: C_PROPERTY,
        category: "Property",
        inputs: [],
        outputs: [{ id: "value", name: "Value", type: "any" }],
        properties: [
            { name: "property", caption: "Property", type: "string", default: "", nodeHidden: true } as any,
        ],
    },

    // ── Math / Arithmetic ──
    {
        typeId: "absolute",
        title: "Absolute",
        color: C_INLINE,
        category: "Math/Arithmetic",
        inputs: [{ id: "x", name: "X", type: "float" }],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_ALL_NUMERIC,
    },
    {
        typeId: "add",
        title: "Add",
        color: C_INLINE,
        category: "Math/Arithmetic",
        inputs: [
            { id: "a", name: "A", type: "float" },
            { id: "b", name: "B", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_ALL_NUMERIC,
    },
    {
        typeId: "divide",
        title: "Divide",
        color: C_INLINE,
        category: "Math/Arithmetic",
        inputs: [
            { id: "a", name: "A", type: "float" },
            { id: "b", name: "B", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_ALL_NUMERIC,
    },
    {
        typeId: "fractional",
        title: "Fractional",
        color: C_INLINE,
        category: "Math/Arithmetic",
        inputs: [{ id: "x", name: "X", type: "float" }],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "inverseLerp",
        title: "Inverse Lerp",
        color: C_INLINE,
        category: "Math/Arithmetic",
        inputs: [
            { id: "x", name: "X", type: "float" },
            { id: "y", name: "Y", type: "float" },
            { id: "s", name: "S", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "lerp",
        title: "Lerp",
        color: C_INLINE,
        category: "Math/Arithmetic",
        inputs: [
            { id: "x", name: "X", type: "float" },
            { id: "y", name: "Y", type: "float" },
            { id: "s", name: "S", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "modulo",
        title: "Modulo",
        color: C_INLINE,
        category: "Math/Arithmetic",
        inputs: [
            { id: "a", name: "A", type: "float" },
            { id: "b", name: "B", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_ALL_NUMERIC,
    },
    {
        typeId: "multiply",
        title: "Multiply",
        color: C_INLINE,
        category: "Math/Arithmetic",
        inputs: [
            { id: "a", name: "A", type: "float" },
            { id: "b", name: "B", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_ALL_NUMERIC,
    },
    {
        typeId: "negate",
        title: "Negate",
        color: C_INLINE,
        category: "Math/Arithmetic",
        inputs: [{ id: "x", name: "X", type: "float" }],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_ALL_NUMERIC,
    },
    {
        typeId: "oneMinus",
        title: "One Minus",
        color: C_INLINE,
        category: "Math/Arithmetic",
        inputs: [{ id: "x", name: "X", type: "float" }],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        // Unity Remap [-1..1] => [0..1]：output = input * 0.5 + 0.5
        typeId: "linearRemap",
        title: "Remap [-1..1] => [0..1]",
        color: C_INLINE,
        category: "Math/Remap",
        inputs: [{ id: "x", name: "Input", type: "float" }],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "power",
        title: "Power",
        color: C_INLINE,
        category: "Math/Arithmetic",
        inputs: [
            { id: "a", name: "A", type: "float" },
            { id: "b", name: "B", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "reciprocal",
        title: "Reciprocal",
        color: C_INLINE,
        category: "Math/Arithmetic",
        inputs: [{ id: "x", name: "X", type: "float" }],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "sign",
        title: "Sign",
        color: C_INLINE,
        category: "Math/Arithmetic",
        inputs: [{ id: "x", name: "X", type: "float" }],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_ALL_NUMERIC,
    },
    {
        typeId: "smoothstep",
        title: "Smoothstep",
        color: C_INLINE,
        category: "Math/Arithmetic",
        inputs: [
            { id: "x", name: "X", type: "float" },
            { id: "y", name: "Y", type: "float" },
            { id: "s", name: "S", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "squareRoot",
        title: "Square Root",
        color: C_INLINE,
        category: "Math/Arithmetic",
        inputs: [{ id: "x", name: "X", type: "float" }],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "step",
        title: "Step",
        color: C_INLINE,
        category: "Math/Arithmetic",
        inputs: [
            { id: "value", name: "Value", type: "float" },
            { id: "threshold", name: "Threshold", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "subtract",
        title: "Subtract",
        color: C_INLINE,
        category: "Math/Arithmetic",
        inputs: [
            { id: "a", name: "A", type: "float" },
            { id: "b", name: "B", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_ALL_NUMERIC,
    },

    // ── Math / Wave ──
    {
        typeId: "sawtoothWave",
        title: "Sawtooth Wave",
        color: C_INLINE,
        category: "Math/Wave",
        inputs: [
            { id: "x", name: "X", type: "float" },
            { id: "frequency", name: "Frequency", type: "float", default: 1 },
            { id: "min", name: "Min", type: "float", default: 0 },
            { id: "max", name: "Max", type: "float", default: 1 },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "triangleWave",
        title: "Triangle Wave",
        color: C_INLINE,
        category: "Math/Wave",
        inputs: [
            { id: "x", name: "X", type: "float" },
            { id: "frequency", name: "Frequency", type: "float", default: 1 },
            { id: "min", name: "Min", type: "float", default: 0 },
            { id: "max", name: "Max", type: "float", default: 1 },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "squareWave",
        title: "Square Wave",
        color: C_INLINE,
        category: "Math/Wave",
        inputs: [
            { id: "x", name: "X", type: "float" },
            { id: "frequency", name: "Frequency", type: "float", default: 1 },
            { id: "min", name: "Min", type: "float", default: 0 },
            { id: "max", name: "Max", type: "float", default: 1 },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "sineWave",
        title: "Sine Wave",
        color: C_INLINE,
        category: "Math/Wave",
        inputs: [
            { id: "x", name: "X", type: "float" },
            { id: "frequency", name: "Frequency", type: "float", default: 1 },
            { id: "min", name: "Min", type: "float", default: -1 },
            { id: "max", name: "Max", type: "float", default: 1 },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },

    // ── Color ──
    {
        typeId: "colorLuma",
        title: "Luma",
        color: C_INLINE,
        category: "Color",
        inputs: [{ id: "color", name: "Color", type: "vec3" }],
        outputs: [{ id: "out", name: "Luma", type: "float" }],
    },
    {
        typeId: "hsvToRgb",
        title: "HSV to RGB",
        color: C_INLINE,
        category: "Color",
        inputs: [
            { id: "h", name: "H", type: "float" },
            { id: "s", name: "S", type: "float" },
            { id: "v", name: "V", type: "float" },
        ],
        outputs: [{ id: "out", name: "RGB", type: "vec3" }],
    },
    {
        typeId: "rgbToHsv",
        title: "RGB to HSV",
        color: C_INLINE,
        category: "Color",
        inputs: [{ id: "rgb", name: "RGB", type: "vec3" }],
        outputs: [{ id: "out", name: "HSV", type: "vec3" }],
    },

    // ── Math / Exp ──
    {
        typeId: "exp",
        title: "Exp",
        color: C_INLINE,
        category: "Math/Exp",
        inputs: [{ id: "x", name: "X", type: "float" }],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "log",
        title: "Log",
        color: C_INLINE,
        category: "Math/Exp",
        inputs: [{ id: "x", name: "X", type: "float" }],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },

    // ── Math / Constants ──
    {
        typeId: "epsilon",
        title: "Epsilon",
        color: C_INLINE,
        category: "Math/Constants",
        inputs: [],
        outputs: [{ id: "out", name: "Out", type: "float" }],
    },
    {
        typeId: "pi",
        title: "Pi",
        color: C_INLINE,
        category: "Math/Constants",
        inputs: [],
        outputs: [{ id: "out", name: "Out", type: "float" }],
    },

    // ── Math / Remap ──
    {
        typeId: "remap",
        title: "Remap",
        color: C_INLINE,
        category: "Math/Remap",
        inputs: [
            { id: "x", name: "X", type: "float" },
            { id: "oldMin", name: "Old Min", type: "float" },
            { id: "oldMax", name: "Old Max", type: "float" },
            { id: "newMin", name: "New Min", type: "float" },
            { id: "newMax", name: "New Max", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },

    // ── Math / Geometry ──
    {
        typeId: "distance",
        title: "Distance",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "a", name: "A", type: "float" },
            { id: "b", name: "B", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "crossProduct",
        title: "Cross Product",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "a", name: "A", type: "vec3" },
            { id: "b", name: "B", type: "vec3" },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec3" }],
    },
    {
        typeId: "dotProduct",
        title: "Dot Product",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "a", name: "A", type: "float" },
            { id: "b", name: "B", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "length",
        title: "Length",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [{ id: "x", name: "X", type: "float" }],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "normalize",
        title: "Normalize",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [{ id: "x", name: "X", type: "vec2" }],
        outputs: [{ id: "out", name: "Out", type: "vec2" }],
        supportedTypes: ["vec2", "vec3", "vec4"],
    },
    {
        typeId: "reflect",
        title: "Reflect",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "i", name: "Incident", type: "vec3" },
            { id: "n", name: "Normal", type: "vec3" },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec3" }],
        supportedTypes: ["vec2", "vec3", "vec4"],
    },
    {
        typeId: "refract",
        title: "Refract",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "i", name: "Incident", type: "vec3" },
            { id: "n", name: "Normal", type: "vec3" },
            { id: "eta", name: "Eta", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec3" }],
        supportedTypes: ["vec2", "vec3", "vec4"],
    },

    // ── Math / Trigonometry ──
    {
        typeId: "sine",
        title: "Sine",
        color: C_INLINE,
        category: "Math/Trigonometry",
        inputs: [{ id: "x", name: "X", type: "float" }],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "cosine",
        title: "Cosine",
        color: C_INLINE,
        category: "Math/Trigonometry",
        inputs: [{ id: "x", name: "X", type: "float" }],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "tangent",
        title: "Tangent",
        color: C_INLINE,
        category: "Math/Trigonometry",
        inputs: [{ id: "x", name: "X", type: "float" }],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "arcsine",
        title: "Arc Sine",
        color: C_INLINE,
        category: "Math/Trigonometry",
        inputs: [{ id: "x", name: "X", type: "float" }],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "arccosine",
        title: "Arc Cosine",
        color: C_INLINE,
        category: "Math/Trigonometry",
        inputs: [{ id: "x", name: "X", type: "float" }],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "arctangent2",
        title: "Arc Tangent 2",
        color: C_INLINE,
        category: "Math/Trigonometry",
        inputs: [
            { id: "y", name: "Y", type: "float" },
            { id: "x", name: "X", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },

    // ── Math / Clamp ──
    {
        typeId: "ceiling",
        title: "Ceiling",
        color: C_INLINE,
        category: "Math/Clamp",
        inputs: [{ id: "x", name: "X", type: "float" }],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "clamp",
        title: "Clamp",
        color: C_INLINE,
        category: "Math/Clamp",
        inputs: [
            { id: "x", name: "X", type: "float" },
            { id: "min", name: "Min", type: "float" },
            { id: "max", name: "Max", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_ALL_NUMERIC,
    },
    {
        typeId: "discretize",
        title: "Discretize",
        color: C_INLINE,
        category: "Math/Clamp",
        inputs: [
            { id: "x", name: "X", type: "float" },
            { id: "step", name: "Step Size", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "floor",
        title: "Floor",
        color: C_INLINE,
        category: "Math/Clamp",
        inputs: [{ id: "x", name: "X", type: "float" }],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "maximum",
        title: "Maximum",
        color: C_INLINE,
        category: "Math/Clamp",
        inputs: [
            { id: "a", name: "A", type: "float" },
            { id: "b", name: "B", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_ALL_NUMERIC,
    },
    {
        typeId: "minimum",
        title: "Minimum",
        color: C_INLINE,
        category: "Math/Clamp",
        inputs: [
            { id: "a", name: "A", type: "float" },
            { id: "b", name: "B", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_ALL_NUMERIC,
    },
    {
        typeId: "round",
        title: "Round",
        color: C_INLINE,
        category: "Math/Clamp",
        inputs: [{ id: "x", name: "X", type: "float" }],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "saturate",
        title: "Saturate",
        color: C_INLINE,
        category: "Math/Clamp",
        inputs: [{ id: "x", name: "X", type: "float" }],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },

    // ── Bitwise ──
    {
        typeId: "bitwiseAnd",
        title: "And",
        color: C_INLINE,
        category: "Bitwise",
        inputs: [
            { id: "a", name: "A", type: "int" },
            { id: "b", name: "B", type: "int" },
        ],
        outputs: [{ id: "out", name: "Out", type: "int" }],
    },
    {
        typeId: "bitwiseComplement",
        title: "Complement",
        color: C_INLINE,
        category: "Bitwise",
        inputs: [
            { id: "a", name: "A", type: "int" },
        ],
        outputs: [{ id: "out", name: "Out", type: "int" }],
    },
    {
        typeId: "bitwiseLeftShift",
        title: "Left Shift",
        color: C_INLINE,
        category: "Bitwise",
        inputs: [
            { id: "a", name: "A", type: "int" },
            { id: "b", name: "B", type: "int" },
        ],
        outputs: [{ id: "out", name: "Out", type: "int" }],
    },
    {
        typeId: "bitwiseOr",
        title: "Or",
        color: C_INLINE,
        category: "Bitwise",
        inputs: [
            { id: "a", name: "A", type: "int" },
            { id: "b", name: "B", type: "int" },
        ],
        outputs: [{ id: "out", name: "Out", type: "int" }],
    },
    {
        typeId: "bitwiseRightShift",
        title: "Right Shift",
        color: C_INLINE,
        category: "Bitwise",
        inputs: [
            { id: "a", name: "A", type: "int" },
            { id: "b", name: "B", type: "int" },
        ],
        outputs: [{ id: "out", name: "Out", type: "int" }],
    },
    {
        typeId: "bitwiseXor",
        title: "Xor",
        color: C_INLINE,
        category: "Bitwise",
        inputs: [
            { id: "a", name: "A", type: "int" },
            { id: "b", name: "B", type: "int" },
        ],
        outputs: [{ id: "out", name: "Out", type: "int" }],
    },

    // ── Sampling ──
    {
        typeId: "sampleTexture2D",
        title: "Sample Texture2D",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "uv", name: "UV", type: "vec2" },
            { id: "mipLevel", name: "Mip Level", type: "float", default: 0 },
        ],
        outputs: [{ id: "out", name: "Color", type: "vec4" }],
        properties: [
            { name: "texture", caption: "Texture", type: "Texture2D" },
        ],
    },
    {
        typeId: "sampleTexture3D",
        title: "Sample Texture3D",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "uvw", name: "UVW", type: "vec3" },
            { id: "mipLevel", name: "Mip Level", type: "float", default: 0 },
        ],
        outputs: [{ id: "out", name: "Color", type: "vec4" }],
        properties: [
            { name: "texture", caption: "Texture", type: "Texture3D" },
        ],
    },
    {
        // Unity LoadTexture2D.cs 对齐：整数坐标精确 texelFetch，无插值
        typeId: "loadTexture2D",
        title: "Load Texture2D",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "x", name: "X", type: "float", default: 0 },
            { id: "y", name: "Y", type: "float", default: 0 },
            { id: "mipLevel", name: "Mip Level", type: "float", default: 0 },
        ],
        outputs: [{ id: "out", name: "Color", type: "vec4" }],
        properties: [
            { name: "texture", caption: "Texture", type: "Texture2D" },
        ],
    },
    {
        // Unity LoadTexture3D.cs 对齐：整数 (x,y,z) + mipLevel 精确 texelFetch
        typeId: "loadTexture3D",
        title: "Load Texture3D",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "x", name: "X", type: "float", default: 0 },
            { id: "y", name: "Y", type: "float", default: 0 },
            { id: "z", name: "Z", type: "float", default: 0 },
            { id: "mipLevel", name: "Mip Level", type: "float", default: 0 },
        ],
        outputs: [{ id: "out", name: "Color", type: "vec4" }],
        properties: [
            { name: "texture", caption: "Texture", type: "Texture3D" },
        ],
    },
    {
        // Unity SampleTextureCube.cs 对齐：Cubemap 采样
        typeId: "sampleTextureCube",
        title: "Sample TextureCube",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "uvw", name: "UVW", type: "vec3" },
            { id: "mipLevel", name: "Mip Level", type: "float", default: 0 },
        ],
        outputs: [{ id: "out", name: "Color", type: "vec4" }],
        properties: [
            { name: "texture", caption: "Texture", type: "TextureCube" },
        ],
    },
    {
        // Unity SampleTexture2DArray.cs 对齐：texture array 按 slice + uv + mip 采样
        typeId: "sampleTexture2DArray",
        title: "Sample Texture2DArray",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "uv", name: "UV", type: "vec2" },
            { id: "slice", name: "Slice", type: "float", default: 0 },
            { id: "mipLevel", name: "Mip Level", type: "float", default: 0 },
        ],
        outputs: [{ id: "out", name: "Color", type: "vec4" }],
        properties: [
            { name: "texture", caption: "Texture", type: "Texture2DArray" },
        ],
    },
    {
        // Unity LoadTexture2DArray.cs 对齐：整数像素坐标 + slice + mip 精确 texelFetch
        typeId: "loadTexture2DArray",
        title: "Load Texture2DArray",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "x", name: "X", type: "float", default: 0 },
            { id: "y", name: "Y", type: "float", default: 0 },
            { id: "slice", name: "Slice", type: "float", default: 0 },
            { id: "mipLevel", name: "Mip Level", type: "float", default: 0 },
        ],
        outputs: [{ id: "out", name: "Color", type: "vec4" }],
        properties: [
            { name: "texture", caption: "Texture", type: "Texture2DArray" },
        ],
    },
    {
        // Unity PeriodicTotalTime.cs 对齐：totalTime 按 period 周期循环，映射到 Range
        typeId: "periodicTotalTime",
        title: "Periodic Total Time",
        color: C_INLINE,
        category: "BuiltIn",
        inputs: [
            { id: "period", name: "Period", type: "float", default: 5 },
            { id: "range", name: "Range", type: "vec2", default: { x: 0, y: 1 } },
        ],
        outputs: [{ id: "out", name: "T", type: "float" }],
        properties: [],
    },
    {
        typeId: "sampleGradient",
        title: "Sample Gradient",
        color: C_CURVE,
        category: "Sampling",
        inputs: [
            { id: "t", name: "Time", type: "float", default: 0 },
        ],
        outputs: [{ id: "out", name: "Color", type: "vec4" }],
        properties: [
            {
                name: "gradient", caption: "Gradient (inline)", type: "Gradient", inspector: "gradient",
                default: { stops: [{ t: 0, color: { r: 1, g: 1, b: 1, a: 1 } }, { t: 1, color: { r: 1, g: 1, b: 1, a: 0 } }] },
                hidden: "!!data.property",
            } as any,
            { name: "property", caption: "Graph Property (Gradient)", type: "string", default: "", tooltip: "填写图级 Gradient 属性名；留空则用 inline gradient" },
        ],
    },

    // ── Noise ──
    {
        typeId: "noise",
        title: "Noise",
        color: C_INLINE,
        category: "Noise",
        inputs: [
            { id: "coord", name: "Coordinate", type: "vec3" },
            { id: "frequency", name: "Frequency", type: "float", default: 5 },
            { id: "octaves", name: "Octaves", type: "int", default: 3 },
            { id: "roughness", name: "Roughness", type: "float", default: 0.5 },
            { id: "lacunarity", name: "Lacunarity", type: "float", default: 2 },
            { id: "amplitude", name: "Amplitude", type: "float", default: 1 },
        ],
        outputs: [
            { id: "out", name: "Noise", type: "float" },
            { id: "out_derivatives", name: "Derivatives", type: "vec3" },
        ],
        properties: [
            { name: "noiseType", caption: "Type", type: "string", enumSource: ["Value", "Perlin", "Cellular"], default: "Perlin" },
        ],
    },
    {
        typeId: "curlNoise",
        title: "Curl Noise",
        color: C_INLINE,
        category: "Noise",
        inputs: [
            { id: "coord", name: "Coordinate", type: "vec3" },
            { id: "frequency", name: "Frequency", type: "float", default: 5 },
            { id: "octaves", name: "Octaves", type: "int", default: 3 },
            { id: "roughness", name: "Roughness", type: "float", default: 0.5 },
            { id: "lacunarity", name: "Lacunarity", type: "float", default: 2 },
            { id: "amplitude", name: "Amplitude", type: "float", default: 1 },
        ],
        outputs: [{ id: "out", name: "Curl", type: "vec3" }],
        properties: [
            { name: "noiseType", caption: "Type", type: "string", enumSource: ["Value", "Perlin", "Cellular"], default: "Perlin" },
        ],
    },

    // ── Logic ──
    {
        typeId: "compare",
        title: "Compare",
        color: C_INLINE,
        category: "Logic",
        inputs: [
            { id: "a", name: "A", type: "float" },
            { id: "b", name: "B", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "bool" }],
        supportedTypes: TYPES_ALL_NUMERIC,
        properties: [
            { name: "operator", caption: "Operator", type: "string", enumSource: ["Equal", "NotEqual", "Less", "LessOrEqual", "Greater", "GreaterOrEqual"], default: "Less" },
        ],
    },
    {
        typeId: "branch",
        title: "Branch",
        color: C_INLINE,
        category: "Logic",
        inputs: [
            { id: "predicate", name: "Predicate", type: "bool" },
            { id: "trueVal", name: "True", type: "float" },
            { id: "falseVal", name: "False", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
    },
    {
        typeId: "logicAnd",
        title: "And",
        color: C_INLINE,
        category: "Logic",
        inputs: [
            { id: "a", name: "A", type: "bool" },
            { id: "b", name: "B", type: "bool" },
        ],
        outputs: [{ id: "out", name: "Out", type: "bool" }],
    },
    {
        typeId: "logicOr",
        title: "Or",
        color: C_INLINE,
        category: "Logic",
        inputs: [
            { id: "a", name: "A", type: "bool" },
            { id: "b", name: "B", type: "bool" },
        ],
        outputs: [{ id: "out", name: "Out", type: "bool" }],
    },
    {
        typeId: "logicNot",
        title: "Not",
        color: C_INLINE,
        category: "Logic",
        inputs: [
            { id: "a", name: "A", type: "bool" },
        ],
        outputs: [{ id: "out", name: "Out", type: "bool" }],
    },
    {
        typeId: "logicNand",
        title: "Nand",
        color: C_INLINE,
        category: "Logic",
        inputs: [
            { id: "a", name: "A", type: "bool" },
            { id: "b", name: "B", type: "bool" },
        ],
        outputs: [{ id: "out", name: "Out", type: "bool" }],
    },
    {
        typeId: "logicNor",
        title: "Nor",
        color: C_INLINE,
        category: "Logic",
        inputs: [
            { id: "a", name: "A", type: "bool" },
            { id: "b", name: "B", type: "bool" },
        ],
        outputs: [{ id: "out", name: "Out", type: "bool" }],
    },

    // ── Random ──
    {
        typeId: "randomNumber",
        title: "Random Number",
        color: C_INLINE,
        category: "Random",
        inputs: [
            { id: "min", name: "Min", type: "float" },
            { id: "max", name: "Max", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
        properties: [
            { name: "seed", caption: "Seed", type: "string", enumSource: ["PerParticle", "PerComponent", "PerParticleStrip"], default: "PerParticle" },
        ],
    },

    // ── Built-in ──
    {
        typeId: "builtinDeltaTime",
        title: "Delta Time",
        color: C_INLINE,
        category: "Built-in",
        inputs: [],
        outputs: [{ id: "out", name: "dt", type: "float" }],
    },
    {
        typeId: "builtinTotalTime",
        title: "Total Time",
        color: C_INLINE,
        category: "Built-in",
        inputs: [],
        outputs: [{ id: "out", name: "t", type: "float" }],
    },
    {
        typeId: "builtinSystemSeed",
        title: "System Seed",
        color: C_INLINE,
        category: "Built-in",
        inputs: [],
        outputs: [{ id: "out", name: "Seed", type: "uint" }],
    },
    {
        typeId: "builtinLocalToWorld",
        title: "Local To World",
        color: C_INLINE,
        category: "Built-in",
        inputs: [],
        outputs: [{ id: "out", name: "Matrix", type: "transform" }],
    },
    {
        typeId: "builtinWorldToLocal",
        title: "World To Local",
        color: C_INLINE,
        category: "Built-in",
        inputs: [],
        outputs: [{ id: "out", name: "Matrix", type: "transform" }],
    },

    // ── Get Attribute ──
    {
        typeId: "getAttribute",
        title: "Get Attribute",
        color: C_ATTRIBUTE,
        category: "Attribute",
        inputs: [],
        outputs: [{ id: "value", name: "Value", type: "any" }],
        properties: [
            { name: "attribute", caption: "Attribute", type: "string", enumSource: VFX_PARTICLE_ATTRIBUTES.map((a: { name: string }) => a.name), default: "position", nodeHidden: true } as any,
            { name: "location", caption: "Location", type: "string", enumSource: ["Current", "Source"], default: "Current" },
        ],
    },

    // ── Camera ──
    {
        typeId: "getMainCamera",
        title: "Get Main Camera",
        color: C_INLINE,
        category: "Camera",
        inputs: [],
        outputs: [{ id: "value", name: "Value", type: "camera" }],
        properties: [],
    },

    // ── Curve ──
    {
        typeId: "curve",
        title: "Curve",
        color: C_CURVE,
        category: "Utility",
        inputs: [],
        outputs: [{ id: "curve", name: "Curve", type: "curve" }],
        properties: [
            {
                name: "curve", caption: "Curve", type: "Curve", inspector: "vfxCurve",
                default: { frameData: [0, 0, 0, 1, 0.333, 0.333, 0, 1, 1, 0, 1, 0.333, 0.333, 0] },
                nodeHidden: true,
            } as any,
        ],
    },
    {
        typeId: "sampleCurve",
        title: "Sample Curve",
        color: C_CURVE,
        category: "Utility",
        inputs: [
            { id: "curve", name: "Curve", type: "curve" },
            { id: "t", name: "Time", type: "float", default: 0 },
        ],
        outputs: [{ id: "value", name: "Value", type: "float" }],
        properties: [
            // 内联曲线：Unity 的 Sample Curve 自带 AnimationCurve，转换器存在本节点 props.curve.frameData。
            // curve 输入槽未连接时编译器用这条内联曲线（见 VfxExprCompiler._compileSampleCurve）。
            // nodeHidden → 不占节点体，只在右侧 Inspector 用 vfxCurve 编辑器渲染。
            {
                name: "curve", caption: "Curve", type: "Curve", inspector: "vfxCurve",
                default: { frameData: [0, 0, 0, 1, 0.333, 0.333, 0, 1, 1, 0, 1, 0.333, 0.333, 0] },
                nodeHidden: true,
            } as any,
        ],
    },

    // ── Math / Geometry (Extended) ──
    {
        typeId: "squaredLength",
        title: "Squared Length",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [{ id: "x", name: "X", type: "vec2" }],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: ["vec2", "vec3", "vec4"],
    },
    {
        typeId: "squaredDistance",
        title: "Squared Distance",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "a", name: "A", type: "vec2" },
            { id: "b", name: "B", type: "vec2" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: ["vec2", "vec3", "vec4"],
    },
    {
        typeId: "rotate2D",
        title: "Rotate 2D",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "x", name: "X", type: "vec2" },
            { id: "angle", name: "Angle (rad)", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec2" }],
    },
    {
        typeId: "rotate3D",
        title: "Rotate 3D",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "position", name: "Position", type: "vec3" },
            { id: "center", name: "Rotation Center", type: "vec3", default: { x: 0, y: 0, z: 0 } },
            { id: "axis", name: "Rotation Axis", type: "vec3", default: { x: 0, y: 1, z: 0 } },
            { id: "angle", name: "Angle (rad)", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec3" }],
    },
    {
        typeId: "lookAt",
        title: "Look At",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "eye", name: "Eye", type: "vec3" },
            { id: "target", name: "Target", type: "vec3" },
            { id: "up", name: "Up", type: "vec3", default: { x: 0, y: 1, z: 0 } },
        ],
        outputs: [{ id: "out", name: "Out", type: "transform" }],
    },

    // ── Distance ──
    {
        typeId: "distanceToLine",
        title: "Distance To Line",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "point", name: "Point", type: "vec3" },
            { id: "start", name: "Start", type: "vec3" },
            { id: "end", name: "End", type: "vec3" },
        ],
        outputs: [{ id: "out", name: "Distance", type: "float" }],
    },
    {
        typeId: "distanceToPlane",
        title: "Distance To Plane",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "point", name: "Point", type: "vec3" },
            { id: "planePos", name: "Plane Position", type: "vec3" },
            { id: "planeNormal", name: "Plane Normal", type: "vec3", default: { x: 0, y: 1, z: 0 } },
        ],
        outputs: [{ id: "out", name: "Distance", type: "float" }],
    },
    {
        typeId: "distanceToAABox",
        title: "Distance to AABox",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "point", name: "Point", type: "vec3" },
            { id: "center", name: "Center", type: "vec3", default: { x: 0, y: 0, z: 0 } },
            { id: "size", name: "Size", type: "vec3", default: { x: 1, y: 1, z: 1 } },
        ],
        outputs: [{ id: "out", name: "Distance", type: "float" }],
    },
    {
        typeId: "distanceToOrientedBox",
        title: "Distance to OrientedBox",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "point", name: "Point", type: "vec3" },
            { id: "box", name: "Box", type: "orientedBox" },
        ],
        outputs: [{ id: "out", name: "Distance", type: "float" }],
    },
    {
        typeId: "distanceToTorus",
        title: "Distance to Torus",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "point", name: "Point", type: "vec3" },
            { id: "center", name: "Center", type: "vec3", default: { x: 0, y: 0, z: 0 } },
            { id: "majorRadius", name: "Major Radius", type: "float", default: 1 },
            { id: "minorRadius", name: "Minor Radius", type: "float", default: 0.3 },
        ],
        outputs: [{ id: "out", name: "Distance", type: "float" }],
    },
    {
        typeId: "distanceToSphere",
        title: "Distance To Sphere",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "point", name: "Point", type: "vec3" },
            { id: "center", name: "Center", type: "vec3" },
            { id: "radius", name: "Radius", type: "float", default: 1 },
        ],
        outputs: [{ id: "out", name: "Distance", type: "float" }],
    },
    {
        // Unity Distance to Cone — 有限 cone SDF：apex 在 center，沿 axis 延伸 height，底半径 baseRadius
        typeId: "distanceToCone",
        title: "Distance to Cone",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "point", name: "Point", type: "vec3" },
            { id: "center", name: "Apex", type: "vec3", default: { x: 0, y: 0, z: 0 } },
            { id: "axis", name: "Axis", type: "vec3", default: { x: 0, y: 1, z: 0 } },
            { id: "height", name: "Height", type: "float", default: 1 },
            { id: "baseRadius", name: "Base Radius", type: "float", default: 1 },
        ],
        outputs: [{ id: "out", name: "Distance", type: "float" }],
    },
    {
        // 通用 mat4 逆（对应 Unity Inverse Matrix）
        typeId: "inverseMatrix",
        title: "Inverse Matrix",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "matrix", name: "Matrix", type: "transform" },
        ],
        outputs: [{ id: "out", name: "Out", type: "transform" }],
    },
    {
        // Unity Distance to Cylinder — 有限 cylinder SDF
        typeId: "distanceToCylinder",
        title: "Distance to Cylinder",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "point", name: "Point", type: "vec3" },
            { id: "center", name: "Center", type: "vec3", default: { x: 0, y: 0, z: 0 } },
            { id: "axis", name: "Axis", type: "vec3", default: { x: 0, y: 1, z: 0 } },
            { id: "height", name: "Height", type: "float", default: 1 },
            { id: "radius", name: "Radius", type: "float", default: 1 },
        ],
        outputs: [{ id: "out", name: "Distance", type: "float" }],
    },
    {
        // Unity Colorize — gradient 采样（和 sampleGradient 同语义，语义命名更直观）
        typeId: "colorize",
        title: "Colorize",
        color: C_INLINE,
        category: "Color",
        inputs: [
            { id: "t", name: "Value", type: "float", default: 0 },
        ],
        outputs: [{ id: "out", name: "Color", type: "vec4" }],
        properties: [
            { name: "gradient", caption: "Gradient", type: "gradient" },
            { name: "property", caption: "Graph Property", type: "string", default: "" },
        ],
    },
    {
        // Unity Worley Noise F1 — cellular noise F1 (distance to nearest cell point)
        typeId: "worleyNoise",
        title: "Worley Noise",
        color: C_INLINE,
        category: "Noise",
        inputs: [
            { id: "coord", name: "Coordinate", type: "vec3" },
            { id: "frequency", name: "Frequency", type: "float", default: 1 },
            { id: "octaves", name: "Octaves", type: "int", default: 3 },
            { id: "roughness", name: "Roughness", type: "float", default: 0.5 },
            { id: "lacunarity", name: "Lacunarity", type: "float", default: 2 },
        ],
        outputs: [{ id: "out", name: "Noise", type: "vec4" }],
    },
    {
        // Unity PerParticleTotalTime — 返回粒子 age（= getAttribute age）
        typeId: "perParticleTotalTime",
        title: "Per-Particle Total Time",
        color: C_ATTRIBUTE,
        category: "Attribute",
        inputs: [],
        outputs: [{ id: "out", name: "Age", type: "float" }],
    },
    {
        // Unity RatioOverStrip — 粒子在 strip 上的位置比例 (0=tail oldest, 1=head newest)
        // 仅在 OutputStrip / OutputTrail context 有效（依赖 OutputStrip shader 内的 stripRatio 局部变量）
        typeId: "ratioOverStrip",
        title: "Get Ratio Over Strip [0..1]",
        color: C_ATTRIBUTE,
        category: "Attribute",
        inputs: [],
        outputs: [{ id: "out", name: "T", type: "float" }],
    },
    {
        // Unity SpawnState.cs 对齐 — 暴露 spawner runtime 状态给图（仅 Initialize 有效）
        typeId: "spawnState",
        title: "Spawn State",
        color: C_INLINE,
        category: "BuiltIn",
        inputs: [],
        outputs: [
            { id: "out_newLoop", name: "NewLoop", type: "bool" },
            { id: "out_loopState", name: "LoopState", type: "int" },
            { id: "out_loopIndex", name: "LoopIndex", type: "int" },
            { id: "out_spawnCount", name: "SpawnCount", type: "float" },
            { id: "out_spawnDeltaTime", name: "SpawnDeltaTime", type: "float" },
            { id: "out_spawnTotalTime", name: "SpawnTotalTime", type: "float" },
            { id: "out_loopDuration", name: "LoopDuration", type: "float" },
            { id: "out_loopCount", name: "LoopCount", type: "int" },
            { id: "out_delayBeforeLoop", name: "DelayBeforeLoop", type: "float" },
            { id: "out_delayAfterLoop", name: "DelayAfterLoop", type: "float" },
        ],
    },
    {
        // Unity Sequential Line — 按 index 在 line 上等分采样
        typeId: "sequentialLine",
        title: "Sequential Line",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "index", name: "Index", type: "int", default: 0 },
            { id: "count", name: "Count", type: "int", default: 10 },
            { id: "start", name: "Start", type: "vec3", default: { x: 0, y: 0, z: 0 } },
            { id: "end", name: "End", type: "vec3", default: { x: 1, y: 0, z: 0 } },
        ],
        outputs: [{ id: "out", name: "Position", type: "vec3" }],
    },
    {
        // Unity Sequential Circle — 按 index 在圆周等分采样（对齐 Unity SequentialCircle.cs InputProperties）
        typeId: "sequentialCircle",
        title: "Sequential Circle",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "index", name: "Index", type: "int", default: 0 },
            { id: "count", name: "Count", type: "int", default: 64 },
            { id: "center", name: "Center", type: "vec3", default: { x: 0, y: 0, z: 0 } },
            { id: "normal", name: "Normal", type: "vec3", default: { x: 0, y: 0, z: 1 } },
            { id: "up", name: "Up", type: "vec3", default: { x: 0, y: 1, z: 0 } },
            { id: "radius", name: "Radius", type: "float", default: 1 },
        ],
        outputs: [{ id: "out", name: "Position", type: "vec3" }],
    },
    {
        // Unity Sequential 3D — 按 index 在 3D 体内采样（对齐 Unity Sequential3D.cs InputProperties）
        // 完整字段 countX/Y/Z + axisX/Y/Z (vec3 each)，跟 Unity VFXOperatorUtility.Sequential3D 公式一致
        typeId: "sequential3D",
        title: "Sequential 3D",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "index", name: "Index", type: "int", default: 0 },
            { id: "countX", name: "CountX", type: "int", default: 8 },
            { id: "countY", name: "CountY", type: "int", default: 8 },
            { id: "countZ", name: "CountZ", type: "int", default: 8 },
            { id: "origin", name: "Origin", type: "vec3", default: { x: 0, y: 0, z: 0 } },
            { id: "axisX", name: "AxisX", type: "vec3", default: { x: 1, y: 0, z: 0 } },
            { id: "axisY", name: "AxisY", type: "vec3", default: { x: 0, y: 1, z: 0 } },
            { id: "axisZ", name: "AxisZ", type: "vec3", default: { x: 0, y: 0, z: 1 } },
        ],
        outputs: [{ id: "out", name: "Position", type: "vec3" }],
    },
    // ── Sample Mesh 系列（Unity SampleMesh/SamplePointCache 对齐）──
    //    通过 runtime 烘焙 mesh 属性到 Texture2D(N×1)，shader 用 index 读取
    {
        typeId: "sampleMeshPosition",
        title: "Sample Mesh Position",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "index", name: "Vertex Index", type: "int", default: 0 },
        ],
        outputs: [{ id: "out", name: "Position", type: "vec3" }],
        properties: [
            { name: "mesh", caption: "Mesh", type: "Mesh" },
        ],
    },
    {
        typeId: "sampleMeshNormal",
        title: "Sample Mesh Normal",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "index", name: "Vertex Index", type: "int", default: 0 },
        ],
        outputs: [{ id: "out", name: "Normal", type: "vec3" }],
        properties: [
            { name: "mesh", caption: "Mesh", type: "Mesh" },
        ],
    },
    {
        typeId: "sampleMeshTangent",
        title: "Sample Mesh Tangent",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "index", name: "Vertex Index", type: "int", default: 0 },
        ],
        outputs: [{ id: "out", name: "Tangent", type: "vec4" }],
        properties: [
            { name: "mesh", caption: "Mesh", type: "Mesh" },
        ],
    },
    {
        typeId: "sampleMeshUV",
        title: "Sample Mesh UV",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "index", name: "Vertex Index", type: "int", default: 0 },
        ],
        outputs: [{ id: "out", name: "UV", type: "vec2" }],
        properties: [
            { name: "mesh", caption: "Mesh", type: "Mesh" },
        ],
    },
    {
        typeId: "sampleMeshColor",
        title: "Sample Mesh Color",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "index", name: "Vertex Index", type: "int", default: 0 },
        ],
        outputs: [{ id: "out", name: "Color", type: "vec4" }],
        properties: [
            { name: "mesh", caption: "Mesh", type: "Mesh" },
        ],
    },
    {
        // Unity Position(Skinned Mesh) 对齐：从 SkinnedMeshRenderer 按 vertex index 读 skinned position
        // 业务侧通过 effect.setSkinnedMeshSource(sourceName, renderer) 注册 SkinnedMeshRenderer 引用
        typeId: "sampleSkinnedMeshPosition",
        title: "Sample Skinned Mesh Position",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "index", name: "Vertex Index", type: "int", default: 0 },
        ],
        outputs: [{ id: "out", name: "Position", type: "vec3" }],
        properties: [
            { name: "sourceName", caption: "Source Name", type: "string", default: "default" },
        ],
    },
    {
        typeId: "sampleSkinnedMeshNormal",
        title: "Sample Skinned Mesh Normal",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "index", name: "Vertex Index", type: "int", default: 0 },
        ],
        outputs: [{ id: "out", name: "Normal", type: "vec3" }],
        properties: [
            { name: "sourceName", caption: "Source Name", type: "string", default: "default" },
        ],
    },
    {
        // Unity SamplePointCache.cs 对齐：从 .pcache 资源按 index 读指定属性
        // pcache 格式（JSON）：{ elementCount, attributes: { position: number[][3], color: number[][4], ... } }
        // 输出统一 vec4，按需 swizzle（position 取 .xyz / color 取 全部）
        typeId: "samplePointCache",
        title: "Sample Point Cache",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "index", name: "Index", type: "int", default: 0 },
        ],
        outputs: [{ id: "out", name: "Value", type: "vec4" }],
        properties: [
            { name: "pcache", caption: "Point Cache", type: "string", default: "" },
            { name: "attribute", caption: "Attribute", type: "string", default: "position" },
        ],
    },
    {
        // Unity SampleIndex.cs 对齐：从 mesh.indexBuffer 按位置 i 读 vertex index
        // 用法：sampleMeshIndex(triangle*3+0/1/2) → 顶点 ID → 再喂 sampleMeshPosition 读三角形顶点位置
        typeId: "sampleMeshIndex",
        title: "Sample Mesh Index",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "index", name: "Index", type: "int", default: 0 },
        ],
        outputs: [{ id: "out", name: "Vertex ID", type: "int" }],
        properties: [
            { name: "mesh", caption: "Mesh", type: "Mesh" },
        ],
    },

    // ── Custom GLSL ──
    {
        // Unity CustomHLSL 对齐（用 GLSL 替代 HLSL）：用户写 GLSL 函数体，runtime 嵌入到 shader
        // 函数签名固定 vec4(a, b, c, d) → vec4，函数体必须含 return 语句
        // 用户在 code 里可写局部变量、调用 vec3/sin/lerp 等内建函数 + 已声明 uniform
        typeId: "customGlsl",
        title: "Custom GLSL",
        color: C_INLINE,
        category: "Custom",
        inputs: [
            { id: "a", name: "A", type: "vec4", default: { x: 0, y: 0, z: 0, w: 0 } },
            { id: "b", name: "B", type: "vec4", default: { x: 0, y: 0, z: 0, w: 0 } },
            { id: "c", name: "C", type: "vec4", default: { x: 0, y: 0, z: 0, w: 0 } },
            { id: "d", name: "D", type: "vec4", default: { x: 0, y: 0, z: 0, w: 0 } },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec4" }],
        properties: [
            { name: "code", caption: "GLSL Code", type: "string", default: "return a;" },
        ],
    },

    // ── Coordinate Conversions ──
    {
        typeId: "polarToRectangular",
        title: "Polar To Rectangular",
        color: C_INLINE,
        category: "Math/Coordinates",
        inputs: [
            { id: "distance", name: "Distance", type: "float", default: 1 },
            { id: "angle", name: "Angle (rad)", type: "float" },
        ],
        outputs: [{ id: "out", name: "XY", type: "vec2" }],
    },
    {
        typeId: "rectangularToPolar",
        title: "Rectangular To Polar",
        color: C_INLINE,
        category: "Math/Coordinates",
        inputs: [
            { id: "xy", name: "XY", type: "vec2" },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec2" }],
    },
    {
        typeId: "sphericalToRectangular",
        title: "Spherical To Rectangular",
        color: C_INLINE,
        category: "Math/Coordinates",
        inputs: [
            { id: "distance", name: "Distance", type: "float", default: 1 },
            { id: "theta", name: "Theta (rad)", type: "float" },
            { id: "phi", name: "Phi (rad)", type: "float" },
        ],
        outputs: [{ id: "out", name: "XYZ", type: "vec3" }],
    },
    {
        typeId: "rectangularToSpherical",
        title: "Rectangular To Spherical",
        color: C_INLINE,
        category: "Math/Coordinates",
        inputs: [
            { id: "xyz", name: "XYZ", type: "vec3" },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec3" }],
    },
    {
        typeId: "cylindricalToRectangular",
        title: "Cylindrical To Rectangular",
        color: C_INLINE,
        category: "Math/Coordinates",
        inputs: [
            { id: "distance", name: "Distance", type: "float", default: 1 },
            { id: "angle", name: "Angle (rad)", type: "float" },
            { id: "height", name: "Height", type: "float" },
        ],
        outputs: [{ id: "out", name: "XYZ", type: "vec3" }],
    },
    {
        typeId: "rectangularToCylindrical",
        title: "Rectangular To Cylindrical",
        color: C_INLINE,
        category: "Math/Coordinates",
        inputs: [
            { id: "xyz", name: "XYZ", type: "vec3" },
        ],
        outputs: [{ id: "out", name: "Out (Dist, Angle, Height)", type: "vec3" }],
    },

    // ── Vector Construction / Decomposition ──
    {
        typeId: "appendFloat2",
        title: "Append (Float → Vec2)",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "a", name: "X", type: "float" },
            { id: "b", name: "Y", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec2" }],
    },
    {
        typeId: "appendFloat3",
        title: "Append (Float → Vec3)",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "a", name: "X", type: "float" },
            { id: "b", name: "Y", type: "float" },
            { id: "c", name: "Z", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec3" }],
    },
    {
        typeId: "appendFloat4",
        title: "Append (Float → Vec4)",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "a", name: "X", type: "float" },
            { id: "b", name: "Y", type: "float" },
            { id: "c", name: "Z", type: "float" },
            { id: "d", name: "W", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec4" }],
    },
    {
        typeId: "appendVec2Float",
        title: "Append (Vec2 + Float → Vec3)",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "a", name: "XY", type: "vec2" },
            { id: "b", name: "Z", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec3" }],
    },
    {
        typeId: "appendVec3Float",
        title: "Append (Vec3 + Float → Vec4)",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "a", name: "XYZ", type: "vec3" },
            { id: "b", name: "W", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec4" }],
    },
    {
        typeId: "appendVec2Vec2",
        title: "Append (Vec2 + Vec2 → Vec4)",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "a", name: "XY", type: "vec2" },
            { id: "b", name: "ZW", type: "vec2" },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec4" }],
    },
    {
        typeId: "swizzle",
        title: "Swizzle",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "a", name: "In", type: "vec4" },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec4" }],
        supportedTypes: ["float", "vec2", "vec3", "vec4"],
        properties: [
            { name: "pattern", caption: "Pattern", type: "string", default: "xyzw" },
            { name: "_type", caption: "Output Type", type: "string", enumSource: ["float", "vec2", "vec3", "vec4"], default: "vec4" },
        ],
    },
    {
        typeId: "componentMaskVec3",
        title: "Component Mask (Vec3)",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "a", name: "In", type: "vec3" },
            { id: "mx", name: "Keep X", type: "float", default: 1 },
            { id: "my", name: "Keep Y", type: "float", default: 1 },
            { id: "mz", name: "Keep Z", type: "float", default: 1 },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec3" }],
    },
    {
        typeId: "weightedSelector",
        title: "Weighted Selector",
        color: C_INLINE,
        category: "Logic",
        inputs: [
            { id: "value0", name: "Value 0", type: "float" },
            { id: "weight0", name: "Weight 0", type: "float", default: 1 },
            { id: "value1", name: "Value 1", type: "float" },
            { id: "weight1", name: "Weight 1", type: "float", default: 1 },
            { id: "value2", name: "Value 2", type: "float" },
            { id: "weight2", name: "Weight 2", type: "float", default: 1 },
            { id: "value3", name: "Value 3", type: "float" },
            { id: "weight3", name: "Weight 3", type: "float", default: 1 },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: ["float", "int", "uint", "vec2", "vec3", "vec4"],
        properties: [
            { name: "count", caption: "Count", type: "number", default: 2, min: 2, max: 8, step: 1 },
            { name: "_type", caption: "Type", type: "string", enumSource: ["float", "int", "uint", "vec2", "vec3", "vec4"], default: "float" },
        ],
    },
    {
        typeId: "componentMaskVec4",
        title: "Component Mask (Vec4)",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "a", name: "In", type: "vec4" },
            { id: "mx", name: "Keep X", type: "float", default: 1 },
            { id: "my", name: "Keep Y", type: "float", default: 1 },
            { id: "mz", name: "Keep Z", type: "float", default: 1 },
            { id: "mw", name: "Keep W", type: "float", default: 1 },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec4" }],
    },

    // ── Volume / Area ──
    {
        typeId: "aaBoxVolume",
        title: "AABox Volume",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "size", name: "Size", type: "vec3", default: { x: 1, y: 1, z: 1 } },
        ],
        outputs: [{ id: "out", name: "Volume", type: "float" }],
    },
    {
        typeId: "orientedBoxVolume",
        title: "OrientedBox Volume",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "box", name: "Box", type: "orientedBox" },
        ],
        outputs: [{ id: "out", name: "Volume", type: "float" }],
    },
    {
        typeId: "sphereVolume",
        title: "Sphere Volume",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "radius", name: "Radius", type: "float", default: 1 },
        ],
        outputs: [{ id: "out", name: "Volume", type: "float" }],
    },
    {
        typeId: "coneVolume",
        title: "Cone Volume",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "baseRadius", name: "Base Radius", type: "float", default: 1 },
            { id: "topRadius", name: "Top Radius", type: "float" },
            { id: "height", name: "Height", type: "float", default: 1 },
        ],
        outputs: [{ id: "out", name: "Volume", type: "float" }],
    },
    {
        typeId: "torusVolume",
        title: "Torus Volume",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "majorRadius", name: "Major Radius", type: "float", default: 1 },
            { id: "minorRadius", name: "Minor Radius", type: "float", default: 0.3 },
        ],
        outputs: [{ id: "out", name: "Volume", type: "float" }],
    },
    {
        typeId: "circleArea",
        title: "Circle Area",
        color: C_INLINE,
        category: "Math/Geometry",
        inputs: [
            { id: "radius", name: "Radius", type: "float", default: 1 },
        ],
        outputs: [{ id: "out", name: "Area", type: "float" }],
    },

    // ── Transform ──
    {
        typeId: "transformPosition",
        title: "Transform Position",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "matrix", name: "Matrix", type: "transform" },
            { id: "position", name: "Position", type: "vec3" },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec3" }],
    },
    {
        typeId: "transformDirection",
        title: "Transform Direction",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "matrix", name: "Matrix", type: "transform" },
            { id: "direction", name: "Direction", type: "vec3" },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec3" }],
    },
    {
        typeId: "transformVector",
        title: "Transform Vector",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "matrix", name: "Matrix", type: "transform" },
            { id: "vector", name: "Vector", type: "vec3" },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec3" }],
    },
    {
        // Unity TransformVector4.cs 对齐：mat4 × vec4 保留 w 分量
        typeId: "transformVector4",
        title: "Transform (Vector4)",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "matrix", name: "Matrix", type: "transform" },
            { id: "vec", name: "Vec4", type: "vec4", default: { x: 0, y: 0, z: 0, w: 0 } },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec4" }],
    },
    {
        // Unity TransformMatrix.cs 对齐：mat4 × mat4 矩阵乘法
        typeId: "transformMatrix",
        title: "Transform (Matrix)",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "matrix", name: "Matrix", type: "transform" },
            { id: "m", name: "M", type: "transform" },
        ],
        outputs: [{ id: "out", name: "Out", type: "transform" }],
    },
    {
        // Unity TextureDimensions.cs 对齐（Texture2D 版）：返回 vec2(width, height)
        typeId: "textureDimensions2D",
        title: "Get Texture2D Dimensions",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "mipLevel", name: "Mip Level", type: "float", default: 0 },
        ],
        outputs: [{ id: "out", name: "Dim", type: "vec2" }],
        properties: [
            { name: "texture", caption: "Texture", type: "Texture2D" },
        ],
    },
    {
        // Unity TextureDimensions.cs 对齐（Texture3D 版）：返回 vec3(width, height, depth)
        typeId: "textureDimensions3D",
        title: "Get Texture3D Dimensions",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "mipLevel", name: "Mip Level", type: "float", default: 0 },
        ],
        outputs: [{ id: "out", name: "Dim", type: "vec3" }],
        properties: [
            { name: "texture", caption: "Texture", type: "Texture3D" },
        ],
    },
    {
        typeId: "constructMatrix",
        title: "Construct Matrix",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "position", name: "Position", type: "vec3" },
            { id: "rotation", name: "Rotation", type: "vec3" },
            { id: "scale", name: "Scale", type: "vec3", default: { x: 1, y: 1, z: 1 } },
        ],
        outputs: [{ id: "out", name: "Out", type: "transform" }],
    },
    {
        typeId: "transposeMatrix",
        title: "Transpose Matrix",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "matrix", name: "Matrix", type: "transform" },
        ],
        outputs: [{ id: "out", name: "Out", type: "transform" }],
    },
    {
        typeId: "inverseTRSMatrix",
        title: "Inverse TRS Matrix",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "matrix", name: "Matrix", type: "transform" },
        ],
        outputs: [{ id: "out", name: "Out", type: "transform" }],
    },
    {
        // Unity ChangeSpace.cs 对齐：Local↔World 空间切换
        typeId: "changeSpace",
        title: "Change Space",
        color: C_INLINE,
        category: "Math/Vector",
        inputs: [
            { id: "input", name: "Input", type: "vec3" },
        ],
        outputs: [{ id: "out", name: "Out", type: "vec3" }],
        properties: [
            { name: "fromSpace", caption: "From", type: "string", enumSource: ["Local", "World"], default: "Local" },
            { name: "toSpace", caption: "To", type: "string", enumSource: ["Local", "World"], default: "World" },
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Position", "Direction"], default: "Position" },
        ],
    },
    {
        // Unity GammaToLinear.cs 对齐：sRGB→Linear 近似 pow 2.2（per channel）
        typeId: "gammaToLinear",
        title: "Gamma To Linear",
        color: C_INLINE,
        category: "Color",
        inputs: [
            { id: "x", name: "Color", type: "vec3" },
        ],
        outputs: [{ id: "out", name: "Linear", type: "vec3" }],
    },
    {
        // Unity LinearToGamma.cs 对齐：Linear→sRGB 近似 pow 1/2.2（per channel）
        typeId: "linearToGamma",
        title: "Linear To Gamma",
        color: C_INLINE,
        category: "Color",
        inputs: [
            { id: "x", name: "Color", type: "vec3" },
        ],
        outputs: [{ id: "out", name: "sRGB", type: "vec3" }],
    },
    {
        // Unity LoadTextureCube.cs 对齐：按方向向量采样（代 texelFetch）
        typeId: "loadTextureCube",
        title: "Load Texture Cube",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "direction", name: "Direction", type: "vec3", default: { x: 0, y: 0, z: 1 } },
            { id: "mipLevel", name: "Mip Level", type: "float", default: 0 },
        ],
        outputs: [{ id: "out", name: "Color", type: "vec4" }],
        properties: [
            { name: "texture", caption: "Texture", type: "TextureCube" },
        ],
    },
    {
        // Unity TextureDimensions cube 版：返回 vec2(w, h)
        typeId: "textureDimensionsCube",
        title: "Get TextureCube Dimensions",
        color: C_INLINE,
        category: "Sampling",
        inputs: [
            { id: "mipLevel", name: "Mip Level", type: "float", default: 0 },
        ],
        outputs: [{ id: "out", name: "Dim", type: "vec2" }],
        properties: [
            { name: "texture", caption: "Texture", type: "TextureCube" },
        ],
    },

    // ── Switch ──
    {
        typeId: "switchOp",
        title: "Switch",
        color: C_INLINE,
        category: "Logic",
        inputs: [
            { id: "index", name: "Index", type: "int" },
            { id: "input0", name: "Input 0", type: "float" },
            { id: "input1", name: "Input 1", type: "float" },
            { id: "input2", name: "Input 2", type: "float" },
            { id: "input3", name: "Input 3", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
        supportedTypes: TYPES_FLOAT_VEC,
        properties: [
            { name: "count", caption: "Count", type: "number", default: 4, min: 2, max: 8, step: 1 },
        ],
    },

    // ── Viewport ──
    {
        typeId: "worldToViewport",
        title: "World To Viewport",
        color: C_INLINE,
        category: "Camera",
        inputs: [
            { id: "position", name: "World Position", type: "vec3" },
            { id: "viewProj", name: "View-Proj Matrix", type: "transform" },
        ],
        outputs: [{ id: "out", name: "Viewport", type: "vec3" }],
    },
    {
        typeId: "viewportToWorld",
        title: "Viewport To World",
        color: C_INLINE,
        category: "Camera",
        inputs: [
            { id: "position", name: "Viewport Position", type: "vec3" },
            { id: "invViewProj", name: "Inv View-Proj Matrix", type: "transform" },
        ],
        outputs: [{ id: "out", name: "World", type: "vec3" }],
    },

    // ── Age Over Lifetime ──
    {
        typeId: "ageOverLifetime",
        title: "Age Over Lifetime",
        color: C_ATTRIBUTE,
        category: "Attribute",
        inputs: [
            { id: "age", name: "Age", type: "float" },
            { id: "lifetime", name: "Lifetime", type: "float" },
        ],
        outputs: [{ id: "out", name: "Out", type: "float" }],
    },
];
