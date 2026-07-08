/**
 * Output Strip -- Minimal version for debugging
 *
 * Each strip gets one workgroup (dispatch x = stripCapacity).
 * Each thread handles one particle slot in the ring buffer.
 * Dead particles produce degenerate (zero-position) vertices.
 *
 * StripDataBuffer layout (4 uint per strip):
 *   [0] FIRST_INDEX
 *   [1] NEXT_INDEX
 *   [2] SNAP_FIRST
 *   [3] SNAP_NEXT
 */

export interface IStripOutputOptions {
    needsCamera: boolean;
    hasColor: boolean;
    hasAlpha: boolean;
    hasSize: boolean;
    blockCode: string;
    extraUniforms: string;
    simulateSpace: string;
    attrNames: Set<string>;
    stripCapacity: number;
    particlePerStripCount: number;
    isGPUEvent?: boolean;
    // Unity uvBias.x/y 接 add(TotalTime, Random) 时, IDE 在 OutputStrip 内 inject 动态 UV offset
    // 让 ribbon 颜色流动 (vertex.uv.x = stripRatio + scroll, scroll 跟时间和 strip 随机种子一起)
    uvBiasScrollX?: { speed: number; randomMin: number; randomMax: number };
    uvBiasScrollY?: { speed: number; randomMin: number; randomMax: number };
}

export function generateStripOutput(
    commonCode: string,
    opts: IStripOutputOptions,
): string {
    const { blockCode, extraUniforms, attrNames, simulateSpace, stripCapacity, particlePerStripCount, isGPUEvent, uvBiasScrollX, uvBiasScrollY } = opts;
    const isWorld = simulateSpace === "World";

    const colorRGB = attrNames.has("color") ? "p.color" : "vec3(1.0)";
    const alpha = attrNames.has("alpha") ? "p.alpha" : "1.0";
    const size = attrNames.has("size") ? "p.size" : "0.1";
    const scale = attrNames.has("scale") ? "p.scale" : "vec3(1.0)";

    const worldToLocal = isWorld && attrNames.has("position")
        ? "        p.position = transformPosition(u_InvEmitterWorldMatrix, p.position);\n"
        : "";
    const worldToLocalNeighbor = isWorld && attrNames.has("position")
        ? "        nP.position = transformPosition(u_InvEmitterWorldMatrix, nP.position);\n"
        : "";

    const blockLines = blockCode ? blockCode + "\n" : "";

    const MAX_PPS = Math.min(particlePerStripCount, 256);
    const ppsc = particlePerStripCount;
    // Total fixed index count: stripCapacity * (ppsc-1) * 6
    const totalFixedIndexCount = stripCapacity * (ppsc - 1) * 6;

    return `Shader3D Start
{
    type: ComputeShader,
    name: "StripOutput",
    uniformMaps: [
        {
            u_Capacity: { type: "Int" },
            u_ParticlePerStrip: { type: "Int" },
            u_StripCapacity: { type: "Int" },
            u_TotalTime: { type: "Float" },
            u_OrientCameraPos: { type: "Vector3" },
            u_EmitterWorldMatrix: { type: "Matrix4x4" },
            u_InvEmitterWorldMatrix: { type: "Matrix4x4" }${extraUniforms}/*VFX_EXTRA_UNIFORMS*/
        }
    ],
    code: "StripOutput_CS"
}
Shader3D End

GLSL Start

#defineGLSL StripOutput_CS

/*VFX_CURVE_FUNC*/
${commonCode}

buffer StripDataBuffer
{
    uint data[];
}
StripData;

buffer RenderBuffer
{
    vec4 data[];
}
Render;

buffer IndirectBuffer
{
    uint count;
    uint instanceCount;
    uint firstInstance;
    uint baseVertex;
    uint firstVertex;
}
Indirect;

#define STRIP_VERTEX_STRIDE 4
#define MAX_PPS ${MAX_PPS}

shared uint s_firstIndex;
shared uint s_particleCount;

layout(local_size_x = MAX_PPS, local_size_y = 1, local_size_z = 1) in;

void main()
{
    uint stripIndex = gl_WorkGroupID.x;
    uint tid = gl_LocalInvocationID.x;
    uint ppsc = uint(u_ParticlePerStrip);

    // ── Thread 0: read compacted ring buffer state from UpdateStrips snapshot ──
    if (tid == 0u) {
        // Slots 2,3 = snapshot written by UpdateStrips pass (stable, not modified by Init)
        s_firstIndex = StripData.data[stripIndex * 5u + 2u];
        s_particleCount = StripData.data[stripIndex * 5u + 3u];

        // indirect.count 必须写「全量 quads」(整个 stripCapacity * (ppsc-1) * 6)，
        // 因为单个 indirect draw call 只能 draw 一个连续 index range，没法只画"活跃 strip"的 quads。
        // 之前每条 strip thread 0 直接写 (_pc >= 2u) ? (_pc-1)*6 : 0 是 RACE：
        // stripCap=320 大量 strip 为空 (count<2)，最后写赢的 strip 把 indirect.count 覆盖成 0 → 不渲染。
        // 修：所有 thread 0 都写同样的全量值（同值无 race），死/未填粒子靠 _degPos collapse
        // 到 lastAlive 位置形成 0 面积 quad 自动隐形。
        if (stripIndex == 0u) {
            Indirect.count = uint(u_StripCapacity) * (ppsc - 1u) * 6u;
            Indirect.instanceCount = 1u;
        }
    }

    barrier();

    // ── Every thread: produce 2 vertices ──
    uint firstIndex = s_firstIndex;
    uint particleCount = s_particleCount;
    uint stripVertBase = (stripIndex * ppsc + tid) * 2u * uint(STRIP_VERTEX_STRIDE);

    // tid >= ppsc: OUTSIDE this strip's vertex range — writing would corrupt next strip!
    if (tid >= ppsc) return;

    // Not enough particles or unused slot → degenerate at last alive position
    if (tid >= particleCount || particleCount < 2u) {
        vec3 _degPos = vec3(0.0);
        if (particleCount > 0u) {
            uint _lastIdx = stripIndex * ppsc + (firstIndex + particleCount - 1u) % ppsc;
            _degPos = readParticle(_lastIdx).position;
        }
        Render.data[stripVertBase + 0u] = vec4(_degPos, 1.0);
        Render.data[stripVertBase + 1u] = vec4(0.0);
        Render.data[stripVertBase + 2u] = vec4(0.0);
        Render.data[stripVertBase + 3u] = vec4(0.0);
        Render.data[stripVertBase + 4u] = vec4(_degPos, 1.0);
        Render.data[stripVertBase + 5u] = vec4(0.0);
        Render.data[stripVertBase + 6u] = vec4(0.0);
        Render.data[stripVertBase + 7u] = vec4(0.0);
        return;
    }

    uint particleIndex = stripIndex * ppsc + (firstIndex + tid) % ppsc;
    Particle p = readParticle(particleIndex);
    // 保存 simulation position (= update 阶段写到 buffer 的位置, 不含 output 阶段 setAttribute(position) 的 noise drift).
    // 用于 tangent + toCamRaw + right 全部基于 simulation, 让 ribbon orient 几何始终基于主轴稳定;
    // noise drift 只 offset vertex 中心位置 (跟 Unity 一致: vertex shader 用 attributes.axis (simulation) + attributes.position (modified)).
    vec3 _simPos = p.position;

    // Dead particle: collapse to own position
    if (!p.alive) {
        Render.data[stripVertBase + 0u] = vec4(p.position, 1.0);
        Render.data[stripVertBase + 1u] = vec4(0.0);
        Render.data[stripVertBase + 2u] = vec4(0.0);
        Render.data[stripVertBase + 3u] = vec4(0.0);
        Render.data[stripVertBase + 4u] = vec4(p.position, 1.0);
        Render.data[stripVertBase + 5u] = vec4(0.0);
        Render.data[stripVertBase + 6u] = vec4(0.0);
        Render.data[stripVertBase + 7u] = vec4(0.0);
        return;
    }

    // Strip position ratio: 0 = tail (oldest, FIFO head), 1 = head (newest)
    float stripRatio = float(tid) / max(float(particleCount - 1u), 1.0);

    // 用粒子自身 normalizedAge(per-particle)— 对齐 Unity strip：每个 trail 粒子按自己 age 取 size/alpha/color，
    // 自然出现"两端细、尾部渐隐"。之前 GPU event 路径覆盖成 head-based(整条用头部年龄)→ 全条同尺寸、不逐粒子收尾，
    // 只能靠硬编码 stripRatio taper 凑，结果偏粗、跟 Unity 细弧不符。(p.normalizedAge 已由 Update 按 age/lifetime 设好)

${worldToLocal}${blockLines}    float halfWidth = max(${size}, 0.001) * ${scale}.x * 0.5;

    // strip 宽度完全由 per-particle size(size-over-life 曲线 × TrailsWideSize)控制，对齐 Unity。
    // 不再用硬编码 stripRatio taper —— 那是 head-based 时代的补偿(整条同 size 才需要硬 taper)。
    // 现在每粒子 size 随自身 age 变(曲线两端小)→ 自然收尾，得到 Unity 那种细弧。

    // Face Camera Position orient (matches Unity VFX strip orient)
    vec3 localCameraPos = transformPosition(u_InvEmitterWorldMatrix, u_OrientCameraPos);

    // Tangent + right 全部用 simulation position (= _simPos), neighbor 也是 simulation buffer 读.
    // 对齐 Unity vertex shader 行为: axis (来自 update orient block) 用 simulation tangent;
    // vertex pos = attributes.position (modified) + axis (simulation) * vOffset
    vec3 tangent = vec3(0.0);
    float _fwdLen = -1.0;
    float _bwdLen = -1.0;
    if (tid + 1u < particleCount) {
        uint nextIdx = stripIndex * ppsc + (firstIndex + tid + 1u) % ppsc;
        Particle nP = readParticle(nextIdx);
${worldToLocalNeighbor}        vec3 fwd = nP.position - _simPos;
        _fwdLen = length(fwd);
        if (_fwdLen > 1e-6) tangent += fwd / _fwdLen;
    }
    if (tid > 0u) {
        uint prevIdx = stripIndex * ppsc + (firstIndex + tid - 1u) % ppsc;
        Particle nP = readParticle(prevIdx);
${worldToLocalNeighbor}        vec3 bwd = _simPos - nP.position;
        _bwdLen = length(bwd);
        if (_bwdLen > 1e-6) tangent += bwd / _bwdLen;
    }
    float tangentLen = length(tangent);
    tangent = (tangentLen > 1e-6) ? tangent / tangentLen : vec3(0.0, 1.0, 0.0);

    // ── Chord cut (generation/wrap 隔离) ──
    // ring buffer 窗口中段若混进跨代/环回/陈旧槽位的粒子，会和邻居形成一条异常长的连线(chord)。
    // 判据：相邻段长 > 5× 另一侧(局部突变) 且 长边为绝对意义上的"长连线"(> _chordAbsMin) → chord 端点，collapse。
    //   加绝对长度门槛是因为：orbit 公转 ribbon 的前缘(刚 spawn 的头段≈0)会让"短段"侧触发 5× 比值，
    //   但那是正常细节、长边并不长 → 用 _chordAbsMin 排除，只切真正跨越缓冲的长 chord(TrailsWide 长亮直线)。
    // 均匀 ribbon(VFX11 等段长接近)两侧比值≈1，永不触发。
    float _chordAbsMin = 0.8;
    float _chordLong = max(_fwdLen, _bwdLen);
    bool _chordCut = (_fwdLen > 1e-6 && _bwdLen > 1e-6 && _chordLong > _chordAbsMin && (_fwdLen > 5.0 * _bwdLen || _bwdLen > 5.0 * _fwdLen));
    if (_chordCut) {
        Render.data[stripVertBase + 0u] = vec4(p.position, 1.0);
        Render.data[stripVertBase + 1u] = vec4(0.0);
        Render.data[stripVertBase + 2u] = vec4(0.0);
        Render.data[stripVertBase + 3u] = vec4(0.0);
        Render.data[stripVertBase + 4u] = vec4(p.position, 1.0);
        Render.data[stripVertBase + 5u] = vec4(0.0);
        Render.data[stripVertBase + 6u] = vec4(0.0);
        Render.data[stripVertBase + 7u] = vec4(0.0);
        return;
    }

    // toCamRaw 用 simulation 让 right vector 始终基于 simulation 几何 (跟 tangent 一致, 不被 noise drift 影响)
    vec3 toCamRaw = _simPos - localCameraPos;
    vec3 toCamera = normalize(toCamRaw);

    // Strip perpendicular: cross(toCam, tangent), 确保 bitangent 始终朝向相机防止翻转
    vec3 rawRight = cross(toCamRaw, tangent);
    float sqLen = dot(rawRight, rawRight);
    vec3 rightDir = (sqLen > 1e-5) ? rawRight * inversesqrt(sqLen) : vec3(0.0, 1.0, 0.0);
    // 一致性检查：bitangent = cross(tangent, right) 必须朝向相机
    vec3 biTangent = cross(tangent, rightDir);
    if (dot(biTangent, toCamRaw) < 0.0) rightDir = -rightDir;

    vec3 right = rightDir * halfWidth;

    // 动态 UV scroll (对齐 Unity uvBias.x/y 接 add(TotalTime, Random) 让 ribbon 颜色流动):
    // u = stripRatio + (TotalTime*speed + perStripRandom)
    // perStripRandom = mix(min, max, hash(stripIndex)) - 让不同 strip 不同 phase
    float u = stripRatio${uvBiasScrollX ? ` + u_TotalTime * ${uvBiasScrollX.speed.toFixed(4)} + mix(${uvBiasScrollX.randomMin.toFixed(4)}, ${uvBiasScrollX.randomMax.toFixed(4)}, float(WangHash(stripIndex + 0xC0FFEE0u)) / 4294967295.0)` : ``};
    float v_top = 0.0${uvBiasScrollY ? ` + u_TotalTime * ${uvBiasScrollY.speed.toFixed(4)} + mix(${uvBiasScrollY.randomMin.toFixed(4)}, ${uvBiasScrollY.randomMax.toFixed(4)}, float(WangHash(stripIndex + 0xBADD00Du)) / 4294967295.0)` : ``};
    float v_bot = 1.0${uvBiasScrollY ? ` + u_TotalTime * ${uvBiasScrollY.speed.toFixed(4)} + mix(${uvBiasScrollY.randomMin.toFixed(4)}, ${uvBiasScrollY.randomMax.toFixed(4)}, float(WangHash(stripIndex + 0xBADD00Du)) / 4294967295.0)` : ``};

    // alpha 由 per-particle alpha-over-life 曲线控制(对齐 Unity strip)。
    // 之前 GPU event 路径额外 *= stripRatio 按位置二次衰减 —— 在 per-particle 下会与曲线尾部淡出叠成双重淡出。
    float finalAlpha = ${alpha};

    // Write two vertices (top & bottom of strip)
    Render.data[stripVertBase + 0u] = vec4(p.position + right, 1.0);
    Render.data[stripVertBase + 1u] = vec4(${colorRGB}, finalAlpha);
    Render.data[stripVertBase + 2u] = vec4(u, v_top, 0.0, 0.0);
    Render.data[stripVertBase + 3u] = vec4(toCamera, 0.0);

    Render.data[stripVertBase + 4u] = vec4(p.position - right, 1.0);
    Render.data[stripVertBase + 5u] = vec4(${colorRGB}, finalAlpha);
    Render.data[stripVertBase + 6u] = vec4(u, v_bot, 0.0, 0.0);
    Render.data[stripVertBase + 7u] = vec4(toCamera, 0.0);
}

#endGLSL

GLSL End
`;
}
