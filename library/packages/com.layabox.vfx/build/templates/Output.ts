import type { IVfxBlockData } from "../../data/VfxTypes";
import type { VfxExprCompiler } from "../VfxExprCompiler";
import { blocksNeedSeed, genBlockCode } from "./BlockCodeGenCommon";

const OUTPUT_BLOCK_OPTS = { particleVar: "p", supportSource: false, includeShape: false } as const;

/** 属性默认值（Particle struct 中不存在时使用） */
const ATTR_DEFAULTS: Record<string, string> = {
    position: "vec3(0.0)",
    size: "0.1",
    scale: "vec3(1.0)",
    color: "vec3(1.0, 1.0, 1.0)",
    alpha: "1.0",
    angle: "vec3(0.0)",
    age: "0.0",
    lifetime: "3.0",
    texIndex: "0.0",
    pivot: "vec3(0.0)",
    axisX: "vec3(1.0, 0.0, 0.0)",
    axisY: "vec3(0.0, 1.0, 0.0)",
    axisZ: "vec3(0.0, 0.0, 1.0)",
};

/** GLSL 辅助函数：四元数运算 + 欧拉角转换 */
const QUAT_HELPERS = `\
// Quaternion multiply: q1 * q2 (apply q2 first, then q1)
vec4 quatMul(vec4 a, vec4 b)
{
    return vec4(
        a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
        a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
        a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
        a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
    );
}

// Rotation matrix (column-major mat3) → unit quaternion
vec4 mat3ToQuat(mat3 m)
{
    float trace = m[0][0] + m[1][1] + m[2][2];
    vec4 q;
    if (trace > 0.0) {
        float s = 0.5 / sqrt(trace + 1.0);
        q = vec4((m[1][2] - m[2][1]) * s,
                 (m[2][0] - m[0][2]) * s,
                 (m[0][1] - m[1][0]) * s,
                 0.25 / s);
    } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
        float s = 2.0 * sqrt(1.0 + m[0][0] - m[1][1] - m[2][2]);
        q = vec4(0.25 * s,
                 (m[0][1] + m[1][0]) / s,
                 (m[2][0] + m[0][2]) / s,
                 (m[1][2] - m[2][1]) / s);
    } else if (m[1][1] > m[2][2]) {
        float s = 2.0 * sqrt(1.0 + m[1][1] - m[0][0] - m[2][2]);
        q = vec4((m[0][1] + m[1][0]) / s,
                 0.25 * s,
                 (m[1][2] + m[2][1]) / s,
                 (m[2][0] - m[0][2]) / s);
    } else {
        float s = 2.0 * sqrt(1.0 + m[2][2] - m[0][0] - m[1][1]);
        q = vec4((m[2][0] + m[0][2]) / s,
                 (m[1][2] + m[2][1]) / s,
                 0.25 * s,
                 (m[0][1] - m[1][0]) / s);
    }
    return normalize(q);
}

// Euler angles (degrees, YXZ order) → unit quaternion
vec4 eulerToQuat(vec3 eulerDeg)
{
    vec3 r = radians(eulerDeg) * 0.5;
    float sx = sin(r.x), cx = cos(r.x);
    float sy = sin(r.y), cy = cos(r.y);
    float sz = sin(r.z), cz = cos(r.z);
    return vec4(
        cy * sx * cz + sy * cx * sz,
        sy * cx * cz - cy * sx * sz,
        cy * cx * sz - sy * sx * cz,
        cy * cx * cz + sy * sx * sz
    );
}`;

// ─── Orient block code generation ──────────────────────────

function findOrientBlock(blocks?: IVfxBlockData[]): IVfxBlockData | null {
    if (!blocks) return null;
    return blocks.find(b => b.typeId === "orient" && b.enabled) || null;
}

/** orient 模式需要哪些 camera uniform */
function orientCameraNeeds(block: IVfxBlockData | null): { pos: boolean; dir: boolean; up: boolean } {
    if (!block) return { pos: false, dir: false, up: false };
    const mode = (block.props?.mode as string) || "Face Camera Plane";
    // Along Velocity (Y primary, Unity faceRay): axisZ = position - cameraPos, 需 u_OrientCameraPos
    const avYPrimary = mode === "Along Velocity" && (((block.props?.axes as string) || "YX")[0] === "Y");
    return {
        pos: mode === "Face Camera Position" || mode === "Fixed Axis" || avYPrimary,
        dir: mode === "Face Camera Plane",
        // Unity Orient.cs LookAtPosition/LookAtLine: axisX = cross(GetVFXToViewRotMatrix()[1], axisZ)
        //   即用【相机 up 轴】做 twist(相机感知),而非世界 up → 面片随相机均匀朝向。需 u_OrientCameraUp。
        up: mode === "Look At Position" || mode === "Look At Line",
    };
}

function toVec3Literal(v: any): string {
    if (!v || typeof v !== "object") return "vec3(0.0)";
    return `vec3(${v.x ?? 0}, ${v.y ?? 0}, ${v.z ?? 0})`;
}

/** 解包 spaceable 复合类型（position/direction/vector），返回内部 vec3 */
function unwrapSpaceable(v: any, type: string): any {
    if (!v || typeof v !== "object") return v;
    if (type === "vector" && v.vector) return v.vector;
    if (type === "position" && v.position) return v.position;
    if (type === "direction" && v.direction) return v.direction;
    return v;
}

/**
 * 生成 Orient block 的 GLSL 代码。
 * 输出 3 个局部变量: vec3 _orientX, _orientY, _orientZ
 *
 * 所有计算在 local 空间进行（与 RenderBuffer 一致）。
 * 当 simulateSpace=World 时，camera/target 坐标需先转到 local 空间，
 * velocity 等方向量需用 mat3(u_InvEmitterWorldMatrix) 旋转。
 */
function genOrientCode(block: IVfxBlockData, attrNames: Set<string>, indent: string, isWorld: boolean): string[] {
    const p = block.props || {};
    const mode = (p.mode as string) || "Face Camera Plane";
    const lines: string[] = [];
    const pos = attrNames.has("position") ? "p.position" : ATTR_DEFAULTS.position;

    lines.push(`${indent}// Orient: ${mode}`);

    switch (mode) {
        case "Face Camera Plane": {
            // u_OrientCameraDir: camera forward direction (world space)
            // All particles face the same direction: opposite to camera forward
            lines.push(`${indent}vec3 _camFwd = normalize(mat3(u_InvEmitterWorldMatrix) * u_OrientCameraDir);`);
            lines.push(`${indent}vec3 _orientZ = -_camFwd;`);
            lines.push(`${indent}vec3 _cross1 = cross(vec3(0.0, 1.0, 0.0), _orientZ);`);
            lines.push(`${indent}float _cross1Len = length(_cross1);`);
            lines.push(`${indent}vec3 _orientX = (_cross1Len > 0.001) ? _cross1 / _cross1Len : normalize(cross(vec3(0.0, 0.0, 1.0), _orientZ));`);
            lines.push(`${indent}vec3 _orientY = cross(_orientZ, _orientX);`);
            break;
        }
        case "Face Camera Position": {
            // Camera position → local space, each particle looks at camera
            lines.push(`${indent}vec3 _camPos = transformPosition(u_InvEmitterWorldMatrix, u_OrientCameraPos);`);
            lines.push(`${indent}vec3 _lookDir = _camPos - ${pos};`);
            lines.push(`${indent}float _lookDist = length(_lookDir);`);
            lines.push(`${indent}vec3 _orientZ = (_lookDist > 0.001) ? _lookDir / _lookDist : vec3(0.0, 0.0, 1.0);`);
            lines.push(`${indent}vec3 _cross1 = cross(vec3(0.0, 1.0, 0.0), _orientZ);`);
            lines.push(`${indent}float _cross1Len = length(_cross1);`);
            lines.push(`${indent}vec3 _orientX = (_cross1Len > 0.001) ? _cross1 / _cross1Len : normalize(cross(vec3(0.0, 0.0, 1.0), _orientZ));`);
            lines.push(`${indent}vec3 _orientY = cross(_orientZ, _orientX);`);
            break;
        }
        case "Fixed Axis": {
            // upAxis is fixed Y; face camera around that axis
            const upAxis = toVec3Literal(unwrapSpaceable(p.upAxis, "vector"));
            const upSpace = (p._space_upAxis as string) || "Local";
            if (upSpace === "World") {
                lines.push(`${indent}vec3 _upAxis = normalize(mat3(u_InvEmitterWorldMatrix) * ${upAxis});`);
            } else {
                lines.push(`${indent}vec3 _upAxis = normalize(${upAxis});`);
            }
            // Camera position → local space, project look direction onto plane perpendicular to upAxis
            lines.push(`${indent}vec3 _camPos2 = transformPosition(u_InvEmitterWorldMatrix, u_OrientCameraPos);`);
            lines.push(`${indent}vec3 _toCamera = _camPos2 - ${pos};`);
            lines.push(`${indent}vec3 _projected = _toCamera - dot(_toCamera, _upAxis) * _upAxis;`);
            lines.push(`${indent}float _projLen = length(_projected);`);
            lines.push(`${indent}vec3 _orientZ = (_projLen > 0.001) ? _projected / _projLen : vec3(0.0, 0.0, 1.0);`);
            lines.push(`${indent}vec3 _orientY = _upAxis;`);
            lines.push(`${indent}vec3 _orientX = cross(_orientY, _orientZ);`);
            break;
        }
        case "Along Velocity": {
            // 对齐 Unity Orient.cs：
            //   - AlongVelocity (Unity mode 6): axisY = normalize(velocity), axisZ = position - cameraPos,
            //     axisX = cross(axisY, axisZ), axisZ = cross(axisX, axisY) (Y primary, camera-aware twist)
            //   - Advanced ZY (Unity mode 4, axes ZY, AxisZ linked to velocity): axisZ = normalize(velocity),
            //     axisX = cross((0,1,0), velocity), axisY = cross(axisZ, axisX) (Z primary, static up)
            // converter 把 Unity Advanced 翻成 Laya AlongVelocity 时通过 axes 字段传 primary axis；
            // 默认 axes="YX/YZ" 走 Unity 原 AlongVelocity (Y 对齐 velocity)。
            const axes = (p.axes as string) || "YX";
            const primary = axes[0];
            const vel = attrNames.has("velocity") ? "p.velocity" : "vec3(0.0, 1.0, 0.0)";
            if (isWorld && attrNames.has("velocity")) {
                lines.push(`${indent}vec3 _vel = mat3(u_InvEmitterWorldMatrix) * ${vel};`);
            } else {
                lines.push(`${indent}vec3 _vel = ${vel};`);
            }
            lines.push(`${indent}float _speed = length(_vel);`);
            if (primary === "Z") {
                // axes="ZY": Z 对齐 velocity, 直接套 Unity Advanced ZY 原 math.
                // Unity Advanced ZY 原 math (Orient.cs):
                //   axisZ = normalize(AxisZ_input);       // = velocity (Unity 用户接 velocity 链)
                //   axisX = normalize(cross(AxisY_input, AxisZ_input));  // = cross((0,1,0), velocity)
                //   axisY = cross(axisZ, axisX);
                // Laya RHS 也用相同公式 (cross 在 RHS 跟 LHS 符号差异由 axisMat→quaternion 一致处理).
                // mesh handedness 在 Laya FBX import 时已经处理 (mesh local +Z 仍是 head 方向),
                // 不需要在 shader 端再 negate velocity. 之前误加 -velocity 让 head/tail 反.
                lines.push(`${indent}vec3 _orientZ = (_speed > 0.001) ? _vel / _speed : vec3(0.0, 0.0, 1.0);`);
                lines.push(`${indent}vec3 _cross1 = cross(vec3(0.0, 1.0, 0.0), _orientZ);`);
                lines.push(`${indent}float _cross1Len = length(_cross1);`);
                lines.push(`${indent}vec3 _orientX = (_cross1Len > 0.001) ? _cross1 / _cross1Len : normalize(cross(vec3(1.0, 0.0, 0.0), _orientZ));`);
                lines.push(`${indent}vec3 _orientY = cross(_orientZ, _orientX);`);
            } else if (primary === "X") {
                // axes="XY/XZ": X 对齐 velocity
                lines.push(`${indent}vec3 _orientX = (_speed > 0.001) ? _vel / _speed : vec3(1.0, 0.0, 0.0);`);
                lines.push(`${indent}vec3 _cross1 = cross(_orientX, vec3(0.0, 0.0, 1.0));`);
                lines.push(`${indent}float _cross1Len = length(_cross1);`);
                lines.push(`${indent}vec3 _orientY = (_cross1Len > 0.001) ? _cross1 / _cross1Len : normalize(cross(_orientX, vec3(0.0, 1.0, 0.0)));`);
                lines.push(`${indent}vec3 _orientZ = cross(_orientX, _orientY);`);
            } else {
                // 默认 axes="YX/YZ" (Unity 原 AlongVelocity, faceRay): Y 对齐 velocity,
                // axisZ = position - cameraPos【视线方向】（Unity 产物公式:
                //   axisY=normalize(velocity); axisZ=position-viewPos;
                //   axisX=SafeNormCross(axisY,axisZ,(1,0,0)); axisZ=cross(axisX,axisY)）。
                // 用固定世界 Z 做 twist 轴会让面片不朝相机，侧视角拉伸条隐形。
                lines.push(`${indent}vec3 _orientY = (_speed > 0.001) ? _vel / _speed : vec3(0.0, 1.0, 0.0);`);
                lines.push(`${indent}vec3 _camPosAV = transformPosition(u_InvEmitterWorldMatrix, u_OrientCameraPos);`);
                lines.push(`${indent}vec3 _rayAV = ${pos} - _camPosAV;`);
                lines.push(`${indent}vec3 _cross1 = cross(_orientY, _rayAV);`);
                lines.push(`${indent}float _cross1Len = length(_cross1);`);
                lines.push(`${indent}vec3 _orientX = (_cross1Len > 0.001) ? _cross1 / _cross1Len : vec3(1.0, 0.0, 0.0);`);
                lines.push(`${indent}vec3 _orientZ = cross(_orientX, _orientY);`);
            }
            break;
        }
        case "Look At Position": {
            const target = toVec3Literal(unwrapSpaceable(p.lookAtPosition, "position"));
            const posSpace = (p._space_lookAtPosition as string) || "Local";
            // Convert target to local space if property is set to World
            if (posSpace === "World") {
                lines.push(`${indent}vec3 _target = transformPosition(u_InvEmitterWorldMatrix, ${target});`);
            } else {
                lines.push(`${indent}vec3 _target = ${target};`);
            }
            // Unity Orient.cs LookAtPosition (非 strip, 229-231 行,1:1 对齐源码):
            //   axisZ = normalize(position - Position);                                                // 径向朝外(粒子 - target)
            //   axisX = VFXSafeNormalizedCross(GetVFXToViewRotMatrix()[1].xyz, axisZ, float3(1,0,0));  // cross(【相机 up】, axisZ), 退化 fallback (1,0,0)
            //   axisY = cross(axisZ, axisX);
            // 用相机 up(u_OrientCameraUp 转 emitter-local),退化 fallback (1,0,0)。
            lines.push(`${indent}vec3 _camUp = normalize(mat3(u_InvEmitterWorldMatrix) * u_OrientCameraUp);`);
            lines.push(`${indent}vec3 _lookDir = ${pos} - _target;`);
            lines.push(`${indent}float _lookDist = length(_lookDir);`);
            lines.push(`${indent}vec3 _orientZ = (_lookDist > 0.001) ? _lookDir / _lookDist : vec3(0.0, 0.0, 1.0);`);
            lines.push(`${indent}vec3 _cross1 = cross(_camUp, _orientZ);`);
            lines.push(`${indent}float _cross1Len = length(_cross1);`);
            lines.push(`${indent}vec3 _orientX = (_cross1Len > 0.001) ? _cross1 / _cross1Len : vec3(1.0, 0.0, 0.0);`);
            lines.push(`${indent}vec3 _orientY = cross(_orientZ, _orientX);`);
            break;
        }
        case "Look At Line": {
            const lineVal = p.lookAtLine || { start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 1, z: 0 } };
            const lineSpace = (p._space_lookAtLine as string) || "Local";
            const lineStart = toVec3Literal(lineVal.start);
            const lineEnd = toVec3Literal(lineVal.end);
            // Convert line endpoints to local space if property is set to World
            if (lineSpace === "World") {
                lines.push(`${indent}vec3 _lineStart = transformPosition(u_InvEmitterWorldMatrix, ${lineStart});`);
                lines.push(`${indent}vec3 _lineEnd = transformPosition(u_InvEmitterWorldMatrix, ${lineEnd});`);
            } else {
                lines.push(`${indent}vec3 _lineStart = ${lineStart};`);
                lines.push(`${indent}vec3 _lineEnd = ${lineEnd};`);
            }
            lines.push(`${indent}vec3 _lineDir = _lineEnd - _lineStart;`);
            lines.push(`${indent}float _lineLenSq = dot(_lineDir, _lineDir);`);
            // Project particle position onto infinite line: t = dot(pos - start, dir) / dot(dir, dir)
            lines.push(`${indent}float _t = (_lineLenSq > 0.001) ? dot(${pos} - _lineStart, _lineDir) / _lineLenSq : 0.0;`);
            lines.push(`${indent}vec3 _closest = _lineStart + _t * _lineDir;`);
            // Unity Orient.cs LookAtLine: axisZ = normalize(position - target) — 远离 line 方向（同 LookAtPosition）
            lines.push(`${indent}vec3 _lookDir2 = ${pos} - _closest;`);
            lines.push(`${indent}float _lookDist2 = length(_lookDir2);`);
            lines.push(`${indent}vec3 _orientZ = (_lookDist2 > 0.001) ? _lookDir2 / _lookDist2 : vec3(0.0, 0.0, 1.0);`);
            lines.push(`${indent}vec3 _cross1 = cross(vec3(0.0, 1.0, 0.0), _orientZ);`);
            lines.push(`${indent}float _cross1Len = length(_cross1);`);
            lines.push(`${indent}vec3 _orientX = (_cross1Len > 0.001) ? _cross1 / _cross1Len : normalize(cross(vec3(0.0, 0.0, 1.0), _orientZ));`);
            lines.push(`${indent}vec3 _orientY = cross(_orientZ, _orientX);`);
            break;
        }
        case "Advanced": {
            // 主轴(axes[0]) + 次轴(axes[1])，第三轴由叉乘推导。
            // 两轴可以是「静态字面量」(customAxisA/B)，也可以是「逐粒子来源」(axisSourceA/B):
            //   "velocity" → 粒子速度; "position" → 径向法线 normalize(position - axisCenter)。
            // 例：OrientAdvanced 模板 axes="ZY"，AxisZ(主)=径向法线、AxisY(次)=velocity。
            const axes = (p.axes as string) || "ZY";
            const primary = axes[0];   // immutable axis
            const secondary = axes[1]; // used to derive third
            const all = "XYZ";
            const third = all.replace(primary, "").replace(secondary, "");

            const axisA = toVec3Literal(unwrapSpaceable(p.customAxisA, "vector"));
            const axisB = toVec3Literal(unwrapSpaceable(p.customAxisB, "vector"));
            const axisASpace = (p._space_customAxisA as string) || "Local";
            const axisBSpace = (p._space_customAxisB as string) || "Local";
            const srcA = (p.axisSourceA as string) || "static"; // 主轴来源
            const srcB = (p.axisSourceB as string) || "static"; // 次轴来源
            const perParticle = srcA !== "static" || srcB !== "static";

            if (!perParticle) {
                // ── 旧路径：两轴均为静态字面量 ──
                const primaryExpr = axisASpace === "World" ? `mat3(u_InvEmitterWorldMatrix) * ${axisA}` : axisA;
                const secondaryExpr = axisBSpace === "World" ? `mat3(u_InvEmitterWorldMatrix) * ${axisB}` : axisB;
                lines.push(`${indent}vec3 _primary = normalize(${primaryExpr});`);
                lines.push(`${indent}vec3 _secondaryIn = normalize(${secondaryExpr});`);
                lines.push(`${indent}vec3 _third = normalize(cross(_primary, _secondaryIn));`);
                lines.push(`${indent}vec3 _secondary = cross(_third, _primary);`);
                const mapping: Record<string, string> = {};
                mapping[primary] = "_primary";
                mapping[secondary] = "_secondary";
                mapping[third] = "_third";
                lines.push(`${indent}vec3 _orientX = ${mapping["X"]};`);
                lines.push(`${indent}vec3 _orientY = ${mapping["Y"]};`);
                lines.push(`${indent}vec3 _orientZ = ${mapping["Z"]};`);
                break;
            }

            // ── 逐粒子路径：严格套 Unity Orient.cs Advanced 数学 ──
            //   axis[primary]   = normalize(P)
            //   axis[third]     = normalize(cross(S, P))            // Unity: axisX = cross(AxisY, AxisZ)
            //   axis[secondary] = cross(axis[primary], axis[third]) // Unity: axisY = cross(axisZ, axisX)
            // 与已验证的 "Along Velocity" ZY 分支同源公式（cross 的 LHS/RHS 符号差异由 axisMat→四元数一致吸收）。
            const velLocal = () => {
                const vel = attrNames.has("velocity") ? "p.velocity" : "vec3(0.0, 1.0, 0.0)";
                return (isWorld && attrNames.has("velocity")) ? `mat3(u_InvEmitterWorldMatrix) * ${vel}` : vel;
            };
            const centerA = toVec3Literal(unwrapSpaceable(p.axisCenterA, "position"));
            const centerB = toVec3Literal(unwrapSpaceable(p.axisCenterB, "position"));
            const resolve = (src: string, staticLit: string, staticSpace: string, center: string): string => {
                if (src === "velocity") return velLocal();
                if (src === "position") return `(${pos} - ${center})`; // 径向法线 = position - center
                return staticSpace === "World" ? `mat3(u_InvEmitterWorldMatrix) * ${staticLit}` : staticLit;
            };
            const Pexpr = resolve(srcA, axisA, axisASpace, centerA); // 主轴 axes[0]
            const Sexpr = resolve(srcB, axisB, axisBSpace, centerB); // 次轴 axes[1]
            lines.push(`${indent}vec3 _pIn = ${Pexpr};`);
            lines.push(`${indent}vec3 _sIn = ${Sexpr};`);
            lines.push(`${indent}float _pLen = length(_pIn);`);
            lines.push(`${indent}vec3 _oPrimary = (_pLen > 1e-5) ? _pIn / _pLen : vec3(0.0, 0.0, 1.0);`);
            // ⚠先归一化次轴(如 velocity)：对齐 Unity normalize(cross(AxisY,AxisZ)) 语义——
            //   即使 velocity 接近径向/幅值很小，其微小垂直分量也被 normalize 放大成完整 tip 方向。
            //   否则按 cross 绝对长度判阈会把这些粒子误落到 world-up 兜底 → 三角尖全部朝上、失去随机。
            lines.push(`${indent}float _sLen = length(_sIn);`);
            lines.push(`${indent}vec3 _sDir = (_sLen > 1e-5) ? _sIn / _sLen : vec3(0.0, 1.0, 0.0);`);
            lines.push(`${indent}vec3 _cx = cross(_sDir, _oPrimary);`);
            lines.push(`${indent}float _cxLen = length(_cx);`);   // = sin(夹角) ∈ [0,1]
            lines.push(`${indent}vec3 _oThird = (_cxLen > 1e-4) ? _cx / _cxLen : normalize(cross(vec3(0.0, 1.0, 0.0), _oPrimary));`);
            lines.push(`${indent}vec3 _oSecondary = cross(_oPrimary, _oThird);`);
            const mapping: Record<string, string> = {};
            mapping[primary] = "_oPrimary";
            mapping[third] = "_oThird";
            mapping[secondary] = "_oSecondary";
            lines.push(`${indent}vec3 _orientX = ${mapping["X"]};`);
            lines.push(`${indent}vec3 _orientY = ${mapping["Y"]};`);
            lines.push(`${indent}vec3 _orientZ = ${mapping["Z"]};`);
            break;
        }
    }

    return lines;
}

// ─── writeRenderData ──────────────────────────────────

/** 生成 writeRenderData 函数，根据 Particle 是否包含对应属性决定读取或使用默认值 */
function genWriteRenderData(attrNames: Set<string>, hasOrient: boolean): string {
    const pos = attrNames.has("position") ? "p.position" : ATTR_DEFAULTS.position;
    const colorRGB = attrNames.has("color") ? "p.color" : ATTR_DEFAULTS.color;
    const alpha = attrNames.has("alpha") ? "p.alpha" : ATTR_DEFAULTS.alpha;
    const size = attrNames.has("size") ? "p.size" : ATTR_DEFAULTS.size;
    const scale = attrNames.has("scale") ? "p.scale" : ATTR_DEFAULTS.scale;
    const angle = attrNames.has("angle") ? "p.angle" : ATTR_DEFAULTS.angle;
    const pivot = attrNames.has("pivot") ? "p.pivot" : ATTR_DEFAULTS.pivot;
    const texIndex = attrNames.has("texIndex") ? "p.texIndex" : ATTR_DEFAULTS.texIndex;

    // When orient block is present, axes come from _orientX/Y/Z locals (set before this call)
    const axisX = hasOrient ? "_orientX" : (attrNames.has("axisX") ? "p.axisX" : ATTR_DEFAULTS.axisX);
    const axisY = hasOrient ? "_orientY" : (attrNames.has("axisY") ? "p.axisY" : ATTR_DEFAULTS.axisY);
    const axisZ = hasOrient ? "_orientZ" : (attrNames.has("axisZ") ? "p.axisZ" : ATTR_DEFAULTS.axisZ);

    let ageExpr: string;
    if (attrNames.has("age") && attrNames.has("lifetime")) {
        ageExpr = "(p.lifetime > 0.0) ? clamp(p.age / p.lifetime, 0.0, 1.0) : 1.0";
    } else {
        ageExpr = "0.0";
    }

    return `\
// RenderBuffer: RENDER_STRIDE vec4s per particle (80 bytes):
//   [0] xyz=position,  w=normalizedAge
//   [1] rgb=color, a=alpha
//   [2] xyzw=rotation (combined quaternion: euler * axis, identity = 0,0,0,1)
//   [3] xyz=scale (size*scale), w=texIndex
//   [4] xyz=pivot, w=reserved
//
// Transform order (applied in vertex shader):
//   1. offset by -pivot
//   2. scale by finalScale
//   3. rotate by combined quaternion (axis orientation, then euler rotation)
//   4. translate to position
void writeRenderData(uint renderIndex, Particle p${hasOrient ? ", vec3 _orientX, vec3 _orientY, vec3 _orientZ" : ""})
{
    float normalizedAge = ${ageExpr};

    // Axis orientation → quaternion
    mat3 axisMat = mat3(${axisX}, ${axisY}, ${axisZ});
    vec4 axisQuat = mat3ToQuat(axisMat);

    // Euler rotation in mesh local space (applied BEFORE axisQuat), 跟 Unity VFX Graph 约定一致：
    //   particle.angle 是 mesh local rotation, axisQuat 把 mesh local 旋转后的几何转到 velocity 朝向
    //   v' = axisQuat * eulerQuat * v * eulerQuat^-1 * axisQuat^-1
    // 之前写的 quatMul(eulerQuat, axisQuat) 让 eulerQuat 在世界空间应用，
    // 让 angle=(180,0,0) 等价于"飞镖绕世界 X 翻 180°"而不是"mesh local +Z↔-Z 翻"
    // 改成 quatMul(axisQuat, eulerQuat) 后 angle 在 mesh local 生效:
    //   - angle=(0,0,0) 时两种顺序结果相同（不影响现有不用 angle 的 sample）
    //   - angle=(0,0,z) 自旋时两种顺序结果也相同（绕 mesh +Z 自旋 ≡ 绕 velocity 自旋）
    //   - angle=(180,0,0) 终于能让 mesh +Z 端跟 -Z 端互换，dart 这种 head/tail 反向能补
    vec4 eulerQuat = eulerToQuat(${angle});
    vec4 rotation = quatMul(axisQuat, eulerQuat);

    vec3 finalScale = vec3(${size}) * ${scale};

    // ⭐2026-06-11 HDR 直通：不再 max-channel 归一化（那是 LDR framebuffer 时代的 crutch——保 chroma
    // 丢强度，让 Unity 的 HDR 红(23.97,0,0)在 additive 下永远压不过低强度橙 → Buff 爆心橙白 vs Unity
    // 饱和红根因）。场景 enableHDR(浮点 framebuffer)下直通才是 Unity 语义；LDR 场景 clip 爆白同样是
    // Unity 行为。仅留安全上限 64 防 Inf/NaN 污染 blend。
    vec3 _writeColor = clamp(${colorRGB}, vec3(0.0), vec3(64.0));

    // ⭐ per-particle 固定随机(0..1) → render data base[4].w(a_AttrPivot.w),供 render shader 做纹理 UV 逐粒子偏移
    //    让每个粒子采样纹理不同区域(对齐 Unity _MainTextureOffset 的 Random 算子 → 雾各自独立飘动,不再一起动)。
    //    用 p.seed(每粒子固定,readParticle 从 base[2].w 读)做自包含整数 hash,不依赖 WangHash 定义顺序。
    //    ⚠粒子结构按 attribute 使用收集,系统不用随机时无 seed 字段(Heal VFX1 编译炸根因)——退化用 renderIndex hash。
${attrNames.has("seed")
    ? `    uint _prh = p.seed;`
    : `    uint _prh = renderIndex * 2654435761u + 1013904223u;`}
    _prh ^= _prh >> 16u; _prh *= 0x7feb352du; _prh ^= _prh >> 15u; _prh *= 0x846ca68bu; _prh ^= _prh >> 16u;
    float _particleRand = float(_prh) / 4294967295.0;

    uint base = renderIndex * RENDER_STRIDE;
    Render.data[base]      = vec4(${pos}, normalizedAge);    // position + normalizedAge
    Render.data[base + 1u] = vec4(_writeColor, ${alpha});      // color (HDR-normalized) + alpha
    Render.data[base + 2u] = rotation;                       // combined rotation quaternion
    Render.data[base + 3u] = vec4(finalScale, ${texIndex});  // scale + texIndex
    Render.data[base + 4u] = vec4(${pivot}, _particleRand);  // pivot + per-particle random(纹理逐粒子偏移源)
}`;
}

/** 生成包围盒计算代码 */
function genBoundsCalc(attrNames: Set<string>): string {
    const pos = attrNames.has("position") ? "p.position" : ATTR_DEFAULTS.position;
    const size = attrNames.has("size") ? "p.size" : ATTR_DEFAULTS.size;
    const scale = attrNames.has("scale") ? "p.scale" : ATTR_DEFAULTS.scale;

    return `\
    // Compute bounding box
    vec3 halfExtent = vec3(${size}) * ${scale} * 0.5;
    vec3 bPos = ${pos};
    atomicMin(Bounds.minX, floatToSortableInt(bPos.x - halfExtent.x));
    atomicMin(Bounds.minY, floatToSortableInt(bPos.y - halfExtent.y));
    atomicMin(Bounds.minZ, floatToSortableInt(bPos.z - halfExtent.z));
    atomicMax(Bounds.maxX, floatToSortableInt(bPos.x + halfExtent.x));
    atomicMax(Bounds.maxY, floatToSortableInt(bPos.y + halfExtent.y));
    atomicMax(Bounds.maxZ, floatToSortableInt(bPos.z + halfExtent.z));`;
}

// ─── setAttribute block code generation for Output ──────────

export function generateOutput(shaderName: string, common: string, attrNames: Set<string>, simulateSpace?: string, blocks?: IVfxBlockData[], contextId?: number, compiler?: VfxExprCompiler): string {
    const isWorld = simulateSpace === "World";
    const orientBlock = findOrientBlock(blocks);
    const orientCamera = orientCameraNeeds(orientBlock);
    // All orient modes are now computed in compute shader
    const computeOrient = !!orientBlock;
    const writeRenderData = genWriteRenderData(attrNames, computeOrient);
    const boundsCalc = genBoundsCalc(attrNames);

    // setAttribute blocks in output context (modify local p before writeRenderData)
    const blockCode = genBlockCode(blocks || [], OUTPUT_BLOCK_OPTS, contextId, compiler, simulateSpace);
    const needSeed = blocksNeedSeed(blocks || [], false);

    // Generate orient code for main() (only for compute-side modes)
    let orientCode = "";
    let orientCallArgs = "";
    if (computeOrient) {
        const orientLines = genOrientCode(orientBlock!, attrNames, "    ", isWorld);
        orientCode = orientLines.join("\n") + "\n";
        orientCallArgs = ", _orientX, _orientY, _orientZ";
    }

    return `\
Shader3D Start
{
    type: ComputeShader,
    name: "${shaderName}",
    uniformMaps: [
        {
            u_Capacity: { type: "Int" },
            u_TotalTime: { type: "Float" },
            u_DeltaTime: { type: "Float" },
            u_EmitterWorldMatrix: { type: "Matrix4x4" },
            u_InvEmitterWorldMatrix: { type: "Matrix4x4" }${orientCamera.pos ? `,
            u_OrientCameraPos: { type: "Vector3" }` : ""}${orientCamera.dir ? `,
            u_OrientCameraDir: { type: "Vector3" }` : ""}${orientCamera.up ? `,
            u_OrientCameraUp: { type: "Vector3" }` : ""}/*VFX_EXTRA_UNIFORMS*/
        }
    ],
    code: "Output_CS"
}
Shader3D End

GLSL Start

#defineGLSL Output_CS

${common}
/*VFX_CURVE_FUNC*/
/*VFX_STORAGE_BUFFERS*/

buffer RenderBuffer
{
    vec4 data[];
}
Render;

struct RenderStruct{
    vec3 position;
    float normalizedAge;
    vec4 color;
    vec4 rotation;
    vec3 scale;
    float texIndex;
    vec3 pivot;
    float _reserved;
};

${QUAT_HELPERS}

${writeRenderData}

buffer IndirectBuffer
{
    uint count;
    uint instanceCount;
    uint firstInstance;
    uint baseVertex;
    uint firstVertex;
}
Indirect;

buffer BoundsBuffer
{
    int minX; int minY; int minZ;
    int maxX; int maxY; int maxZ;
}
Bounds;

#define NB_THREADS_PER_GROUP 64
layout(local_size_x = NB_THREADS_PER_GROUP, local_size_y = 1, local_size_z = 1) in;

void main()
{
    uint aliveIndex = gl_LocalInvocationID.x + gl_WorkGroupID.x * NB_THREADS_PER_GROUP;

    if (aliveIndex >= AliveListRead.count) {
        return;
    }

    uint particleIndex = AliveListRead.indices[aliveIndex];

    Particle p = readParticle(particleIndex);
${needSeed ? `    p.seed = WangHash(p.seed ^ particleIndex);\n` : ""}\
${isWorld && attrNames.has("position") ? `    // World space: convert back to local space (renderer applies worldMatrix)
    p.position = transformPosition(u_InvEmitterWorldMatrix, p.position);
` : ""}${blockCode ? blockCode + "\n" : ""}${orientCode}    writeRenderData(aliveIndex, p${orientCallArgs});

${boundsCalc}

    if (aliveIndex == 0) {
        Indirect.instanceCount = AliveListRead.count;
    }
}

#endGLSL

GLSL End`;
}
