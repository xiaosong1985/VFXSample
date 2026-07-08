import type { IVfxGraphData, IVfxContextData, IVfxBlockData, IVfxEventData, IVfxOperatorData, IVfxPropertyDef } from "../data/VfxTypes";
import { getAttributeType, setCustomAttributeTypes } from "../data/VfxOperatorDefs";
import { VfxShaderGen } from "./VfxShaderGen";
import { bakeCurves } from "./VfxCurveBaker";
import { parseBlockSlotId } from "../display/VfxSlot";
import { OUTPUT_EVENT_ENTRY_FLOATS, OUTPUT_EVENT_ENTRY_BYTES } from "./templates/OutputEventTemplates";

/** 把 mesh 字段规整为 runtime 期望的 URL：
 *  - 空 → null
 *  - 已带 "res://" 前缀 → 保持原值
 *  - "builtin:Sphere" 等 marker → 保持原值（runtime VFXAssetParser 识别后调 PrimitiveMesh.createXxx）
 *  - 否则 → 加 "res://" 前缀
 *  之前所有调用点直接 `"res://" + value`，让 builtin:Sphere 变成 res://builtin:Sphere 触发 loader.load("res://builtin:Sphere") 失败
 */
function normalizeMeshUrl(mesh: any): string | null {
    if (!mesh) return null;
    const s = String(mesh);
    if (s.startsWith("res://") || s.startsWith("builtin:")) return s;
    return "res://" + s;
}

/** 遍历 flowLinks 的所有目标（兼容单对象和数组格式） */
function iterateFlowTargets(flowLinks: Record<string, any>): { targetId: number; targetSlotId: string }[] {
    const result: { targetId: number; targetSlotId: string }[] = [];
    for (const val of Object.values(flowLinks)) {
        if (Array.isArray(val)) {
            for (const item of val) result.push(item);
        } else if (val && typeof val === "object" && "targetId" in val) {
            result.push(val);
        }
    }
    return result;
}

/** 编译后的 attribute 使用记录 */
export interface IVfxAttributeUsage {
    name: string;           // attribute 名称 (position, velocity, color …)
    type: string;           // 数据类型 (vec3, float, color, bool)
    usage: "get" | "set";   // 读 / 写
    stage: string;          // 所属 context typeId (initialize, update, outputBillboard …)
    // ── get 专有 ──
    location?: string;      // Current / Source
    // ── set 专有 ──
    composition?: string;   // Overwrite / Add / Multiply / Blend
    source?: string;        // Slot / Source
    blendValue?: number;    // composition=Blend 时的混合值
}

export interface IVfxCompiledEvent {
    name: string;
    playSystems: number[];
    stopSystems: number[];
    initSystems: number[];
}

export interface IVfxCompiledProperty {
    name: string;
    uniform: string;
    type: string;
    default: any;
    /** 分组名（来自 Blackboard 定义，传给运行时 Inspector 用） */
    group?: string;
    /** 友好显示名（来自 Blackboard 定义） */
    displayName?: string;
}

export interface IVfxCompiledData {
    fixedDeltaTime: boolean;
    exactFixedTime: boolean;
    ignoreTimeScale: boolean;
    preWarmTotalTime: number;
    preWarmStepCount: number;
    preWarmDeltaTime: number;
    initialEventName: string;
    eventAttributes: { name: string; type: string }[];
    properties: IVfxCompiledProperty[];
    systems: any[];
    events: IVfxCompiledEvent[];
    /** 烘焙的曲线纹理数据（所有 system 共享，import 后替换为 bakedTexture 资源引用） */
    curveTextureData?: { width: number; height: number; data: Float32Array | number[] };
    /** 每条曲线的 curveData uniform 元数据 */
    curveUniforms?: { opId: number; uniform: string; curveData: [number, number, number, number] }[];
    /** 曲线纹理资源引用（import 后生成） */
    bakedTexture?: string;
}

export class VfxBuild {
    /** 将图数据编译为 .lvfx 运行时数据 */
    static compile(graphData: IVfxGraphData, assetId: string = ""): IVfxCompiledData {
        const props = graphData.props || {};
        const contexts = graphData.contexts || [];

        // 把 Unity 转换出来的 customAttributes 注入 getAttributeType 查询路径，
        // 让 vec2/vec3 custom attribute（如 P4 "sequential" vec2）在 _collectAttributes 等
        // 多处 getAttributeType 调用点自动拿到正确类型，不用改所有调用点
        setCustomAttributeTypes(graphData.customAttributes);

        console.log(`[VFX-DBG] compile asset=${assetId} contexts=${contexts.length} types=`,
            contexts.map(c => `${c.id}:${c.typeId}`).join(","));

        // 1. 检测有效的 Particle 系统（Initialize + Update + Output 连通分量）
        const validParticles = VfxBuild._findValidParticleSystems(contexts);
        console.log(`[VFX-DBG]  validParticles=${validParticles.length}`,
            validParticles.map(p => `init=${p.initCtx.id} update=${p.updateCtx?.id} outs=${p.outputCtxs.map(o => o.id).join(",")} spawns=${p.spawnIds.join(",")}`).join(" | "));

        // 2. 收集连接到有效 Particle 系统的 Spawn context
        const validInitIds = new Set(validParticles.map(p => p.initCtx.id));
        const validSpawnIds = new Set<number>();
        for (const ctx of contexts) {
            if (ctx.typeId !== "spawn") continue;
            if (!ctx.flowLinks) continue;
            // Spawn 直接连接到有效 Initialize，或连接到其他有效 Spawn
            for (const lk of iterateFlowTargets(ctx.flowLinks)) {
                if (validInitIds.has(lk.targetId)) {
                    validSpawnIds.add(ctx.id);
                    break;
                }
            }
        }
        // 传播：Spawn→Spawn 链上游也算有效
        let changed = true;
        while (changed) {
            changed = false;
            for (const ctx of contexts) {
                if (ctx.typeId !== "spawn" || validSpawnIds.has(ctx.id)) continue;
                if (!ctx.flowLinks) continue;
                for (const lk of iterateFlowTargets(ctx.flowLinks)) {
                    if (validSpawnIds.has(lk.targetId)) {
                        validSpawnIds.add(ctx.id);
                        changed = true;
                        break;
                    }
                }
            }
        }

        const spawnContexts = contexts.filter(c => validSpawnIds.has(c.id));

        // 3. 构建 spawn 之间的依赖图 + 拓扑排序（Kahn 算法）
        const inDegree = new Map<number, number>();
        const dependents = new Map<number, number[]>();
        for (const ctx of spawnContexts) {
            inDegree.set(ctx.id, 0);
            dependents.set(ctx.id, []);
        }
        for (const srcCtx of spawnContexts) {
            if (!srcCtx.flowLinks) continue;
            for (const link of iterateFlowTargets(srcCtx.flowLinks)) {
                if (!validSpawnIds.has(link.targetId)) continue;
                dependents.get(srcCtx.id)!.push(link.targetId);
                inDegree.set(link.targetId, inDegree.get(link.targetId)! + 1);
            }
        }

        const sorted: IVfxContextData[] = [];
        const queue: number[] = [];
        const ctxById = new Map<number, IVfxContextData>();
        for (const ctx of spawnContexts) {
            ctxById.set(ctx.id, ctx);
            if (inDegree.get(ctx.id) === 0) queue.push(ctx.id);
        }
        while (queue.length > 0) {
            const id = queue.shift()!;
            sorted.push(ctxById.get(id)!);
            for (const depId of dependents.get(id)!) {
                const deg = inDegree.get(depId)! - 1;
                inDegree.set(depId, deg);
                if (deg === 0) queue.push(depId);
            }
        }
        if (sorted.length < spawnContexts.length) {
            for (const ctx of spawnContexts) {
                if (!sorted.includes(ctx)) sorted.push(ctx);
            }
        }

        // 4. 建立排序后的 contextId → systemIndex 映射
        const ctxIdToSystemIdx = new Map<number, number>();
        for (let i = 0; i < sorted.length; i++) {
            ctxIdToSystemIdx.set(sorted[i].id, i);
        }

        // 5. 编译有效 spawn 为 Spawner system（operators 透传：解析 getProperty→rate 等属性驱动链）
        const systems = sorted.map(ctx => VfxBuild._compileSpawn(ctx, graphData.operators || []));

        // 6. 解析 spawn 之间的 flow 连接 → onPlayInputs / onStopInputs
        for (const srcCtx of sorted) {
            const srcIdx = ctxIdToSystemIdx.get(srcCtx.id)!;
            const links = srcCtx.flowLinks;
            if (!links) continue;

            for (const link of Object.values(links)) {
                const targetIdx = ctxIdToSystemIdx.get(link.targetId);
                if (targetIdx == null) continue;

                const system = systems[targetIdx];
                if (link.targetSlotId === "start") {
                    if (!system.onPlayInputs) system.onPlayInputs = [];
                    system.onPlayInputs.push(srcIdx);
                } else if (link.targetSlotId === "stop") {
                    if (!system.onStopInputs) system.onStopInputs = [];
                    system.onStopInputs.push(srcIdx);
                }
            }
        }

        // 7. 全局收集 attribute（仅用于 eventAttributes）
        const operators = graphData.operators || [];

        // 7.5 自动注入默认 color block：outputDistortion shader 依赖 v_Color.a 做 alpha 通道，
        //     用户未设 color attribute 时粒子全透明。检测到 outputDistortion 且 Initialize 里
        //     没有 setAttribute color block 时，插入合成 block 避免设计陷阱。
        for (let pi = 0; pi < validParticles.length; pi++) {
            const ps = validParticles[pi];
            const hasDistortion = ps.outputCtxs.some(o => o.typeId === "outputDistortion");
            if (!hasDistortion) continue;
            const blocks = ps.initCtx.blocks || [];
            const hasColorSet = blocks.some(b =>
                b.enabled !== false && b.typeId === "setAttribute" && b.props?.attribute === "color"
            );
            if (hasColorSet) continue;
            const syntheticColorBlock: IVfxBlockData = {
                id: -(ps.initCtx.id * 1000 + 99),
                typeId: "setAttribute",
                enabled: true,
                props: {
                    attribute: "color",
                    source: "Slot",
                    composition: "Overwrite",
                    random: "Off",
                    _values: { r: 1, g: 1, b: 1, a: 1, b_r: 1, b_g: 1, b_b: 1, b_a: 1 },
                },
            } as any;
            // 克隆 initCtx（非破坏原始 graphData），合成 block 放最前让用户后续 block 可覆盖
            validParticles[pi] = {
                ...ps,
                initCtx: { ...ps.initCtx, blocks: [syntheticColorBlock, ...blocks] } as IVfxContextData,
            };
        }

        // 7.6 自动注入默认 lifetime block：outputTrail (strip) 系统 alive/lifetime 必需 (output shader 用 p.alive 检查死粒子).
        //     Unity 不显式 set lifetime 时 strip 粒子永不 reap (ring buffer 管理), Laya defaultParticle.lifetime=3 让 3 秒后死.
        //     检测到 outputTrail 且 Initialize 没 setAttribute lifetime 时插入 1e9 (effective infinite) lifetime 让粒子永远 alive.
        for (let pi = 0; pi < validParticles.length; pi++) {
            const ps = validParticles[pi];
            const hasStrip = ps.outputCtxs.some(o => o.typeId === "outputTrail" || o.typeId === "outputParticleStripSGQuad");
            if (!hasStrip) continue;
            const blocks = ps.initCtx.blocks || [];
            const hasLifetimeSet = blocks.some(b =>
                b.enabled !== false && b.typeId === "setAttribute" && b.props?.attribute === "lifetime"
            );
            if (hasLifetimeSet) continue;
            const syntheticLifetimeBlock: IVfxBlockData = {
                id: -(ps.initCtx.id * 1000 + 98),
                typeId: "setAttribute",
                enabled: true,
                props: {
                    attribute: "lifetime",
                    source: "Slot",
                    composition: "Overwrite",
                    random: "Off",
                    _values: { x: 1e9, value: 1e9 },
                },
            } as any;
            validParticles[pi] = {
                ...ps,
                initCtx: { ...ps.initCtx, blocks: [syntheticLifetimeBlock, ...(validParticles[pi].initCtx.blocks || [])] } as IVfxContextData,
            };
        }

        const allAttributes = VfxBuild._collectAttributes(contexts, operators);

        // 8. 预收集每个 Particle system 的 attribute（供 GPU Event 源系统查找）
        const gpuEvents = (graphData.events || []).filter(e => e.typeId === "gpuEvent");
        const perSystemAttrs = validParticles.map(ps => {
            // spawn ctxs 也要扫描，让 setSpawnEventAttribute 写的 attribute（如 texIndex）
            // 进入 SourceEventData，init alloc 用 source.texIndex 做 strip 分配
            const spawnCtxs = ps.spawnIds
                .map(id => contexts.find(c => c.id === id))
                .filter((c): c is IVfxContextData => !!c);
            return VfxBuild._collectAttributes([...spawnCtxs, ps.initCtx, ps.updateCtx, ...ps.outputCtxs], operators);
        });

        // 8b. Strip 跨代复用根因修复：strip trail 的 stripIndex 必须按"稳定的单调 head-ID"分配，
        //     而非可复用的 sourceParticleIndex(emitter buffer 槽位 LIFO 立即复用 → 新老两代挤进同一 strip
        //     → chord-cut 截断 + 环回覆盖 → strip 硬截断/碎片，而非 Unity 的逐 head 干净 ribbon 缩放收尾)。
        //     emitter(CPU init)的 particleId = id + u_TotalSpawnedCount 是 init 设定一次的稳定全局单调值,
        //     正好做 head-ID。这里强制 strip trail(接收端读 src.particleId)及其 source emitter(打包 particleId)
        //     都带上 particleId，让 trail init 用 src.particleId % stripCapacity 分配 strip(见 Initialize.ts)。
        for (let pi = 0; pi < validParticles.length; pi++) {
            const ps = validParticles[pi];
            const hasStripOutput = ps.outputCtxs.some(c => c.typeId === "outputTrail" || c.typeId === "outputLineStrip");
            if (!hasStripOutput) continue;
            const gei = VfxBuild._resolveGPUEventInput(ps.initCtx, gpuEvents, contexts, validParticles, sorted.length);
            if (!gei) continue;
            const srcIdx = gei.sourceSystem - sorted.length;
            if (srcIdx < 0 || srcIdx >= perSystemAttrs.length) continue;
            // trail 接收端：struct 里要有 particleId 才能接收 src.particleId
            if (!perSystemAttrs[pi].some(a => a.name === "particleId")) {
                perSystemAttrs[pi].push({ name: "particleId", type: "uint", usage: "set", stage: "initialize" });
            }
            // source emitter：要 set+打包 particleId（CPU init 写 id+u_TotalSpawnedCount = 稳定单调）
            if (!perSystemAttrs[srcIdx].some(a => a.name === "particleId")) {
                perSystemAttrs[srcIdx].push({ name: "particleId", type: "uint", usage: "set", stage: "initialize" });
            }
        }

        // 9. 编译有效的 Particle system（per-system 生成 shader）
        let particleIdx = 0;
        for (let pi = 0; pi < validParticles.length; pi++) {
            const ps = validParticles[pi];
            const spawnerIndices: number[] = [];
            for (const spawnId of ps.spawnIds) {
                const idx = ctxIdToSystemIdx.get(spawnId);
                if (idx != null) spawnerIndices.push(idx);
            }
            const shaderId = `${assetId}_s${particleIdx}`;
            const systemAttrs = perSystemAttrs[pi];

            // 检测 GPU Event 连接：GPU Event → Initialize(input)
            const gpuEventInput = VfxBuild._resolveGPUEventInput(ps.initCtx, gpuEvents, contexts, validParticles, sorted.length);
            const isGPUEvent = !!gpuEventInput;

            // 收集此 Update 中的 triggerEvent blocks → ITriggerEventInfo[]
            const triggerEvents = VfxBuild._collectTriggerEvents(ps.updateCtx, gpuEvents);

            // 收集此 Update 中路由到 outputEvent context 的 triggerEvent blocks
            const outputEvents = VfxBuild._collectOutputEvents(ps.updateCtx, contexts);

            // GPU Event 接收端需要源系统的 attribute 来生成 readSourceParticle
            let sourceAttrs: IVfxAttributeUsage[] | undefined;
            let sourceSimulateSpace: string | undefined;
            if (gpuEventInput) {
                const srcParticleIdx = gpuEventInput.sourceSystem - sorted.length;
                if (srcParticleIdx >= 0 && srcParticleIdx < perSystemAttrs.length) {
                    sourceAttrs = perSystemAttrs[srcParticleIdx];
                    sourceSimulateSpace = validParticles[srcParticleIdx].initCtx.props?.space as string ?? "Local";
                }
            }

            // Multi-Output: 第一个 output 用作主 output（生成 init/update shader），
            // 其余 output 只生成额外 output shader + 渲染参数
            // 关键：strip 类型 (outputTrail/outputLineStrip) 必须作为主 output —— runtime 根据主 output
            // 决定是否分配 StripDataBuffer / updateStripsShader / prepareDispatchShader / strip geometry，
            // 这些资源 extra output 路径不会创建。strip 是 sub 时直接看不见。
            const isStripOutput = (c: IVfxContextData) => c.typeId === "outputTrail" || c.typeId === "outputLineStrip";
            // 多 strip 时按 blendMode 排序：Alpha 类先 (primary，做底)，Additive 类后 (extra，做 overlay)。
            // Unity StripProperties 是 Strip Alpha (yellow alpha=0.18 底色) + Strip Wireframe (Additive 白描边)，
            // 顺序反了 alpha blend 让 yellow*0.18 跟 dst(white) 混 ≈ white，看不到 yellow 主体色。
            const blendModePriority = (c: IVfxContextData): number => {
                const m = String(c.props?.blendMode ?? "Alpha");
                // 小 priority 先渲染 (画在底), 大 priority 后渲染 (overlay 在上)
                if (m === "Additive") return 2;
                if (m === "Alpha") return 1;
                return 0;   // Opaque first
            };
            const sortedOutputCtxs = [...ps.outputCtxs].sort((a, b) => {
                const aStrip = isStripOutput(a), bStrip = isStripOutput(b);
                if (aStrip && !bStrip) return -1;
                if (!aStrip && bStrip) return 1;
                if (aStrip && bStrip) return blendModePriority(a) - blendModePriority(b);
                return 0;
            });
            const primaryOutputCtx = sortedOutputCtxs[0];
            const compiled = VfxBuild._compileParticle(ps.initCtx, ps.updateCtx, primaryOutputCtx, spawnerIndices, shaderId, systemAttrs, operators, graphData.properties || [], isGPUEvent, triggerEvents, sourceAttrs, sourceSimulateSpace, outputEvents);

            if (gpuEventInput) {
                compiled.receiveGPUEvent = true;
                compiled.gpuEventInput = gpuEventInput;
                compiled.sourceSimulateSpace = sourceSimulateSpace ?? "Local";
            }

            // Multi-Output: 额外 output contexts → 只生成 output shader + 渲染参数
            // 注意：用 sortedOutputCtxs 而不是 ps.outputCtxs，跟主 output 选择保持一致
            if (sortedOutputCtxs.length > 1) {
                const extraOutputs: any[] = [];
                const simulateSpace = (ps.initCtx.props?.space as string) ?? "Local";
                for (let oi = 1; oi < sortedOutputCtxs.length; oi++) {
                    const extraCtx = sortedOutputCtxs[oi];
                    const extraShaderId = `${assetId}_s${particleIdx}_o${oi}`;

                    // 只生成 output shader（复用主 system 的 attributes + common 布局）
                    const extraGen = VfxShaderGen.generateOutputOnly(
                        ps.updateCtx, extraCtx, extraShaderId, systemAttrs, operators,
                        graphData.properties || [], simulateSpace
                    );

                    const blendMode = (extraCtx.props?.blendMode as string) || "Alpha";
                    const softParticleFade = Number(extraCtx.props?.softParticleFade) || 0;
                    const uvMode = (extraCtx.props?.uvMode as string) || "Default";
                    const fbSize = extraCtx.props?.flipbookSize as any || { x: 4, y: 4 };
                    const subpixelAA = Array.isArray(extraCtx.blocks)
                        && extraCtx.blocks.some(b => b.typeId === "subpixelAA" && b.enabled !== false);
                    const customShaderName = (extraCtx.props?.shaderName as string) || "";
                    const customShaderRes = (extraCtx.props?.shaderRes as string) || "";

                    // outputComposedParticle 同样按 topology 分流到 outputBillboard / outputMesh
                    let extraResolvedType = extraCtx.typeId;
                    if (extraCtx.typeId === "outputComposedParticle") {
                        const topo = (extraCtx.props?.topology as string) || "Quad";
                        extraResolvedType = topo === "Mesh" ? "outputMesh" : "outputBillboard";
                    }
                    // outputShaderGraphMesh → outputMesh，runtime 看 customShaderName 走自定义材质（跟主 output 同语义）
                    else if (extraCtx.typeId === "outputShaderGraphMesh") {
                        extraResolvedType = "outputMesh";
                    }

                    // billboard procedural primitive 字段（与主 output 同逻辑）
                    let extraBillboardPrimitive = "";
                    let extraBillboardVertexCount = 0;
                    let extraBillboardCropFactor = 0.146;
                    if (extraCtx.typeId === "outputBillboard"
                        || (extraCtx.typeId === "outputComposedParticle" && extraResolvedType === "outputBillboard")) {
                        const prim = String(extraCtx.props?.primitive ?? extraCtx.props?.topology ?? "Quad");
                        const VCOUNT: Record<string, number> = { "Quad": 6, "Triangle": 3, "Octagon": 18 };
                        if (VCOUNT[prim] !== undefined) {
                            extraBillboardPrimitive = prim;
                            extraBillboardVertexCount = VCOUNT[prim];
                            extraBillboardCropFactor = Number(extraCtx.props?.cropFactor ?? 0.146);
                        }
                    } else if (extraCtx.typeId === "outputCube") {
                        extraBillboardPrimitive = "Cube";
                        extraBillboardVertexCount = 36;
                    } else if (extraCtx.typeId === "outputDistortion") {
                        extraBillboardPrimitive = "Distortion";
                        extraBillboardVertexCount = 6;
                        extraBillboardCropFactor = Number(extraCtx.props?.distortionStrength ?? 0.05);
                    }

                    // Alpha Clipping (extra output 漏写让 multi-output 第 2+ output 不能 discard alpha mask → 大白矩形)
                    // primary 在 line 700-702 已写，extras 跟齐
                    const extraUseAlphaClipping = !!(extraCtx.props as any)?.useAlphaClipping;
                    const extraAlphaThreshold = Number((extraCtx.props as any)?.alphaThreshold ?? 0.5);
                    extraOutputs.push({
                        outputType: extraResolvedType,
                        outputShader: extraGen.outputShader,
                        blendMode,
                        softParticleFade,
                        uvMode,
                        flipbookSize: [Number(fbSize.x) || 4, Number(fbSize.y) || 4],
                        subpixelAA,
                        customShaderName: customShaderName || undefined,
                        customShaderRes: customShaderRes || undefined,
                        mesh: normalizeMeshUrl(extraCtx.props?.mesh),
                        mainTexture: (extraCtx.props as any)?.mainTexture || null,
                        textureUniforms: extraGen.textureUniforms,
                        billboardPrimitive: extraBillboardPrimitive,
                        billboardVertexCount: extraBillboardVertexCount,
                        billboardCropFactor: extraBillboardCropFactor,
                        useAlphaClipping: extraUseAlphaClipping,
                        alphaThreshold: extraAlphaThreshold,
                        // Strip 专属字段（extra outputTrail 也需要 — runtime 用 tilingMode 决定 UV 拉伸 vs 每段 tile）
                        tilingMode: (extraCtx.props as any)?.tilingMode || "Stretch",
                        colorMapping: (extraCtx.props as any)?.colorMapping || "Default",
                        uvScale: (extraCtx.props as any)?.uvScale,
                        uvBias: (extraCtx.props as any)?.uvBias,
                        // ShaderGraph property binding/defaults/expressions（extra output 也跟 primary 一样需要 hoist）
                        shaderPropertyBindings: (extraCtx.props as any)?.shaderPropertyBindings || undefined,
                        shaderPropertyDefaults: (extraCtx.props as any)?.shaderPropertyDefaults || undefined,
                        shaderPropertyExpressions: (extraCtx.props as any)?.shaderPropertyExpressions || undefined,
                    });
                }
                compiled.extraOutputs = extraOutputs;

                // ── Multi-Output: 把每个 extra output 的 textureUniforms 合到 system 级
                //
                // runtime VFXAssetParser 只解析 system.textureUniforms 跟着 VisualEffect.applyAssetTextureUniforms
                // 把 entry 应用到 system.getAllShaderDatas()（含 extras' outputDatas）让所有 stage shader 拿到纹理；
                // extra output 的 textureUniforms 单独存在 extraOutputs[i].textureUniforms 完全没人读 → extra 的
                // sampleGradient/sampleMesh/sampleTexture2D uniform 永远绑默认空纹理（采样返回 0 让粒子全白色/全黑）。
                //
                // TexIndexAdvanced Cube Background 2 (Sphere mesh extra output) 的 u_VfxGradient_362 漏绑根因。
                // 合并按 uniformName 去重避免主跟 extra 同名重复 (e.g., 同一 graph gradient property uniform)。
                const mergedTex = (compiled.textureUniforms ?? []) as Array<any>;
                const seenTex = new Set<string>(mergedTex.map((t: any) => t.uniformName));
                for (const eo of extraOutputs) {
                    if (!Array.isArray(eo.textureUniforms)) continue;
                    for (const tu of eo.textureUniforms) {
                        if (seenTex.has(tu.uniformName)) continue;
                        seenTex.add(tu.uniformName);
                        mergedTex.push(tu);
                    }
                }
                if (mergedTex.length > 0) compiled.textureUniforms = mergedTex;
            }

            systems.push(compiled);
            particleIdx++;
        }

        // ── 扫描独立的 outputStaticMesh context → 单独 emit StaticMesh system ──
        // Unity VFXStaticMeshOutput 对齐：不跑 particle simulation，渲染单个 mesh
        // 扫描其下的 setStaticMeshAttr block，提取 binding 列表（白名单：inline static / propertyReference）
        const allOperators = graphData.operators || [];
        for (const ctx of contexts) {
            if (ctx.typeId !== "outputStaticMesh") continue;
            const p = ctx.props || {};

            const bindings: any[] = [];
            for (const block of (ctx.blocks || [])) {
                if (!block.enabled || block.typeId !== "setStaticMeshAttr") continue;
                const target = String(block.props?.target || "color");
                const binding = VfxBuild._compileStaticMeshBinding(ctx.id, block.id, target, allOperators);
                bindings.push(binding);
            }

            systems.push({
                type: "StaticMesh",
                mesh: normalizeMeshUrl(p.mesh) || "",
                materialUuid: p.material ? String(p.material) : "",
                bindings,
            } as any);
        }

        // ── 合并所有 system 的曲线，统一烘焙为一张纹理 ──
        const mergedCurveEntries = new Map<number, number[]>();
        for (const sys of systems) {
            if (sys.curveEntries) {
                (sys.curveEntries as Map<number, number[]>).forEach((v, k) => mergedCurveEntries.set(k, v));
                delete sys.curveEntries;
            }
        }

        const compiledResult: IVfxCompiledData = {
            fixedDeltaTime: !!props.fixedDeltaTime,
            exactFixedTime: !!props.exactFixedTime,
            ignoreTimeScale: !!props.ignoreTimeScale,
            preWarmTotalTime: props.preWarmTotalTime ?? 0,
            preWarmStepCount: props.preWarmStepCount ?? 0,
            preWarmDeltaTime: props.preWarmDeltaTime ?? 0,
            initialEventName: props.initialEventName ?? "OnPlay",
            // ⚠️ 关键：必须用 perSystemAttrs（spawn-first 顺序）而非 allAttributes（contexts 全局顺序）
            // 否则 lvfx eventAttributes 顺序 ≠ GLSL SourceEventData struct 字段顺序，
            // CPU desc 与 GLSL std430 layout offset 不一致 → CPU 写 texIndex 在 GLSL 读出 color.x → 字段错位。
            // perSystemAttrs[i] 跟 generateVFXCommon → getSourceAttributes 用同一个 usages，保证两边顺序一致。
            // 多 system union 时按 system 顺序合并去重。
            eventAttributes: VfxBuild._collectEventAttributesFromPerSystem(perSystemAttrs),
            // Curve type 已被 _compileGetProperty inline 化（frames 烘焙到 curve atlas），
            // runtime 不需要 uniform。skip 避免 normalizePropertyType fallback Float 上传无意义值。
            properties: (graphData.properties || []).filter(p => p.exposed && String(p.type).toLowerCase() !== "curve").map(p => ({ name: p.name, uniform: `u_VfxProp_${p.name}`, type: p.type, default: p.default, group: p.group, displayName: p.displayName })),
            systems,
            events: VfxBuild._compileEvents(graphData.events || [], ctxIdToSystemIdx, validParticles, sorted.length),
        };

        if (mergedCurveEntries.size > 0) {
            const bakeResult = bakeCurves(mergedCurveEntries);
            compiledResult.curveTextureData = bakeResult.texture;
            compiledResult.curveUniforms = bakeResult.uniforms;
        }

        return compiledResult;
    }

    /** 编译 Spawn Context → Spawner system */
    private static _compileSpawn(ctx: IVfxContextData, allOperators: IVfxOperatorData[] = []): any {
        const p = ctx.props || {};

        // loopDuration: Infinite→[-1,-1], Constant→[v,v], Random→[min,max]
        let loopDuration: [number, number];
        if (p.durationMode === "Constant") {
            const v = p.loopDuration ?? 1;
            loopDuration = [v, v];
        } else if (p.durationMode === "Random") {
            const range = p.loopDurationRange || { x: 1, y: 3 };
            loopDuration = [range.x, range.y];
        } else {
            loopDuration = [-1, -1];
        }

        // loopCount: Infinite→[-1,-1], Constant→[v,v], Random→[min,max]
        let loopCount: [number, number];
        if (p.countMode === "Constant") {
            const v = p.loopCount ?? 1;
            loopCount = [v, v];
        } else if (p.countMode === "Random") {
            const range = p.loopCountRange || { x: 1, y: 3 };
            loopCount = [range.x, range.y];
        } else {
            loopCount = [-1, -1];
        }

        const tasks: any[] = [];
        for (const block of ctx.blocks || []) {
            if (!block.enabled) continue;
            const compiled = VfxBuild._compileBlock(block, ctx.id, allOperators);
            if (compiled) tasks.push(compiled);
        }

        return {
            type: "Spawner",
            loopCount,
            loopDuration,
            delayBeforeLoop: typeof p.delayBeforeLoop === "number" ? p.delayBeforeLoop : (p.delayBeforeLoop ? 1 : 0),
            delayAfterLoop: typeof p.delayAfterLoop === "number" ? p.delayAfterLoop : (p.delayAfterLoop ? 1 : 0),
            tasks,
        };
    }

    /** 检测有效的 Particle 系统（Initialize + Update + Output 连通分量） */
    private static _findValidParticleSystems(
        contexts: IVfxContextData[],
    ): { initCtx: IVfxContextData; updateCtx: IVfxContextData; outputCtxs: IVfxContextData[]; spawnIds: number[] }[] {
        if (contexts.length === 0) return [];

        // 注意：outputStaticMesh 不在此列 — 它是 Unity VFXStaticMeshOutput 对齐的独立 system 类型
        // 不跑 particle simulation，由 compile() 末尾单独扫描 emit StaticMesh system desc
        const OUTPUT_TYPES = new Set(["outputBillboard", "outputMesh", "outputComposedParticle", "outputShaderGraphQuad", "outputShaderGraphMesh", "outputTrail", "outputParticleStripSGQuad", "outputLine", "outputPoint", "outputCube", "outputLineStrip", "outputDistortion"]);

        // ⚠️ 之前用 BFS 连通分量找 system — 但 spawn 1 → init 3 + init 8 让 init 3/8 同分量 →
        //   两个 system 被错误合并成 1 个 (StripProperties 把 Strip Quad system 的 outputs 合到 Strip Line system).
        // 修复：每个 init context 独立成 system，沿 flowLinks "output" slot 走找自己的 update + outputs。
        const ctxMap = new Map(contexts.map(c => [c.id, c]));
        const result: { initCtx: IVfxContextData; updateCtx: IVfxContextData; outputCtxs: IVfxContextData[]; spawnIds: number[] }[] = [];

        for (const initCtx of contexts) {
            if (initCtx.typeId !== "initialize") continue;

            // 沿 flowLinks output → update → output → ... 找下游
            let updateCtx: IVfxContextData | null = null;
            const outputCtxs: IVfxContextData[] = [];
            const visited = new Set<number>([initCtx.id]);
            const queue: number[] = [initCtx.id];
            while (queue.length > 0) {
                const cur = ctxMap.get(queue.shift()!);
                if (!cur || !cur.flowLinks) continue;
                for (const lk of iterateFlowTargets(cur.flowLinks)) {
                    if (visited.has(lk.targetId)) continue;
                    const next = ctxMap.get(lk.targetId);
                    if (!next) continue;
                    visited.add(lk.targetId);
                    if (next.typeId === "update") {
                        if (!updateCtx) updateCtx = next;
                        queue.push(next.id);
                    } else if (OUTPUT_TYPES.has(next.typeId)) {
                        outputCtxs.push(next);
                    }
                }
            }

            if (!updateCtx) continue;

            // Heads 系统（无 Output）：生成虚拟 "none" output，只参与 Update/Initialize 不渲染
            if (outputCtxs.length === 0) {
                outputCtxs.push({ id: -initCtx.id, typeId: "none", blocks: [], props: {}, uiData: { x: 0, y: 0 } } as any);
            }

            // 找上游 spawn：所有 flowLinks 指向此 init 的 spawn context
            const spawnIds: number[] = [];
            for (const ctx of contexts) {
                if (ctx.typeId !== "spawn" || !ctx.flowLinks) continue;
                for (const lk of iterateFlowTargets(ctx.flowLinks)) {
                    if (lk.targetId === initCtx.id) {
                        spawnIds.push(ctx.id);
                        break;
                    }
                }
            }

            result.push({ initCtx, updateCtx, outputCtxs, spawnIds });
        }

        return result;
    }

    /** 编译 Particle system（含 3 个 compute shader） */
    private static _compileParticle(
        initCtx: IVfxContextData,
        updateCtx: IVfxContextData,
        outputCtx: IVfxContextData,
        spawnerIndices: number[],
        shaderId: string,
        attributes: IVfxAttributeUsage[],
        operators: IVfxOperatorData[],
        graphProperties: IVfxPropertyDef[],
        isGPUEvent?: boolean,
        triggerEvents?: { eventIdx: number; eventType: string; param: number }[],
        sourceAttrs?: IVfxAttributeUsage[],
        sourceSimulateSpace?: string,
        outputEvents?: { eventIdx: number; eventType: string; param: number; eventName: string; capacity: number; blockId: number }[],
    ): any {
        const p = initCtx.props || {};
        const simulateSpace = p.space as string ?? "Local";
        const boundsMode = p.boundsMode ?? "Automatic";

        const shaders = VfxShaderGen.generateAll(initCtx, updateCtx, outputCtx, shaderId, attributes, operators, graphProperties, isGPUEvent, triggerEvents, sourceAttrs, simulateSpace, sourceSimulateSpace, outputEvents);

        const stripCapacity = Number(outputCtx.props?.stripCapacity) || 1;
        const particlePerStripCount = Number(outputCtx.props?.particlePerStripCount) || 128;
        const isStripOutput = outputCtx.typeId === "outputTrail" || outputCtx.typeId === "outputParticleStripSGQuad";

        // For strip systems with ring buffer: capacity = stripCapacity * particlePerStripCount
        const capacity = isStripOutput && isGPUEvent
            ? stripCapacity * particlePerStripCount
            : (p.capacity ?? 64);

        const blendMode = (outputCtx.props?.blendMode as string) || "Alpha";
        const softParticleFade = Number(outputCtx.props?.softParticleFade) || 0;
        const uvMode = (outputCtx.props?.uvMode as string) || "Default";
        const fbSize = outputCtx.props?.flipbookSize as any || { x: 4, y: 4 };
        const flipbookSize = [Number(fbSize.x) || 4, Number(fbSize.y) || 4];
        const subpixelAA = Array.isArray(outputCtx.blocks)
            && outputCtx.blocks.some(b => b.typeId === "subpixelAA" && b.enabled !== false);

        const customShaderName = (outputCtx.props?.shaderName as string) || "";
        const customShaderRes = (outputCtx.props?.shaderRes as string) || "";

        // outputComposedParticle (Unity VFXComposedParticleOutput 对齐) 编译时按 topology 分流
        // 重写 outputType 让 runtime 走对应 outputBillboard / outputMesh 路径
        let resolvedOutputType = outputCtx.typeId;
        if (outputCtx.typeId === "outputComposedParticle") {
            const topo = (outputCtx.props?.topology as string) || "Quad";
            resolvedOutputType = topo === "Mesh" ? "outputMesh" : "outputBillboard";
        }
        // outputShaderGraphMesh (Unity ParticleTopologyMesh + ParticleShadingShaderGraph 组合) → outputMesh
        // runtime 看 customShaderName 非空就用 getCustomShaderMaterial 替代内置 shader，
        // 整个 mesh 渲染路径不需要单独 case
        else if (outputCtx.typeId === "outputShaderGraphMesh") {
            resolvedOutputType = "outputMesh";
        }

        // Billboard / Cube procedural（对齐 Unity VFXPlanarPrimitive / VFXBasicCubeOutput）
        // runtime 用 VFXBillboardGeometry（DrawArrayIndirect）+ gl_VertexID 生成顶点
        let billboardPrimitive = "";
        let billboardVertexCount = 0;
        let billboardCropFactor = 0.146;
        if (outputCtx.typeId === "outputBillboard"
            || (outputCtx.typeId === "outputComposedParticle" && resolvedOutputType === "outputBillboard")) {
            // outputBillboard 用 props.primitive；outputComposedParticle 用 props.topology
            const prim = String(outputCtx.props?.primitive ?? outputCtx.props?.topology ?? "Quad");
            const VCOUNT: Record<string, number> = { "Quad": 6, "Triangle": 3, "Octagon": 18 };
            if (VCOUNT[prim] !== undefined) {
                billboardPrimitive = prim;
                billboardVertexCount = VCOUNT[prim];
                billboardCropFactor = Number(outputCtx.props?.cropFactor ?? 0.146);
            }
        } else if (outputCtx.typeId === "outputCube") {
            // Cube：固定 36 顶点（6 面 × 2 三角形 × 3 顶点），共用 billboard procedural 通用 geometry
            billboardPrimitive = "Cube";
            billboardVertexCount = 36;
        } else if (outputCtx.typeId === "outputDistortion") {
            // Distortion：固定 Quad 6 顶点，使用独立 shader (VFXDistortionQuad)
            // runtime 用 mode/distortionStrength 两个 prop 配置 material define + uniform
            billboardPrimitive = "Distortion";
            billboardVertexCount = 6;
            billboardCropFactor = Number(outputCtx.props?.distortionStrength ?? 0.05);
        }

        // Alpha Clipping (Unity VFXPlanarPrimitiveOutput useAlphaClipping + alphaThreshold)
        // atlas 字符 mask 用：alpha<threshold 时 discard，背景方块透明
        const useAlphaClipping = !!(outputCtx.props as any)?.useAlphaClipping;
        const alphaThreshold = Number((outputCtx.props as any)?.alphaThreshold ?? 0.5);
        const result: any = {
            type: "Particle",
            outputType: resolvedOutputType,
            simulateSpace,
            capacity,
            boundsMode,
            blendMode,
            softParticleFade,
            uvMode,
            flipbookSize,
            subpixelAA,
            spawnerSystems: spawnerIndices,
            mesh: normalizeMeshUrl(outputCtx.props?.mesh),
            // Atlas 模式（Flipbook/FlipbookBlend）：mainTexture 资源透传给 runtime 设到材质 u_AlbedoTexture
            // 注意 outputCtx.props.mainTexture 已是 res:// 形式（unity-vfx-to-laya 转换器写的），不再加前缀
            mainTexture: (outputCtx.props as any)?.mainTexture || null,
            stripCapacity,
            particlePerStripCount,
            billboardPrimitive,
            billboardVertexCount,
            billboardCropFactor,
            useAlphaClipping,
            alphaThreshold,
            ...shaders,
        };
        // Distortion 专属：mode 字段（Procedural / NormalMap）
        if (outputCtx.typeId === "outputDistortion") {
            result.distortionMode = (outputCtx.props?.mode as string) || "Procedural";
        }
        // Strip 专属：colorMapping / uvScale / uvBias / gradient（对齐 Unity Output Trail 视觉细节）
        if (isStripOutput) {
            result.colorMapping = (outputCtx.props?.colorMapping as string) || "Default";
            if (outputCtx.props?.uvScale) result.uvScale = outputCtx.props.uvScale;
            if (outputCtx.props?.uvBias) result.uvBias = outputCtx.props.uvBias;
            if (outputCtx.props?.gradient) result.gradient = outputCtx.props.gradient;
            if (typeof outputCtx.props?.tilingMode === "string") result.tilingMode = outputCtx.props.tilingMode;
            if (typeof outputCtx.props?.swapUV === "boolean") result.swapUV = outputCtx.props.swapUV;
        }
        if (customShaderName) {
            result.customShaderName = customShaderName;
        }
        if (customShaderRes) {
            result.customShaderRes = customShaderRes;
        }
        // ShaderGraph property binding (VFX exposed prop name → shader uniform name)
        // 来自 unity-vfx-to-laya 转换器扫 Unity OutputContext m_InputSlots slot.m_Property.name + m_LinkedSlots → VFXParameter.m_ExposedName 反查的映射
        // runtime VisualEffect setTexture 时按这个 binding 把 exposed name → shader uniform name 转换让 .bps sampler 正确接收
        if (outputCtx.props && (outputCtx.props as any).shaderPropertyBindings && typeof (outputCtx.props as any).shaderPropertyBindings === "object") {
            result.shaderPropertyBindings = (outputCtx.props as any).shaderPropertyBindings;
        }
        // ShaderGraph property inline defaults (shader uniform name → res://uuid，VFX 端 outputCtx 给某 shader 属性写的 inline 资源 default
        // 而非 link 到 exposed property — .bps 编译时丢了这种 inline default，所以 runtime 也要 setTexture 覆盖让 wall mesh 等用 uni_ring_warped 而非 .bps 内 white texture)
        if (outputCtx.props && (outputCtx.props as any).shaderPropertyDefaults && typeof (outputCtx.props as any).shaderPropertyDefaults === "object") {
            result.shaderPropertyDefaults = (outputCtx.props as any).shaderPropertyDefaults;
        }
        // ShaderGraph property expression chain (VFX operator chain → shader uniform，runtime 每帧 evaluate)
        // 来自 unity-vfx-to-laya 转换器序列化的 operator chain（Sample.Gradient/SampleCurve/Math 等）
        // runtime VisualEffect._evaluateShaderExpressions 每帧 evaluate → setVector/setNumber 到 material
        if (outputCtx.props && (outputCtx.props as any).shaderPropertyExpressions && typeof (outputCtx.props as any).shaderPropertyExpressions === "object") {
            (result as any).shaderPropertyExpressions = (outputCtx.props as any).shaderPropertyExpressions;
        }

        if (boundsMode === "Manual") {
            const center = p.boundsCenter || { x: 0, y: 0, z: 0 };
            const size = p.boundsSize || { x: 1, y: 1, z: 1 };
            result.boundsCenter = [center.x ?? 0, center.y ?? 0, center.z ?? 0];
            result.boundsExtents = [size.x ?? 1, size.y ?? 1, size.z ?? 1];
        }

        // Output Event 元数据：runtime 据此分配 GPU buffer + readback + 派发
        if (outputEvents && outputEvents.length > 0) {
            result.outputEvents = outputEvents.map(oe => ({
                eventIdx: oe.eventIdx,
                eventName: oe.eventName,
                eventType: oe.eventType,
                capacity: oe.capacity,
                entryFloats: OUTPUT_EVENT_ENTRY_FLOATS,
                entryBytes: OUTPUT_EVENT_ENTRY_BYTES,
            }));
        }

        return result;
    }

    /** 收集 Particle system 中用到的 attribute（区分 get/set，携带 block 属性） */
    static _collectAttributes(
        contexts: IVfxContextData[],
        operators: IVfxOperatorData[],
    ): IVfxAttributeUsage[] {
        const result: IVfxAttributeUsage[] = [];

        // 1. 从 setAttribute / setPositionShape block 收集（set）
        for (const ctx of contexts) {
            for (const block of ctx.blocks || []) {
                if (!block.enabled) continue;

                if (block.typeId === "setAttribute") {
                    const p = block.props || {};
                    const attrName = (p.attribute as string) || "position";
                    const composition = (p.composition as string) || "Overwrite";
                    const entry: IVfxAttributeUsage = {
                        name: attrName,
                        type: getAttributeType(attrName),
                        usage: "set",
                        stage: ctx.typeId,
                        composition,
                        source: (p.source as string) || "Slot",
                    };
                    if (composition === "Blend") {
                        entry.blendValue = (p._values?.blend as number) ?? 0.5;
                    }
                    result.push(entry);
                } else if (block.typeId === "setSpawnEventAttribute") {
                    // spawn task 写的 attribute 进入 SourceEventData，
                    // 让 init/update 可读 source.<attr>（如 source.texIndex 用作 strip 分配）
                    const p = block.props || {};
                    const attrName = (p.attribute as string) || "spawnIndex";
                    result.push({
                        name: attrName,
                        type: getAttributeType(attrName),
                        usage: "set",
                        stage: ctx.typeId,
                        composition: "Overwrite",
                        source: "Source",
                    });
                } else if (block.typeId === "setAttributeCurve") {
                    const p = block.props || {};
                    const attrName = (p.attribute as string) || "size";
                    const composition = (p.composition as string) || "Overwrite";
                    const sampleMode = (p.sampleMode as string) || "OverLife";
                    result.push({
                        name: attrName,
                        type: getAttributeType(attrName),
                        usage: "set",
                        stage: ctx.typeId,
                        composition,
                    });
                    // OverLife / BySpeed / Random 等不同 sampleMode 需要读不同属性
                    if (sampleMode === "OverLife") {
                        result.push({ name: "age", type: "float", usage: "get", stage: ctx.typeId });
                        result.push({ name: "lifetime", type: "float", usage: "get", stage: ctx.typeId });
                    } else if (sampleMode === "BySpeed") {
                        result.push({ name: "velocity", type: "vec3", usage: "get", stage: ctx.typeId });
                    } else if (sampleMode === "Random" || sampleMode === "RandomConstantPerParticle") {
                        // Rand(p.seed) / VfxFixedRand(p.seed + ...) 需要 seed 字段
                        result.push({ name: "seed", type: "uint", usage: "get", stage: ctx.typeId });
                    }
                } else if (block.typeId === "attributeFromMap") {
                    const p = block.props || {};
                    const attrName = (p.attribute as string) || "color";
                    const composition = (p.composition as string) || "Overwrite";
                    result.push({
                        name: attrName,
                        type: getAttributeType(attrName),
                        usage: "set",
                        stage: ctx.typeId,
                        composition,
                    });
                } else if (block.typeId === "orient") {
                    const mode = (block.props?.mode as string) || "Face Camera Plane";
                    // Orient computes _orientX/Y/Z locals in compute shader, written directly to render buffer.
                    // No particle attributes are set — only declare "get" for attributes the orient code reads.
                    if (mode === "Along Velocity") {
                        result.push({ name: "velocity", type: "vec3", usage: "get", stage: ctx.typeId });
                    }
                    if (mode === "Face Camera Position" || mode === "Fixed Axis"
                        || mode === "Along Velocity" || mode === "Look At Position" || mode === "Look At Line") {
                        result.push({ name: "position", type: "vec3", usage: "get", stage: ctx.typeId });
                    }
                } else if (block.typeId === "linearDrag") {
                    result.push({ name: "velocity", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Multiply" });
                    result.push({ name: "mass", type: "float", usage: "get", stage: ctx.typeId });
                    if (block.props?.useParticleSize) {
                        result.push({ name: "size", type: "float", usage: "get", stage: ctx.typeId });
                        result.push({ name: "scale", type: "vec3", usage: "get", stage: ctx.typeId });
                    }
                } else if (block.typeId === "gravity") {
                    result.push({ name: "velocity", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Add" });
                } else if (block.typeId === "velNewDirection") {
                    const p = block.props || {};
                    const composition = (p.composition as string) || "Overwrite";
                    result.push({ name: "velocity", type: "vec3", usage: "set", stage: ctx.typeId, composition });
                    result.push({ name: "direction", type: "vec3", usage: "get", stage: ctx.typeId });
                } else if (block.typeId === "setPositionShape") {
                    const p = block.props || {};
                    result.push({
                        name: "position",
                        type: "vec3",
                        usage: "set",
                        stage: ctx.typeId,
                        composition: (p.positionComposition as string) || "Overwrite",
                    });
                    const orientFlags = (p.applyOrientation as number) ?? 0b01;
                    if (orientFlags & 1) {
                        result.push({
                            name: "direction",
                            type: "vec3",
                            usage: "set",
                            stage: ctx.typeId,
                            composition: (p.directionComposition as string) || "Overwrite",
                        });
                    }
                    if (orientFlags & 2) {
                        for (const axis of ["axisX", "axisY", "axisZ"]) {
                            result.push({
                                name: axis,
                                type: "vec3",
                                usage: "set",
                                stage: ctx.typeId,
                                composition: (p.axesComposition as string) || "Overwrite",
                            });
                        }
                    }
                } else if (block.typeId === "turbulence") {
                    result.push({ name: "velocity", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Add" });
                    result.push({ name: "position", type: "vec3", usage: "get", stage: ctx.typeId });
                    result.push({ name: "mass", type: "float", usage: "get", stage: ctx.typeId });
                } else if (block.typeId === "vortex") {
                    // vortex (Unity VortexForceField)：p.velocity += (axis*channel + radial*gravity + tangent*vortex)*dt
                    // 然后 p.velocity *= exp(-drag*dt / p.mass)（BlockCodeGenCommon vortex codegen）
                    // 需读 position（按径向距离采曲线）/ 写 velocity / 读 mass，漏注册 mass → 'no such field mass' 编译失败
                    result.push({ name: "velocity", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Add" });
                    result.push({ name: "position", type: "vec3", usage: "get", stage: ctx.typeId });
                    result.push({ name: "mass", type: "float", usage: "get", stage: ctx.typeId });
                } else if (block.typeId === "force") {
                    result.push({ name: "velocity", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Add" });
                    // force shader 不论 Absolute / Relative 都用 p.mass（velocity += force/mass*dt 或 (target-velocity)*min(1, drag*dt/mass)）
                    // 之前只在 Relative 注入 mass 让 Absolute 模式 shader 引用 p.mass 时 Particle struct 没 mass 字段 → 编译失败
                    result.push({ name: "mass", type: "float", usage: "get", stage: ctx.typeId });
                } else if (block.typeId === "attractorSphere") {
                    result.push({ name: "velocity", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Add" });
                    result.push({ name: "position", type: "vec3", usage: "get", stage: ctx.typeId });
                } else if (block.typeId === "calculateMassFromVolume") {
                    const comp = (block.props?.composition as string) || "Overwrite";
                    result.push({ name: "mass", type: "float", usage: "set", stage: ctx.typeId, composition: comp });
                    result.push({ name: "scale", type: "vec3", usage: "get", stage: ctx.typeId });
                } else if (block.typeId === "conformToSphere" || block.typeId === "conformToAABox"
                    || block.typeId === "conformToOrientedBox" || block.typeId === "conformToCone") {
                    result.push({ name: "velocity", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Add" });
                    result.push({ name: "position", type: "vec3", usage: "get", stage: ctx.typeId });
                    result.push({ name: "mass", type: "float", usage: "get", stage: ctx.typeId });
                } else if (block.typeId === "collisionOrientedBox" || block.typeId === "collisionTorus"
                    || block.typeId === "collisionAABox" || block.typeId === "collisionPlane"
                    || block.typeId === "collisionSphere") {
                    // collisionAABox/Plane/Sphere 与 collisionOrientedBox/Torus 一样走 collisionResponse 共享代码：
                    // 读 p.velocity + p.position，反弹后写回。漏声明 usage 会让 attribute scanner 不注入
                    // velocity 字段到 Particle struct → GLSL 引用 p.velocity 时 'no such field' 编译失败
                    result.push({ name: "velocity", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                    result.push({ name: "position", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                    if ((block.props?.lifetimeLoss as number) > 0) {
                        result.push({ name: "age", type: "float", usage: "set", stage: ctx.typeId, composition: "Add" });
                    }
                } else if (block.typeId === "colorOverLife") {
                    result.push({ name: "color", type: "color", usage: "set", stage: ctx.typeId, composition: (block.props?.composition as string) || "Multiply" });
                    result.push({ name: "normalizedAge", type: "float", usage: "get", stage: ctx.typeId });
                } else if (block.typeId === "alphaOverLife") {
                    result.push({ name: "alpha", type: "float", usage: "set", stage: ctx.typeId, composition: "Multiply" });
                    result.push({ name: "normalizedAge", type: "float", usage: "get", stage: ctx.typeId });
                } else if (block.typeId === "velTangent" || block.typeId === "velSpherical") {
                    const comp = (block.props?.composition as string) || "Add";
                    result.push({ name: "velocity", type: "vec3", usage: "set", stage: ctx.typeId, composition: comp });
                    result.push({ name: "position", type: "vec3", usage: "get", stage: ctx.typeId });
                } else if (block.typeId === "velSpeed" || block.typeId === "velAlongVelocity") {
                    const comp = (block.props?.composition as string) || "Overwrite";
                    result.push({ name: "velocity", type: "vec3", usage: "set", stage: ctx.typeId, composition: comp });
                    result.push({ name: "direction", type: "vec3", usage: "get", stage: ctx.typeId });
                } else if (block.typeId === "velRandom") {
                    const comp = (block.props?.composition as string) || "Overwrite";
                    result.push({ name: "velocity", type: "vec3", usage: "set", stage: ctx.typeId, composition: comp });
                } else if (block.typeId === "collisionCone") {
                    result.push({ name: "velocity", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                    result.push({ name: "position", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                    result.push({ name: "age", type: "float", usage: "set", stage: ctx.typeId, composition: "Add" });
                } else if (block.typeId === "positionSequential") {
                    result.push({ name: "position", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                    result.push({ name: "spawnIndex", type: "uint", usage: "get", stage: ctx.typeId });
                    // Circle 模式会额外写 direction（outward normal）
                    if ((block.props?.mode as string) === "Circle") {
                        result.push({ name: "direction", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                    }
                } else if (block.typeId === "connectTarget") {
                    result.push({ name: "targetPosition", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                    result.push({ name: "axisX", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                    result.push({ name: "axisY", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                    result.push({ name: "axisZ", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                    result.push({ name: "scale", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                    result.push({ name: "pivot", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                    result.push({ name: "position", type: "vec3", usage: "get", stage: ctx.typeId });
                    result.push({ name: "direction", type: "vec3", usage: "get", stage: ctx.typeId });
                } else if (block.typeId === "flipbookPlay") {
                    result.push({ name: "texIndex", type: "float", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                    result.push({ name: "normalizedAge", type: "float", usage: "get", stage: ctx.typeId });
                    result.push({ name: "age", type: "float", usage: "get", stage: ctx.typeId });
                    result.push({ name: "velocity", type: "vec3", usage: "get", stage: ctx.typeId });
                } else if (block.typeId === "screenSpaceSize") {
                    result.push({ name: "size", type: "float", usage: "set", stage: ctx.typeId, composition: "Multiply" });
                    result.push({ name: "position", type: "vec3", usage: "get", stage: ctx.typeId });
                } else if (block.typeId === "cameraFade") {
                    result.push({ name: "alpha", type: "float", usage: "set", stage: ctx.typeId, composition: "Multiply" });
                    result.push({ name: "position", type: "vec3", usage: "get", stage: ctx.typeId });
                } else if (block.typeId === "setPositionDepthBuffer") {
                    result.push({ name: "position", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                } else if (block.typeId === "collisionSDF") {
                    result.push({ name: "position", type: "vec3", usage: "get", stage: ctx.typeId });
                    const sdfBounce = (block.props?.mode as string) === "Bounce";
                    if (sdfBounce) {
                        result.push({ name: "velocity", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                        result.push({ name: "position", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                    } else {
                        result.push({ name: "alive", type: "bool", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                    }
                } else if (block.typeId === "attractorShapeSDF") {
                    result.push({ name: "position", type: "vec3", usage: "get", stage: ctx.typeId });
                    result.push({ name: "velocity", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Add" });
                    // codegen 用 mass 做加速度限制（_saStep / max(p.mass, 1e-6)），需要注册 attribute
                    result.push({ name: "mass", type: "float", usage: "get", stage: ctx.typeId });
                } else if (block.typeId === "collisionDepthBuffer") {
                    result.push({ name: "position", type: "vec3", usage: "get", stage: ctx.typeId });
                    const bounce = (block.props?.mode as string) === "Bounce";
                    if (bounce) {
                        result.push({ name: "velocity", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                        result.push({ name: "position", type: "vec3", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                    } else {
                        result.push({ name: "alive", type: "bool", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                    }
                } else if (block.typeId === "positionSDF") {
                    const comp = (block.props?.composition as string) || "Overwrite";
                    result.push({ name: "position", type: "vec3", usage: "set", stage: ctx.typeId, composition: comp });
                } else if (block.typeId === "setPositionMesh") {
                    const comp = (block.props?.composition as string) || "Overwrite";
                    result.push({ name: "position", type: "vec3", usage: "set", stage: ctx.typeId, composition: comp });
                } else if (block.typeId === "incrementStripIndex") {
                    result.push({ name: "stripIndex", type: "uint", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                } else if (block.typeId === "setSpawnTime") {
                    result.push({ name: "spawnTime", type: "float", usage: "set", stage: ctx.typeId, composition: "Overwrite" });
                }
            }
        }

        // 2. 从 getAttribute operator 收集（get），递归追踪 operator 链找到最终连接的 context stage
        const ctxMap = new Map(contexts.map(c => [c.id, c]));
        const opMap = new Map(operators.map(o => [o.id, o]));

        /** 递归追踪 operator 输出链，收集最终到达的 context stage */
        function traceToContextStages(op: IVfxOperatorData, visited: Set<number>, stages: Set<string>): void {
            if (!op.output) return;
            for (const slot of Object.values(op.output)) {
                for (const conn of slot.infoArr || []) {
                    const ctx = ctxMap.get(conn.nodeId);
                    if (ctx) {
                        stages.add(ctx.typeId);
                    } else {
                        // 连接到另一个 operator，继续追踪
                        const nextOp = opMap.get(conn.nodeId);
                        if (nextOp && !visited.has(nextOp.id)) {
                            visited.add(nextOp.id);
                            traceToContextStages(nextOp, visited, stages);
                        }
                    }
                }
            }
        }

        for (const op of operators) {
            if (op.typeId !== "getAttribute" || !op.output) continue;
            let attrName = (op.props?.attribute as string) || "position";
            // Unity attribute alias: spawnIndexInStrip → particleIndexInStrip (跟 VfxExprCompiler 同 alias)
            // 让 attribute set 含 particleIndexInStrip → Particle struct 有该字段, getAttribute() 才能编译
            if (attrName === "spawnIndexInStrip") attrName = "particleIndexInStrip";

            // 递归追踪 operator 输出链，找到最终连接到的 context stage
            const connectedStages = new Set<string>();
            const visited = new Set<number>([op.id]);
            traceToContextStages(op, visited, connectedStages);

            // 每个 stage 生成一条 get 记录
            const location = (op.props?.location as string) || "Current";
            for (const stage of connectedStages) {
                result.push({
                    name: attrName,
                    type: getAttributeType(attrName),
                    usage: "get",
                    stage,
                    location,
                });
            }
        }

        // getCustomAttribute — 用户自定义属性的 get 追踪：attribute 必须由用户
        // 在某个 stage 用 setAttribute 或 setAttributeCurve 声明过（free-form 名字）。
        // 这里补一条 "get" 记录，避免 "字段未声明" 造成 shader 编译失败。
        for (const op of operators) {
            if (op.typeId !== "getCustomAttribute" || !op.output) continue;
            const rawName = (op.props?.name as string) || "";
            const name = rawName.replace(/[^A-Za-z0-9_]/g, "_");
            if (!name) continue;
            const type = (op.props?._type as string) || "float";
            const connectedStages = new Set<string>();
            const visited = new Set<number>([op.id]);
            traceToContextStages(op, visited, connectedStages);
            for (const stage of connectedStages) {
                result.push({ name, type, usage: "get", stage });
            }
        }

        // 2c. attributeFromMap block 在 sampleMode=RandomConstantPerParticle/Sequential 时
        //     硬编码引用 ${particleVar}.particleId（见 BlockCodeGenCommon.ts genAttributeFromMapCode）
        //     这是隐式依赖，外部扫描不到 → 必须显式补一条 get usage 触发后续 particleId 隐式注入
        for (const ctx of contexts) {
            for (const block of ctx.blocks || []) {
                if (block.typeId !== "attributeFromMap" || !block.enabled) continue;
                const sm = (block.props?.sampleMode as string) || "RandomConstantPerParticle";
                if (sm === "RandomConstantPerParticle" || sm === "Sequential") {
                    result.push({ name: "particleId", type: "uint", usage: "get", stage: ctx.typeId });
                }
            }
        }

        // 2d. sampleGradient / sampleCurve / colorize op 的 input "t" 不接时，
        //     VfxExprCompiler.ts 默认 fallback 用 `particle.normalizedAge`（见 line 1641-1646）。
        //     这是隐式依赖，必须补 get usage 让 attrNames 包含 normalizedAge,
        //     否则 shader Particle struct 没该字段 → "no such field 'normalizedAge'" 编译错。
        for (const op of operators) {
            if (op.typeId !== "sampleGradient" && op.typeId !== "sampleCurve" && op.typeId !== "colorize") continue;
            // 检查 input slot "t" 是否被外部 op 连接了（_inputs 里有真实 link 标记）
            const inputs = (op.props as any)?._inputs || {};
            const hasTLink = inputs.t != null && typeof inputs.t === "object" && (inputs.t as any).infoArr?.length > 0;
            if (hasTLink) continue;   // 真实接了 op，不需要 fallback
            const connectedStages = new Set<string>();
            const visited = new Set<number>([op.id]);
            traceToContextStages(op, visited, connectedStages);
            for (const stage of connectedStages) {
                result.push({ name: "normalizedAge", type: "float", usage: "get", stage });
            }
        }

        // 3. 若任意阶段存在随机 setAttribute 或 setPositionShape，自动注入 seed 属性
        //    Initialize 和 Update 都使用有状态 Rand(seed)
        let hasSeedNeed = false;
        for (const ctx of contexts) {
            if (ctx.typeId !== "initialize" && ctx.typeId !== "update") continue;
            for (const block of ctx.blocks || []) {
                if (!block.enabled) continue;
                if (block.typeId === "setPositionShape") {
                    hasSeedNeed = true;
                    break;
                }
                if (block.typeId === "setPositionMesh" || block.typeId === "positionSequential") {
                    hasSeedNeed = true;
                    break;
                }
                if ((block.typeId === "velNewDirection" || block.typeId === "velTangent" || block.typeId === "velSpeed" || block.typeId === "velRandom") && block.props?.speedMode === "Random") {
                    hasSeedNeed = true;
                    break;
                }
                if (block.typeId === "setAttributeCurve") {
                    const sm = (block.props?.sampleMode as string) || "OverLife";
                    if (sm === "Random" || sm === "RandomConstantPerParticle") {
                        hasSeedNeed = true;
                        break;
                    }
                }
                if (block.typeId !== "setAttribute") continue;
                const random = (block.props?.random as string) || "Off";
                if (random !== "Off" && block.props?.source !== "Source") {
                    hasSeedNeed = true;
                    break;
                }
            }
            if (hasSeedNeed) break;
        }
        // 也扫 operators —— randomNumber 等 op emit Rand(p.seed)，但只在 op 被
        // init/update 阶段实际引用时才需要 seed。这里采用保守策略：只要 graph 里
        // 存在 randomNumber operator 就注入 seed，避免 dead-link 检测复杂度。
        if (!hasSeedNeed) {
            for (const op of operators || []) {
                if (op.typeId === "randomNumber") { hasSeedNeed = true; break; }
            }
        }
        if (hasSeedNeed && !result.some(a => a.name === "seed")) {
            result.push({ name: "seed", type: "uint", usage: "set", stage: "initialize" });
        }

        // 4. 隐式属性自动注入：particleId / spawnIndex 被 getAttribute 引用时自动加入
        //    它们由 Init shader 隐式赋值，不需要用户手动 set
        for (const implicitName of ["particleId", "spawnIndex"] as const) {
            if (result.some(a => a.name === implicitName && a.usage === "get") && !result.some(a => a.name === implicitName && a.usage === "set")) {
                result.push({ name: implicitName, type: "uint", usage: "set", stage: "initialize" });
            }
        }

        // 4b. outputTrail → 自动注入 stripIndex / particleIndexInStrip
        // ⚠️ 不论 stripCapacity 是 1 还是 N，useStripRingBuffer 路径在 init shader 都无条件写
        //    `particle.stripIndex = stripIdx`，attribute set 必须含该字段否则 Particle struct 没生成
        //    → 'no such field stripIndex' 编译失败 (StripProperties sample 即使 stripCap=1)。
        const outputTrailCtx = contexts.find(c => c.typeId === "outputTrail");
        if (outputTrailCtx) {
            // Strip output shader (templates/Update.ts) 用 `if (!p.alive)` 检查死粒子, alive/age/lifetime/normalizedAge 必须在 Particle struct.
            // 即使 init 没显式 setAttribute(lifetime), 也要让 useStripRingBuffer 路径有这些字段, 否则 shader 编译错 fragment 完全不画.
            for (const a of ["alive", "lifetime", "age", "normalizedAge"] as const) {
                if (!result.some(e => e.name === a)) {
                    const t = a === "alive" ? "bool" : "float";
                    result.push({ name: a, type: t, usage: "set", stage: "initialize" });
                }
            }
            if (!result.some(a => a.name === "stripIndex")) {
                result.push({ name: "stripIndex", type: "uint", usage: "set", stage: "initialize" });
                result.push({ name: "stripIndex", type: "uint", usage: "get", stage: "outputTrail" });
            }
            // particleIndexInStrip / particleCountInStrip: Update.ts 每帧动态重算（对齐 Unity
            // VFXParticleStripCommon.hlsl InitStripAttributes），让 stripRatio 沿 ribbon 平滑。
            // 某些 sample 没显式 op 链引用，但 init/update 仍要写 → particle struct 必须含字段。
            if (!result.some(a => a.name === "particleIndexInStrip")) {
                result.push({ name: "particleIndexInStrip", type: "uint", usage: "set", stage: "initialize" });
            }
            if (!result.some(a => a.name === "particleCountInStrip")) {
                result.push({ name: "particleCountInStrip", type: "uint", usage: "set", stage: "update" });
            }
            // 4c. outputTrail → 自动注入 stripGeneration（区分同一 stripIndex 不同 head 的 trail 粒子）
            if (!result.some(a => a.name === "stripGeneration")) {
                result.push({ name: "stripGeneration", type: "float", usage: "set", stage: "initialize" });
                result.push({ name: "stripGeneration", type: "float", usage: "get", stage: "outputTrail" });
            }
            // 4d. outputTrail → 自动注入 headDeathTime（精确同步 head 和 trail 的透明度衰减）
            if (!result.some(a => a.name === "headDeathTime")) {
                result.push({ name: "headDeathTime", type: "float", usage: "set", stage: "initialize" });
                result.push({ name: "headDeathTime", type: "float", usage: "get", stage: "outputTrail" });
            }
        }

        // 5. 关联属性自动引入：隐式行为依赖的属性
        const writtenAttrs = new Set(result.filter(a => a.usage === "set").map(a => a.name));
        //    velocity 被写入 → 需要 position（EulerIntegration: position += velocity * dt）
        if (writtenAttrs.has("velocity") && !result.some(a => a.name === "position")) {
            result.push({ name: "position", type: "vec3", usage: "set", stage: "initialize" });
        }
        //    simulateSpace=World → 需要 position（Initialize/Output 中做空间变换）
        const initCtx = contexts.find(c => c.typeId === "initialize");
        if (initCtx?.props?.space === "World" && !result.some(a => a.name === "position")) {
            result.push({ name: "position", type: "vec3", usage: "set", stage: "initialize" });
        }
        //    lifetime 被写入 → 需要 age + alive（Age: age += dt; Reap: alive = alive && age < lifetime）
        if (writtenAttrs.has("lifetime")) {
            if (!writtenAttrs.has("age")) {
                result.push({ name: "age", type: "float", usage: "set", stage: "initialize" });
            }
            if (!writtenAttrs.has("alive")) {
                result.push({ name: "alive", type: "bool", usage: "set", stage: "initialize" });
            }
            if (!writtenAttrs.has("normalizedAge")) {
                result.push({ name: "normalizedAge", type: "float", usage: "set", stage: "initialize" });
            }
        }

        // 6. OverDistance GPU Event → 自动注入 oldPosition（updateParticle 中备份）
        const updateCtx = contexts.find(c => c.typeId === "update");
        if (updateCtx) {
            const hasOverDistance = (updateCtx.blocks || []).some(
                b => b.enabled && b.typeId === "triggerEvent" && (b.props?.eventType as string) === "OverDistance"
            );
            if (hasOverDistance && !result.some(a => a.name === "oldPosition")) {
                result.push({ name: "oldPosition", type: "vec3", usage: "set", stage: "update" });
                result.push({ name: "oldPosition", type: "vec3", usage: "get", stage: "update" });
            }
        }

        return result;
    }

    /** VFX 类型 → 引擎类型
     * ⚠️ color 必须 Vector3 (12 bytes)，跟 GLSL `genSourceEventData` 用的 vec3 一致。
     * 原本 Vector4 (16 bytes) 会让 CPU buffer 比 GLSL std430 layout 多 4 bytes，
     * 导致 SourceEventData 后续字段（texIndex/lifetime）offset 与 GLSL 错位 → 字段读错。
     */
    private static _toEngineType(vfxType: string): string {
        switch (vfxType) {
            case "vec2": return "Vector2";
            case "vec3": return "Vector3";
            case "color": return "Vector3";
            case "vec4": return "Vector4";
            case "float": return "Float";
            case "bool": return "Bool";
            case "int": return "Int";
            case "uint": return "Uint";
            default: return "Float";
        }
    }

    /** 从 attributes 中收集来源为 Source 的属性，去重后生成 eventAttributes */
    private static _collectEventAttributes(attributes: IVfxAttributeUsage[]): { name: string; type: string }[] {
        const seen = new Set<string>();
        const result: { name: string; type: string }[] = [];
        for (const a of attributes) {
            const isSourceGet = a.usage === "get" && a.location === "Source";
            const isSourceSet = a.usage === "set" && a.source === "Source";
            if (!isSourceGet && !isSourceSet) continue;
            if (seen.has(a.name)) continue;
            seen.add(a.name);
            result.push({ name: a.name, type: VfxBuild._toEngineType(a.type) });
        }
        return result;
    }

    /**
     * 跨多 particle system 收集 eventAttributes，按 spawn-first 顺序合并去重。
     * 保证 lvfx eventAttributes 顺序 = GLSL SourceEventData struct 字段顺序，
     * 让 CPU `VFXEventAttributeDesc` 算出的字段 offset 与 GLSL std430 layout 一致。
     */
    private static _collectEventAttributesFromPerSystem(perSystemAttrs: IVfxAttributeUsage[][]): { name: string; type: string }[] {
        const seen = new Set<string>();
        const result: { name: string; type: string }[] = [];
        for (const usages of perSystemAttrs) {
            for (const a of usages) {
                const isSourceGet = a.usage === "get" && a.location === "Source";
                const isSourceSet = a.usage === "set" && a.source === "Source";
                if (!isSourceGet && !isSourceSet) continue;
                if (a.name === "spawnCount") continue;   // 内置 header，不在 events[]
                if (seen.has(a.name)) continue;
                seen.add(a.name);
                result.push({ name: a.name, type: VfxBuild._toEngineType(a.type) });
            }
        }
        return result;
    }

    /** 编译 Event 列表 → 解析 flowLinks 为 system 索引（排除 gpuEvent） */
    private static _compileEvents(
        events: IVfxEventData[],
        spawnIdToIdx: Map<number, number>,
        validParticles: { initCtx: IVfxContextData; updateCtx: IVfxContextData; outputCtxs: IVfxContextData[]; spawnIds: number[] }[],
        particleStartIdx: number,
    ): IVfxCompiledEvent[] {
        // GPU Event 不编译到 events 数组中
        events = events.filter(e => e.typeId !== "gpuEvent");
        // initCtx.id → particle system 在 systems 数组中的索引
        const initIdToSystemIdx = new Map<number, number>();
        for (let i = 0; i < validParticles.length; i++) {
            initIdToSystemIdx.set(validParticles[i].initCtx.id, particleStartIdx + i);
        }

        // 记录已被 Event 连接的 Spawn（按 start/stop 分别追踪）
        const connectedStart = new Set<number>();
        const connectedStop = new Set<number>();

        const compiled = events.map(evt => {
            const playSystems: number[] = [];
            const stopSystems: number[] = [];
            const initSystems: number[] = [];

            const links = evt.flowLinks;
            if (links) {
                for (const key of Object.keys(links)) {
                    // event 的 flow link 是 1:N（一个 source 连多个 target），所以 lk 可能是 array；
                    // 单 target 则是 object，统一规范成 array 再遍历
                    const lkRaw = links[key];
                    const lks: any[] = Array.isArray(lkRaw) ? lkRaw : [lkRaw];
                    for (const lk of lks) {
                        if (!lk) continue;
                        if (lk.targetSlotId === "start") {
                            const idx = spawnIdToIdx.get(lk.targetId);
                            if (idx != null) { playSystems.push(idx); connectedStart.add(idx); }
                        } else if (lk.targetSlotId === "stop") {
                            const idx = spawnIdToIdx.get(lk.targetId);
                            if (idx != null) { stopSystems.push(idx); connectedStop.add(idx); }
                        } else if (lk.targetSlotId === "input") {
                            const idx = initIdToSystemIdx.get(lk.targetId);
                            if (idx != null) initSystems.push(idx);
                        }
                    }
                }
            }

            return {
                name: evt.props?.eventName ?? "OnPlay",
                playSystems,
                stopSystems,
                initSystems,
            };
        });

        // 未连接 Event 的 Spawn 默认归入 OnPlay / OnStop
        const allSpawnIndices = Array.from(spawnIdToIdx.values());
        const unconnectedStart = allSpawnIndices.filter(i => !connectedStart.has(i));
        const unconnectedStop = allSpawnIndices.filter(i => !connectedStop.has(i));

        if (unconnectedStart.length > 0) {
            let onPlay = compiled.find(e => e.name === "OnPlay");
            if (!onPlay) { onPlay = { name: "OnPlay", playSystems: [], stopSystems: [], initSystems: [] }; compiled.push(onPlay); }
            onPlay.playSystems.push(...unconnectedStart);
        }
        if (unconnectedStop.length > 0) {
            let onStop = compiled.find(e => e.name === "OnStop");
            if (!onStop) { onStop = { name: "OnStop", playSystems: [], stopSystems: [], initSystems: [] }; compiled.push(onStop); }
            onStop.stopSystems.push(...unconnectedStop);
        }

        return compiled;
    }

    /**
     * 检测 Initialize 是否通过 GPU Event 接收事件。
     * 连接链：Update(triggerEvent block) → GPUEvent → Initialize(input)
     * 返回 gpuEventInput 对象，或 null。
     */
    private static _resolveGPUEventInput(
        initCtx: IVfxContextData,
        gpuEvents: IVfxEventData[],
        contexts: IVfxContextData[],
        validParticles: { initCtx: IVfxContextData; updateCtx: IVfxContextData; outputCtxs: IVfxContextData[]; spawnIds: number[] }[],
        particleStartIdx: number,
    ): { sourceSystem: number; eventType: string; param: number } | null {
        // 找连接到此 Initialize(input) 的 GPU Event
        const gpuEvt = gpuEvents.find(evt => {
            if (!evt.flowLinks) return false;
            return iterateFlowTargets(evt.flowLinks).some(
                lk => lk.targetId === initCtx.id && lk.targetSlotId === "input"
            );
        });
        if (!gpuEvt) return null;

        // 找哪个 Context 的 flowLinks 连接到此 GPU Event 的 evt 输入
        for (const ctx of contexts) {
            if (!ctx.flowLinks) continue;
            for (const [slotId, lk] of Object.entries(ctx.flowLinks)) {
                if (lk.targetId !== gpuEvt.id || lk.targetSlotId !== "evt") continue;
                // 解析 block_<blockId>_evt → 找到 triggerEvent block
                const parsed = parseBlockSlotId(slotId);
                if (!parsed) continue;
                const block = (ctx.blocks || []).find(b => b.id === parsed.blockId && b.typeId === "triggerEvent");
                if (!block) continue;

                // 找到包含此 Update context 的 Particle system 索引
                let sourceSystem = -1;
                for (let i = 0; i < validParticles.length; i++) {
                    if (validParticles[i].updateCtx.id === ctx.id) {
                        sourceSystem = particleStartIdx + i;
                        break;
                    }
                }

                const bp = block.props || {};
                return {
                    sourceSystem,
                    eventType: (bp.eventType as string) || "OnDie",
                    param: (bp.param as number) ?? 1,
                };
            }
        }
        return null;
    }

    /**
     * 从 Update context 中收集路由到 outputEvent context 的 triggerEvent blocks
     * → IOutputEventInfo[]（携带目标 outputEvent context 的 eventName / capacity）
     */
    private static _collectOutputEvents(
        updateCtx: IVfxContextData,
        contexts: IVfxContextData[],
    ): { eventIdx: number; eventType: string; param: number; eventName: string; capacity: number; blockId: number }[] {
        const result: { eventIdx: number; eventType: string; param: number; eventName: string; capacity: number; blockId: number }[] = [];
        const oeMap = new Map<number, IVfxContextData>();
        for (const ctx of contexts) {
            if (ctx.typeId === "outputEvent") oeMap.set(ctx.id, ctx);
        }
        if (oeMap.size === 0) return result;

        const flowLinks = updateCtx.flowLinks || {};
        let idx = 0;
        for (const block of updateCtx.blocks || []) {
            if (!block.enabled || block.typeId !== "triggerEvent") continue;
            const slotKey = `block_${block.id}_evt`;
            const link = flowLinks[slotKey];
            if (!link) continue;
            const oeCtx = oeMap.get(link.targetId);
            if (!oeCtx) continue;
            const bp = block.props || {};
            const op = oeCtx.props || {};
            result.push({
                eventIdx: idx,
                eventType: (bp.eventType as string) || "OnDie",
                param: (bp.param as number) ?? 1,
                eventName: (op.eventName as string) || "OnReceived",
                capacity: Math.max(1, Number(op.capacity) || 256),
                blockId: block.id,
            });
            idx++;
        }
        return result;
    }

    /** 从 Update context 中收集有效连接的 triggerEvent blocks → ITriggerEventInfo[] */
    private static _collectTriggerEvents(updateCtx: IVfxContextData, gpuEvents: IVfxEventData[]): { eventIdx: number; eventType: string; param: number }[] {
        const result: { eventIdx: number; eventType: string; param: number }[] = [];
        const gpuEventIds = new Set(gpuEvents.map(e => e.id));
        const flowLinks = updateCtx.flowLinks || {};
        let idx = 0;
        for (const block of updateCtx.blocks || []) {
            if (!block.enabled || block.typeId !== "triggerEvent") continue;
            // 检查此 block 的输出是否连接到了有效的 GPU Event 节点
            const slotKey = `block_${block.id}_evt`;
            const link = flowLinks[slotKey];
            if (!link || !gpuEventIds.has(link.targetId)) continue;
            const p = block.props || {};
            result.push({
                eventIdx: idx,
                eventType: (p.eventType as string) || "OnDie",
                param: (p.param as number) ?? 1,
            });
            idx++;
        }
        return result;
    }

    /** outputStaticMesh 的 setStaticMeshAttr block → binding 描述
     *  白名单源：inlineFloat/Color/Vec3/Vec4 → inline；getProperty → property；其他 → inline 默认 */
    private static _compileStaticMeshBinding(ctxId: number, blockId: number, target: string, allOperators: IVfxOperatorData[]): any {
        const slotId = `block_${blockId}_value`;
        // 默认值（按 target 决定）
        const defaultValue: any = target === "color" ? { r: 1, g: 1, b: 1, a: 1 }
                              : target === "scale" ? { x: 1, y: 1, z: 1 }
                              : { x: 0, y: 0, z: 0 };

        // 找连接到此 block input 的 source operator
        let sourceOp: IVfxOperatorData | null = null;
        outer: for (const op of allOperators) {
            if (!op.output) continue;
            for (const slot of Object.values(op.output)) {
                for (const conn of (slot.infoArr || [])) {
                    if (conn.nodeId === ctxId && conn.slotId === slotId) {
                        sourceOp = op;
                        break outer;
                    }
                }
            }
        }

        if (!sourceOp) {
            return { target, source: "inline", value: defaultValue };
        }

        const sp = sourceOp.props || {};
        switch (sourceOp.typeId) {
            case "inlineFloat": {
                const v = Number(sp.value ?? 0);
                // 标量喂到 vec3/vec4 时填全分量
                if (target === "color") return { target, source: "inline", value: { r: v, g: v, b: v, a: 1 } };
                return { target, source: "inline", value: { x: v, y: v, z: v } };
            }
            case "inlineColor":
                return { target, source: "inline", value: { r: Number(sp.r ?? 1), g: Number(sp.g ?? 1), b: Number(sp.b ?? 1), a: Number(sp.a ?? 1) } };
            case "inlineVector2":
                return { target, source: "inline", value: { x: Number(sp.x ?? 0), y: Number(sp.y ?? 0), z: 0 } };
            case "inlineVector3":
            case "inlineVector":
                return { target, source: "inline", value: { x: Number(sp.x ?? 0), y: Number(sp.y ?? 0), z: Number(sp.z ?? 0) } };
            case "inlineVector4":
                return { target, source: "inline", value: { r: Number(sp.x ?? 0), g: Number(sp.y ?? 0), b: Number(sp.z ?? 0), a: Number(sp.w ?? 1) } };
            case "getProperty":
                return { target, source: "property", name: String(sp.property || "") };
            default:
                console.warn(`[VFX] setStaticMeshAttr(target=${target}): operator typeId="${sourceOp.typeId}" 不在白名单（仅支持 inline / getProperty），回退默认值`);
                return { target, source: "inline", value: defaultValue };
        }
    }

    /** 找喂到 ctx 某 block slot 的 getProperty 算子名（spawn task 属性驱动用）。无链接/非 getProperty 返回 null */
    private static _findSpawnSlotProperty(ctxId: number, slotId: string, allOperators: IVfxOperatorData[]): string | null {
        for (const op of allOperators) {
            if (op.typeId !== "getProperty" || !op.output) continue;
            for (const slot of Object.values(op.output)) {
                for (const conn of ((slot as any).infoArr || [])) {
                    if (conn.nodeId === ctxId && conn.slotId === slotId) {
                        const name = String(op.props?.property || "");
                        return name || null;
                    }
                }
            }
        }
        return null;
    }

    /** 编译单个 Block → task 对象，不支持的返回 null */
    private static _compileBlock(block: IVfxBlockData, ctxId: number = -1, allOperators: IVfxOperatorData[] = []): any {
        const p = block.props || {};
        switch (block.typeId) {
            case "constantRate": {
                const task: any = {
                    type: "ConstantRate",
                    rate: p.rate ?? 10,
                };
                // rate 链到 getProperty(暴露属性)时记录属性名，runtime 每帧从 _propertyValues 读
                // （不能烘焙成常量，否则 Inspector 改 spawn rate 属性永远不生效）
                const rp = VfxBuild._findSpawnSlotProperty(ctxId, `block_${block.id}_value`, allOperators);
                if (rp) task.rateProperty = rp;
                return task;
            }
            case "singleBurst": {
                let count: [number, number];
                if (p.spawnMode === "Random") {
                    const range = p.countRange || { x: 0, y: 10 };
                    count = [range.x, range.y];
                } else {
                    const v = p.count ?? 0;
                    count = [v, v];
                }
                let delay: [number, number];
                if (p.delayMode === "Random") {
                    const range = p.delayRange || { x: 0, y: 1 };
                    delay = [range.x, range.y];
                } else {
                    const v = p.delay ?? 0;
                    delay = [v, v];
                }
                const result: any = {
                    type: "SingleBurst",
                    delay,
                    count,
                };
                if (p.countFromLoopIndex) {
                    result.countFromLoopIndex = true;
                    if (typeof p.countModulo === "number" && p.countModulo > 0) result.countModulo = p.countModulo;
                }
                return result;
            }
            case "periodicBurst": {
                let count: [number, number];
                if (p.spawnMode === "Random") {
                    const range = p.countRange || { x: 5, y: 15 };
                    count = [Number(range.x ?? 5), Number(range.y ?? 15)];
                } else {
                    const raw = p.count;
                    const v = Number(typeof raw === "object" ? (raw?.x ?? 1) : (raw ?? 10));
                    count = [v, v];
                }
                let period: [number, number];
                if (p.delayMode === "Random") {
                    const range = p.delayRange || { x: 0.5, y: 2 };
                    period = [Number(range.x ?? 0.5), Number(range.y ?? 2)];
                } else {
                    const raw = p.delay;
                    const v = Number(typeof raw === "object" ? (raw?.x ?? 1) : (raw ?? 1));
                    period = [v, v];
                }
                return {
                    type: "PeriodicBurst",
                    delay: period,
                    count,
                };
            }
            case "variableRate": {
                // runtime 未实现独立的 VariableRate spawn task（只有 ConstantRate/SingleBurst/PeriodicBurst），
                // 之前返回 type:"VariableRate" → runtime 无对应 task → 该系统一个粒子都不发射
                // （UNI_Aura 底圈 disc A 用 variableRate 持续发射，因此整圈不显示，只剩 singleBurst 那条播一次）。
                // variableRate 的 rate 在转换结果里是常量，与 ConstantRate 等价 → 映射到 ConstantRate 让其持续发射。
                const task: any = {
                    type: "ConstantRate",
                    rate: p.rate ?? 10,
                };
                const rp = VfxBuild._findSpawnSlotProperty(ctxId, `block_${block.id}_value`, allOperators);
                if (rp) task.rateProperty = rp;
                return task;
            }
            case "spawnOverDistance":
                return {
                    type: "SpawnOverDistance",
                    distance: Number(p.distance ?? 1),
                };
            case "customSpawn":
                return {
                    type: "CustomWrapper",
                    callbackName: String(p.callbackName ?? "default"),
                };
            case "setSpawnEventAttribute": {
                // 输出给 runtime VFXSpawnerTask: SetEventAttribute task
                // attribute name + 单值 / vec / loopIndex(%N) 三种来源
                const attr = String(p.attribute ?? "position");
                const result: any = {
                    type: "SetEventAttribute",
                    attribute: attr,
                };
                if (p.useLoopIndex) {
                    result.fromLoopIndex = true;
                    if (typeof p.loopIndexModulo === "number" && p.loopIndexModulo > 0) {
                        result.loopIndexModulo = p.loopIndexModulo;
                    }
                } else if (p.fromSpawnStateLoop) {
                    // Unity SpawnContext 模式：lifetime ← Add(spawnState.loopDuration, spawnState.delayAfterLoop)
                    // runtime 时由 VFXSpawnerSetEventAttribute 用 spawnerState.loopDuration+delayAfterLoop 算 lifetime
                    result.fromSpawnStateLoop = true;
                } else {
                    // IDE 打开 .vfx 时会把 def 中所有 property 默认填到 0，
                    // 不能仅靠 typeof valueX/Y/Z/W === "number" 判断是不是 vec 输入
                    // (lifetime/texIndex 等单值 attribute 也会有 valueX=0 让分支错走 vec)
                    // 优先级: 如果单值 value 非 0 → 单值; 否则任一分量非 0 → vec; 否则 fallback 单值
                    const single = Number(p.value ?? 0);
                    const vx = Number(p.valueX ?? 0);
                    const vy = Number(p.valueY ?? 0);
                    const vz = Number(p.valueZ ?? 0);
                    const vw = Number(p.valueW ?? 0);
                    const anyVecNonZero = (vx !== 0 || vy !== 0 || vz !== 0 || vw !== 0);
                    if (single !== 0) {
                        result.value = [single, 0, 0, 0];
                    } else if (anyVecNonZero) {
                        result.value = [vx, vy, vz, vw];
                    } else {
                        result.value = [single, 0, 0, 0];
                    }
                }
                return result;
            }
            default:
                return null;
        }
    }
}
