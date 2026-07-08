import type { IVfxBlockData } from "../../data/VfxTypes";
import type { IPackEntry } from "./VFXCommon";
import { GPU_EVENT_TEMPLATES } from "./GPUEventTemplates";
import type { ITriggerEventInfo } from "./Update";
import type { VfxExprCompiler } from "../VfxExprCompiler";
import { blocksNeedSeed, genBlockCode } from "./BlockCodeGenCommon";

const INIT_BLOCK_OPTS = { particleVar: "particle", supportSource: true, includeShape: true } as const;

export function generateInitialize(shaderName: string, common: string, blocks: IVfxBlockData[], attrNames?: Set<string>, triggerEvents?: ITriggerEventInfo[], contextId?: number, compiler?: VfxExprCompiler, simulateSpace?: string, useStripRingBuffer?: boolean, hasSourceAttrs?: boolean, operators?: { typeId: string }[], sourceAttrNames?: Set<string>): string {
    const blockCode = genBlockCode(blocks, { ...INIT_BLOCK_OPTS, hasStripIndex: !!useStripRingBuffer }, contextId, compiler, simulateSpace);
    // needSource: init 块直接 setAttribute(source=Source) 或者 op 链有 getAttribute(location=Source)
    // 让 src.<attr> 引用前先声明 SourceEventData src
    const needSource = blocks.some(b => b.enabled && b.typeId === "setAttribute" && b.props?.source === "Source")
        || !!hasSourceAttrs;
    const needSeed = blocksNeedSeed(blocks, true, operators);
    const hasAttr = (n: string) => !attrNames || attrNames.has(n);
    // 多 burst (Unity SpawnContext) 用 PrefixSum 二分找 thread 所属 event：
    //   PrefixSum[i] = sum(spawnCounts[0..i-1])，让 thread.id 落在 [PrefixSum[i], PrefixSum[i+1]) 用 events[i]
    // 之前 hardcode eventIndex=0u 让所有 burst 粒子都读 events[0] 同一 src.texIndex/lifetime/color，
    // 多 burst 跨 loop 切换 src 字段时所有粒子用同一 (最近) entry 视觉永远不切换。
    const srcCode = needSource
        ? `\n    // Find source event index by binary searching PrefixSum (multi-burst aware)\n    uint eventIndex = 0u;\n    {\n        uint lo = 0u; uint hi = uint(u_EventCount);\n        while (lo + 1u < hi) {\n            uint mid = (lo + hi) >> 1u;\n            if (id >= PrefixSum.sums[mid]) lo = mid;\n            else hi = mid;\n        }\n        eventIndex = lo;\n    }\n    SourceEventData src = SourceAttributes.events[eventIndex];\n`
        : "";

    // ── GPU Event 累加器布局 ──
    const events = triggerEvents || [];
    let totalAccSlots = 0;
    const eventLayouts: { info: ITriggerEventInfo; accOffset: number }[] = [];
    for (const info of events) {
        const tmpl = GPU_EVENT_TEMPLATES[info.eventType];
        if (!tmpl || tmpl.accSlotsPerParticle === 0) continue;
        eventLayouts.push({ info, accOffset: totalAccSlots });
        totalAccSlots += tmpl.accSlotsPerParticle;
    }

    // AccumulatorBuffer 声明 + 清零代码
    let accBufferDecl = "";
    const accClearLines: string[] = [];
    if (totalAccSlots > 0) {
        accBufferDecl = "\n// GPU Event Accumulator\nbuffer AccumulatorBuffer { float data[]; } Accumulators;\n";
        accClearLines.push("");
        accClearLines.push("    // Clear GPU Event accumulators");
        for (const { info, accOffset } of eventLayouts) {
            const tmpl = GPU_EVENT_TEMPLATES[info.eventType];
            accClearLines.push(tmpl.genInitClearSnippet({ accOffset, totalAccSlots }));
        }
    }
    const accClearCode = accClearLines.join("\n");

    // 隐式属性初始化代码
    const implicitLines: string[] = [];
    if (needSeed) {
        // 用单调 spawn id（id+累计总数）而非槽位：槽位复用会让重生粒子拿到与前任完全相同的
        // seed（随机参数逐周期重复）。Unity 的 seed 同样基于单调 particleId。
        implicitLines.push("    // Initialize random seed (stateful RNG, each Rand() call advances seed)");
        implicitLines.push("    particle.seed = WangHash((id + uint(u_TotalSpawnedCount)) ^ uint(u_SystemSeed));");
    }
    if (hasAttr("particleId")) {
        // particleId 是粒子系统单调累计的总 ID（对齐 Unity attribute "particleId"）
        implicitLines.push("    particle.particleId = id + uint(u_TotalSpawnedCount);");
    }
    if (hasAttr("spawnIndex")) {
        // spawnIndex = 当前 spawn batch 内的索引 [0, u_SpawnedCount)，对齐 Unity attribute "spawnIndex"
        // ⚠️ 不能用 `id + u_TotalSpawnedCount`（累计），否则 PositionSequential / countPerLine 公式
        //   t = spawnIndex / (countPerLine-1) 会让每 loop 的粒子分布到 line 不同位置；
        //   Unity 同 batch 多颗粒子应叠在 line 起始几个槽位（因为 Unity spawnIndex 是 batch-local）。
        implicitLines.push("    particle.spawnIndex = id;");
    }
    if (useStripRingBuffer) {
        // useStripRingBuffer 时 stripIndex / particleIndexInStrip 永远写入（即使 attrNames 不显式包含）
        // 因为 setPositionShape Custom + perStripRand 用 particle.stripIndex 作 hash seed，
        // 不写它会让所有 strip 用 stripIndex=0 hash 让所有粒子塌缩到圆周同一点
        implicitLines.push("    particle.stripIndex = stripIdx;");
        // particleIndexInStrip = relativeIndex(本 strip 内 claim 顺序 0..ppsc-1),严格对齐 Unity。
        // Unity VFXParticleStripCommon.hlsl: particleIndexInStrip = GetRelativeIndex(slot)
        //   = (cap + slot - firstIndex)%cap，init 时恰 = relativeIndex；且 = 渲染走线序(OutputStrip 的 tid)。
        // 用户算子(如 Gateway Bronze VFX10 的 bezier: t = particleIndexInStrip/15)按它定位粒子，
        //   relativeIndex 跨 ring 滚动仍与渲染序一致 → 平滑弧。
        // ⛔ 不能用存储槽 (ringFirst+relIdx)%ppsc：strip 复用使 firstIndex≠0 时 slot≠relativeIndex →
        //   bezier 位置按 slot 排、渲染按 tid 连 → 乱序跨屏线(VFX10 乱线根因)。
        //   (stripRatio 已改用渲染 tid，不再读此属性，故不会回归 ribbon 三角块。)
        implicitLines.push("    particle.particleIndexInStrip = relativeIndex;");
    }
    const implicitCode = implicitLines.length > 0 ? "\n" + implicitLines.join("\n") + "\n" : "";

    // Sub-frame spawn integration（对齐 Unity VFX）：本帧 spawn 的多个粒子按 sub-frame 时间均匀分布
    // 在过去 dt 内，并按 sub-frame age 预进 position。
    const subFrameCode = (hasAttr("position") && hasAttr("velocity"))
        ? `\n    // Sub-frame spawn integration\n    {\n        float _initSubAge = (1.0 - (float(id) + 0.5) / max(float(u_SpawnedCount), 1.0)) * u_DeltaTime;\n        particle.position += particle.velocity * _initSubAge;\n    }\n`
        : "";

    const stripBufferDecl = useStripRingBuffer
        ? "\n// Strip Ring Buffer data (4 uint per strip: firstIndex, nextIndex, snapFirst, snapNext)\nbuffer StripDataBuffer { uint data[]; } StripData;\n"
        : "";

    const stripUniforms = useStripRingBuffer
        ? `,
            u_StripCapacity: { type: "Int" },
            u_ParticlePerStrip: { type: "Int" }`
        : "";

    // Strip 分配（对齐 Unity VFXInit.template line 165: stripIndex = sourceIndex）：
    //   1) 优先 source.texIndex（PeriodicBurst sample 用 SetSpawnEventAttribute useLoopIndex 让 1 burst 1 strip）
    //   2) fallback 用 id % stripCap (= Unity sourceIndex per-burst 行为)
    // 配合 update 阶段动态重算 particleIndexInStrip = GetRelativeIndex（ring 内位置）让 stripRatio 沿 ribbon 平滑.
    // ⚠️ events[0].texIndex 引用必须满足两点：(1) needSource=true (SourceEventData 生成且 events[] 存在)，
    //    (2) source attr 真实包含 texIndex (PeriodicBurst 用 setSpawnEventAttribute(texIndex))。
    //    否则 SourceAttributeBuffer 没 events 字段或 SourceEventData 没 texIndex 字段都会编译失败。
    const hasSourceTexIndex = needSource && !!sourceAttrNames?.has("texIndex");
    const stripAllocLine = useStripRingBuffer && hasSourceTexIndex
        ? `    uint stripIdx = uint(SourceAttributes.events[0u].texIndex) % uint(u_StripCapacity);`
        : `    uint stripIdx = id % uint(u_StripCapacity);`;
    const allocCode = useStripRingBuffer ? `\
    // Ring Buffer allocation
${stripAllocLine}
    uint ppsc = uint(u_ParticlePerStrip);

    // Atomically increment nextIndex to claim a slot
    uint relativeIndex = atomicAdd(StripData.data[stripIdx * 5u + 1u], 1u);
    if (relativeIndex >= ppsc) {
        // Roll back: use atomicAdd(-1) to safely undo the increment
        atomicAdd(StripData.data[stripIdx * 5u + 1u], 4294967295u); // -1 as uint
        return;
    }

    // Compute actual particle index in the ring buffer
    uint ringFirst = StripData.data[stripIdx * 5u];
    uint particleIndex = stripIdx * ppsc + (ringFirst + relativeIndex) % ppsc;

    // Add to AliveList
    uint aliveIndex = atomicAdd(AliveListWrite.count, 1u);
    AliveListWrite.indices[aliveIndex] = particleIndex;` : `\
    // Get free slot from DeadList
    uint deadCount = atomicAdd(DeadList.count, -1);
    if (deadCount == 0u || deadCount > uint(u_Capacity)) {
        atomicAdd(DeadList.count, 1);
        return;
    }
    uint particleIndex = DeadList.indices[deadCount - 1];

    // Add to AliveList
    uint aliveIndex = atomicAdd(AliveListWrite.count, 1);
    AliveListWrite.indices[aliveIndex] = particleIndex;`;

    return `\
Shader3D Start
{
    type: ComputeShader,
    name: "${shaderName}",
    uniformMaps: [
        {
            u_Capacity: { type: "Int" },
            u_SpawnedCount: { type: "Int" },
            u_SystemSeed: { type: Int },
            u_EventCount: { type: Int },
            u_TotalSpawnedCount: { type: Int },
            u_LoopIndex: { type: "Int" },
            u_TotalTime: { type: "Float" },
            u_DeltaTime: { type: "Float" },
            u_NewLoop: { type: "Int" },
            u_LoopState: { type: "Int" },
            u_SpawnCount: { type: "Float" },
            u_SpawnDeltaTime: { type: "Float" },
            u_SpawnTotalTime: { type: "Float" },
            u_LoopDuration: { type: "Float" },
            u_LoopCount: { type: "Int" },
            u_DelayBeforeLoop: { type: "Float" },
            u_DelayAfterLoop: { type: "Float" }${stripUniforms},
            u_EmitterWorldMatrix: { type: "Matrix4x4" },
            u_InvEmitterWorldMatrix: { type: "Matrix4x4" }/*VFX_EXTRA_UNIFORMS*/
        }
    ],
    code: "Initialize_CS"
}
Shader3D End

GLSL Start

#defineGLSL Initialize_CS

${common}
/*VFX_CURVE_FUNC*/
/*VFX_STORAGE_BUFFERS*/
${accBufferDecl}${stripBufferDecl}
#define NB_THREADS_PER_GROUP 64
layout(local_size_x = NB_THREADS_PER_GROUP, local_size_y = 1, local_size_z = 1) in;

void main()
{
    uint id = gl_LocalInvocationID.x + gl_WorkGroupID.x * NB_THREADS_PER_GROUP;

    if (id >= u_SpawnedCount) {
        return;
    }

    ${allocCode}

${srcCode}
    // Initialize particle attributes (get defaults, then override)
    Particle particle = defaultParticle();
${implicitCode}${blockCode}${subFrameCode}
${accClearCode}

    writeParticle(particleIndex, particle);
}

#endGLSL

GLSL End`;
}

/**
 * 生成从 SourceParticleBuffer 读取源粒子的函数。
 * entries 和 sourceStride 来自**源系统**的属性布局，
 * 与当前系统的 PARTICLE_STRIDE / readParticle 布局无关。
 */
function genReadSourceParticle(entries: IPackEntry[], sourceStride: number, receiverAttrNames: Set<string>): string {
    // 只读取接收端 Particle struct 也拥有的属性
    const filtered = entries.filter(e => receiverAttrNames.has(e.name));
    const has = (n: string) => filtered.some(e => e.name === n);
    const lines: string[] = [];
    lines.push("Particle readSourceParticle(uint particleIndex)");
    lines.push("{");
    lines.push(`    uint base = particleIndex * ${sourceStride}u;`);

    const usedSlots = [...new Set(filtered.map(e => e.slot))].sort((a, b) => a - b);
    for (const s of usedSlots) {
        lines.push(`    vec4 v${s} = SourceParticles.data[base + ${s}u];`);
    }

    lines.push("");
    // 用 defaultParticle() 初始化避免未读字段未初始化（GLSL/WGSL 未初始化局部变量行为未定义，
    // 实测 alpha 等会被当成 0 → strip output finalAlpha = alpha * stripRatio = 0 → 完全透明）。
    // receiver 端 setAttribute(attr, source=Source) 引用 src.<attr> 时，如果 source 没该 attribute，
    // src.<attr> 自动取 defaultParticle 的合理默认（alpha=1, color=white, size=0.1 等）。
    lines.push("    Particle p = defaultParticle();");
    for (const e of filtered) {
        if (e.type === "uint") {
            lines.push(`    p.${e.name} = uint(v${e.slot}${e.swizzle});`);
        } else if (e.type === "bool") {
            lines.push(`    p.${e.name} = v${e.slot}${e.swizzle} > 0.5;`);
        } else {
            lines.push(`    p.${e.name} = v${e.slot}${e.swizzle};`);
        }
    }

    if (receiverAttrNames.has("oldPosition")) {
        lines.push(has("position") ? "    p.oldPosition = p.position;" : "    p.oldPosition = vec3(0.0);");
    }
    lines.push("    return p;");
    lines.push("}");
    return lines.join("\n");
}

/**
 * GPU Initialize shader — 接收 GPU Event 的粒子系统初始化
 * 与 CPU Initialize 的区别：
 *   - include VFXGPUEvent.glsl (EventIndexBuffer + GPUEventDispatchBuffer)
 *   - 数据源: SourceParticleBuffer (源系统 AttributeBuffer) 而非 SourceAttributeBuffer
 *   - uniform: u_MaxSpawnCount 而非 u_SpawnedCount/u_EventCount
 *   - 线程控制: min(GPUEvent.count, u_MaxSpawnCount) 而非 u_SpawnedCount
 *   - 无累加器清零
 */
export function generateGPUInitialize(
    shaderName: string,
    common: string,
    blocks: IVfxBlockData[],
    attrNames: Set<string> | undefined,
    sourcePackEntries: IPackEntry[],
    sourceStride: number,
    contextId?: number,
    compiler?: VfxExprCompiler,
    simulateSpace?: string,
    _sourceSimulateSpace?: string,
    useStripRingBuffer?: boolean,
    hasSourceAttrs?: boolean,
): string {
    const receiverSpace = simulateSpace ?? "Local";
    const isReceiverWorld = receiverSpace === "World";
    let blockCode = genBlockCode(blocks, INIT_BLOCK_OPTS, contextId, compiler, simulateSpace);
    // GPU strip init 路径下 u_TotalSpawnedCount 不会正确累加（GPU dispatchIndirect, CPU 不知道 spawn 数）
    // → positionSequential 的 _psId = id + u_TotalSpawnedCount 永远只是 id (0..eventCount-1)
    // → 多帧 spawn 出来的粒子全堆在前几个角度
    // 修复：strip ring buffer 里 particleIndex 是 0..ppsc-1 唯一的 slot 索引，用它替代 _psId
    if (useStripRingBuffer) {
        blockCode = blockCode.replace(/uint _psId = id \+ uint\(u_TotalSpawnedCount\);/g,
            "uint _psId = particleIndex;  // GPU strip: 用 ring buffer slot 索引保证 _psId 全圆周唯一");
    }
    // strip 跨代复用修复：source emitter 若带 particleId(= id+u_TotalSpawnedCount, init 设定一次的稳定全局单调 head-ID),
    // 用 src.particleId % stripCapacity 分配 strip —— 同 head 的 trail 共享 → 同 strip；不同 head → 不同 strip；
    // 同槽复用要 256 head(远超 trail 寿命)后才碰撞 → 永不跨代。否则回退旧的 sourceParticleIndex(可复用,会跨代)。
    const sourceHasParticleId = (sourcePackEntries || []).some(e => e.name === "particleId");
    const stripHeadIdExpr = sourceHasParticleId
        ? "readSourceParticle(sourceParticleIndex).particleId"
        : "sourceParticleIndex";
    // needSource: init 块 setAttribute(source=Source) 或者 op 链有 getAttribute(location=Source)
    // 跟 CPU init 同语义；之前只看 block.source 漏 op 链让 _op = src.position 这种引用 src 但
    // 没声明 Particle src → 编译错 "src undeclared identifier"（TriggerEventCollide system 2 根因）
    const needSource = blocks.some(b => b.enabled && b.typeId === "setAttribute" && b.props?.source === "Source")
        || !!hasSourceAttrs;
    const needSeed = blocksNeedSeed(blocks);
    const hasAttr = (n: string) => !attrNames || attrNames.has(n);

    // SourceParticleBuffer + readSourceParticle 必须仅在实际被调用时才生成：
    // glslang.preprocess_compute 通过可达性检测 SSBO，未调用 → 不注册到 ssboBindingMap
    // → ssboStrings 把整段 buffer 声明删掉 → 函数体仍引用 SourceParticles → undeclared identifier。
    // 实际调用点：
    //   1) needSource: setAttribute(source="Source") 触发 srcCode 里的 readSourceParticle 调用
    //   2) useStripRingBuffer: strip safety check (lifetime fallback) + implicit stripGeneration/headDeathTime
    const needsSourceRead = needSource || useStripRingBuffer;
    const sourceParticleCode = needsSourceRead
        ? genReadSourceParticle(sourcePackEntries, sourceStride, attrNames || new Set())
        : "";

    const srcCode = needSource
        ? `\n    // Inherit attributes from source particle\n    Particle src = readSourceParticle(sourceParticleIndex);\n`
        : "";

    // 隐式属性初始化代码
    const implicitLines: string[] = [];
    if (needSeed) {
        // GPU 事件没有 CPU 侧单调 spawn 计数，掺 u_TotalTime 时间盐：
        // 槽位复用（短命中继粒子每帧死亡重生同一批槽位）会让纯槽位 seed 每帧重复，
        // 圆周随机角等逐帧同值。
        implicitLines.push("    // Initialize random seed (slot ^ systemSeed ^ time-salt, 防槽位复用 seed 重复)");
        implicitLines.push("    particle.seed = WangHash(particleIndex ^ uint(u_SystemSeed) ^ floatBitsToUint(u_TotalTime));");
    }
    if (hasAttr("particleId")) {
        implicitLines.push("    particle.particleId = id;");
    }
    if (hasAttr("spawnIndex")) {
        implicitLines.push("    particle.spawnIndex = id;");
    }
    // stripGeneration: head 出生时间，所有来自同一 head 的 trail 共享
    if (hasAttr("stripGeneration")) {
        implicitLines.push("    particle.stripGeneration = u_TotalTime - readSourceParticle(sourceParticleIndex).age;");
    }
    // headDeathTime: head 死亡时间 = headBirthTime + headLifetime，用于精确同步 trail 透明度衰减
    if (hasAttr("headDeathTime")) {
        implicitLines.push("    // headDeathTime = headBirthTime + headLifetime = (u_TotalTime - src.age) + src.lifetime");
        implicitLines.push("    particle.headDeathTime = u_TotalTime - readSourceParticle(sourceParticleIndex).age + readSourceParticle(sourceParticleIndex).lifetime;");
    }
    // stripIndex: 用稳定单调 head-ID(src.particleId, 见上方 stripHeadIdExpr)分配，保证同一 head 的 trail
    // 进同一 strip、不同 head 进不同 strip、复用槽位不跨代。必须与 allocCode 的 stripIdx 用同一表达式保持一致。
    if (hasAttr("stripIndex")) {
        implicitLines.push(`    particle.stripIndex = (${stripHeadIdExpr}) % uint(u_StripCapacity);`);
    }
    // particleIndexInStrip = relativeIndex(claim 顺序),严格对齐 Unity GetRelativeIndex(详见上方 CPU 路径注释)。
    // 与 stripIndex 同样必须由 GPU init 写。
    if (hasAttr("particleIndexInStrip")) {
        implicitLines.push("    particle.particleIndexInStrip = relativeIndex;");
    }
    const implicitCode = implicitLines.length > 0 ? "\n" + implicitLines.join("\n") + "\n" : "";

    const stripBufferDecl = useStripRingBuffer
        ? "\n// Strip Ring Buffer data (4 uint per strip: firstIndex, nextIndex, snapFirst, snapNext)\nbuffer StripDataBuffer { uint data[]; } StripData;\n"
        : "";

    const allocCode = useStripRingBuffer ? `
    // Index source particle via EventIndexBuffer
    uint sourceParticleIndex = GPUEvent.indices[id];

    // Ring Buffer allocation —— stripIdx 用稳定单调 head-ID(避免 emitter 槽位复用导致 strip 跨代混用)
    uint stripIdx = (${stripHeadIdExpr}) % uint(u_StripCapacity);
    uint ppsc = uint(u_ParticlePerStrip);

    // Atomically increment nextIndex to claim a slot
    uint relativeIndex = atomicAdd(StripData.data[stripIdx * 5u + 1u], 1u);
    if (relativeIndex >= ppsc) {
        // Strip is full, roll back
        StripData.data[stripIdx * 5u + 1u] = ppsc;
        return;
    }

    // Compute actual particle index in the ring buffer
    uint ringFirst = StripData.data[stripIdx * 5u];
    uint particleIndex = stripIdx * ppsc + (ringFirst + relativeIndex) % ppsc;

    // Add to AliveList
    uint aliveIndex = atomicAdd(AliveListWrite.count, 1u);
    AliveListWrite.indices[aliveIndex] = particleIndex;
` : `
    // Index source particle via EventIndexBuffer
    uint sourceParticleIndex = GPUEvent.indices[id];

    // Get free slot from DeadList
    uint deadCount = atomicAdd(DeadList.count, -1);
    if (deadCount == 0u || deadCount > uint(u_Capacity)) {
        atomicAdd(DeadList.count, 1);
        return;
    }
    uint particleIndex = DeadList.indices[deadCount - 1];

    // Add to AliveList
    uint aliveIndex = atomicAdd(AliveListWrite.count, 1u);
    AliveListWrite.indices[aliveIndex] = particleIndex;
`;

    return `\
Shader3D Start
{
    type: ComputeShader,
    name: "${shaderName}",
    uniformMaps: [
        {
            u_Capacity: { type: "Int" },
            u_MaxSpawnCount: { type: "Int" },
            u_SystemSeed: { type: "Int" },
            u_TotalTime: { type: "Float" },
            u_TotalSpawnedCount: { type: "Int" },
            u_StripCapacity: { type: "Int" },
            u_ParticlePerStrip: { type: "Int" },
            u_EmitterWorldMatrix: { type: "Matrix4x4" },
            u_InvEmitterWorldMatrix: { type: "Matrix4x4" },
            u_SourceSimulateSpace: { type: "Int" }/*VFX_EXTRA_UNIFORMS*/
        }
    ],
    code: "GPUInitialize_CS"
}
Shader3D End

GLSL Start

#defineGLSL GPUInitialize_CS

${common}
/*VFX_CURVE_FUNC*/
/*VFX_STORAGE_BUFFERS*/

#include "VFXGPUEvent.glsl"
${needsSourceRead ? `
// Source system AttributeBuffer (read-only, source system layout)
buffer SourceParticleBuffer
{
    vec4 data[];
}
SourceParticles;
` : ""}${stripBufferDecl}${needsSourceRead ? `
// Read particle from SourceParticleBuffer (source layout, only receiver-owned attributes)
${sourceParticleCode}` : ""}

#define NB_THREADS_PER_GROUP 64
layout(local_size_x = NB_THREADS_PER_GROUP, local_size_y = 1, local_size_z = 1) in;

void main()
{
    uint id = gl_LocalInvocationID.x + gl_WorkGroupID.x * NB_THREADS_PER_GROUP;

    // GPU Event thread control: determined by EventIndexBuffer.count
    uint eventCount = GPUEvent.count;
    uint totalSpawn = min(eventCount, uint(u_MaxSpawnCount));

    if (id >= totalSpawn) {
        return;
    }
${allocCode}
${srcCode}
    // Initialize particle attributes (get defaults, then override)
    Particle particle = defaultParticle();
${implicitCode}${blockCode}
${useStripRingBuffer && hasAttr("lifetime") ? `
    // Strip safety: Unity OnDie event 模式常见的 \`source.lifetime - source.age\` 计算
    // 在 source 死亡瞬间结果 = 0（因为 Laya readSourceParticle 读 post-update 状态，src.age 已 = src.lifetime）
    // → strip 粒子瞬死 → ring buffer 永远空 → strip 看不见
    // 兜底：若 lifetime <= 0，回退到 source 的完整 lifetime，让 ring buffer 有机会工作
    if (particle.lifetime <= 0.0) {
        particle.lifetime = max(readSourceParticle(sourceParticleIndex).lifetime, 0.001);
    }
` : ""}${hasAttr("position") ? (isReceiverWorld
    ? `
    // Receiver is World: convert Local source to World, inherit World directly
    if (u_SourceSimulateSpace == 0) {
        particle.position = transformPosition(u_EmitterWorldMatrix, particle.position);
    }`
    : `
    // Receiver is Local: convert World source to Local, inherit Local directly
    if (u_SourceSimulateSpace == 1) {
        particle.position = transformPosition(u_InvEmitterWorldMatrix, particle.position);
    }`) : ""}

    writeParticle(particleIndex, particle);
}

#endGLSL

GLSL End`;
}
