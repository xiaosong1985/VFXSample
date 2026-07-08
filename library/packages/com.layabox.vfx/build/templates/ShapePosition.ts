/**
 * Set Position (Shape) — GLSL 代码生成
 *
 * 支持形状: Sphere, Box, Cone, Torus, Circle, Line
 * 每种形状生成 _shapePos (vec3) 和 _shapeDir (vec3)，
 * 然后根据 composition 应用到 particle.position / particle.direction
 */

import type { IVfxBlockData } from "../../data/VfxTypes";
import type { VfxExprCompiler } from "../VfxExprCompiler";

// ─── 工具函数 ───────────────────────────────────────

function toFloat(v: number | undefined, fallback: number): string {
    const n = v ?? fallback;
    const s = String(n);
    return s.includes(".") ? s : s + ".0";
}

/** 从 vec3 对象属性 { x, y, z } 读取 GLSL vec3 字面量 */
function readVec3(props: Record<string, any>, name: string, dx: number, dy: number, dz: number): string {
    const v = props[name] || {};
    const x = toFloat(v.x, dx);
    const y = toFloat(v.y, dy);
    const z = toFloat(v.z, dz);
    return `vec3(${x}, ${y}, ${z})`;
}

function applyComp(lines: string[], pVar: string, attr: string, expr: string, comp: string, indent: string): void {
    switch (comp) {
        case "Add":
            lines.push(`${indent}${pVar}.${attr} += ${expr};`);
            break;
        case "Multiply":
            lines.push(`${indent}${pVar}.${attr} *= ${expr};`);
            break;
        case "Blend":
            lines.push(`${indent}${pVar}.${attr} = mix(${pVar}.${attr}, ${expr}, 0.5);`);
            break;
        default: // Overwrite
            lines.push(`${indent}${pVar}.${attr} = ${expr};`);
            break;
    }
}

/** 根据 applyOrientation flag 生成 direction 和 axes 赋值代码 */
function applyOrientation(lines: string[], pVar: string, p: Record<string, any>, indent: string): void {
    const flags = (p.applyOrientation as number) ?? 0b01;
    const applyDir = !!(flags & 1);
    const applyAxes = !!(flags & 2);

    if (applyDir) {
        const dirComp = (p.directionComposition as string) || "Overwrite";
        applyComp(lines, pVar, "direction", "_shapeDir", dirComp, indent);
    }

    if (applyAxes) {
        const axesComp = (p.axesComposition as string) || "Overwrite";
        // Derive local coordinate frame from _shapeDir
        // axisZ = _shapeDir (outward normal), compute axisX/Y via cross products
        lines.push(`${indent}vec3 _axisZ = _shapeDir;`);
        lines.push(`${indent}vec3 _up = abs(_axisZ.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);`);
        lines.push(`${indent}vec3 _axisX = normalize(cross(_up, _axisZ));`);
        lines.push(`${indent}vec3 _axisY = cross(_axisZ, _axisX);`);
        applyComp(lines, pVar, "axisX", "_axisX", axesComp, indent);
        applyComp(lines, pVar, "axisY", "_axisY", axesComp, indent);
        applyComp(lines, pVar, "axisZ", "_axisZ", axesComp, indent);
    }
}

// ─── 形状 GLSL 生成器 ───────────────────────────────

/** Spawn mode options — Custom replaces specific Rand() calls with sequencer values */
interface SpawnOpts {
    custom: boolean;       // true when spawnMode === "Custom"
    arcSeq: string;        // GLSL literal for arc sequencer (0~1)
    heightSeq: string;     // GLSL literal for height sequencer (0~1)
    lineSeq: string;       // GLSL literal for line sequencer (0~1)
    perStripRand?: boolean; // true: 一条 strip 内所有粒子用同一 random t（用 stripIndex 作 hash seed）
                            // 对齐 Unity Random Float (Per Particle Strip) 模式
    perStripSeed?: number;  // 真实 Unity 接 op 的 seed 值（让 Laya hash 跟 Unity 一致）
    hasStripIndex?: boolean; // 系统是否 strip(useStripRingBuffer)。false 时 perStripRand 退化用 spawnIndex——
                             // 非 strip 系统没有 stripIndex 字段,硬用会 'stripIndex' undeclared 编译报错(OrientFixedAxis)。
}

const PI2 = "6.28318530718";

/**
 * Generate GLSL for radial sampling with CalculateVolumeFactor pattern.
 * Outputs `float _R;` — normalized radius factor in [0,1].
 * @param dims 3 for Sphere, 2 for Circle/Cone/Torus
 * @param radius GLSL expression for the radius used in Thickness Absolute factor calculation
 */
function genRadialSampling(
    lines: string[], indent: string, seed: string,
    mode: string, thickness: string, radius: string, dims: number,
): void {
    if (mode === "Surface") {
        lines.push(`${indent}float _R = 1.0;`);
    } else if (mode === "Volume") {
        if (dims === 3) {
            lines.push(`${indent}float _R = pow(Rand(${seed}), 0.333333);`);
        } else {
            lines.push(`${indent}float _R = sqrt(Rand(${seed}));`);
        }
    } else {
        // Thickness Absolute or Relative
        if (mode === "Thickness Absolute") {
            lines.push(`${indent}float _factor = clamp(${thickness} / ${radius}, 0.0, 1.0);`);
        } else {
            lines.push(`${indent}float _factor = clamp(${thickness}, 0.0, 1.0);`);
        }
        lines.push(`${indent}float _vf = pow(1.0 - _factor, ${toFloat(dims, dims)});`);
        if (dims === 3) {
            lines.push(`${indent}float _R = pow(_vf + (1.0 - _vf) * Rand(${seed}), 0.333333);`);
        } else {
            lines.push(`${indent}float _R = sqrt(_vf + (1.0 - _vf) * Rand(${seed}));`);
        }
    }
}

/** Sphere (fallback): reads from arcSphere composite { sphere: { transform, radius }, arc }
 *  应用 transform.angles/scale 到 _shapePos 和 _shapeDir，对齐 Unity arc sphere transform 行为
 *  （MultiStripSingleBurst sphere 用 scale (0.0001, 1, 1) + angles (0,0,90) 把球压扁成 yz 平面圆，
 *  之前只读 transform.position 让 50 粒子在完整 unit sphere 上散开 + line 加 random y → strip
 *  ribbon 顶点位置乱跳形成锯齿三角形）*/
const genSphereFallback = (p: Record<string, any>, pVar: string, indent: string, mode: string, thickness: string = "0.1", spawn?: SpawnOpts) => {
    const as = (p.arcSphere as Record<string, any>) || {};
    const sp = (as.sphere as Record<string, any>) || {};
    const tf = (sp.transform as Record<string, any>) || {};
    const tfPos = (tf.position as Record<string, any>) || {};
    const tfAng = (tf.angles as Record<string, any>) || {};
    const tfScl = (tf.scale as Record<string, any>) || {};
    const px = toFloat(tfPos.x, 0), py = toFloat(tfPos.y, 0), pz = toFloat(tfPos.z, 0);
    const ax = toFloat(tfAng.x, 0), ay = toFloat(tfAng.y, 0), az = toFloat(tfAng.z, 0);
    const sx = toFloat(tfScl.x, 1), sy = toFloat(tfScl.y, 1), sz = toFloat(tfScl.z, 1);
    const radius = toFloat(sp.radius, 1);
    const arc = toFloat(as.arc, 6.2831853);
    const seed = `${pVar}.seed`;
    const arcSrc = spawn?.custom ? spawn.arcSeq : `Rand(${seed})`;
    const heightSrc = spawn?.custom ? spawn.heightSeq : `Rand(${seed})`;
    const hasNonIdentity = (ax !== "0.0" || ay !== "0.0" || az !== "0.0" || sx !== "1.0" || sy !== "1.0" || sz !== "1.0");

    const lines: string[] = [];
    lines.push(`${indent}float _theta = ${arcSrc} * ${arc};`);
    lines.push(`${indent}float _cosPhi = mix(-1.0, 1.0, ${heightSrc});`);
    lines.push(`${indent}float _sinPhi = sqrt(1.0 - _cosPhi * _cosPhi);`);
    lines.push(`${indent}vec3 _shapeDir = vec3(_sinPhi * cos(_theta), _cosPhi, _sinPhi * sin(_theta));`);
    genRadialSampling(lines, indent, seed, mode, thickness, radius, 3);
    if (hasNonIdentity) {
        lines.push(`${indent}vec3 _shapePos = _shapeDir * (${radius} * _R);`);
        lines.push(`${indent}mat4 _sphereTRS = BuildTRS(vec3(${px}, ${py}, ${pz}), radians(vec3(${ax}, ${ay}, ${az})), vec3(${sx}, ${sy}, ${sz}));`);
        lines.push(`${indent}_shapePos = (_sphereTRS * vec4(_shapePos, 1.0)).xyz;`);
        lines.push(`${indent}_shapeDir = normalize(mat3(_sphereTRS) * _shapeDir);`);
    } else {
        lines.push(`${indent}vec3 _shapePos = vec3(${px}, ${py}, ${pz}) + _shapeDir * (${radius} * _R);`);
    }
    return lines;
};

/** Sphere (compiled): uses compiled arcSphere expression (already space-converted by compiler) */
function genSphereCompiled(compiledExpr: string, compiledStmts: string[], pVar: string, indent: string, mode: string, thickness: string = "0.1", spawn?: SpawnOpts): string[] {
    const seed = `${pVar}.seed`;
    const lines: string[] = [];
    const arcSrc = spawn?.custom ? spawn.arcSeq : `Rand(${seed})`;
    const heightSrc = spawn?.custom ? spawn.heightSeq : `Rand(${seed})`;

    for (const s of compiledStmts) lines.push(`${indent}${s}`);

    lines.push(`${indent}VFXArcSphere _as = ${compiledExpr};`);
    lines.push(`${indent}float _radius = _as.sphere.radius;`);
    lines.push(`${indent}float _arc = _as.arc;`);
    lines.push(`${indent}vec3 _center = _as.sphere.transform[3].xyz;`);

    lines.push(`${indent}float _theta = ${arcSrc} * _arc;`);
    lines.push(`${indent}float _cosPhi = mix(-1.0, 1.0, ${heightSrc});`);
    lines.push(`${indent}float _sinPhi = sqrt(1.0 - _cosPhi * _cosPhi);`);
    lines.push(`${indent}vec3 _shapeDir = vec3(_sinPhi * cos(_theta), _cosPhi, _sinPhi * sin(_theta));`);
    genRadialSampling(lines, indent, seed, mode, thickness, "_radius", 3);
    lines.push(`${indent}vec3 _shapePos = _center + _shapeDir * (_radius * _R);`);
    return lines;
}

/** Box (OrientedBox): reads from orientedBox composite { center, angle, size } */
const genBoxFallback = (p: Record<string, any>, pVar: string, indent: string, mode: string, thickness: string = "0.1") => {
    const ob = (p.orientedBox as Record<string, any>) || {};
    const center = readVec3(ob, "center", 0, 0, 0);
    const angle = readVec3(ob, "angle", 0, 0, 0);
    const size = readVec3(ob, "size", 1, 1, 1);
    return genBoxCore(center, size, angle, pVar, indent, mode, thickness);
};

/** Box (compiled): uses compiled orientedBox expression */
function genBoxCompiled(compiledExpr: string, compiledStmts: string[], pVar: string, indent: string, mode: string, thickness: string = "0.1"): string[] {
    const lines: string[] = [];
    for (const s of compiledStmts) lines.push(`${indent}${s}`);
    lines.push(`${indent}VFXOrientedBox _box = ${compiledExpr};`);
    return [...lines, ...genBoxCore("_box.center", "_box.size", "_box.angle", pVar, indent, mode, thickness)];
}

/** Box core GLSL generation (shared by fallback and compiled paths) */
function genBoxCore(center: string, size: string, angle: string, pVar: string, indent: string, mode: string, thickness: string = "0.1"): string[] {
    const seed = `${pVar}.seed`;
    const lines: string[] = [];

    // Build rotation matrix from euler angles (radians, YXZ order)
    lines.push(`${indent}mat3 _boxRot = mat3(BuildTRS(vec3(0.0), radians(${angle}), vec3(1.0)));`);

    if (mode === "Volume") {
        lines.push(`${indent}vec3 _local = vec3(Rand(${seed}) - 0.5, Rand(${seed}) - 0.5, Rand(${seed}) - 0.5);`);
        lines.push(`${indent}vec3 _shapePos = ${center} + _boxRot * (_local * ${size});`);
        // Face-aligned direction: 用 if/else 代替嵌套三元（避免 WGSL 后端转换 bug）
        lines.push(`${indent}vec3 _absL = abs(_local);`);
        lines.push(`${indent}vec3 _localDir;`);
        lines.push(`${indent}if (_absL.x >= _absL.y && _absL.x >= _absL.z) {`);
        lines.push(`${indent}    _localDir = vec3(_local.x >= 0.0 ? 1.0 : -1.0, 0.0, 0.0);`);
        lines.push(`${indent}} else if (_absL.y >= _absL.z) {`);
        lines.push(`${indent}    _localDir = vec3(0.0, _local.y >= 0.0 ? 1.0 : -1.0, 0.0);`);
        lines.push(`${indent}} else {`);
        lines.push(`${indent}    _localDir = vec3(0.0, 0.0, _local.z >= 0.0 ? 1.0 : -1.0);`);
        lines.push(`${indent}}`);
        lines.push(`${indent}vec3 _shapeDir = _boxRot * _localDir;`);
    } else if (mode === "Surface") {
        // Surface: pick random face, then random point on that face
        lines.push(`${indent}float _face = floor(Rand(${seed}) * 6.0);`);
        lines.push(`${indent}float _u = Rand(${seed}) - 0.5;`);
        lines.push(`${indent}float _v = Rand(${seed}) - 0.5;`);
        lines.push(`${indent}vec3 _local = vec3(0.0);`);
        lines.push(`${indent}vec3 _localDir = vec3(0.0);`);
        lines.push(`${indent}if (_face < 1.0)      { _local = vec3( 0.5, _u, _v); _localDir = vec3( 1.0, 0.0, 0.0); }`);
        lines.push(`${indent}else if (_face < 2.0)  { _local = vec3(-0.5, _u, _v); _localDir = vec3(-1.0, 0.0, 0.0); }`);
        lines.push(`${indent}else if (_face < 3.0)  { _local = vec3(_u,  0.5, _v); _localDir = vec3( 0.0, 1.0, 0.0); }`);
        lines.push(`${indent}else if (_face < 4.0)  { _local = vec3(_u, -0.5, _v); _localDir = vec3( 0.0,-1.0, 0.0); }`);
        lines.push(`${indent}else if (_face < 5.0)  { _local = vec3(_u, _v,  0.5); _localDir = vec3( 0.0, 0.0, 1.0); }`);
        lines.push(`${indent}else                   { _local = vec3(_u, _v, -0.5); _localDir = vec3( 0.0, 0.0,-1.0); }`);
        lines.push(`${indent}vec3 _shapePos = ${center} + _boxRot * (_local * ${size});`);
        lines.push(`${indent}vec3 _shapeDir = _boxRot * _localDir;`);
    } else {
        // Thickness Absolute / Relative — slab decomposition
        lines.push(`${indent}vec3 _bSize = ${size};`);
        if (mode === "Thickness Absolute") {
            lines.push(`${indent}vec3 _fac = clamp(vec3(${thickness} * 2.0), vec3(0.0), _bSize);`);
        } else {
            lines.push(`${indent}vec3 _fac = clamp(vec3(${thickness}), vec3(0.0), vec3(1.0)) * _bSize;`);
        }
        // Normalized half-thickness per axis (in [-0.5,0.5] space)
        lines.push(`${indent}vec3 _hf = _fac / max(_bSize, vec3(0.001)) * 0.5;`);
        // 3 slab-pair volumes (non-overlapping decomposition)
        lines.push(`${indent}float _vXY = _bSize.x * _bSize.y * _fac.z;`);
        lines.push(`${indent}float _vXZ = _bSize.x * max(_bSize.z - _fac.z, 0.0) * _fac.y;`);
        lines.push(`${indent}float _vYZ = max(_bSize.y - _fac.y, 0.0) * max(_bSize.z - _fac.z, 0.0) * _fac.x;`);
        lines.push(`${indent}float _vTotal = max(_vXY + _vXZ + _vYZ, 0.0001);`);
        lines.push(`${indent}float _sel = Rand(${seed}) * _vTotal;`);
        lines.push(`${indent}vec3 _local;`);
        lines.push(`${indent}vec3 _localDir;`);
        // Z-face slab: full XY, thin Z at edges
        lines.push(`${indent}if (_sel < _vXY) {`);
        lines.push(`${indent}    float _side = Rand(${seed}) < 0.5 ? 1.0 : -1.0;`);
        lines.push(`${indent}    _local = vec3(Rand(${seed}) - 0.5, Rand(${seed}) - 0.5, _side * (0.5 - Rand(${seed}) * _hf.z));`);
        lines.push(`${indent}    _localDir = vec3(0.0, 0.0, _side);`);
        // Y-face slab: full X, Z excluding corners, thin Y
        lines.push(`${indent}} else if (_sel < _vXY + _vXZ) {`);
        lines.push(`${indent}    float _side = Rand(${seed}) < 0.5 ? 1.0 : -1.0;`);
        lines.push(`${indent}    float _zRange = 1.0 - 2.0 * _hf.z;`);
        lines.push(`${indent}    _local = vec3(Rand(${seed}) - 0.5, _side * (0.5 - Rand(${seed}) * _hf.y), (Rand(${seed}) - 0.5) * _zRange);`);
        lines.push(`${indent}    _localDir = vec3(0.0, _side, 0.0);`);
        // X-face slab: Y and Z excluding corners, thin X
        lines.push(`${indent}} else {`);
        lines.push(`${indent}    float _side = Rand(${seed}) < 0.5 ? 1.0 : -1.0;`);
        lines.push(`${indent}    float _yRange = 1.0 - 2.0 * _hf.y;`);
        lines.push(`${indent}    float _zRange = 1.0 - 2.0 * _hf.z;`);
        lines.push(`${indent}    _local = vec3(_side * (0.5 - Rand(${seed}) * _hf.x), (Rand(${seed}) - 0.5) * _yRange, (Rand(${seed}) - 0.5) * _zRange);`);
        lines.push(`${indent}    _localDir = vec3(_side, 0.0, 0.0);`);
        lines.push(`${indent}}`);
        lines.push(`${indent}vec3 _shapePos = ${center} + _boxRot * (_local * _bSize);`);
        lines.push(`${indent}vec3 _shapeDir = _boxRot * _localDir;`);
    }
    return lines;
}

/** Cone (fallback): reads from arcCone composite { cone: { transform, baseRadius, topRadius, height }, arc } */
const genConeFallback = (p: Record<string, any>, pVar: string, indent: string, mode: string, heightMode: string = "Volume", thickness: string = "0.1", spawn?: SpawnOpts) => {
    const ac = (p.arcCone as Record<string, any>) || {};
    const cn = (ac.cone as Record<string, any>) || {};
    const tf = (cn.transform as Record<string, any>) || {};
    const center = readVec3(tf, "position", 0, 0, 0);
    const baseR = toFloat(cn.baseRadius, 1);
    const topR = toFloat(cn.topRadius, 0);
    const height = toFloat(cn.height, 1);
    const arc = toFloat(ac.arc, 6.2831853);
    return genConeCore(center, baseR, topR, height, arc, pVar, indent, mode, heightMode, thickness, spawn);
};

/** Cone (compiled): uses compiled arcCone expression */
function genConeCompiled(compiledExpr: string, compiledStmts: string[], pVar: string, indent: string, mode: string, heightMode: string = "Volume", thickness: string = "0.1", spawn?: SpawnOpts): string[] {
    const lines: string[] = [];
    for (const s of compiledStmts) lines.push(`${indent}${s}`);
    lines.push(`${indent}VFXArcCone _ac = ${compiledExpr};`);
    return [...lines, ...genConeCore("_ac.cone.transform[3].xyz", "_ac.cone.baseRadius", "_ac.cone.topRadius", "_ac.cone.height", "_ac.arc", pVar, indent, mode, heightMode, thickness, spawn)];
}

/** Cone core GLSL generation (shared by fallback and compiled paths) */
function genConeCore(center: string, baseR: string, topR: string, height: string, arc: string, pVar: string, indent: string, mode: string, heightMode: string = "Volume", thickness: string = "0.1", spawn?: SpawnOpts): string[] {
    const seed = `${pVar}.seed`;
    const arcSrc = spawn?.custom ? spawn.arcSeq : `Rand(${seed})`;
    const lines: string[] = [];
    lines.push(`${indent}float _theta = ${arcSrc} * ${arc};`);
    if (heightMode === "Base") {
        lines.push(`${indent}float _t = 0.0;`);
    } else if (spawn?.custom) {
        // Custom: linear height mapping
        lines.push(`${indent}float _t = ${spawn.heightSeq};`);
    } else {
        lines.push(`${indent}float _t = Rand(${seed});`);
    }
    lines.push(`${indent}float _rMax = mix(${baseR}, ${topR}, _t);`);
    // Cone uses dims=2, radius=baseRadius for CalculateVolumeFactor
    genRadialSampling(lines, indent, seed, mode, thickness, baseR, 2);
    lines.push(`${indent}float _r = _rMax * _R;`);
    lines.push(`${indent}float _cosT = cos(_theta);`);
    lines.push(`${indent}float _sinT = sin(_theta);`);
    lines.push(`${indent}vec3 _shapePos = ${center} + vec3(_r * _cosT, _t * ${height}, _r * _sinT);`);
    // Direction: outward radial (perpendicular to cone slant)
    lines.push(`${indent}float _dr = ${baseR} - ${topR};`);
    lines.push(`${indent}vec3 _shapeDir = normalize(vec3(_cosT * ${height}, _dr, _sinT * ${height}));`);
    return lines;
}

/** Torus (fallback): reads from arcTorus composite { torus: { transform, majorRadius, minorRadius }, arc } */
const genTorusFallback = (p: Record<string, any>, pVar: string, indent: string, mode: string, thickness: string = "0.1", spawn?: SpawnOpts) => {
    const at = (p.arcTorus as Record<string, any>) || {};
    const tr = (at.torus as Record<string, any>) || {};
    const tf = (tr.transform as Record<string, any>) || {};
    const center = readVec3(tf, "position", 0, 0, 0);
    const majorR = toFloat(tr.majorRadius, 1);
    const minorR = toFloat(tr.minorRadius, 0.3);
    const arc = toFloat(at.arc, 6.2831853);
    return genTorusCore(center, majorR, minorR, arc, pVar, indent, mode, thickness, spawn);
};

/** Torus (compiled): uses compiled arcTorus expression */
function genTorusCompiled(compiledExpr: string, compiledStmts: string[], pVar: string, indent: string, mode: string, thickness: string = "0.1", spawn?: SpawnOpts): string[] {
    const lines: string[] = [];
    for (const s of compiledStmts) lines.push(`${indent}${s}`);
    lines.push(`${indent}VFXArcTorus _at = ${compiledExpr};`);
    return [...lines, ...genTorusCore("_at.torus.transform[3].xyz", "_at.torus.majorRadius", "_at.torus.minorRadius", "_at.arc", pVar, indent, mode, thickness, spawn)];
}

/** Torus core GLSL generation (shared by fallback and compiled paths) */
function genTorusCore(center: string, majorR: string, minorR: string, arc: string, pVar: string, indent: string, mode: string, thickness: string = "0.1", spawn?: SpawnOpts): string[] {
    const seed = `${pVar}.seed`;
    const arcSrc = spawn?.custom ? spawn.arcSeq : `Rand(${seed})`;
    const heightSrc = spawn?.custom ? spawn.heightSeq : `Rand(${seed})`;

    const lines: string[] = [];
    lines.push(`${indent}float _theta = ${arcSrc} * ${arc};`);
    lines.push(`${indent}float _phi = ${heightSrc} * ${PI2};`);
    // Torus uses dims=2, radius=majorRadius for CalculateVolumeFactor
    genRadialSampling(lines, indent, seed, mode, thickness, majorR, 2);
    lines.push(`${indent}float _rTube = ${minorR} * _R;`);
    lines.push(`${indent}float _cosPhi = cos(_phi);`);
    lines.push(`${indent}float _sinPhi = sin(_phi);`);
    lines.push(`${indent}float _Rmaj = ${majorR} + _rTube * _cosPhi;`);
    lines.push(`${indent}vec3 _shapePos = ${center} + vec3(_Rmaj * sin(_theta), _Rmaj * cos(_theta), _rTube * _sinPhi);`);
    lines.push(`${indent}vec3 _shapeDir = normalize(vec3(_cosPhi * sin(_theta), _cosPhi * cos(_theta), _sinPhi));`);
    return lines;
}

/** Circle (fallback): reads from arcCircle composite { circle: { transform, radius }, arc } — XY plane
 *  应用 transform.angles/scale 到 _shapePos 和 _shapeDir，对齐 Unity arc circle transform 行为
 *  (例如 angles=(90,0,0) 让圆面绕 X 轴翻 90 度变成 XZ 水平平面) */
const genCircleFallback = (p: Record<string, any>, pVar: string, indent: string, mode: string, thickness: string = "0.1", spawn?: SpawnOpts, radiusOverride?: string) => {
    const ac = (p.arcCircle as Record<string, any>) || {};
    const cr = (ac.circle as Record<string, any>) || {};
    const tf = (cr.transform as Record<string, any>) || {};
    const tfPos = (tf.position as Record<string, any>) || {};
    const tfAng = (tf.angles as Record<string, any>) || {};
    const tfScl = (tf.scale as Record<string, any>) || {};
    const px = toFloat(tfPos.x, 0), py = toFloat(tfPos.y, 0), pz = toFloat(tfPos.z, 0);
    const ax = toFloat(tfAng.x, 0), ay = toFloat(tfAng.y, 0), az = toFloat(tfAng.z, 0);
    const sx = toFloat(tfScl.x, 1), sy = toFloat(tfScl.y, 1), sz = toFloat(tfScl.z, 1);
    // 算子驱动半径优先（Unity randomNumber → circle.radius），否则用内联字面量
    const radius = radiusOverride || toFloat(cr.radius, 1);
    const arc = toFloat(ac.arc, 6.2831853);
    // 直接用 BuildTRS 构造 transform，Circle 在 local XY 平面生成后用 _circleTRS 变换
    const lines: string[] = [];
    const hasNonIdentity = (ax !== "0.0" || ay !== "0.0" || az !== "0.0" || sx !== "1.0" || sy !== "1.0" || sz !== "1.0");
    if (hasNonIdentity) {
        // 在 local 圆生成后用 BuildTRS 变换 position 和 direction（angles 单位是度，需要转弧度）
        lines.push(`${indent}mat4 _circleTRS = BuildTRS(vec3(${px}, ${py}, ${pz}), radians(vec3(${ax}, ${ay}, ${az})), vec3(${sx}, ${sy}, ${sz}));`);
        const coreLines = genCircleCore("vec3(0.0)", radius, arc, pVar, indent, mode, thickness, spawn);
        lines.push(...coreLines);
        lines.push(`${indent}_shapePos = (_circleTRS * vec4(_shapePos, 1.0)).xyz;`);
        lines.push(`${indent}_shapeDir = normalize((mat3(_circleTRS) * _shapeDir));`);
        return lines;
    }
    return genCircleCore(`vec3(${px}, ${py}, ${pz})`, radius, arc, pVar, indent, mode, thickness, spawn);
};

/** Circle (compiled): uses compiled arcCircle expression */
function genCircleCompiled(compiledExpr: string, compiledStmts: string[], pVar: string, indent: string, mode: string, thickness: string = "0.1", spawn?: SpawnOpts): string[] {
    const lines: string[] = [];
    for (const s of compiledStmts) lines.push(`${indent}${s}`);
    lines.push(`${indent}VFXArcCircle _ac = ${compiledExpr};`);
    return [...lines, ...genCircleCore("_ac.circle.transform[3].xyz", "_ac.circle.radius", "_ac.arc", pVar, indent, mode, thickness, spawn)];
}

/** Circle core GLSL generation — XY plane, arc starts from +Y
 * 注: Unity PositionCircle.cs 默认 Circle 在 XZ plane (transform identity axisX/Z)，
 * 但 VFX 中常配 TransformPosition operator + Rx(90°) rotation 把 ring 旋转到 XY plane (大多 effect 实际用 XY plane)
 * Laya 转换器目前漏读 TransformPosition operator chain, 直接 emit XY plane 简化跟 Unity 最常见配置一致
 */
function genCircleCore(center: string, radius: string, arc: string, pVar: string, indent: string, mode: string, thickness: string = "0.1", spawn?: SpawnOpts): string[] {
    const seed = `${pVar}.seed`;
    // perStripRand: 用 stripIndex 派生 hash seed → 同一 strip 内所有粒子用同一 t（径向尾迹）
    // 对齐 Unity arcSequencer ← Random Float (Per Particle Strip) 的语义
    // perStripSeed 是 Unity Random op 的 seed 值，hardcode fallback 用 0xC0FFEE 兼容旧路径
    const stripHashSeed = (spawn?.perStripSeed != null) ? `${spawn.perStripSeed >>> 0}u` : "0xC0FFEEu";
    // perStripRand 的 hash 种子:strip 系统用 stripIndex(同 strip 同 t);非 strip 系统没有 stripIndex 字段,
    // 退化用 spawnIndex(每粒子稳定唯一)——否则 'stripIndex' undeclared 编译报错(OrientFixedAxis Circle)。
    const perStripSeedField = spawn?.hasStripIndex ? `${pVar}.stripIndex` : `${pVar}.spawnIndex`;
    const arcSrc = spawn?.custom
        ? (spawn.perStripRand ? `(float(WangHash(${perStripSeedField} + ${stripHashSeed})) / 4294967295.0)` : spawn.arcSeq)
        : `Rand(${seed})`;
    const lines: string[] = [];
    lines.push(`${indent}float _theta = ${arcSrc} * ${arc};`);
    lines.push(`${indent}vec3 _shapeDir = vec3(sin(_theta), cos(_theta), 0.0);`);
    genRadialSampling(lines, indent, seed, mode, thickness, radius, 2);
    lines.push(`${indent}vec3 _shapePos = ${center} + _shapeDir * (${radius} * _R);`);
    return lines;
}

/** Line (fallback): reads from line composite { start, end } */
const genLineFallback = (p: Record<string, any>, pVar: string, indent: string, _mode: string, _thickness?: string, spawn?: SpawnOpts) => {
    const ln = (p.line as Record<string, any>) || {};
    const start = readVec3(ln, "start", 0, 0, 0);
    const end = readVec3(ln, "end", 0, 1, 0);
    return genLineCore(start, end, pVar, indent, spawn);
};

/** Plane (fallback): center + normal + size(2D) → 随机矩形平面采样（Unity Set Position Random Planar） */
const genPlaneFallback = (p: Record<string, any>, pVar: string, indent: string, _mode: string) => {
    const cRaw = (p.planeCenter as any)?.pos || p.planeCenter || { x: 0, y: 0, z: 0 };
    const nRaw = (p.planeNormal as any)?.direction || p.planeNormal || { x: 0, y: 1, z: 0 };
    const sRaw = (p.planeSize as any) || { x: 2, y: 2 };
    // JS 阶段：归一化 normal + 构造正交基 u/v
    const nLen = Math.hypot(Number(nRaw.x), Number(nRaw.y), Number(nRaw.z)) || 1;
    const nx = Number(nRaw.x) / nLen, ny = Number(nRaw.y) / nLen, nz = Number(nRaw.z) / nLen;
    // 选和 n 不平行的参考轴做 cross
    const refAxis = Math.abs(ny) > 0.99 ? [1, 0, 0] : [0, 1, 0];
    const uxR = refAxis[1] * nz - refAxis[2] * ny;
    const uyR = refAxis[2] * nx - refAxis[0] * nz;
    const uzR = refAxis[0] * ny - refAxis[1] * nx;
    const uLen = Math.hypot(uxR, uyR, uzR) || 1;
    const ux = uxR / uLen, uy = uyR / uLen, uz = uzR / uLen;
    // v = n × u
    const vx = ny * uz - nz * uy;
    const vy = nz * ux - nx * uz;
    const vz = nx * uy - ny * ux;
    const seed = `${pVar}.seed`;
    const lines: string[] = [];
    lines.push(`${indent}float _plU = (Rand(${seed}) - 0.5) * ${toFloat(Number(sRaw.x), 2)};`);
    lines.push(`${indent}float _plV = (Rand(${seed}) - 0.5) * ${toFloat(Number(sRaw.y), 2)};`);
    lines.push(`${indent}vec3 _shapePos = vec3(${toFloat(Number(cRaw.x), 0)}, ${toFloat(Number(cRaw.y), 0)}, ${toFloat(Number(cRaw.z), 0)}) + vec3(${toFloat(ux, 1)}, ${toFloat(uy, 0)}, ${toFloat(uz, 0)}) * _plU + vec3(${toFloat(vx, 0)}, ${toFloat(vy, 0)}, ${toFloat(vz, 1)}) * _plV;`);
    lines.push(`${indent}vec3 _shapeDir = vec3(${toFloat(nx, 0)}, ${toFloat(ny, 1)}, ${toFloat(nz, 0)});`);
    return lines;
};

/** Line (compiled): uses compiled line expression */
function genLineCompiled(compiledExpr: string, compiledStmts: string[], pVar: string, indent: string, spawn?: SpawnOpts): string[] {
    const lines: string[] = [];
    for (const s of compiledStmts) lines.push(`${indent}${s}`);
    lines.push(`${indent}VFXLine _line = ${compiledExpr};`);
    return [...lines, ...genLineCore("_line.start", "_line.end", pVar, indent, spawn)];
}

/** Line core GLSL generation */
function genLineCore(start: string, end: string, pVar: string, indent: string, spawn?: SpawnOpts): string[] {
    const seed = `${pVar}.seed`;
    const tSrc = spawn?.custom ? spawn.lineSeq : `Rand(${seed})`;
    const lines: string[] = [];
    lines.push(`${indent}float _t = ${tSrc};`);
    lines.push(`${indent}vec3 _shapePos = mix(${start}, ${end}, _t);`);
    lines.push(`${indent}vec3 _shapeDir = normalize(${end} - ${start});`);
    return lines;
}

// ─── 形状注册表 ──────────────────────────────────────

interface IShapeGenOpts {
    thickness: string;
    heightMode: string;
    spawn?: SpawnOpts;
    /** 算子驱动的半径（Unity randomNumber → circle/sphere.radius 等逐粒子半径）。
     *  存在时覆盖形状内联 radius 字面量。已 hoist 成局部变量名（如 _shapeRadius）。 */
    radiusOverride?: string;
}

interface IShapeDef {
    /** block input slot 名（用于编译器查找连线） */
    slotId: string;
    /** 编译路径：从编译后的 GLSL 表达式生成形状代码 */
    compiled: (expr: string, stmts: string[], pVar: string, indent: string, mode: string, o: IShapeGenOpts) => string[];
    /** 回退路径：从 block.props 读字面量生成形状代码 */
    fallback: (p: Record<string, any>, pVar: string, indent: string, mode: string, o: IShapeGenOpts) => string[];
}

const SHAPE_DEFS: Record<string, IShapeDef> = {
    Sphere: {
        slotId: "arcSphere",
        compiled: (e, s, pV, i, m, o) => genSphereCompiled(e, s, pV, i, m, o.thickness, o.spawn),
        fallback: (p, pV, i, m, o) => genSphereFallback(p, pV, i, m, o.thickness, o.spawn),
    },
    Box: {
        slotId: "orientedBox",
        compiled: (e, s, pV, i, m, o) => genBoxCompiled(e, s, pV, i, m, o.thickness),
        fallback: (p, pV, i, m, o) => genBoxFallback(p, pV, i, m, o.thickness),
    },
    Cone: {
        slotId: "arcCone",
        compiled: (e, s, pV, i, m, o) => genConeCompiled(e, s, pV, i, m, o.heightMode, o.thickness, o.spawn),
        fallback: (p, pV, i, m, o) => genConeFallback(p, pV, i, m, o.heightMode, o.thickness, o.spawn),
    },
    Torus: {
        slotId: "arcTorus",
        compiled: (e, s, pV, i, m, o) => genTorusCompiled(e, s, pV, i, m, o.thickness, o.spawn),
        fallback: (p, pV, i, m, o) => genTorusFallback(p, pV, i, m, o.thickness, o.spawn),
    },
    Circle: {
        slotId: "arcCircle",
        compiled: (e, s, pV, i, m, o) => genCircleCompiled(e, s, pV, i, m, o.thickness, o.spawn),
        fallback: (p, pV, i, m, o) => genCircleFallback(p, pV, i, m, o.thickness, o.spawn, o.radiusOverride),
    },
    Line: {
        slotId: "line",
        compiled: (e, s, pV, i, _m, o) => genLineCompiled(e, s, pV, i, o.spawn),
        fallback: (p, pV, i, _m, o) => genLineFallback(p, pV, i, _m, o.thickness, o.spawn),
    },
    Plane: {
        slotId: "planeCenter", // Plane 无 composite 输入 slot，这里只提供字面量 fallback 路径
        compiled: (_e, _s, pV, i, m, _o) => genPlaneFallback({ /* compiled 路径暂退回 fallback 默认值 */ } as Record<string, any>, pV, i, m),
        fallback: (p, pV, i, m, _o) => genPlaneFallback(p, pV, i, m),
    },
};

// ─── materialize 上扫 (ySweep) ──────────────────────
// Unity materialize 类特效(如 Patterned/Abrupt DM swarm)的 Circle position 被一个随 spawn 源年龄
// (sourceAttributes.age)线性动画的 TRS 上扫:圆环高度 = base + height×(sourceAge/duration),粒子留在
// 各自 spawn 高度 → 形成高度梯度的穹顶/列。转换器把 source-age 驱动的 transform 折成了静态圆,这里据
// props.ySweep 在 init(u_TotalTime = 当前帧 = spawn 时刻 ≈ sourceAge)重建上扫 + 随机厚度带。
// 不加则所有粒子堆在同一高度 → 同高度过量叠加 additive HDR → 实心白盘(Patterned Hex 穹顶白根因)。
function applyYSweep(lines: string[], particleVar: string, p: Record<string, any>, indent: string): void {
    const sw = p.ySweep as Record<string, any> | undefined;
    if (!sw || typeof sw !== "object") return;
    const base = toFloat(sw.base as number, 0);
    const height = toFloat(sw.height as number, 0);
    const duration = toFloat(sw.duration as number, 1);
    const band = toFloat(sw.band as number, 0);
    lines.push(`${indent}// ySweep: materialize 上扫 (Y 随全局时间线性扫 + 随机厚度带)`);
    lines.push(`${indent}float _swProg = clamp(u_TotalTime / max(${duration}, 0.001), 0.0, 1.0);`);
    lines.push(`${indent}_shapePos.y += ${base} + ${height} * _swProg + (Rand(${particleVar}.seed) - 0.5) * ${band};`);
}

// ─── 主入口 ─────────────────────────────────────────

/**
 * 为 setPositionShape block 生成 GLSL 代码片段
 * @param block Block 数据
 * @param particleVar 粒子变量名 ("particle" in Initialize, "p" in Update)
 * @param indent 基础缩进
 * @returns GLSL 代码行数组
 */
export function genSetPositionShapeCode(
    block: IVfxBlockData,
    particleVar: string,
    indent: string,
    simulateSpace?: string,
    contextId?: number,
    compiler?: VfxExprCompiler,
    hasStripIndex?: boolean,
): string[] {
    const p = block.props || {};
    const shape = (p.shape as string) || "Sphere";
    const mode = (p.positionMode as string) || "Volume";
    const heightMode = (p.heightMode as string) || "Volume";
    const thickness = toFloat(p.thickness as number, 0.1);
    // 优先编译 op 链 (Unity Custom mode 接 Random/op 链给 sequencer); 失败再用 props 字面量
    let arcSeqExpr: string = toFloat(p.arcSequencer as number, 0);
    let heightSeqExpr: string = toFloat(p.heightSequencer as number, 0.5);
    let lineSeqExpr: string = toFloat(p.lineSequencer as number, 0.5);
    const seqStmts: string[] = [];
    if (compiler && contextId != null) {
        const arcRes = compiler.compileBlockInput(contextId, `block_${block.id}_arcSequencer`, "float");
        if (arcRes) { seqStmts.push(...arcRes.stmts); arcSeqExpr = arcRes.expr; }
        const heightRes = compiler.compileBlockInput(contextId, `block_${block.id}_heightSequencer`, "float");
        if (heightRes) { seqStmts.push(...heightRes.stmts); heightSeqExpr = heightRes.expr; }
        const lineRes = compiler.compileBlockInput(contextId, `block_${block.id}_lineSequencer`, "float");
        if (lineRes) { seqStmts.push(...lineRes.stmts); lineSeqExpr = lineRes.expr; }
    }
    // 算子驱动的半径（Unity randomNumber/operator → 形状 radius 逐粒子）。
    // 转换器把这种 link 写成 block_<id>_radius（blockLinkSlotId 特判 setPositionShape.radius）。
    // hoist 成局部 _shapeRadius 避免在 genRadialSampling + _shapePos 处重复求值。
    let radiusOverride: string | undefined;
    const radiusStmts: string[] = [];
    if (compiler && contextId != null) {
        const rRes = compiler.compileBlockInput(contextId, `block_${block.id}_radius`, "float");
        if (rRes) {
            // ⚠ op 声明（如 float _op6 = ...）必须在【顶层】emit，不能进形状的 { } 作用域 ——
            // 否则同一 op 被 size/lifetime 复用时（编译器缓存只引用不再声明）在 { } 外引用 = undeclared。
            // 变量名带 block.id 后缀避免多个 setPositionShape 撞名。
            radiusStmts.push(...rRes.stmts);
            radiusStmts.push(`float _shapeRadius_${block.id} = ${rRes.expr};`);
            radiusOverride = `_shapeRadius_${block.id}`;
        }
    }
    const spawn: SpawnOpts = {
        custom: (p.spawnMode as string) === "Custom" && shape !== "Box",
        arcSeq: arcSeqExpr,
        heightSeq: heightSeqExpr,
        lineSeq: lineSeqExpr,
        perStripRand: !!p._perStripRand,
        perStripSeed: typeof p._perStripSeed === "number" ? (p._perStripSeed as number) : undefined,
        hasStripIndex: !!hasStripIndex,
    };
    const posComp = (p.positionComposition as string) || "Overwrite";

    const lines: string[] = [];
    const inner = indent + "    ";
    // emit 上面的 sequencer + radius op statements (在 shape code 之前，顶层作用域)
    for (const s of seqStmts) lines.push(`${indent}${s}`);
    for (const s of radiusStmts) lines.push(`${indent}${s}`);
    const shapeDef = SHAPE_DEFS[shape];
    if (!shapeDef) return [`${indent}// Unknown shape: ${shape}`];

    const shapeOpts: IShapeGenOpts = { thickness, heightMode, spawn, radiusOverride };

    // ── 编译路径：Operator 连线提供形状数据（已由编译器处理空间转换） ──
    if (compiler && contextId != null) {
        const compiled = compiler.compileBlockInput(contextId, `block_${block.id}_${shapeDef.slotId}`);
        if (compiled) {
            lines.push(`${indent}// setPositionShape: ${shape} (${mode}, compiled)`);
            lines.push(`${indent}{`);
            lines.push(...shapeDef.compiled(compiled.expr, compiled.stmts, particleVar, inner, mode, shapeOpts));
            applyYSweep(lines, particleVar, p, inner);
            applyComp(lines, particleVar, "position", "_shapePos", posComp, inner);
            applyOrientation(lines, particleVar, p, inner);
            lines.push(`${indent}}`);
            return lines;
        }
    }

    // ── 回退路径：从 block.props 读字面量 ──
    const blockSpace = (p[`_space_${shapeDef.slotId}`] as string) || "Local";

    lines.push(`${indent}// setPositionShape: ${shape} (${mode}, space: ${blockSpace})`);
    lines.push(`${indent}{`);
    lines.push(...shapeDef.fallback(p, particleVar, inner, mode, shapeOpts));

    // 空间转换：block space → simulate space
    const simSpace = simulateSpace ?? "Local";
    if (blockSpace === "World" && simSpace === "Local") {
        lines.push(`${inner}_shapePos = transformPosition(u_InvEmitterWorldMatrix, _shapePos);`);
        lines.push(`${inner}_shapeDir = transformDirection(u_InvEmitterWorldMatrix, _shapeDir);`);
    } else if (blockSpace === "Local" && simSpace === "World") {
        lines.push(`${inner}_shapePos = transformPosition(u_EmitterWorldMatrix, _shapePos);`);
        lines.push(`${inner}_shapeDir = transformDirection(u_EmitterWorldMatrix, _shapeDir);`);
    }

    // materialize 上扫 (ySweep) — 在 composition 写回前偏移 _shapePos.y
    applyYSweep(lines, particleVar, p, inner);
    // 应用 composition
    applyComp(lines, particleVar, "position", "_shapePos", posComp, inner);
    applyOrientation(lines, particleVar, p, inner);

    lines.push(`${indent}}`);
    return lines;
}
