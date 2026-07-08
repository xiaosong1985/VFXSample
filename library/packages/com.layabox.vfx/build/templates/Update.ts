import type { IVfxBlockData } from "../../data/VfxTypes";
import { GPU_EVENT_TEMPLATES, type IGPUEventTemplate } from "./GPUEventTemplates";
import { OUTPUT_EVENT_TEMPLATES, type IOutputEventTemplate } from "./OutputEventTemplates";
import type { VfxExprCompiler } from "../VfxExprCompiler";
import { blocksNeedSeed, genBlockCode } from "./BlockCodeGenCommon";

const UPDATE_BLOCK_OPTS = { particleVar: "p", supportSource: false, sourceUnavailableComment: "(Source not available in Update stage)", includeShape: true } as const;

/** triggerEvent block 编译后的描述 */
export interface ITriggerEventInfo {
    eventIdx: number;       // 在此 Update 中的序号 (0, 1, 2...)
    eventType: string;      // "OnDie" / "OverTime" / ...
    param: number;          // 硬编码到 GLSL 的参数值
}

/** triggerEvent block 路由到 outputEvent context 的描述（CPU readback 通知） */
export interface IOutputEventInfo {
    eventIdx: number;       // 在此 Update 中的序号 (0, 1, 2...)
    eventType: string;      // "OnDie" / "Always" / "OverTime" / "OverDistance"
    param: number;
    eventName: string;      // CPU 派发的事件名（"OnDie" 等）
    capacity: number;       // 缓冲容量上限
    blockId: number;
}

export function generateUpdate(shaderName: string, common: string, blocks: IVfxBlockData[], triggerEvents?: ITriggerEventInfo[], contextId?: number, compiler?: VfxExprCompiler, skipZeroDeltaTime?: boolean, simulateSpace?: string, useStripRingBuffer?: boolean, outputEvents?: IOutputEventInfo[], attrNames?: Set<string>): string {
    const needsDepthBuffer = blocks.some(b => b.enabled !== false && b.typeId === "collisionDepthBuffer");
    const blockCode = genBlockCode(blocks, { ...UPDATE_BLOCK_OPTS, hasStripIndex: !!useStripRingBuffer }, contextId, compiler, simulateSpace);
    const needSeed = blocksNeedSeed(blocks);
    const events = triggerEvents || [];
    const hasEvents = events.length > 0;
    const oeEvents = outputEvents || [];
    const hasOutputEvents = oeEvents.length > 0;

    // ── GPU Event: 计算累加器布局 ──
    let totalAccSlots = 0;
    const eventLayouts: { info: ITriggerEventInfo; template: IGPUEventTemplate; accOffset: number }[] = [];
    for (const info of events) {
        const tmpl = GPU_EVENT_TEMPLATES[info.eventType];
        if (!tmpl) continue;
        eventLayouts.push({ info, template: tmpl, accOffset: totalAccSlots });
        totalAccSlots += tmpl.accSlotsPerParticle;
    }

    // ── GPU Event: buffer 声明 ──
    const eventBufferDecls: string[] = [];
    if (hasEvents) {
        for (const { info } of eventLayouts) {
            eventBufferDecls.push(`buffer EventIndexBuffer_${info.eventIdx} { uint count; uint indices[]; } GPUEvent${info.eventIdx};`);
        }
        if (totalAccSlots > 0) {
            eventBufferDecls.push(`\nbuffer AccumulatorBuffer { float data[]; } Accumulators;`);
        }
    }

    // ── Output Event: 累加器布局（独立于 GPU Event） ──
    let totalOEAccSlots = 0;
    const oeLayouts: { info: IOutputEventInfo; template: IOutputEventTemplate; accOffset: number }[] = [];
    for (const info of oeEvents) {
        const tmpl = OUTPUT_EVENT_TEMPLATES[info.eventType];
        if (!tmpl) continue;
        oeLayouts.push({ info, template: tmpl, accOffset: totalOEAccSlots });
        totalOEAccSlots += tmpl.accSlotsPerParticle;
    }

    // ── Output Event: buffer 声明 ──
    if (hasOutputEvents) {
        for (const { info } of oeLayouts) {
            eventBufferDecls.push(`buffer OutputEventBuffer_${info.eventIdx} { uint count; float data[]; } OutputEvent${info.eventIdx};`);
        }
        if (totalOEAccSlots > 0) {
            eventBufferDecls.push(`\nbuffer OutputEventAccumulatorBuffer { float data[]; } AccumulatorsOE;`);
        }
    }

    const eventBufferCode = eventBufferDecls.length > 0
        ? "\n// Event buffers (GPU + Output)\n" + eventBufferDecls.join("\n") + "\n"
        : "";

    // ── 重置：aliveIndex==0 清零所有 event buffer 的 count ──
    const resetLines: string[] = [];
    if (hasEvents || hasOutputEvents) {
        resetLines.push("    // Reset all event buffer counts each frame");
        resetLines.push("    if (aliveIndex == 0u) {");
        for (const { info } of eventLayouts) {
            resetLines.push(`        GPUEvent${info.eventIdx}.count = 0u;`);
        }
        for (const { info } of oeLayouts) {
            resetLines.push(`        OutputEvent${info.eventIdx}.count = 0u;`);
        }
        resetLines.push("    }");
    }
    const resetCode = resetLines.length > 0 ? "\n" + resetLines.join("\n") + "\n" : "";

    // ── GPU Event: 事件输出代码片段 ──
    const eventSnippets: string[] = [];
    if (hasEvents) {
        eventSnippets.push("");
        eventSnippets.push("    // 5. GPU Event Output");
        for (const { info, template: tmpl, accOffset } of eventLayouts) {
            eventSnippets.push(tmpl.genUpdateSnippet({
                eventIdx: info.eventIdx,
                accOffset,
                totalAccSlots,
                paramValue: info.param,
                bufferName: `GPUEvent${info.eventIdx}`,
            }));
        }
    }
    if (hasOutputEvents) {
        eventSnippets.push("");
        eventSnippets.push("    // 6. Output Event (CPU readback)");
        for (const { info, template: tmpl, accOffset } of oeLayouts) {
            const accExpr = totalOEAccSlots > 1
                ? `particleIndex * ${totalOEAccSlots}u + ${accOffset}u`
                : `particleIndex`;
            eventSnippets.push(tmpl.genUpdateSnippet({
                eventIdx: info.eventIdx,
                capacity: info.capacity,
                bufferName: `OutputEvent${info.eventIdx}`,
                paramValue: info.param,
                accExpr,
                attrNames,
            }));
        }
    }
    const eventOutputCode = eventSnippets.join("\n");

    const stripBufferDecl = useStripRingBuffer
        ? "\n// Strip Ring Buffer data (5 uint per strip)\nbuffer StripDataBuffer { uint data[]; } StripData;\n"
        : "";

    const doSkipZeroDt = skipZeroDeltaTime ?? false;
    const dtGuardOpen = doSkipZeroDt ? "\n    // Skip Zero Delta Time\n    if (u_DeltaTime != 0.0) {\n" : "";
    const dtGuardClose = doSkipZeroDt ? "\n    }" : "";
    const dtIndent = doSkipZeroDt ? "    " : "";

    return `\
Shader3D Start
{
    type: ComputeShader,
    name: "${shaderName}",
    uniformMaps: [
        {
            u_Capacity: { type: "Int" },
            u_DeltaTime: { type: "Float" },
            u_TotalTime: { type: "Float" },${useStripRingBuffer ? `
            u_StripCapacity: { type: "Int" },
            u_ParticlePerStrip: { type: "Int" },` : ``}
            u_EmitterWorldMatrix: { type: "Matrix4x4" },
            u_InvEmitterWorldMatrix: { type: "Matrix4x4" }${needsDepthBuffer ? `,
            u_CameraDepthTexture: { type: "Texture2D" },
            u_VfxViewProjection: { type: "Matrix4x4" },
            u_VfxInvViewProjection: { type: "Matrix4x4" },
            u_VfxCameraParams: { type: "Vector4" },
            u_VfxCameraParams2: { type: "Vector4" },
            u_VfxCameraParams3: { type: "Vector4" }` : ``}/*VFX_EXTRA_UNIFORMS*/
        }
    ],
    code: "Update_CS"
}
Shader3D End

GLSL Start

#defineGLSL Update_CS

${common}
/*VFX_CURVE_FUNC*/
/*VFX_STORAGE_BUFFERS*/

${eventBufferCode}${stripBufferDecl}
#define NB_THREADS_PER_GROUP 64
layout(local_size_x = NB_THREADS_PER_GROUP, local_size_y = 1, local_size_z = 1) in;

${useStripRingBuffer ? `void main()
{
    // Strip ring buffer mode: 遍历整个 capacity，让 ring buffer 内死粒子也参与 atomicMin
    // (对齐 Unity update phase: 死粒子 alive=false 时 atomicMin 仍写当前粒子的 relInRing)
    uint particleIndex = gl_LocalInvocationID.x + gl_WorkGroupID.x * NB_THREADS_PER_GROUP;
    uint aliveIndex = particleIndex;  // (resetCode 用 aliveIndex==0u 约定，需保留别名)
${resetCode}
    if (particleIndex >= uint(u_Capacity)) {
        return;
    }

    // 检查这个 slot 是否在 ring buffer 内 active 范围
    // ring buffer: relInRing ∈ [0, ringCount) 是 active；ringCount = StripData[base+1] (init 累的 nextIndex)
    uint _stripIdx = particleIndex / uint(u_ParticlePerStrip);
    uint _relIdx = particleIndex - _stripIdx * uint(u_ParticlePerStrip);
    uint _ringFirst = StripData.data[_stripIdx * 5u];
    uint _ringCount = StripData.data[_stripIdx * 5u + 1u];
    uint _relInRing = (_relIdx + uint(u_ParticlePerStrip) - _ringFirst) % uint(u_ParticlePerStrip);
    if (_relInRing >= _ringCount) {
        return;  // ring buffer 范围外的 slot，不需要处理
    }

    // 1. Read particle
    Particle p = readParticle(particleIndex);
    if (!p.alive) {
        return;  // 已死粒子保留在 ring buffer 但不 update（避免 age++ / 重复 integration）
                 // ring buffer compaction：updateStrips 用 minAlive 推进 firstIndex 跳过头部死粒子
    }
${dtGuardOpen}${needSeed ? `\n    ${dtIndent}// Advance seed to avoid same sequence as Initialize stage\n    ${dtIndent}p.seed = WangHash(p.seed ^ uint(u_DeltaTime * 1000.0));\n` : ""}${attrNames?.has("particleIndexInStrip") || attrNames?.has("stripRatio") ? `
    ${dtIndent}// Dynamic strip attributes (对齐 Unity VFXParticleStripCommon.hlsl InitStripAttributes):
    ${dtIndent}// particleIndexInStrip = GetRelativeIndex = (capacity + particleIndex - firstIndex) % capacity
    ${dtIndent}// particleCountInStrip = nextIndex (= ringCount), stripRatio = particleIndexInStrip / (count-1)
    ${dtIndent}// 让 stripRatio 沿 ring buffer 内当前位置平滑变化，force/size/turbulence 等基于
    ${dtIndent}// sampleCurve(stripRatio) 的链每帧重算 — Unity update 阶段也是这样动态算的.
    ${dtIndent}p.particleIndexInStrip = (uint(u_ParticlePerStrip) + _relIdx - _ringFirst) % uint(u_ParticlePerStrip);
${attrNames?.has("particleCountInStrip") ? `    ${dtIndent}p.particleCountInStrip = _ringCount;
` : ""}${attrNames?.has("stripRatio") ? `    ${dtIndent}p.stripRatio = float(p.particleIndexInStrip) / max(float(_ringCount - 1u), 1.0);
` : ""}` : ""}
    ${dtIndent}// 2. Block code (user logic)
${blockCode}

    ${dtIndent}// 3. Update particle (implicit behavior)
    ${dtIndent}updateParticle(p, u_DeltaTime);${dtGuardClose}
${attrNames?.has("headDeathTime") ? `
    // [已移除 instant-kill] 原先 head(发射器)一死就把整条 strip 全部 alive=false →
    // 几何同帧整条抹掉，残留 alpha 的 ribbon"啪"地消失，很突兀(与 Unity 渐隐不符)。
    // 折角(chord)现已由 OutputStrip 渲染端 chord-cut 处理，不再需要靠 kill 清旧 generation。
    // 让 trail 粒子按自身 lifetime 自然老化消亡 → strip 渐隐(对齐 Unity)。
    // head 死后 head-based normalizedAge 钳到 1 → alphaOverLife=0，残留粒子 alpha 0 不可见无副作用。
` : ""}
    // 4. Write back particle data
    writeParticle(particleIndex, p);
    if (p.alive) {
        uint newAliveIndex = atomicAdd(AliveListWrite.count, 1);
        AliveListWrite.indices[newAliveIndex] = particleIndex;

        // Track alive range for ring buffer compaction (matches Unity InterlockedMin/Max)
        atomicMin(StripData.data[_stripIdx * 5u + 4u], _relInRing);
    }
    // alive=false 路径：粒子刚刚死 (本帧 age 跨过 lifetime)，不写 atomicMin → minAlive 取活粒子最小，
    // updateStrips 推进 firstIndex 跳过它
${eventOutputCode}
}` : `void main()
{
    uint aliveIndex = gl_LocalInvocationID.x + gl_WorkGroupID.x * NB_THREADS_PER_GROUP;
${resetCode}
    if (aliveIndex >= AliveListRead.count) {
        return;
    }

    uint particleIndex = AliveListRead.indices[aliveIndex];

    // 1. Read particle
    Particle p = readParticle(particleIndex);
${dtGuardOpen}${needSeed ? `\n    ${dtIndent}// Advance seed to avoid same sequence as Initialize stage\n    ${dtIndent}p.seed = WangHash(p.seed ^ uint(u_DeltaTime * 1000.0));\n` : ""}
    ${dtIndent}// 2. Block code (user logic)
${blockCode}

    ${dtIndent}// 3. Update particle (implicit behavior)
    ${dtIndent}updateParticle(p, u_DeltaTime);${dtGuardClose}

    // 4. Write back particle data
    writeParticle(particleIndex, p);
    if (p.alive) {
        uint newAliveIndex = atomicAdd(AliveListWrite.count, 1);
        AliveListWrite.indices[newAliveIndex] = particleIndex;
    } else {
        uint deadIndex = atomicAdd(DeadList.count, 1);
        DeadList.indices[deadIndex] = particleIndex;
    }
${eventOutputCode}
}`}

#endGLSL

GLSL End`;
}
