import type { IVfxAttributeUsage } from "../VfxBuild";

// ─── GLSL 类型映射 ─────────────────────────────────

const GLSL_TYPE: Record<string, string> = {
    vec2: "vec2",
    vec3: "vec3",
    vec4: "vec4",
    color: "vec3",
    float: "float",
    bool: "bool",
    uint: "uint",
    int: "int",
};

// ─── 打包数据结构 ──────────────────────────────────

export interface IPackEntry {
    name: string;
    type: string;       // vec3 / color (vec3) / float / bool
    slot: number;       // vec4 索引
    swizzle: string;    // 读取 swizzle: ".xyz" / "" (整个 vec4) / ".x" / ".y" …
}

/**
 * 打包规则（flat vec4[] 布局，避免 naga 对齐问题）：
 *   1. vec4: 单独占满 1 个 vec4（.xyzw）
 *   2. vec3/color + float/bool/uint 合占 1 个 vec4（xyz + w）
 *   3. vec2 配 2 个 scalar 合占 1 个 vec4（xy + z + w）；或两个 vec2 合占（xy + zw）；
 *      或单独占 1 个 vec4（xy）浪费 zw
 *   4. 剩余 scalar 每 4 个合占 1 个 vec4（xyzw）
 */
function packAttributes(attrs: { name: string; type: string }[]): { entries: IPackEntry[]; stride: number } {
    const vec4s = attrs.filter(a => a.type === "vec4");
    const vec3s = attrs.filter(a => a.type === "vec3" || a.type === "color");
    const vec2s = attrs.filter(a => a.type === "vec2");
    const scalars = attrs.filter(a => a.type === "float" || a.type === "bool" || a.type === "uint" || a.type === "int");

    const entries: IPackEntry[] = [];
    let slot = 0;

    // 1. vec4 独占一个 slot
    for (const v of vec4s) {
        entries.push({ name: v.name, type: v.type, slot, swizzle: "" });
        slot++;
    }

    // 2. 配对 vec3/color + scalar (xyz + w)
    const pairedV3 = Math.min(vec3s.length, scalars.length);
    for (let i = 0; i < vec3s.length; i++) {
        entries.push({ name: vec3s[i].name, type: vec3s[i].type, slot, swizzle: ".xyz" });
        if (i < pairedV3) {
            entries.push({ name: scalars[i].name, type: scalars[i].type, slot, swizzle: ".w" });
        }
        slot++;
    }
    let scalarsRemaining = scalars.slice(pairedV3);

    // 3. vec2 处理：优先 vec2(.xy) + 2 scalar(.z + .w) 合占；其次两 vec2 合占；最后 vec2 独占
    let v2Idx = 0;
    while (v2Idx < vec2s.length) {
        const v = vec2s[v2Idx];
        entries.push({ name: v.name, type: v.type, slot, swizzle: ".xy" });
        // 看是否还有 scalar 跟它配对 (.z .w)
        if (scalarsRemaining.length >= 2) {
            entries.push({ name: scalarsRemaining[0].name, type: scalarsRemaining[0].type, slot, swizzle: ".z" });
            entries.push({ name: scalarsRemaining[1].name, type: scalarsRemaining[1].type, slot, swizzle: ".w" });
            scalarsRemaining = scalarsRemaining.slice(2);
        } else if (scalarsRemaining.length === 1) {
            entries.push({ name: scalarsRemaining[0].name, type: scalarsRemaining[0].type, slot, swizzle: ".z" });
            scalarsRemaining = [];
        } else if (v2Idx + 1 < vec2s.length) {
            // 两个 vec2 合占
            const v2 = vec2s[v2Idx + 1];
            entries.push({ name: v2.name, type: v2.type, slot, swizzle: ".zw" });
            v2Idx++;
        }
        slot++;
        v2Idx++;
    }

    // 4. 剩余 scalar 4 个一组
    const comps = ["x", "y", "z", "w"];
    for (let i = 0; i < scalarsRemaining.length; i++) {
        const ci = i % 4;
        if (ci === 0 && i > 0) slot++;
        entries.push({ name: scalarsRemaining[i].name, type: scalarsRemaining[i].type, slot, swizzle: `.${comps[ci]}` });
    }
    if (scalarsRemaining.length > 0) slot++;

    return { entries, stride: Math.max(slot, 1) };
}

// ─── 去重 ──────────────────────────────────────────

/** 不存在于粒子 buffer 中的属性（仅通过 Source 读取） */
const SOURCE_ONLY_ATTRS = new Set(["spawnCount"]);

function getUniqueAttributes(usages: IVfxAttributeUsage[]): { name: string; type: string }[] {
    const seen = new Map<string, string>();
    for (const u of usages) {
        if (!seen.has(u.name) && !SOURCE_ONLY_ATTRS.has(u.name)) seen.set(u.name, u.type);
    }
    // 隐式依赖补全：angularVelocity 需要 angle（integrate），velocity 需要 position，age/reap 需要 lifetime/age
    if (seen.has("angularVelocity") && !seen.has("angle")) seen.set("angle", "vec3");
    if (seen.has("velocity") && !seen.has("position")) seen.set("position", "vec3");
    return Array.from(seen.entries()).map(([name, type]) => ({ name, type }));
}

function getSourceAttributes(usages: IVfxAttributeUsage[]): { name: string; type: string }[] {
    const seen = new Set<string>();
    const result: { name: string; type: string }[] = [];
    for (const u of usages) {
        const isSource = (u.usage === "get" && u.location === "Source")
            || (u.usage === "set" && u.source === "Source");
        // spawnCount 是 SourceAttributeBuffer 的固有首字段，不需要加入 SourceEventData
        if (!isSource || seen.has(u.name) || u.name === "spawnCount") continue;
        seen.add(u.name);
        result.push({ name: u.name, type: u.type });
    }
    return result;
}

// ─── 代码生成 ──────────────────────────────────────

function genLayoutComment(entries: IPackEntry[], stride: number): string {
    const lines: string[] = [];
    lines.push("// ============================================================");
    lines.push("// Particle Attribute Layout (dynamically generated)");
    lines.push("// ============================================================");
    lines.push("// AttributeBuffer uses flat vec4[] storage to avoid");
    lines.push("// naga (SPIR-V -> WGSL) struct alignment inconsistency.");
    lines.push("//");
    lines.push(`// AttributeBuffer: ${stride} vec4(s) per particle (${stride * 16} bytes):`);

    const slotMap = new Map<number, IPackEntry[]>();
    for (const e of entries) {
        if (!slotMap.has(e.slot)) slotMap.set(e.slot, []);
        slotMap.get(e.slot)!.push(e);
    }
    for (const [s, ents] of Array.from(slotMap.entries()).sort(([a], [b]) => a - b)) {
        const desc = ents.map(e => `${e.swizzle || "rgba"}=${e.name}`).join(", ");
        lines.push(`//   [${s}] ${desc}`);
    }
    lines.push("// ============================================================");
    return lines.join("\n");
}

function genStruct(attrs: { name: string; type: string }[]): string {
    const has = (n: string) => attrs.some(a => a.name === n);
    const lines = ["struct Particle {"];
    for (const a of attrs) {
        lines.push(`    ${GLSL_TYPE[a.type] || "float"} ${a.name};`);
    }
    // alive 不在属性列表时仍需要作为 struct 字段（用于 Update shader 的存活判断）
    if (!has("alive")) lines.push("    bool alive;");
    lines.push("};");
    return lines.join("\n");
}

function genReadParticle(entries: IPackEntry[]): string {
    const has = (n: string) => entries.some(e => e.name === n);
    const lines: string[] = [];
    lines.push("Particle readParticle(uint particleIndex)");
    lines.push("{");
    lines.push("    uint base = particleIndex * PARTICLE_STRIDE;");

    const usedSlots = [...new Set(entries.map(e => e.slot))].sort((a, b) => a - b);
    for (const s of usedSlots) {
        lines.push(`    vec4 v${s} = Attributes.data[base + ${s}u];`);
    }

    lines.push("");
    lines.push("    Particle p;");
    for (const e of entries) {
        if (e.type === "uint") {
            // Use float conversion instead of bitcast to avoid denormalized float flush-to-zero
            lines.push(`    p.${e.name} = uint(v${e.slot}${e.swizzle});`);
        } else if (e.type === "int") {
            lines.push(`    p.${e.name} = int(v${e.slot}${e.swizzle});`);
        } else if (e.type === "bool") {
            lines.push(`    p.${e.name} = v${e.slot}${e.swizzle} > 0.5;`);
        } else if (e.type === "vec2") {
            // vec2 swizzle 已含两个分量（.xy 或 .zw），直接当 vec2 读
            lines.push(`    p.${e.name} = v${e.slot}${e.swizzle};`);
        } else {
            lines.push(`    p.${e.name} = v${e.slot}${e.swizzle};`);
        }
    }

    // alive: 如果在 buffer 中存储则已从 buffer 读取，否则默认 true
    if (!has("alive")) lines.push("    p.alive = true;");
    lines.push("    return p;");
    lines.push("}");
    return lines.join("\n");
}

function genWriteParticle(entries: IPackEntry[]): string {
    const lines: string[] = [];
    lines.push("void writeParticle(uint particleIndex, Particle p)");
    lines.push("{");
    lines.push("    uint base = particleIndex * PARTICLE_STRIDE;");

    const slotMap = new Map<number, IPackEntry[]>();
    for (const e of entries) {
        if (!slotMap.has(e.slot)) slotMap.set(e.slot, []);
        slotMap.get(e.slot)!.push(e);
    }

    for (const [s, ents] of Array.from(slotMap.entries()).sort(([a], [b]) => a - b)) {
        const vec4Entry = ents.find(e => e.type === "vec4");
        const vec3Entry = ents.find(e => e.type === "vec3" || e.type === "color");

        if (vec4Entry) {
            // vec4 独占整个 slot
            lines.push(`    Attributes.data[base + ${s}u] = p.${vec4Entry.name};`);
        } else if (vec3Entry) {
            const wEntry = ents.find(e => e !== vec3Entry);
            let wExpr = "0.0";
            if (wEntry) {
                if (wEntry.type === "uint" || wEntry.type === "int") wExpr = `float(p.${wEntry.name})`;
                // bool → float：用 float() 内置转换代替 ternary，避免 naga 下 divergent
                //   分支污染同 vec4 slot 的 vec3 分量（kill block 错杀全局粒子根因）
                else if (wEntry.type === "bool") wExpr = `float(p.${wEntry.name})`;
                else wExpr = `p.${wEntry.name}`;
            }
            lines.push(`    Attributes.data[base + ${s}u] = vec4(p.${vec3Entry.name}, ${wExpr});`);
        } else {
            // 可能含 vec2（占 .xy 或 .zw）+ scalar (.z .w)，或 4 个 scalar 各占一分量
            const vals = ["0.0", "0.0", "0.0", "0.0"];
            const compNames = ["x", "y", "z", "w"];
            for (const e of ents) {
                if (e.type === "vec2") {
                    const sw = e.swizzle.replace(".", "");
                    // .xy → 写 [0]/[1]；.zw → 写 [2]/[3]
                    if (sw === "xy") { vals[0] = `p.${e.name}.x`; vals[1] = `p.${e.name}.y`; }
                    else if (sw === "zw") { vals[2] = `p.${e.name}.x`; vals[3] = `p.${e.name}.y`; }
                } else {
                    const ci = compNames.indexOf(e.swizzle.replace(".", ""));
                    if (ci >= 0) {
                        if (e.type === "uint" || e.type === "int") vals[ci] = `float(p.${e.name})`;
                        else if (e.type === "bool") vals[ci] = `float(p.${e.name})`;
                        else vals[ci] = `p.${e.name}`;
                    }
                }
            }
            lines.push(`    Attributes.data[base + ${s}u] = vec4(${vals.join(", ")});`);
        }
    }

    lines.push("}");
    return lines.join("\n");
}

const ATTR_DEFAULT: Record<string, string> = {
    position: "vec3(0.0)",
    velocity: "vec3(0.0)",
    direction: "vec3(0.0, 0.0, 1.0)",
    color: "vec3(1.0, 1.0, 1.0)",
    alpha: "1.0",
    age: "0.0",
    lifetime: "3.0",
    normalizedAge: "0.0",
    size: "0.1",
    scale: "vec3(1.0)",
    angle: "vec3(0.0)",
    angularVelocity: "vec3(0.0)",
    mass: "1.0",
    oldPosition: "vec3(0.0)",
    targetPosition: "vec3(0.0)",
    pivot: "vec3(0.0)",
    texIndex: "0.0",
    axisX: "vec3(1.0, 0.0, 0.0)",
    axisY: "vec3(0.0, 1.0, 0.0)",
    axisZ: "vec3(0.0, 0.0, 1.0)",
    alive: "true",
    spawnTime: "0.0",
};

const TYPE_DEFAULT: Record<string, string> = {
    vec2: "vec2(0.0)",
    vec3: "vec3(0.0)",
    vec4: "vec4(0.0)",
    color: "vec3(1.0, 1.0, 1.0)",
    float: "0.0",
    bool: "false",
    uint: "0u",
    int: "0",
};

function genDefaultParticle(attrs: { name: string; type: string }[]): string {
    const has = (n: string) => attrs.some(a => a.name === n);
    const lines: string[] = [];
    lines.push("Particle defaultParticle()");
    lines.push("{");
    lines.push("    Particle p;");
    for (const a of attrs) {
        lines.push(`    p.${a.name} = ${ATTR_DEFAULT[a.name] || TYPE_DEFAULT[a.type] || "0.0"};`);
    }
    // alive 不在属性列表时仍需默认为 true
    if (!has("alive")) lines.push("    p.alive = true;");
    lines.push("    return p;");
    lines.push("}");
    return lines.join("\n");
}

function genVfxRand(): string {
    // Rand() / FixedRand() / WangHash() are provided by VFXUtils.glsl (included via BUFFER_HEADER)
    // No additional random functions needed here.
    return `\
// ---------- Pseudo Random ----------
// Rand(inout uint seed)   - stateful, advances seed each call
// FixedRand(uint seed)    - stateless, same input same output
// WangHash(uint seed)     - used to initialize seed
// Provided by VFXUtils.glsl`;
}

function genVFXSphere(): string {
    return `\
// ---------- Sphere ----------
struct VFXSphere
{
    mat4 transform;
    float radius;
};

// ---------- Arc Sphere ----------
struct VFXArcSphere
{
    VFXSphere sphere;
    float arc;  // angle in radians of the sphere segment
};

// ---------- AA Box ----------
struct VFXAABox
{
    vec3 center;
    vec3 size;
};

// ---------- Plane ----------
struct VFXPlane
{
    vec3 position;
    vec3 normal;
};

// ---------- Oriented Box ----------
struct VFXOrientedBox
{
    vec3 center;
    vec3 angle;   // euler angles in degrees
    vec3 size;
};

// ---------- Cone ----------
struct VFXCone
{
    mat4 transform;   // pivot at center of base cap
    float baseRadius;
    float topRadius;
    float height;
};

// ---------- Arc Cone ----------
struct VFXArcCone
{
    VFXCone cone;
    float arc;  // angle in radians of the cone segment
};

// ---------- Torus ----------
struct VFXTorus
{
    mat4 transform;
    float majorRadius;  // distance from center to tube center
    float minorRadius;  // tube radius
};

// ---------- Arc Torus ----------
struct VFXArcTorus
{
    VFXTorus torus;
    float arc;  // angle in radians of the torus segment
};

// ---------- Circle ----------
struct VFXCircle
{
    mat4 transform;
    float radius;
};

// ---------- Arc Circle ----------
struct VFXArcCircle
{
    VFXCircle circle;
    float arc;  // angle in radians of the circle segment
};

// ---------- Line ----------
struct VFXLine
{
    vec3 start;
    vec3 end;
};

// ---------- Camera ----------
struct VFXCamera
{
    mat4 transform;
    float orthographic;   // 0.0 = perspective, 1.0 = orthographic
    float fieldOfView;
    float nearPlane;
    float farPlane;
    float orthographicSize;
    float aspectRatio;
};`;
}

function genBuildTRS(): string {
    return `\
// ---------- Transform Utility ----------
mat4 BuildTRS(vec3 pos, vec3 rot, vec3 scl)
{
    float cx = cos(rot.x); float sx = sin(rot.x);
    float cy = cos(rot.y); float sy = sin(rot.y);
    float cz = cos(rot.z); float sz = sin(rot.z);
    // Rotation: YXZ euler order (matches LayaAir convention)
    mat3 R = mat3(
        cy*cz + sy*sx*sz,     cx*sz,                cy*sx*sz - sy*cz,
        sy*sx*cz - cy*sz,     cx*cz,                cy*sx*cz + sy*sz,
        sy*cx,               -sx,                    cy*cx
    );
    return mat4(
        vec4(R[0] * scl.x, 0.0),
        vec4(R[1] * scl.y, 0.0),
        vec4(R[2] * scl.z, 0.0),
        vec4(pos, 1.0)
    );
}`;
}

function genExtractEulerYXZ(): string {
    // Inverse of BuildTRS rotation (YXZ euler order, column-major mat3)
    // Column 1 = (cx*sz, cx*cz, -sx) → R[1][2] = -sx
    // Column 2 row 0 = sy*cx → atan2(R[2][0], R[2][2]) = y
    // Column 0 row 1 = cx*sz → atan2(R[0][1], R[1][1]) = z
    return `\
// ---------- Extract Euler YXZ from mat4 ----------
vec3 _extractEulerYXZ(mat4 m)
{
    // Remove scale from columns
    vec3 c0 = normalize(m[0].xyz);
    vec3 c1 = normalize(m[1].xyz);
    vec3 c2 = normalize(m[2].xyz);
    // R[1][2] = -sin(x)
    float sx = -c1.z;
    sx = clamp(sx, -1.0, 1.0);
    float x = asin(sx);
    float cx = cos(x);
    float y, z;
    if (abs(cx) > 0.001) {
        // R[2][0] = sy*cx, R[2][2] = cy*cx
        y = atan(c2.x, c2.z);
        // R[0][1] = cx*sz, R[1][1] = cx*cz
        z = atan(c0.y, c1.y);
    } else {
        // Gimbal lock: x ≈ ±90°
        y = atan(-c0.z, c0.x);
        z = 0.0;
    }
    return vec3(x, y, z);
}`;
}

function genMathHelpers(): string {
    return `\
// ---------- Math Helpers ----------
vec3 _rotate3D(vec3 v, vec3 axis, float angle)
{
    // axis = (0,0,0) → normalize 产生 NaN → 整个 position NaN → 粒子不渲染。
    // operator 链缺失时（如某些 multiply 输入 b 默认 vec3(0)）会出现这种情况，
    // 必须兜底：axis 几乎为 0 时不旋转直接返回 v。
    float _axisLen = length(axis);
    if (_axisLen < 1e-6) return v;
    vec3 a = axis / _axisLen;
    float s = sin(angle);
    float c = cos(angle);
    float oc = 1.0 - c;
    mat3 m = mat3(
        oc * a.x * a.x + c,       oc * a.x * a.y + a.z * s, oc * a.x * a.z - a.y * s,
        oc * a.x * a.y - a.z * s, oc * a.y * a.y + c,       oc * a.y * a.z + a.x * s,
        oc * a.x * a.z + a.y * s, oc * a.y * a.z - a.x * s, oc * a.z * a.z + c
    );
    return m * v;
}

mat4 _lookAt(vec3 eye, vec3 target, vec3 up)
{
    vec3 fwd = normalize(target - eye);
    vec3 right = normalize(cross(fwd, up));
    vec3 u = cross(right, fwd);
    return mat4(
        vec4(right, 0.0),
        vec4(u, 0.0),
        vec4(-fwd, 0.0),
        vec4(eye, 1.0)
    );
}

float _distanceToLine(vec3 p, vec3 a, vec3 b)
{
    vec3 ab = b - a;
    float l2 = dot(ab, ab);
    if (l2 < 1e-12) return distance(p, a);
    float t = clamp(dot(p - a, ab) / l2, 0.0, 1.0);
    return distance(p, a + t * ab);
}

// Signed distance to AABox (负=内部, 正=外部)
float _distanceToAABox(vec3 p, vec3 center, vec3 size)
{
    vec3 d = abs(p - center) - size * 0.5;
    float outsideDist = length(max(d, vec3(0.0)));
    float insideDist = min(max(d.x, max(d.y, d.z)), 0.0);
    return outsideDist + insideDist;
}

// Euler (deg, ZXY Unity-order) → 正向旋转矩阵的逆（即 transpose，正交矩阵性质）
// 把世界 point 转到 OBB local space
vec3 _applyEulerInverse(vec3 p, vec3 eulerDeg)
{
    vec3 r = eulerDeg * 0.01745329252;
    float cx = cos(r.x), sx = sin(r.x);
    float cy = cos(r.y), sy = sin(r.y);
    float cz = cos(r.z), sz = sin(r.z);
    // GLSL mat3 构造按列：mat3(col0, col1, col2)
    mat3 Rx = mat3(1.0, 0.0, 0.0, 0.0, cx, sx, 0.0, -sx, cx);
    mat3 Ry = mat3(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy);
    mat3 Rz = mat3(cz, sz, 0.0, -sz, cz, 0.0, 0.0, 0.0, 1.0);
    mat3 Rfull = Ry * Rx * Rz;
    return transpose(Rfull) * p;
}

// Signed distance to OrientedBox
float _distanceToOrientedBox(vec3 p, vec3 center, vec3 angleDeg, vec3 size)
{
    vec3 localP = _applyEulerInverse(p - center, angleDeg);
    return _distanceToAABox(localP, vec3(0.0), size);
}

// Signed distance to Torus（沿 XZ 平面的圆环，majorR 环半径，minorR 管半径）
float _distanceToTorus(vec3 p, vec3 center, float majorR, float minorR)
{
    vec3 localP = p - center;
    vec2 q = vec2(length(localP.xz) - majorR, localP.y);
    return length(q) - minorR;
}

// Signed distance to finite Cylinder (capped) — center at midpoint, total length = height, radius = r
float _distanceToCylinder(vec3 p, vec3 center, vec3 axis, float height, float r)
{
    vec3 off = p - center;
    vec3 a = normalize(axis);
    float h = dot(off, a);            // 沿 axis 投影（可正可负）
    float rad = length(off - a * h);  // 垂直 axis 的距离
    float dH = abs(h) - height * 0.5; // 轴向超出（负=内，正=外）
    float dR = rad - r;               // 径向超出
    vec2 d = vec2(dR, dH);
    // 经典 iq 2D-to-3D cylinder SDF
    return min(max(dR, dH), 0.0) + length(max(d, vec2(0.0)));
}

// Signed distance to finite Cone — apex at center, extending along axis for height, base radius baseR
// 用 iq 的 capped cone SDF 公式（简化）
float _distanceToCone(vec3 p, vec3 center, vec3 axis, float height, float baseR)
{
    vec3 off = p - center;
    vec3 a = normalize(axis);
    float h = dot(off, a);
    float r = length(off - a * h);
    // 有限 cone 投影到 (r, h) 2D 空间 → apex at (0,0), base at (baseR, height)
    // 2D SDF of the triangle (apex, base-rim, axis-segment)
    vec2 q = vec2(r, h);
    vec2 tip = vec2(0.0, 0.0);
    vec2 baseCorner = vec2(baseR, height);
    vec2 axisTop = vec2(0.0, height);
    // Edge 1: tip → baseCorner (slant)
    vec2 e1 = baseCorner - tip;
    vec2 v1 = q - tip;
    float t1 = clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
    vec2 p1 = tip + t1 * e1;
    // Edge 2: baseCorner → axisTop (bottom)
    vec2 e2 = axisTop - baseCorner;
    vec2 v2 = q - baseCorner;
    float t2 = clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
    vec2 p2 = baseCorner + t2 * e2;
    // Min distance to edges
    float d1 = length(q - p1);
    float d2 = length(q - p2);
    float d = min(d1, d2);
    // Inside check: h in [0, height] AND r <= baseR * (h/height)
    float s = (h >= 0.0 && h <= height && r <= baseR * (h / max(height, 1e-6))) ? -1.0 : 1.0;
    return s * d;
}

// AABox 表面最近点：外部 → clamp 到 box；内部 → 沿最近面投影
vec3 _aaboxClosestSurface(vec3 p, vec3 center, vec3 size)
{
    vec3 halfSize = size * 0.5;
    vec3 q = p - center;
    vec3 qAbs = abs(q);
    bool outside = qAbs.x > halfSize.x || qAbs.y > halfSize.y || qAbs.z > halfSize.z;
    vec3 closestLocal;
    if (outside) {
        closestLocal = clamp(q, -halfSize, halfSize);
    } else {
        vec3 diff = halfSize - qAbs;
        closestLocal = q;
        if (diff.x <= diff.y && diff.x <= diff.z) closestLocal.x = sign(q.x) * halfSize.x;
        else if (diff.y <= diff.z) closestLocal.y = sign(q.y) * halfSize.y;
        else closestLocal.z = sign(q.z) * halfSize.z;
    }
    return center + closestLocal;
}

// AABox 外向法线（SDF 梯度近似）：外部 = 从最近点指向粒子；内部 = 指向最近面
vec3 _aaboxOutwardNormal(vec3 p, vec3 center, vec3 size)
{
    vec3 halfSize = size * 0.5;
    vec3 q = p - center;
    vec3 d = abs(q) - halfSize;
    float mxD = max(d.x, max(d.y, d.z));
    if (mxD > 0.0) {
        // 外部：外向方向
        vec3 n = max(d, vec3(0.0)) * sign(q);
        return normalize(n);
    } else {
        // 内部：指向最近面的方向
        vec3 n = vec3(0.0);
        if (d.x >= d.y && d.x >= d.z) n.x = sign(q.x);
        else if (d.y >= d.z) n.y = sign(q.y);
        else n.z = sign(q.z);
        return n;
    }
}

// 正向 euler 应用（用于把 OBB local space 转回世界）
vec3 _applyEulerForward(vec3 p, vec3 eulerDeg)
{
    vec3 r = eulerDeg * 0.01745329252;
    float cx = cos(r.x), sx = sin(r.x);
    float cy = cos(r.y), sy = sin(r.y);
    float cz = cos(r.z), sz = sin(r.z);
    mat3 Rx = mat3(1.0, 0.0, 0.0, 0.0, cx, sx, 0.0, -sx, cx);
    mat3 Ry = mat3(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy);
    mat3 Rz = mat3(cz, sz, 0.0, -sz, cz, 0.0, 0.0, 0.0, 1.0);
    mat3 Rfull = Ry * Rx * Rz;
    return Rfull * p;
}

mat4 _inverseTRS(mat4 m)
{
    vec3 sx = vec3(length(m[0].xyz), length(m[1].xyz), length(m[2].xyz));
    vec3 invS = 1.0 / max(sx, vec3(1e-6));
    mat3 r = mat3(m[0].xyz * invS.x, m[1].xyz * invS.y, m[2].xyz * invS.z);
    mat3 rT = transpose(r);
    vec3 t = -rT * m[3].xyz;
    return mat4(
        vec4(rT[0] * invS.x, 0.0),
        vec4(rT[1] * invS.y, 0.0),
        vec4(rT[2] * invS.z, 0.0),
        vec4(t, 1.0)
    );
}

vec3 _worldToViewport(vec3 worldPos, mat4 viewProj)
{
    vec4 clip = viewProj * vec4(worldPos, 1.0);
    vec3 ndc = clip.xyz / clip.w;
    return vec3(ndc.xy * 0.5 + 0.5, ndc.z);
}

vec3 _viewportToWorld(vec3 vpPos, mat4 invViewProj)
{
    vec4 ndc = vec4(vpPos.xy * 2.0 - 1.0, vpPos.z, 1.0);
    vec4 world = invViewProj * ndc;
    return world.xyz / world.w;
}`;
}

function genSpaceTransform(): string {
    return `\
// ---------- Space Transform Utility ----------
vec3 transformPosition(mat4 m, vec3 pos)
{
    return (m * vec4(pos, 1.0)).xyz;
}

vec3 transformDirection(mat4 m, vec3 dir)
{
    return (m * vec4(dir, 0.0)).xyz;
}

// ---------- Composite Type Space Transform ----------
VFXSphere transformSphere(mat4 m, VFXSphere s)
{
    return VFXSphere(m * s.transform, s.radius);
}

VFXArcSphere transformArcSphere(mat4 m, VFXArcSphere a)
{
    return VFXArcSphere(transformSphere(m, a.sphere), a.arc);
}

VFXAABox transformAABox(mat4 m, VFXAABox b)
{
    return VFXAABox(transformPosition(m, b.center), b.size);
}

VFXPlane transformPlane(mat4 m, VFXPlane p)
{
    return VFXPlane(transformPosition(m, p.position), transformDirection(m, p.normal));
}

VFXOrientedBox transformOrientedBox(mat4 m, VFXOrientedBox b)
{
    return VFXOrientedBox(transformPosition(m, b.center), b.angle, b.size);
}

VFXCone transformCone(mat4 m, VFXCone c)
{
    return VFXCone(m * c.transform, c.baseRadius, c.topRadius, c.height);
}

VFXArcCone transformArcCone(mat4 m, VFXArcCone a)
{
    return VFXArcCone(transformCone(m, a.cone), a.arc);
}

VFXTorus transformTorus(mat4 m, VFXTorus t)
{
    return VFXTorus(m * t.transform, t.majorRadius, t.minorRadius);
}

VFXArcTorus transformArcTorus(mat4 m, VFXArcTorus a)
{
    return VFXArcTorus(transformTorus(m, a.torus), a.arc);
}

VFXCircle transformCircle(mat4 m, VFXCircle c)
{
    return VFXCircle(m * c.transform, c.radius);
}

VFXArcCircle transformArcCircle(mat4 m, VFXArcCircle a)
{
    return VFXArcCircle(transformCircle(m, a.circle), a.arc);
}

VFXLine transformLine(mat4 m, VFXLine l)
{
    return VFXLine(transformPosition(m, l.start), transformPosition(m, l.end));
}`;
}

/** Update context 隐式行为开关 */
export interface IUpdateFlags {
    updatePosition: boolean;
    ageParticles: boolean;
    reapParticles: boolean;
}

function genUpdateParticle(usages: IVfxAttributeUsage[], flags?: IUpdateFlags): string {
    // 隐式行为基于用户 Block 实际写入的属性，而非属性列表中的存在性
    const written = new Set(usages.filter(a => a.usage === "set").map(a => a.name));
    const doPosition = (flags?.updatePosition ?? true);
    const doAge = (flags?.ageParticles ?? true);
    const doReap = (flags?.reapParticles ?? true);
    const lines: string[] = [];
    lines.push("void updateParticle(inout Particle p, float dt)");
    lines.push("{");
    // BackupOldPosition: 仅当 oldPosition 显式存在于属性列表时才备份（供 OverDistance GPU Event 使用）
    if (written.has("oldPosition")) lines.push("    p.oldPosition = p.position;");
    // EulerIntegration: velocity 被写入 + updatePosition 开启
    if (written.has("velocity") && doPosition) lines.push("    p.position += p.velocity * dt;");
    // AngularIntegration: angularVelocity 被写入 → angle += angularVelocity * dt
    if (written.has("angularVelocity")) lines.push("    p.angle += p.angularVelocity * dt;");
    // Age: ageParticles 开启 + age 被任何 block/op 用到（set 或 read）就累加
    // flipbookPlay 等 block 只 read p.age，但 written.has("age") 只查 set，会漏掉，导致 age 永 0
    if (doAge && usages.some(a => a.name === "age")) lines.push("    p.age += dt;");
    // NormalizedAge: lifetime 存在时自动计算
    if (written.has("lifetime")) lines.push("    p.normalizedAge = (p.lifetime > 0.0) ? clamp(p.age / p.lifetime, 0.0, 1.0) : 1.0;");
    // Reap: lifetime 被写入 + reapParticles 开启
    if (written.has("lifetime") && doReap) lines.push("    p.alive = p.alive && p.age < p.lifetime;");
    lines.push("}");
    return lines.join("\n");
}

function genSourceEventData(eventAttrs: { name: string; type: string }[]): string {
    if (eventAttrs.length === 0) {
        return "struct SourceEventData {\n};";
    }
    const lines = ["struct SourceEventData {"];
    for (const a of eventAttrs) {
        lines.push(`    ${GLSL_TYPE[a.type] || "float"} ${a.name};`);
    }
    lines.push("};");
    return lines.join("\n");
}

// ─── 静态 buffer 声明 ──────────────────────────────

const BUFFER_HEADER = `\
#include "VFXUtils.glsl"

// DeadList manages free slots (stack)
buffer DeadListBuffer
{
    uint count;
    uint indices[];
}
DeadList;

// AliveList stores alive particle indices (read buffer)
buffer AliveListReadBuffer
{
    uint count;
    uint indices[];
}
AliveListRead;

// AliveList stores alive particle indices (write buffer)
buffer AliveListWriteBuffer
{
    uint count;
    uint indices[];
}
AliveListWrite;`;

// ─── 导出 ──────────────────────────────────────────

/**
 * 根据 attribute 使用列表，动态生成 VFX Common shader 代码。
 * 包括 Particle struct / buffer 布局 / readParticle / writeParticle / updateParticle / SourceEventData。
 */
/**
 * 根据 attribute 使用列表生成 packEntries + stride（不生成代码）。
 * 用于获取源系统的布局信息供 readSourceParticle 使用。
 */
export function generateSourcePackInfo(usages: IVfxAttributeUsage[]): { entries: IPackEntry[]; stride: number } {
    const uniqueAttrs = getUniqueAttributes(usages);
    return packAttributes(uniqueAttrs);
}

export function generateVFXCommon(usages: IVfxAttributeUsage[], updateFlags?: IUpdateFlags): { code: string; stride: number; packEntries: IPackEntry[] } {
    const uniqueAttrs = getUniqueAttributes(usages);
    const { entries, stride } = packAttributes(uniqueAttrs);
    const eventAttrs = getSourceAttributes(usages);

    const code = [
        BUFFER_HEADER,
        "",
        genLayoutComment(entries, stride),
        "",
        `#define PARTICLE_STRIDE ${stride}u`,
        "#define RENDER_STRIDE 5u",
        "",
        genStruct(uniqueAttrs),
        "",
        "// ---------- Buffer Declarations ----------",
        "",
        "buffer AttributeBuffer\n{\n    vec4 data[];\n}\nAttributes;",
        "",
        "// ---------- Particle Read/Write ----------",
        "",
        genReadParticle(entries),
        "",
        genWriteParticle(entries),
        "",
        genDefaultParticle(uniqueAttrs),
        "",
        genVfxRand(),
        "",
        genBuildTRS(),
        "",
        genExtractEulerYXZ(),
        "",
        genMathHelpers(),
        "",
        genVFXSphere(),
        "",
        genSpaceTransform(),
        "",
        "// ---------- Particle Implicit Behavior ----------",
        "",
        genUpdateParticle(usages, updateFlags),
        "",
        "// ---------- Other Buffers ----------",
        "",
        "buffer PrefixSumBuffer\n{\n    uint sums[];\n}\nPrefixSum;",
        ...(eventAttrs.length > 0 ? [
            "",
            "// CPU Event Source Attributes",
            genSourceEventData(eventAttrs),
            "",
            "buffer SourceAttributeBuffer\n{\n    float spawnCount;\n    SourceEventData events[];\n}\nSourceAttributes;",
        ] : [
            "",
            "buffer SourceAttributeBuffer\n{\n    float spawnCount;\n}\nSourceAttributes;",
        ]),
    ].join("\n");

    return { code, stride, packEntries: entries };
}
