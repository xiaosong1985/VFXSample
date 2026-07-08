/**
 * Context 类型定义 — 生命周期容器
 *
 * 添加新 Context 类型只需在 VFX_CONTEXT_DEFS 数组中追加条目。
 */

import type { IVfxContextTypeDef } from "./VfxTypes";

// ─── 颜色常量 ──────────────────────────────────────

const C_SPAWN = "#7B4E8E";
const C_INIT = "#3A6E8F";
const C_UPDATE = "#5A8A3F";
const C_OUTPUT = "#8F5A3A";

// 输出混合模式 — 对齐 Unity VFX Graph BlendMode 枚举
const BLEND_MODE_PROP = { name: "blendMode", caption: "Blend Mode", type: "string", enumSource: ["Alpha", "Additive", "Premultiplied", "Opaque"], default: "Alpha" };

// Soft Particle 淡出距离（眼空间单位，0 = 关闭）
// 对齐 Unity VFX Graph Soft Particles
const SOFT_PARTICLE_PROP = { name: "softParticleFade", caption: "Soft Particle Fade", type: "number", default: 0, min: 0, step: 0.01 };

// UV Mode — 对齐 Unity VFX Graph Output Context UV Mode 枚举
// Default: 单帧纹理   Flipbook: 帧动画硬切   FlipbookBlend: 帧间平滑混合
const UV_MODE_PROP = { name: "uvMode", caption: "UV Mode", type: "string", enumSource: ["Default", "Flipbook", "FlipbookBlend"], default: "Default" };
const FLIPBOOK_SIZE_PROP = { name: "flipbookSize", caption: "Flipbook Size (cols, rows)", type: "vec2", default: { x: 4, y: 4 }, hidden: "data.uvMode === 'Default'" };

// ─── Context 定义 ──────────────────────────────────

export const VFX_CONTEXT_DEFS: IVfxContextTypeDef[] = [
    {
        typeId: "spawn",
        title: "Spawn",
        color: C_SPAWN,
        flowInputs: [
            { id: "start", name: "OnStart", type: "flow" },
            { id: "stop", name: "OnStop", type: "flow" },
        ],
        flowOutputs: [
            { id: "spawnEvt", name: "SpawnEvent", type: "flow" },
        ],
        compatibleBlocks: ["constantRate", "singleBurst", "periodicBurst", "variableRate", "setSpawnEventAttribute"],
        properties: [
            { name: "durationMode", caption: "Loop Duration", type: "string", enumSource: ["Infinite", "Constant", "Random"], default: "Infinite" },
            { name: "loopDuration", caption: "Duration", type: "number", default: 1, min: 0, step: 0.1, hidden: "data.durationMode !== 'Constant'" },
            { name: "loopDurationRange", caption: "Duration", type: "vec2", default: { x: 1, y: 3 }, min: 0, step: 0.1, hidden: "data.durationMode !== 'Random'" },
            { name: "countMode", caption: "Loop Count", type: "string", enumSource: ["Infinite", "Constant", "Random"], default: "Infinite" },
            { name: "loopCount", caption: "Count", type: "number", default: 1, min: 0, step: 1, hidden: "data.countMode !== 'Constant'" },
            { name: "loopCountRange", caption: "Count", type: "vec2", default: { x: 1, y: 3 }, min: 0, step: 1, hidden: "data.countMode !== 'Random'" },
            { name: "delayBeforeLoop", caption: "Delay Before Loop", type: "boolean", default: false },
            { name: "delayAfterLoop", caption: "Delay After Loop", type: "boolean", default: false },
        ],
    },
    {
        typeId: "initialize",
        title: "Initialize",
        color: C_INIT,
        flowInputs: [
            { id: "input", name: "Input", type: "flow" },
        ],
        flowOutputs: [
            { id: "output", name: "Output", type: "flow" },
        ],
        compatibleBlocks: ["setAttribute", "setAttributeCurve", "attributeFromMap", "setPositionShape", "positionSequential", "positionSDF", "velNewDirection", "velRandom", "velSpherical", "velAlongVelocity", "calculateMassFromVolume", "killSphere", "killAABox"],
        properties: [
            { name: "space", caption: "Space", type: "space", default: "Local" },
            { name: "capacity", caption: "Capacity", type: "number", default: 64, min: 1, step: 1 },
            { name: "boundsMode", caption: "Bounds Mode", type: "string", enumSource: ["Automatic", "Manual"], default: "Automatic" },
            { name: "boundsCenter", caption: "Bounds Center", type: "vec3", default: { x: 0, y: 0, z: 0 }, hidden: "data.boundsMode !== 'Manual'" },
            { name: "boundsSize", caption: "Bounds Size", type: "vec3", default: { x: 1, y: 1, z: 1 }, hidden: "data.boundsMode !== 'Manual'" },
        ],
    },
    {
        typeId: "update",
        title: "Update",
        color: C_UPDATE,
        flowInputs: [
            { id: "input", name: "Input", type: "flow" },
        ],
        flowOutputs: [
            { id: "output", name: "Output", type: "flow" },
        ],
        compatibleBlocks: ["setAttribute", "setAttributeCurve", "attributeFromMap", "setPositionShape", "velNewDirection", "velRandom", "velSpherical", "velAlongVelocity", "gravity", "linearDrag", "force", "attractorSphere", "conformToSphere", "turbulence", "vectorFieldForce", "attractorShapeSDF", "collisionPlane", "collisionSphere", "collisionAABox", "collisionSDF", "killSphere", "killAABox", "tileWarpPositions", "triggerEvent"],
        properties: [
            { name: "updatePosition", caption: "Update Position", type: "boolean", default: true, blockHidden: true } as any,
            { name: "ageParticles", caption: "Age Particles", type: "boolean", default: true, blockHidden: true } as any,
            { name: "reapParticles", caption: "Reap Particles", type: "boolean", default: true, blockHidden: true } as any,
            { name: "skipZeroDeltaTime", caption: "Skip Zero Delta Time", type: "boolean", default: false, blockHidden: true } as any,
        ],
    },
    {
        typeId: "outputBillboard",
        title: "Output Billboard",
        color: C_OUTPUT,
        flowInputs: [
            { id: "input", name: "Input", type: "flow" },
        ],
        flowOutputs: [],
        compatibleBlocks: ["setAttribute", "setAttributeCurve", "attributeFromMap", "orient", "cameraFade", "colorOverLife", "alphaOverLife", "connectTarget", "flipbookPlay", "screenSpaceSize"],
        properties: [
            // Unity VFXPlanarPrimitiveOutput 对齐：三种 billboard 形状
            // Quad: 6 顶点（2 三角形）；Triangle: 3 顶点；Octagon: 18 顶点（6 三角形，按 cropFactor 裁角）
            { name: "primitive", caption: "Primitive", type: "string", enumSource: ["Quad", "Triangle", "Octagon"], default: "Quad" },
            // Octagon 专用：裁角因子 [0, 1]，控制八边形从接近方形→接近圆形，减少 overdraw
            { name: "cropFactor", caption: "Crop Factor", type: "number", default: 0.146, min: 0, max: 0.5, step: 0.01, hidden: "data.primitive !== 'Octagon'" },
            BLEND_MODE_PROP,
            // Unity VFXPlanarPrimitiveOutput.useAlphaClipping 对齐：alpha mask 纹理裁切（atlas 字符 / brush stroke 等）
            // shader 用 #ifdef VFX_ALPHA_CLIP 路径在 `texColor.a < u_AlphaThreshold` 时 discard 像素
            { name: "useAlphaClipping", caption: "Use Alpha Clipping", type: "boolean", default: false },
            { name: "alphaThreshold", caption: "Alpha Threshold", type: "number", default: 0.5, min: 0, max: 1, step: 0.01, hidden: "!data.useAlphaClipping" },
            SOFT_PARTICLE_PROP,
            UV_MODE_PROP,
            FLIPBOOK_SIZE_PROP,
            { name: "cameraSort", caption: "Camera Sort", type: "boolean", default: false },
            { name: "frustumCull", caption: "Frustum Culling", type: "boolean", default: false },
        ],
    },
    {
        // Unity VFXComposedParticleOutput 对齐（API 形式对齐）：把 Topology + Shading 配置在
        // 同一节点暴露。Topology=Quad/Triangle/Octagon 走 outputBillboard 编译路径，
        // Topology=Mesh 走 outputMesh 编译路径。视觉效果等价于这两个 context 但 API 统一。
        typeId: "outputComposedParticle",
        title: "Output Composed Particle",
        color: C_OUTPUT,
        flowInputs: [
            { id: "input", name: "Input", type: "flow" },
        ],
        flowOutputs: [],
        compatibleBlocks: ["setAttribute", "setAttributeCurve", "attributeFromMap", "orient", "cameraFade", "colorOverLife", "alphaOverLife", "connectTarget", "flipbookPlay", "screenSpaceSize"],
        properties: [
            // ── Topology trait ──
            { name: "topology", caption: "Topology", type: "string", enumSource: ["Quad", "Triangle", "Octagon", "Mesh"], default: "Quad" },
            // Octagon: 裁角因子
            { name: "cropFactor", caption: "Crop Factor", type: "number", default: 0.146, min: 0, max: 0.5, step: 0.01, hidden: "data.topology !== 'Octagon'" },
            // Mesh: 网格资源
            { name: "mesh", caption: "Mesh", type: "Mesh", hidden: "data.topology !== 'Mesh'" },
            // ── Shading trait ──
            BLEND_MODE_PROP,
            { name: "useAlphaClipping", caption: "Use Alpha Clipping", type: "boolean", default: false },
            { name: "alphaThreshold", caption: "Alpha Threshold", type: "number", default: 0.5, min: 0, max: 1, step: 0.01, hidden: "!data.useAlphaClipping" },
            SOFT_PARTICLE_PROP,
            UV_MODE_PROP,
            FLIPBOOK_SIZE_PROP,
            { name: "cameraSort", caption: "Camera Sort", type: "boolean", default: false },
            { name: "frustumCull", caption: "Frustum Culling", type: "boolean", default: false },
        ],
    },
    {
        typeId: "outputMesh",
        title: "Output Mesh",
        color: C_OUTPUT,
        flowInputs: [
            { id: "input", name: "Input", type: "flow" },
        ],
        flowOutputs: [],
        compatibleBlocks: ["setAttribute", "setAttributeCurve", "attributeFromMap", "orient", "cameraFade", "colorOverLife", "alphaOverLife", "connectTarget", "flipbookPlay", "screenSpaceSize"],
        properties: [
            { name: "mesh", caption: "Mesh", type: "Mesh" },
            // 对齐 Unity Output Mesh 的 Main Texture —— 基础 mesh(无 shadergraph)也能直接设纹理。
            { name: "mainTexture", caption: "Main Texture", type: "Texture2D", default: "" },
            BLEND_MODE_PROP,
            { name: "useAlphaClipping", caption: "Use Alpha Clipping", type: "boolean", default: false },
            { name: "alphaThreshold", caption: "Alpha Threshold", type: "number", default: 0.5, min: 0, max: 1, step: 0.01, hidden: "!data.useAlphaClipping" },
            SOFT_PARTICLE_PROP,
            UV_MODE_PROP,
            FLIPBOOK_SIZE_PROP,
            { name: "cameraSort", caption: "Camera Sort", type: "boolean", default: false },
            { name: "frustumCull", caption: "Frustum Culling", type: "boolean", default: false },
        ],
    },
    {
        typeId: "outputShaderGraphQuad",
        title: "Output Particle (ShaderGraph)",
        color: C_OUTPUT,
        flowInputs: [
            { id: "input", name: "Input", type: "flow" },
        ],
        flowOutputs: [],
        compatibleBlocks: ["setAttribute", "setAttributeCurve", "attributeFromMap", "orient", "cameraFade", "colorOverLife", "alphaOverLife", "connectTarget", "flipbookPlay", "screenSpaceSize"],
        properties: [
            // shaderName 由 shaderRes(蓝图.bps) 自动派生（= 文件名去扩展），节点图里隐藏，只暴露一个 Shader Graph 选择器（对齐 Unity）
            { name: "shaderName", caption: "Shader Name", type: "string", default: "VFXUnlit", hidden: "true" },
            { name: "shaderRes", caption: "Shader Graph", type: "ShaderBlueprint", default: "" },
            BLEND_MODE_PROP,
            UV_MODE_PROP,
            FLIPBOOK_SIZE_PROP,
            { name: "cameraSort", caption: "Camera Sort", type: "boolean", default: false },
            { name: "frustumCull", caption: "Frustum Culling", type: "boolean", default: false },
        ],
    },
    {
        // Unity 17.3+ ParticleTopologyMesh + ParticleShadingShaderGraph 组合 = 用 ShaderGraph 给 mesh 粒子做表面渲染
        // mirror outputMesh + 加 shaderName prop（让 runtime 用 setShaderName 替代内置 VFXUnlit 用户自定义 .bps 编译出的 shader）
        typeId: "outputShaderGraphMesh",
        title: "Output Mesh (ShaderGraph)",
        color: C_OUTPUT,
        flowInputs: [
            { id: "input", name: "Input", type: "flow" },
        ],
        flowOutputs: [],
        compatibleBlocks: ["setAttribute", "setAttributeCurve", "attributeFromMap", "orient", "cameraFade", "colorOverLife", "alphaOverLife", "connectTarget", "flipbookPlay", "screenSpaceSize"],
        properties: [
            { name: "mesh", caption: "Mesh", type: "Mesh" },
            // 节点级 Main Texture(独立于 shadergraph)—— 即使清空 Shader Res 也保留,基础材质直接显示纹理。对齐 Unity Output Mesh 的 Main Texture。
            { name: "mainTexture", caption: "Main Texture", type: "Texture2D", default: "" },
            // shaderName 由 shaderRes(蓝图.bps) 自动派生（= 文件名去扩展），节点图里隐藏，只暴露一个 Shader Graph 选择器（对齐 Unity）
            { name: "shaderName", caption: "Shader Name", type: "string", default: "VFXUnlit", hidden: "true" },
            { name: "shaderRes", caption: "Shader Graph", type: "ShaderBlueprint", default: "" },
            BLEND_MODE_PROP,
            { name: "useAlphaClipping", caption: "Use Alpha Clipping", type: "boolean", default: false },
            { name: "alphaThreshold", caption: "Alpha Threshold", type: "number", default: 0.5, min: 0, max: 1, step: 0.01, hidden: "!data.useAlphaClipping" },
            SOFT_PARTICLE_PROP,
            UV_MODE_PROP,
            FLIPBOOK_SIZE_PROP,
            { name: "cameraSort", caption: "Camera Sort", type: "boolean", default: false },
            { name: "frustumCull", caption: "Frustum Culling", type: "boolean", default: false },
        ],
    },
    {
        // Unity VFXStaticMeshOutput 对齐：渲染单个静态 mesh，不跑 particle simulation
        // mesh 自动跟随 owner（VisualEffect 节点）transform；material 由用户提供，未指定则 fallback unlit
        // 通过 setStaticMeshAttr block 让 transform/color 被 graph 驱动（白名单：inline 静态 / propertyReference）
        typeId: "outputStaticMesh",
        title: "Output Static Mesh",
        color: C_OUTPUT,
        flowInputs: [],
        flowOutputs: [],
        compatibleBlocks: ["setStaticMeshAttr"],
        properties: [
            { name: "mesh", caption: "Mesh", type: "Mesh" },
            { name: "material", caption: "Material", type: "Material" },
        ],
    },
    {
        typeId: "outputTrail",
        title: "Output Trail",
        color: C_OUTPUT,
        flowInputs: [
            { id: "input", name: "Input", type: "flow" },
        ],
        flowOutputs: [],
        compatibleBlocks: ["setAttribute", "setAttributeCurve", "attributeFromMap", "orient", "cameraFade", "colorOverLife", "alphaOverLife", "connectTarget", "flipbookPlay", "screenSpaceSize"],
        properties: [
            BLEND_MODE_PROP,
            { name: "stripCapacity", caption: "Strip Capacity", type: "number", default: 1, min: 1, step: 1 },
            { name: "particlePerStripCount", caption: "Particles Per Strip", type: "number", default: 128, min: 2, step: 1 },
        ],
    },
    {
        typeId: "outputParticleStripSGQuad",
        title: "Output Trail (ShaderGraph)",
        color: C_OUTPUT,
        flowInputs: [
            { id: "input", name: "Input", type: "flow" },
        ],
        flowOutputs: [],
        compatibleBlocks: ["setAttribute", "setAttributeCurve", "attributeFromMap", "orient", "cameraFade", "colorOverLife", "alphaOverLife", "connectTarget", "flipbookPlay", "screenSpaceSize"],
        properties: [
            { name: "shaderName", caption: "Shader Name", type: "string", default: "VFXStrip" },
            BLEND_MODE_PROP,
            { name: "stripCapacity", caption: "Strip Capacity", type: "number", default: 1, min: 1, step: 1 },
            { name: "particlePerStripCount", caption: "Particles Per Strip", type: "number", default: 128, min: 2, step: 1 },
        ],
    },
    {
        typeId: "outputLine",
        title: "Output Line",
        color: C_OUTPUT,
        flowInputs: [
            { id: "input", name: "Input", type: "flow" },
        ],
        flowOutputs: [],
        compatibleBlocks: ["setAttribute", "setAttributeCurve", "attributeFromMap", "cameraFade"],
        properties: [
            BLEND_MODE_PROP,
            { name: "targetOffset", caption: "Target Offset", type: "vec3", default: { x: 0, y: 0.1, z: 0 } },
        ],
    },
    {
        typeId: "outputPoint",
        title: "Output Point",
        color: C_OUTPUT,
        flowInputs: [
            { id: "input", name: "Input", type: "flow" },
        ],
        flowOutputs: [],
        compatibleBlocks: ["setAttribute", "setAttributeCurve", "attributeFromMap", "cameraFade"],
        properties: [
            BLEND_MODE_PROP,
        ],
    },
    {
        // Unity VFXBasicCubeOutput 对齐：3D cube 粒子（非 billboard，6 面实体）
        // procedural vertex：gl_VertexID 生成 36 顶点（6 面 × 2 三角形 × 3 顶点）
        typeId: "outputCube",
        title: "Output Cube",
        color: C_OUTPUT,
        flowInputs: [
            { id: "input", name: "Input", type: "flow" },
        ],
        flowOutputs: [],
        compatibleBlocks: ["setAttribute", "setAttributeCurve", "attributeFromMap", "orient", "cameraFade", "colorOverLife", "alphaOverLife"],
        properties: [
            BLEND_MODE_PROP,
            { name: "cameraSort", caption: "Camera Sort", type: "boolean", default: false },
            { name: "frustumCull", caption: "Frustum Culling", type: "boolean", default: false },
        ],
    },
    {
        // Unity VFXLineStripOutput 对齐：粒子按生成顺序连成连续线段（beam/闪电/激光/轨迹线）
        // 复用 OutputPoint compute shader（每粒子 1 vertex）+ MeshTopology.LineStrip
        typeId: "outputLineStrip",
        title: "Output LineStrip",
        color: C_OUTPUT,
        flowInputs: [
            { id: "input", name: "Input", type: "flow" },
        ],
        flowOutputs: [],
        compatibleBlocks: ["setAttribute", "setAttributeCurve", "attributeFromMap", "cameraFade", "colorOverLife", "alphaOverLife"],
        properties: [
            BLEND_MODE_PROP,
        ],
    },
    {
        // Unity VFXDistortion 对齐：采样 u_CameraOpaqueTexture 做 UV 偏移
        // 典型用途：热浪 / 冲击波 / 爆炸扭曲。Camera 必须启用 opaqueTexture 才能采样到场景
        // Quad procedural 几何（复用 VFXBillboardGeometry，vertexCount=6）
        typeId: "outputDistortion",
        title: "Output Distortion",
        color: C_OUTPUT,
        flowInputs: [
            { id: "input", name: "Input", type: "flow" },
        ],
        flowOutputs: [],
        compatibleBlocks: ["setAttribute", "setAttributeCurve", "attributeFromMap", "orient", "colorOverLife", "alphaOverLife", "flipbookPlay", "screenSpaceSize"],
        properties: [
            // 扭曲强度：UV 偏移的乘法因子，典型 0.01 ~ 0.1（实际强度 = 此值 × particle.alpha × quad 边缘 mask）
            { name: "distortionStrength", caption: "Distortion Strength", type: "number", default: 0.05, min: 0, max: 1, step: 0.01 },
            // 用法模式：Procedural = 径向透镜（quad 中心向外），NormalMap = 采 albedo 的 RG 当 normal.xy
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Procedural", "NormalMap"], default: "Procedural" },
            BLEND_MODE_PROP,
            UV_MODE_PROP,
            FLIPBOOK_SIZE_PROP,
            { name: "cameraSort", caption: "Camera Sort", type: "boolean", default: false },
            { name: "frustumCull", caption: "Frustum Culling", type: "boolean", default: false },
        ],
    },
    {
        // Unity VFXOutputEvent 对齐：CPU 端接收粒子事件回调（粒子死亡/触发等）
        // 上游：从 update context 的 triggerEvent block 通过 flowLink 路由进来
        // GPU 端 atomic 写入 EventOutputBuffer + attribute snapshot
        // CPU 端每帧 readback，分发到 VisualEffect.addOutputEventListener 注册的回调
        typeId: "outputEvent",
        title: "Output Event",
        color: C_SPAWN,
        flowInputs: [
            { id: "input", name: "Event", type: "flow" },
        ],
        flowOutputs: [],
        compatibleBlocks: [],
        properties: [
            { name: "eventName", caption: "Event Name", type: "string", default: "OnReceived" },
            { name: "capacity", caption: "Buffer Capacity", type: "number", default: 256, min: 1, max: 4096, step: 1 },
        ],
    },
];
