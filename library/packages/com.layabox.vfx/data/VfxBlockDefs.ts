/**
 * Block 类型定义 — Context 内的操作
 *
 * 添加新 Block 类型只需在 VFX_BLOCK_DEFS 数组中追加条目，
 * 并确保 affinity 中的 Context typeId 正确，
 * 同时在对应 Context 的 compatibleBlocks 中加入该 typeId。
 */

import type { IVfxBlockTypeDef } from "./VfxTypes";
import { VFX_SETTABLE_ATTRIBUTES } from "./VfxOperatorDefs";

// ─── Block 定义 ────────────────────────────────────

export const VFX_BLOCK_DEFS: IVfxBlockTypeDef[] = [
    // ── Spawn ──
    {
        typeId: "constantRate",
        title: "Constant Rate",
        category: "Spawn",
        affinity: ["spawn"],
        properties: [
            { name: "rate", caption: "Rate", type: "number", default: 10, min: 0 },
        ],
    },
    {
        typeId: "singleBurst",
        title: "Single Burst",
        category: "Spawn",
        affinity: ["spawn"],
        inputs: [
            { id: "count", name: "Count", type: "float" },
            { id: "delay", name: "Delay", type: "float" },
        ],
        properties: [
            { name: "spawnMode", caption: "Spawn Mode", type: "string", enumSource: ["Constant", "Random"], default: "Constant" },
            { name: "delayMode", caption: "Delay Mode", type: "string", enumSource: ["Constant", "Random"], default: "Constant" },
            { name: "count", caption: "Count", type: "number", default: 0, min: 0, step: 1, hidden: "data.spawnMode !== 'Constant'" },
            { name: "countRange", caption: "Count", type: "vec2", default: { x: 0, y: 10 }, min: 0, step: 1, hidden: "data.spawnMode !== 'Random'" },
            { name: "delay", caption: "Delay", type: "number", default: 0, min: 0, hidden: "data.delayMode !== 'Constant'" },
            { name: "delayRange", caption: "Delay", type: "vec2", default: { x: 0, y: 1 }, min: 0, hidden: "data.delayMode !== 'Random'" },
        ],
    },
    {
        typeId: "periodicBurst",
        title: "Periodic Burst",
        category: "Spawn",
        affinity: ["spawn"],
        properties: [
            { name: "spawnMode", caption: "Spawn Mode", type: "string", enumSource: ["Constant", "Random"], default: "Constant" },
            { name: "count", caption: "Count", type: "number", default: 10, min: 0, step: 1, hidden: "data.spawnMode !== 'Constant'" },
            { name: "countRange", caption: "Count", type: "vec2", default: { x: 5, y: 15 }, min: 0, step: 1, hidden: "data.spawnMode !== 'Random'" },
            { name: "delayMode", caption: "Delay Mode", type: "string", enumSource: ["Constant", "Random"], default: "Constant" },
            { name: "delay", caption: "Period", type: "number", default: 1, min: 0, hidden: "data.delayMode !== 'Constant'" },
            { name: "delayRange", caption: "Period", type: "vec2", default: { x: 0.5, y: 2 }, min: 0, hidden: "data.delayMode !== 'Random'" },
        ],
    },
    {
        typeId: "spawnOverDistance",
        title: "Spawn Over Distance",
        category: "Spawn",
        affinity: ["spawn"],
        properties: [
            { name: "distance", caption: "Distance", type: "number", default: 1, min: 0.001 },
        ],
    },
    {
        typeId: "variableRate",
        title: "Variable Spawn Rate",
        category: "Spawn",
        affinity: ["spawn"],
        inputs: [
            { id: "rate", name: "Rate", type: "float" },
        ],
        properties: [
            { name: "rate", caption: "Rate", type: "number", default: 10, min: 0 },
        ],
    },
    {
        typeId: "setSpawnEventAttribute",
        title: "Set SpawnEvent Attribute",
        category: "Spawn",
        affinity: ["spawn"],
        properties: [
            { name: "attribute", caption: "Attribute", type: "string", enumSource: VFX_SETTABLE_ATTRIBUTES.map((a: { name: string }) => a.name), default: "position" },
            { name: "value", caption: "Value", type: "number", default: 0 },
            { name: "valueX", caption: "X", type: "number", default: 0 },
            { name: "valueY", caption: "Y", type: "number", default: 0 },
            { name: "valueZ", caption: "Z", type: "number", default: 0 },
            { name: "valueW", caption: "W", type: "number", default: 0 },
            { name: "useLoopIndex", caption: "From Loop Index", type: "boolean", default: false },
            { name: "loopIndexModulo", caption: "Loop Index % N (0=disable)", type: "number", default: 0 },
        ],
    },
    {
        // Unity CustomHLSL Block 对齐（GLSL 版）：用户在 init/update/output 阶段写一段 GLSL
        // 直接读写粒子属性。约定用别名 $p 引用粒子（编译时替换为 init=particle / update,output=p）
        // 用户代码示例: "$p.position += vec3(0, sin($p.age * 5.0) * 0.1, 0);"
        typeId: "customGlslBlock",
        title: "Custom GLSL Block",
        category: "Custom",
        affinity: ["initialize", "update", "outputBillboard", "outputMesh", "outputTrail"],
        properties: [
            { name: "code", caption: "GLSL Code", type: "string", default: "// $p.position / $p.velocity / $p.color etc.\n$p.color.r = 1.0;" },
        ],
    },
    {
        // outputStaticMesh 专属：把一个 graph value 绑定到 staticMesh 的 transform / color
        // 白名单源：未连接/inline operator → 静态值；propertyReference → 由 effect.setProperty 驱动
        // value 类型 "any" — 编译时按 target 决定取 .xyz（transform）还是全 vec4（color）
        typeId: "setStaticMeshAttr",
        title: "Set Static Mesh Attr",
        category: "Static Mesh",
        affinity: ["outputStaticMesh"],
        inputs: [{ id: "value", name: "Value", type: "any" }],
        properties: [
            { name: "target", caption: "Target", type: "string", enumSource: ["position", "rotation", "scale", "color"], default: "color" },
        ],
    },
    {
        // Unity VFXSpawnerCustomWrapper 对齐：用户脚本驱动 spawn count
        // 通过 VisualEffect.setCustomSpawnCallback(callbackName, fn) 注册回调
        // 回调签名：(state: VFXSpawnerState, dt: number) => number  返回本帧要 spawn 的数量
        typeId: "customSpawn",
        title: "Custom Spawner",
        category: "Spawn",
        affinity: ["spawn"],
        properties: [
            { name: "callbackName", caption: "Callback Name", type: "string", default: "default" },
        ],
    },

    // ── Attribute ──
    {
        typeId: "setAttribute",
        title: "Set Attribute",
        category: "Attribute",
        affinity: ["initialize", "update", "outputBillboard", "outputMesh", "outputTrail", "outputComposedParticle", "outputLineStrip"],
        inputs: [{ id: "value", name: "Value", type: "any" }],
        properties: [
            { name: "attribute", caption: "Attribute", type: "string", enumSource: VFX_SETTABLE_ATTRIBUTES.map((a: { name: string }) => a.name), default: "position" },
            { name: "source", caption: "Source", type: "string", enumSource: ["Slot", "Source"], default: "Slot" },
            { name: "composition", caption: "Composition", type: "string", enumSource: ["Overwrite", "Add", "Multiply", "Blend"], default: "Overwrite" },
            { name: "random", caption: "Random", type: "string", enumSource: ["Off", "Per Component", "Uniform"], default: "Off", hidden: "data.source === 'Source'" },
        ],
    },
    // ── Position ──
    {
        typeId: "setPositionShape",
        title: "Set Position (Shape)",
        category: "Position",
        affinity: ["initialize", "update"],
        // Custom spawn mode 时 sequencer 可接 op 链 (Unity Random Vec2 → heightSeq/arcSeq 等)
        inputs: [
            { id: "heightSequencer", name: "Height Sequencer", type: "float" },
            { id: "arcSequencer", name: "Arc Sequencer", type: "float" },
            { id: "lineSequencer", name: "Line Sequencer", type: "float" },
        ],
        properties: [
            { name: "shape", caption: "Shape", type: "string", enumSource: ["Sphere", "Box", "Cone", "Torus", "Circle", "Line", "Plane"], default: "Sphere" },
            { name: "positionMode", caption: "Position Mode", type: "string", enumSource: ["Surface", "Volume", "Thickness Absolute", "Thickness Relative"], default: "Volume" },
            { name: "thickness", caption: "Thickness", type: "number", default: 0.1, min: 0, hidden: "data.positionMode !== 'Thickness Absolute' && data.positionMode !== 'Thickness Relative'" },
            { name: "heightMode", caption: "Height Mode", type: "string", enumSource: ["Volume", "Base"], default: "Volume", hidden: "data.shape !== 'Cone'" },
            { name: "spawnMode", caption: "Spawn Mode", type: "string", enumSource: ["Random", "Custom"], default: "Random", hidden: "data.shape === 'Box'" },
            { name: "heightSequencer", caption: "Height Sequencer", type: "number", default: 0.5, min: 0, max: 1, hidden: "data.spawnMode !== 'Custom' || (data.shape !== 'Sphere' && data.shape !== 'Cone' && data.shape !== 'Torus')" },
            { name: "arcSequencer", caption: "Arc Sequencer", type: "number", default: 0, min: 0, max: 1, hidden: "data.spawnMode !== 'Custom' || (data.shape !== 'Sphere' && data.shape !== 'Circle' && data.shape !== 'Cone' && data.shape !== 'Torus')" },
            { name: "lineSequencer", caption: "Line Sequencer", type: "number", default: 0.5, min: 0, max: 1, hidden: "data.spawnMode !== 'Custom' || data.shape !== 'Line'" },
            { name: "applyOrientation", caption: "Apply Orientation", type: "flags", enumSource: ["Direction", "Axes"], default: 0b01, blockHidden: true } as any,
            { name: "positionComposition", caption: "Position", type: "string", enumSource: ["Overwrite", "Add", "Multiply", "Blend"], default: "Overwrite", blockHidden: true } as any,
            { name: "directionComposition", caption: "Direction", type: "string", enumSource: ["Overwrite", "Add", "Multiply", "Blend"], default: "Overwrite", blockHidden: true } as any,
            { name: "axesComposition", caption: "Axes", type: "string", enumSource: ["Overwrite", "Add", "Multiply", "Blend"], default: "Overwrite", blockHidden: true } as any,
            // ── Sphere: arcSphere composite ──
            { name: "arcSphere", caption: "Arc Sphere", type: "arcSphere", default: { sphere: { transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, radius: 1 }, arc: 6.2831853 }, hidden: "data.shape !== 'Sphere'" },
            // ── Box: orientedBox composite ──
            { name: "orientedBox", caption: "Oriented Box", type: "orientedBox", default: { center: { x: 0, y: 0, z: 0 }, angle: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } }, hidden: "data.shape !== 'Box'" },
            // ── Cone: arcCone composite ──
            { name: "arcCone", caption: "Arc Cone", type: "arcCone", default: { cone: { transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, baseRadius: 1, topRadius: 0, height: 1 }, arc: 6.2831853 }, hidden: "data.shape !== 'Cone'" },
            // ── Torus: arcTorus composite ──
            { name: "arcTorus", caption: "Arc Torus", type: "arcTorus", default: { torus: { transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, majorRadius: 1, minorRadius: 0.3 }, arc: 6.2831853 }, hidden: "data.shape !== 'Torus'" },
            // ── Circle: arcCircle composite ──
            { name: "arcCircle", caption: "Arc Circle", type: "arcCircle", default: { circle: { transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, radius: 1 }, arc: 6.2831853 }, hidden: "data.shape !== 'Circle'" },
            // ── Line: line composite ──
            { name: "line", caption: "Line", type: "line", default: { start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 1, z: 0 } }, hidden: "data.shape !== 'Line'" },
            // ── Plane: center + normal + size(2D) ──（对齐 Unity Set Position Random Planar）
            { name: "planeCenter", caption: "Plane Center", type: "position", default: { x: 0, y: 0, z: 0 }, hidden: "data.shape !== 'Plane'" },
            { name: "planeNormal", caption: "Plane Normal", type: "direction", default: { x: 0, y: 1, z: 0 }, hidden: "data.shape !== 'Plane'" },
            { name: "planeSize", caption: "Plane Size", type: "vec2", default: { x: 2, y: 2 }, hidden: "data.shape !== 'Plane'" },
        ],
    },
    // ── Position Utility ──
    {
        typeId: "tileWarpPositions",
        title: "Tile/Warp Positions",
        category: "Position",
        affinity: ["update"],
        properties: [
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "size", caption: "Size", type: "vec3", default: { x: 10, y: 10, z: 10 } },
        ],
    },

    // ── GPUEvent ──
    {
        typeId: "triggerEvent",
        title: "Trigger Event",
        category: "GPUEvent",
        affinity: ["update"],
        outputs: [{ id: "evt", name: "Evt", type: "flow" }],
        properties: [
            { name: "eventType", caption: "Event Type", type: "string", enumSource: ["OnDie", "Always", "OverTime", "OverDistance"], default: "OnDie" },
            { name: "param", caption: "Param", type: "number", default: 1, min: 0, step: 1 },
        ],
    },
    // ── Velocity ──
    {
        typeId: "velNewDirection",
        title: "Velocity from Direction & Speed (New Direction)",
        category: "Velocity",
        affinity: ["initialize", "update"],
        properties: [
            { name: "composition", caption: "Composition", type: "string", enumSource: ["Overwrite", "Add", "Multiply", "Blend"], default: "Overwrite", blockHidden: true } as any,
            { name: "direction", caption: "Direction", type: "direction", default: { x: 0, y: 1, z: 0 } },
            { name: "speedMode", caption: "Speed Mode", type: "string", enumSource: ["Constant", "Random"], default: "Constant" },
            { name: "speed", caption: "Speed", type: "number", default: 1, min: 0, hidden: "data.speedMode !== 'Constant'" },
            { name: "minSpeed", caption: "Min Speed", type: "number", default: 0, min: 0, hidden: "data.speedMode !== 'Random'" },
            { name: "maxSpeed", caption: "Max Speed", type: "number", default: 1, min: 0, hidden: "data.speedMode !== 'Random'" },
            { name: "blendDirection", caption: "Blend Direction", type: "number", default: 1, min: 0, max: 1 },
            { name: "blendVelocity", caption: "Blend Velocity", type: "number", default: 0.5, min: 0, max: 1, hidden: "data.composition !== 'Blend'" },
        ],
    },
    {
        typeId: "velRandom",
        title: "Velocity Random",
        category: "Velocity",
        affinity: ["initialize", "update"],
        properties: [
            { name: "composition", caption: "Composition", type: "string", enumSource: ["Overwrite", "Add", "Multiply", "Blend"], default: "Overwrite", blockHidden: true } as any,
            { name: "speedMode", caption: "Speed Mode", type: "string", enumSource: ["Constant", "Random"], default: "Constant" },
            { name: "speed", caption: "Speed", type: "number", default: 1, min: 0, hidden: "data.speedMode !== 'Constant'" },
            { name: "minSpeed", caption: "Min Speed", type: "number", default: 0, min: 0, hidden: "data.speedMode !== 'Random'" },
            { name: "maxSpeed", caption: "Max Speed", type: "number", default: 1, min: 0, hidden: "data.speedMode !== 'Random'" },
            { name: "blendVelocity", caption: "Blend Velocity", type: "number", default: 0.5, min: 0, max: 1, hidden: "data.composition !== 'Blend'" },
        ],
    },
    {
        typeId: "velSpherical",
        title: "Velocity from Direction & Speed (Spherical)",
        category: "Velocity",
        affinity: ["initialize", "update"],
        properties: [
            { name: "composition", caption: "Composition", type: "string", enumSource: ["Overwrite", "Add", "Multiply", "Blend"], default: "Overwrite", blockHidden: true } as any,
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "speedMode", caption: "Speed Mode", type: "string", enumSource: ["Constant", "Random"], default: "Constant" },
            { name: "speed", caption: "Speed", type: "number", default: 1, min: 0, hidden: "data.speedMode !== 'Constant'" },
            { name: "minSpeed", caption: "Min Speed", type: "number", default: 0, min: 0, hidden: "data.speedMode !== 'Random'" },
            { name: "maxSpeed", caption: "Max Speed", type: "number", default: 1, min: 0, hidden: "data.speedMode !== 'Random'" },
            { name: "blendDirection", caption: "Blend Direction", type: "number", default: 1, min: 0, max: 1 },
            { name: "blendVelocity", caption: "Blend Velocity", type: "number", default: 0.5, min: 0, max: 1, hidden: "data.composition !== 'Blend'" },
        ],
    },
    {
        typeId: "velAlongVelocity",
        title: "Velocity Along Velocity",
        category: "Velocity",
        affinity: ["initialize", "update"],
        properties: [
            { name: "composition", caption: "Composition", type: "string", enumSource: ["Overwrite", "Add", "Multiply", "Blend"], default: "Add", blockHidden: true } as any,
            { name: "speedMode", caption: "Speed Mode", type: "string", enumSource: ["Constant", "Random"], default: "Constant" },
            { name: "speed", caption: "Speed", type: "number", default: 1, min: 0, hidden: "data.speedMode !== 'Constant'" },
            { name: "minSpeed", caption: "Min Speed", type: "number", default: 0, min: 0, hidden: "data.speedMode !== 'Random'" },
            { name: "maxSpeed", caption: "Max Speed", type: "number", default: 1, min: 0, hidden: "data.speedMode !== 'Random'" },
            { name: "blendVelocity", caption: "Blend Velocity", type: "number", default: 0.5, min: 0, max: 1, hidden: "data.composition !== 'Blend'" },
        ],
    },

    // ── Force ──
    {
        typeId: "gravity",
        title: "Gravity",
        category: "Force",
        affinity: ["update"],
        // Gravity force vec3 + per-component (x/y/z) input：Unity 可以让 .y 接 op 链
        // (典型用法: force.y = sampleCurve(stripRatio) × -2 让重力按 strip 位置变化)
        inputs: [
            { id: "force", name: "Force", type: "vec3" },
            { id: "force_x", name: "Force X", type: "float" },
            { id: "force_y", name: "Force Y", type: "float" },
            { id: "force_z", name: "Force Z", type: "float" },
        ],
        properties: [
            { name: "force", caption: "Force", type: "vector", default: { x: 0, y: -9.81, z: 0 } },
            { name: "_space_force", caption: "", type: "string", default: "World", blockHidden: true } as any,
        ],
    },
    {
        typeId: "linearDrag",
        title: "Linear Drag",
        category: "Force",
        affinity: ["update"],
        properties: [
            { name: "useParticleSize", caption: "Use Particle Size", type: "boolean", default: false },
            { name: "dragCoefficient", caption: "Drag Coefficient", type: "number", default: 1, min: 0 },
        ],
    },
    {
        typeId: "turbulence",
        title: "Turbulence",
        category: "Force",
        affinity: ["update"],
        // Unity Turbulence intensity 接 op chain（如 multiply(sampleCurve(stripRatio), -2)）
        // 让 intensity per-particle 动态变化（沿生命周期/strip 位置）。
        // 没接 op 时 fallback 到 props.intensity 内联值
        inputs: [{ id: "intensity", name: "Intensity", type: "float" }],
        properties: [
            { name: "noiseType", caption: "Noise Type", type: "string", enumSource: ["Value", "Perlin", "Cellular"], default: "Perlin" },
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Absolute", "Relative"], default: "Absolute" },
            { name: "intensity", caption: "Intensity", type: "number", default: 1 },
            { name: "frequency", caption: "Frequency", type: "number", default: 1, min: 0 },
            { name: "octaves", caption: "Octaves", type: "number", default: 3, min: 1, max: 8, step: 1 },
            { name: "roughness", caption: "Roughness", type: "number", default: 0.5, min: 0, max: 1 },
            { name: "lacunarity", caption: "Lacunarity", type: "number", default: 2, min: 0 },
            { name: "drag", caption: "Drag", type: "number", default: 1, min: 0, hidden: "data.mode !== 'Relative'" },
        ],
    },
    {
        typeId: "force",
        title: "Force",
        category: "Force",
        affinity: ["update"],
        // Unity Force.force 接 op chain（动态风方向）或者按 .x/.y/.z 单分量接
        // 没接时 fallback 到 props.force inline 值
        inputs: [{ id: "force", name: "Force", type: "vec3" }],
        properties: [
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Absolute", "Relative"], default: "Absolute" },
            { name: "force", caption: "Force", type: "vector", default: { x: 0, y: 0, z: 0 } },
            { name: "_space_force", caption: "", type: "string", default: "World", blockHidden: true } as any,
            { name: "drag", caption: "Drag", type: "number", default: 1, min: 0, hidden: "data.mode !== 'Relative'" },
        ],
    },
    {
        // 对齐 Unity VFX Graph VectorFieldForce.cs
        // 从 3D 纹理采样向量场，作用到粒子速度
        typeId: "vectorFieldForce",
        title: "Vector Field Force",
        category: "Force",
        affinity: ["update"],
        properties: [
            { name: "texture", caption: "Vector Field (3D)", type: "Texture3D" },
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Absolute", "Relative"], default: "Absolute" },
            { name: "intensity", caption: "Intensity", type: "number", default: 1 },
            { name: "fieldCenter", caption: "Field Center", type: "vec3", default: { x: 0, y: 0, z: 0 } },
            { name: "fieldSize", caption: "Field Size", type: "vec3", default: { x: 2, y: 2, z: 2 } },
            { name: "drag", caption: "Drag", type: "number", default: 1, min: 0, hidden: "data.mode !== 'Relative'" },
        ],
    },
    {
        typeId: "attractorSphere",
        title: "Attractor (Sphere)",
        category: "Force",
        affinity: ["update"],
        properties: [
            { name: "attractionSpeed", caption: "Attraction Speed", type: "number", default: 5, min: 0 },
            { name: "stickDistance", caption: "Stick Distance", type: "number", default: 0.1, min: 0 },
            { name: "stickForce", caption: "Stick Force", type: "number", default: 10, min: 0 },
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "radius", caption: "Radius", type: "number", default: 1, min: 0 },
        ],
    },
    {
        typeId: "attractorAABox",
        title: "Attractor (AABox)",
        category: "Force",
        affinity: ["update"],
        properties: [
            { name: "attractionSpeed", caption: "Attraction Speed", type: "number", default: 5, min: 0 },
            { name: "stickDistance", caption: "Stick Distance", type: "number", default: 0.1, min: 0 },
            { name: "stickForce", caption: "Stick Force", type: "number", default: 10, min: 0 },
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "size", caption: "Size", type: "vec3", default: { x: 2, y: 2, z: 2 } },
        ],
    },
    {
        // 对齐 Unity ConformToSphere.cs — 把粒子吸附到球面表面
        typeId: "conformToSphere",
        title: "Conform to Sphere",
        category: "Force",
        affinity: ["update"],
        properties: [
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "radius", caption: "Radius", type: "number", default: 1, min: 0 },
            { name: "attractionSpeed", caption: "Attraction Speed", type: "number", default: 5, min: 0 },
            { name: "attractionForce", caption: "Attraction Force", type: "number", default: 20, min: 0 },
            { name: "stickDistance", caption: "Stick Distance", type: "number", default: 0.1, min: 0 },
            { name: "stickForce", caption: "Stick Force", type: "number", default: 50, min: 0 },
        ],
    },
    {
        // 对齐 Unity VortexForceField — 让粒子绕 vortex plane 旋转 (swirl) + radial pull + axial channel
        typeId: "vortex",
        title: "Vortex",
        category: "Force",
        affinity: ["update"],
        properties: [
            { name: "vortexPlane", caption: "Vortex Plane", type: "plane", default: { position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 } } },
            { name: "drag", caption: "Drag", type: "number", default: 0, min: 0 },
            { name: "channelDistance", caption: "Channel / Distance", type: "curve", default: { frameData: [0, 0, 0, 0, 0.333, 0.333, 0, 1, 0, 0, 0, 0.333, 0.333, 0] } },
            { name: "gravityDistance", caption: "Gravity / Distance", type: "curve", default: { frameData: [0, 0, 0, 0, 0.333, 0.333, 0, 1, 0, 0, 0, 0.333, 0.333, 0] } },
            { name: "vortexDistance", caption: "Vortex / Distance", type: "curve", default: { frameData: [0, 0, 0, 0, 0.333, 0.333, 0, 1, 0, 0, 0, 0.333, 0.333, 0] } },
        ],
    },
    {
        // 对齐 Unity ConformToAABox.cs — 把粒子吸附到 AABox 表面
        typeId: "conformToAABox",
        title: "Conform to AABox",
        category: "Force",
        affinity: ["update"],
        properties: [
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "size", caption: "Size", type: "vec3", default: { x: 1, y: 1, z: 1 } },
            { name: "attractionSpeed", caption: "Attraction Speed", type: "number", default: 5, min: 0 },
            { name: "attractionForce", caption: "Attraction Force", type: "number", default: 20, min: 0 },
            { name: "stickDistance", caption: "Stick Distance", type: "number", default: 0.1, min: 0 },
            { name: "stickForce", caption: "Stick Force", type: "number", default: 50, min: 0 },
        ],
    },
    {
        // 对齐 Unity ConformToOrientedBox — OBB 表面吸附
        typeId: "conformToOrientedBox",
        title: "Conform to OrientedBox",
        category: "Force",
        affinity: ["update"],
        properties: [
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "angle", caption: "Euler Angles", type: "vec3", default: { x: 0, y: 0, z: 0 } },
            { name: "size", caption: "Size", type: "vec3", default: { x: 1, y: 1, z: 1 } },
            { name: "attractionSpeed", caption: "Attraction Speed", type: "number", default: 5, min: 0 },
            { name: "attractionForce", caption: "Attraction Force", type: "number", default: 20, min: 0 },
            { name: "stickDistance", caption: "Stick Distance", type: "number", default: 0.1, min: 0 },
            { name: "stickForce", caption: "Stick Force", type: "number", default: 50, min: 0 },
        ],
    },
    {
        // 对齐 Unity ConformToCone — cone 表面吸附
        typeId: "conformToCone",
        title: "Conform to Cone",
        category: "Force",
        affinity: ["update"],
        properties: [
            { name: "center", caption: "Apex", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "axis", caption: "Axis", type: "vector", default: { x: 0, y: 1, z: 0 } },
            { name: "height", caption: "Height", type: "number", default: 1, min: 0 },
            { name: "baseRadius", caption: "Base Radius", type: "number", default: 1, min: 0 },
            { name: "attractionSpeed", caption: "Attraction Speed", type: "number", default: 5, min: 0 },
            { name: "attractionForce", caption: "Attraction Force", type: "number", default: 20, min: 0 },
            { name: "stickDistance", caption: "Stick Distance", type: "number", default: 0.1, min: 0 },
            { name: "stickForce", caption: "Stick Force", type: "number", default: 50, min: 0 },
        ],
    },
    {
        typeId: "cameraFade",
        title: "Camera Fade",
        category: "Output",
        affinity: ["outputBillboard", "outputMesh", "outputTrail"],
        properties: [
            { name: "nearFadeDistance", caption: "Near Fade Distance", type: "number", default: 0.5, min: 0 },
            { name: "farFadeDistance", caption: "Far Fade Distance", type: "number", default: 50, min: 0 },
        ],
    },
    {
        typeId: "calculateMassFromVolume",
        title: "Calculate Mass From Volume",
        category: "Attribute",
        affinity: ["initialize", "update"],
        properties: [
            // Unity VFX Graph 4 种基础形状
            //   Box:      V = sx * sy * sz
            //   Sphere:   V = (4/3)π * (sx/2)^3        (sx 视为直径)
            //   Cylinder: V = π * (sx/2)^2 * sy        (sx 直径, sy 高)
            //   Cone:     V = (1/3)π * (sx/2)^2 * sy   (sx 底直径, sy 高)
            { name: "shape", caption: "Shape", type: "string", enumSource: ["Box", "Sphere", "Cylinder", "Cone"], default: "Box" },
            { name: "density", caption: "Density", type: "number", default: 1, min: 0 },
            { name: "composition", caption: "Composition", type: "string", enumSource: ["Overwrite", "Add", "Multiply"], default: "Overwrite" },
        ],
    },

    // ── Attribute Curve ──
    {
        typeId: "setAttributeCurve",
        title: "Set Attribute (Curve)",
        category: "Attribute",
        affinity: ["initialize", "update", "outputBillboard", "outputMesh", "outputTrail", "outputComposedParticle", "outputLineStrip"],
        properties: [
            { name: "attribute", caption: "Attribute", type: "string", enumSource: VFX_SETTABLE_ATTRIBUTES.map((a: { name: string }) => a.name), default: "size" },
            {
                name: "curve", caption: "Curve", type: "Curve", inspector: "vfxCurve",
                default: { frameData: [0, 0, 0, 1, 0.333, 0.333, 0, 1, 1, 0, 1, 0.333, 0.333, 0] },
                hidden: "data.attribute === 'color'",
            } as any,
            // vec3 属性(scale 等)的 per-channel 曲线：Y/Z 通道独立曲线(可选,未设时 broadcast 主 curve)。
            // 对齐 Unity AttributeFromCurve 的 Scale_x/y/z 三曲线(Barrier walls 烟雾片 z 从 0 生长的翻滚动态依赖此)。
            {
                name: "curveY", caption: "Curve Y", type: "Curve", inspector: "vfxCurve",
                hidden: "data.attribute !== 'scale' && data.attribute !== 'angle' && data.attribute !== 'velocity'",
            } as any,
            {
                name: "curveZ", caption: "Curve Z", type: "Curve", inspector: "vfxCurve",
                hidden: "data.attribute !== 'scale' && data.attribute !== 'angle' && data.attribute !== 'velocity'",
            } as any,
            // attribute=color 时显示 gradient editor 而不是 curve（对齐 Unity 的 SetColor block UX）
            // 编译时优先读 gradient props 生成 sampleGradient GLSL
            {
                name: "gradient", caption: "Gradient", type: "Gradient", inspector: "gradient",
                default: { stops: [{ t: 0, color: { r: 1, g: 1, b: 1, a: 1 } }, { t: 1, color: { r: 1, g: 1, b: 1, a: 0 } }] },
                hidden: "data.attribute !== 'color'",
            } as any,
            { name: "sampleMode", caption: "Sample Mode", type: "string", enumSource: ["OverLife", "BySpeed", "Random", "RandomConstantPerParticle", "Custom"], default: "OverLife" },
            { name: "composition", caption: "Composition", type: "string", enumSource: ["Overwrite", "Add", "Multiply", "Blend"], default: "Overwrite" },
            { name: "value", caption: "Custom T", type: "number", default: 0, hidden: "data.sampleMode !== 'Custom'" },
            { name: "minSpeed", caption: "Min Speed", type: "number", default: 0, min: 0, hidden: "data.sampleMode !== 'BySpeed'" },
            { name: "maxSpeed", caption: "Max Speed", type: "number", default: 1, min: 0, hidden: "data.sampleMode !== 'BySpeed'" },
        ],
    },
    // ── Attribute from Map ──
    {
        typeId: "attributeFromMap",
        title: "Set Attribute from Map",
        category: "Attribute",
        affinity: ["initialize", "update", "outputBillboard", "outputMesh", "outputTrail", "outputComposedParticle", "outputLineStrip"],
        properties: [
            { name: "attribute", caption: "Attribute", type: "string", enumSource: VFX_SETTABLE_ATTRIBUTES.map((a: { name: string }) => a.name), default: "color" },
            { name: "composition", caption: "Composition", type: "string", enumSource: ["Overwrite", "Add", "Multiply", "Blend"], default: "Overwrite" },
            { name: "sampleMode", caption: "Sample Mode", type: "string", enumSource: ["RandomConstantPerParticle", "Random", "Sequential", "Sample2DLOD"], default: "RandomConstantPerParticle" },
            { name: "texture", caption: "Texture", type: "Texture2D" },
            { name: "uvChannel", caption: "UV", type: "vec2", default: { x: 0, y: 0 }, hidden: "data.sampleMode !== 'Sample2DLOD'" },
            { name: "lod", caption: "LOD", type: "number", default: 0, min: 0, hidden: "data.sampleMode !== 'Sample2DLOD'" },
        ],
    },

    // ── Color Over Life ──
    {
        typeId: "colorOverLife",
        title: "Color over Life",
        category: "Output",
        affinity: ["outputBillboard", "outputMesh", "outputTrail", "outputComposedParticle", "outputLineStrip"],
        properties: [
            { name: "colorA", caption: "Color A", type: "color", default: { r: 1, g: 0.5, b: 0, a: 1 } },
            { name: "colorB", caption: "Color B", type: "color", default: { r: 0.2, g: 0.7, b: 1, a: 1 } },
            { name: "transition", caption: "Transition", type: "number", default: 0.5, min: 0, max: 1 },
            { name: "smoothness", caption: "Smoothness", type: "number", default: 0.05, min: 0, max: 0.5 },
            { name: "composition", caption: "Composition", type: "string", enumSource: ["Overwrite", "Multiply"], default: "Multiply" },
        ],
    },
    {
        typeId: "alphaOverLife",
        title: "Alpha over Life",
        category: "Output",
        affinity: ["outputBillboard", "outputMesh", "outputTrail"],
        properties: [
            { name: "fadeInEnd", caption: "Fade In End", type: "number", default: 0.0, min: 0, max: 1 },
            { name: "fadeOutStart", caption: "Fade Out Start", type: "number", default: 0.8, min: 0, max: 1 },
        ],
    },

    // ── Collision ──
    {
        typeId: "collisionPlane",
        title: "Collide with Plane",
        category: "Collision",
        affinity: ["update"],
        properties: [
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Solid", "Inverted"], default: "Solid" },
            { name: "planePosition", caption: "Position", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "planeNormal", caption: "Normal", type: "direction", default: { x: 0, y: 1, z: 0 } },
            { name: "bounce", caption: "Bounce", type: "number", default: 0.1, min: 0 },
            { name: "friction", caption: "Friction", type: "number", default: 0, min: 0 },
            { name: "lifetimeLoss", caption: "Lifetime Loss", type: "number", default: 0, min: 0, max: 1 },
        ],
    },
    {
        typeId: "collisionSphere",
        title: "Collide with Sphere",
        category: "Collision",
        affinity: ["update"],
        properties: [
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Solid", "Inverted"], default: "Solid" },
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "radius", caption: "Radius", type: "number", default: 1, min: 0 },
            { name: "bounce", caption: "Bounce", type: "number", default: 0.1, min: 0 },
            { name: "friction", caption: "Friction", type: "number", default: 0, min: 0 },
            { name: "lifetimeLoss", caption: "Lifetime Loss", type: "number", default: 0, min: 0, max: 1 },
        ],
    },
    {
        typeId: "collisionAABox",
        title: "Collide with AABox",
        category: "Collision",
        affinity: ["update"],
        properties: [
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Solid", "Inverted"], default: "Solid" },
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "size", caption: "Size", type: "vec3", default: { x: 2, y: 2, z: 2 } },
            { name: "bounce", caption: "Bounce", type: "number", default: 0.1, min: 0 },
            { name: "friction", caption: "Friction", type: "number", default: 0, min: 0 },
            { name: "lifetimeLoss", caption: "Lifetime Loss", type: "number", default: 0, min: 0, max: 1 },
        ],
    },
    {
        typeId: "collisionOrientedBox",
        title: "Collide with OrientedBox",
        category: "Collision",
        affinity: ["update"],
        properties: [
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Solid", "Inverted"], default: "Solid" },
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "angle", caption: "Euler Angles (deg)", type: "vec3", default: { x: 0, y: 0, z: 0 } },
            { name: "size", caption: "Size", type: "vec3", default: { x: 2, y: 2, z: 2 } },
            { name: "bounce", caption: "Bounce", type: "number", default: 0.1, min: 0 },
            { name: "friction", caption: "Friction", type: "number", default: 0, min: 0 },
            { name: "lifetimeLoss", caption: "Lifetime Loss", type: "number", default: 0, min: 0, max: 1 },
        ],
    },

    // ── Kill ──
    {
        typeId: "setPositionDepthBuffer",
        title: "Set Position (Depth Buffer)",
        category: "Position",
        affinity: ["update"],
        properties: [
            { name: "offset", caption: "Surface Offset", type: "number", default: 0.01, min: 0 },
        ],
    },
    {
        typeId: "collisionSDF",
        title: "Collision (SDF)",
        category: "Collision",
        affinity: ["update"],
        properties: [
            { name: "texture", caption: "SDF Texture", type: "Texture3D" },
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "size", caption: "Size", type: "vec3", default: { x: 1, y: 1, z: 1 } },
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Kill", "Bounce"], default: "Bounce" },
            { name: "bounce", caption: "Bounce", type: "number", default: 0.5, min: 0, max: 1, hidden: "data.mode !== 'Bounce'" },
            { name: "friction", caption: "Friction", type: "number", default: 0.2, min: 0, max: 1, hidden: "data.mode !== 'Bounce'" },
            { name: "radius", caption: "Surface Offset", type: "number", default: 0.01, min: 0 },
        ],
    },
    {
        typeId: "attractorShapeSDF",
        title: "Conform to Shape (SDF)",
        category: "Forces",
        affinity: ["update"],
        properties: [
            { name: "texture", caption: "SDF Texture", type: "Texture3D" },
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "size", caption: "Size", type: "vec3", default: { x: 1, y: 1, z: 1 } },
            { name: "attractionSpeed", caption: "Attraction Speed", type: "number", default: 5, min: 0 },
            { name: "attractionForce", caption: "Attraction Force", type: "number", default: 20, min: 0 },
            { name: "stickDistance", caption: "Stick Distance", type: "number", default: 0.1, min: 0 },
            { name: "stickForce", caption: "Stick Force", type: "number", default: 50, min: 0 },
        ],
    },
    {
        typeId: "positionSDF",
        title: "Position (SDF)",
        category: "Position",
        affinity: ["initialize"],
        properties: [
            { name: "texture", caption: "SDF Texture", type: "Texture3D" },
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "size", caption: "Size", type: "vec3", default: { x: 1, y: 1, z: 1 } },
            { name: "positionMode", caption: "Position Mode", type: "string", enumSource: ["Surface", "Volume"], default: "Surface" },
            { name: "thickness", caption: "Thickness", type: "number", default: 0.1, min: 0, hidden: "data.positionMode !== 'Volume'" },
            { name: "projectionSteps", caption: "Projection Steps", type: "number", default: 2, min: 1, max: 8, step: 1 },
            { name: "composition", caption: "Composition", type: "string", enumSource: ["Overwrite", "Add"], default: "Overwrite" },
        ],
    },
    {
        typeId: "collisionDepthBuffer",
        title: "Collision (Depth Buffer)",
        category: "Collision",
        affinity: ["update"],
        properties: [
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Kill", "Bounce"], default: "Kill" },
            { name: "bounce", caption: "Bounce", type: "number", default: 0.5, min: 0, max: 1, hidden: "data.mode !== 'Bounce'" },
            { name: "friction", caption: "Friction", type: "number", default: 0.2, min: 0, max: 1, hidden: "data.mode !== 'Bounce'" },
            { name: "radius", caption: "Radius", type: "number", default: 0.05, min: 0 },
        ],
    },
    {
        typeId: "killSphere",
        title: "Kill (Sphere)",
        category: "Kill",
        affinity: ["initialize", "update"],
        properties: [
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Solid", "Inverted"], default: "Solid" },
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "radius", caption: "Radius", type: "number", default: 1, min: 0 },
        ],
    },
    {
        typeId: "killAABox",
        title: "Kill (AABox)",
        category: "Kill",
        affinity: ["initialize", "update"],
        properties: [
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Solid", "Inverted"], default: "Solid" },
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "size", caption: "Size", type: "vec3", default: { x: 2, y: 2, z: 2 } },
        ],
    },
    {
        typeId: "killPlane",
        title: "Kill (Plane)",
        category: "Kill",
        affinity: ["initialize", "update"],
        properties: [
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Above", "Below"], default: "Below" },
            { name: "position", caption: "Plane Position", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "normal", caption: "Plane Normal", type: "direction", default: { x: 0, y: 1, z: 0 } },
        ],
    },
    {
        typeId: "killCone",
        title: "Kill (Cone)",
        category: "Kill",
        affinity: ["initialize", "update"],
        properties: [
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Solid", "Inverted"], default: "Solid" },
            { name: "center", caption: "Apex (Center)", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "axis", caption: "Axis", type: "vector", default: { x: 0, y: 1, z: 0 } },
            { name: "height", caption: "Height", type: "number", default: 1, min: 0 },
            { name: "baseRadius", caption: "Base Radius", type: "number", default: 1, min: 0 },
        ],
    },
    {
        typeId: "killTorus",
        title: "Kill (Torus)",
        category: "Kill",
        affinity: ["initialize", "update"],
        properties: [
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Solid", "Inverted"], default: "Solid" },
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "majorRadius", caption: "Major Radius", type: "number", default: 1, min: 0 },
            { name: "minorRadius", caption: "Minor Radius", type: "number", default: 0.3, min: 0 },
        ],
    },
    {
        typeId: "killOrientedBox",
        title: "Kill (OrientedBox)",
        category: "Kill",
        affinity: ["initialize", "update"],
        properties: [
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Solid", "Inverted"], default: "Solid" },
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "angle", caption: "Euler Angles", type: "vec3", default: { x: 0, y: 0, z: 0 } },
            { name: "size", caption: "Size", type: "vec3", default: { x: 2, y: 2, z: 2 } },
        ],
    },

    // ── Velocity (Extended) ──
    {
        typeId: "velTangent",
        title: "Velocity Tangent",
        category: "Velocity",
        affinity: ["initialize", "update"],
        properties: [
            { name: "composition", caption: "Composition", type: "string", enumSource: ["Overwrite", "Add", "Multiply", "Blend"], default: "Add", blockHidden: true } as any,
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "axis", caption: "Axis", type: "vector", default: { x: 0, y: 1, z: 0 } },
            { name: "speedMode", caption: "Speed Mode", type: "string", enumSource: ["Constant", "Random"], default: "Constant" },
            { name: "speed", caption: "Speed", type: "number", default: 1, min: 0, hidden: "data.speedMode !== 'Constant'" },
            { name: "minSpeed", caption: "Min Speed", type: "number", default: 0, min: 0, hidden: "data.speedMode !== 'Random'" },
            { name: "maxSpeed", caption: "Max Speed", type: "number", default: 1, min: 0, hidden: "data.speedMode !== 'Random'" },
            { name: "blendVelocity", caption: "Blend Velocity", type: "number", default: 0.5, min: 0, max: 1, hidden: "data.composition !== 'Blend'" },
        ],
    },
    {
        typeId: "velSpeed",
        title: "Velocity from Direction & Speed (Speed)",
        category: "Velocity",
        affinity: ["initialize", "update"],
        properties: [
            { name: "composition", caption: "Composition", type: "string", enumSource: ["Overwrite", "Add", "Multiply", "Blend"], default: "Overwrite", blockHidden: true } as any,
            { name: "speedMode", caption: "Speed Mode", type: "string", enumSource: ["Constant", "Random"], default: "Constant" },
            { name: "speed", caption: "Speed", type: "number", default: 1, min: 0, hidden: "data.speedMode !== 'Constant'" },
            { name: "minSpeed", caption: "Min Speed", type: "number", default: 0, min: 0, hidden: "data.speedMode !== 'Random'" },
            { name: "maxSpeed", caption: "Max Speed", type: "number", default: 1, min: 0, hidden: "data.speedMode !== 'Random'" },
            { name: "blendVelocity", caption: "Blend Velocity", type: "number", default: 0.5, min: 0, max: 1, hidden: "data.composition !== 'Blend'" },
        ],
    },

    // ── Collision (Extended) ──
    {
        typeId: "collisionCone",
        title: "Collide with Cone",
        category: "Collision",
        affinity: ["update"],
        properties: [
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Solid", "Inverted"], default: "Solid" },
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "baseRadius", caption: "Base Radius", type: "number", default: 1, min: 0 },
            { name: "topRadius", caption: "Top Radius", type: "number", default: 0, min: 0 },
            { name: "height", caption: "Height", type: "number", default: 2, min: 0 },
            { name: "bounce", caption: "Bounce", type: "number", default: 0, min: 0, max: 1 },
            { name: "friction", caption: "Friction", type: "number", default: 0, min: 0, max: 1 },
            { name: "lifetimeLoss", caption: "Lifetime Loss", type: "number", default: 0, min: 0, max: 1 },
        ],
    },
    {
        typeId: "collisionTorus",
        title: "Collide with Torus",
        category: "Collision",
        affinity: ["update"],
        properties: [
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Solid", "Inverted"], default: "Solid" },
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "majorRadius", caption: "Major Radius", type: "number", default: 1, min: 0 },
            { name: "minorRadius", caption: "Minor Radius", type: "number", default: 0.3, min: 0 },
            { name: "bounce", caption: "Bounce", type: "number", default: 0.1, min: 0, max: 1 },
            { name: "friction", caption: "Friction", type: "number", default: 0, min: 0, max: 1 },
            { name: "lifetimeLoss", caption: "Lifetime Loss", type: "number", default: 0, min: 0, max: 1 },
        ],
    },

    // ── Position (Extended) ──
    {
        typeId: "positionSequential",
        title: "Position (Sequential)",
        category: "Position",
        affinity: ["initialize"],
        properties: [
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Line", "Circle", "ThreeDimensional"], default: "Line" },
            { name: "start", caption: "Start", type: "position", default: { x: -1, y: 0, z: 0 }, hidden: "data.mode !== 'Line'" },
            { name: "end", caption: "End", type: "position", default: { x: 1, y: 0, z: 0 }, hidden: "data.mode !== 'Line'" },
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 }, hidden: "data.mode === 'Line'" },
            { name: "radius", caption: "Radius", type: "number", default: 1, min: 0, hidden: "data.mode !== 'Circle'" },
            { name: "axis", caption: "Axis", type: "vector", default: { x: 0, y: 1, z: 0 }, hidden: "data.mode !== 'Circle'" },
            { name: "countPerLine", caption: "Count", type: "number", default: 16, min: 1, step: 1, hidden: "data.mode === 'ThreeDimensional'" },
            { name: "origin", caption: "Origin", type: "vec3", default: { x: 0, y: 0, z: 0 }, hidden: "data.mode !== 'ThreeDimensional'" },
            { name: "stepSize", caption: "Step Size", type: "vec3", default: { x: 1, y: 1, z: 1 }, hidden: "data.mode !== 'ThreeDimensional'" },
            // 3D 模式用 X/Y/Z 独立 count（Unity CountX/CountY/CountZ）— 单 countPerLine 退化为对称立方体
            { name: "countX", caption: "Count X", type: "number", default: 16, min: 1, step: 1, hidden: "data.mode !== 'ThreeDimensional'" },
            { name: "countY", caption: "Count Y", type: "number", default: 1, min: 1, step: 1, hidden: "data.mode !== 'ThreeDimensional'" },
            { name: "countZ", caption: "Count Z", type: "number", default: 1, min: 1, step: 1, hidden: "data.mode !== 'ThreeDimensional'" },
        ],
    },

    // ── Output (Extended) ──
    {
        typeId: "connectTarget",
        title: "Connect Target",
        category: "Output",
        affinity: ["outputBillboard", "outputMesh"],
        properties: [
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Position", "Direction"], default: "Position" },
            { name: "targetPosition", caption: "Target", type: "position", default: { x: 0, y: 1, z: 0 }, hidden: "data.mode !== 'Position'" },
        ],
    },
    {
        typeId: "flipbookPlay",
        title: "Flipbook Play",
        category: "Output",
        // Unity FlipbookPlay 仅 Update context（compatibleContexts = Update），主要用于 update 阶段累加 texIndex；
        // outputBillboard/Mesh/Trail 也保留以兼容用户在 output 配每个材质独立 frame rate 的场景
        affinity: ["update", "outputBillboard", "outputMesh", "outputTrail"],
        properties: [
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Constant", "OverLife", "BySpeed"], default: "Constant" },
            { name: "frameRate", caption: "Frame Rate", type: "number", default: 30, min: 0, hidden: "data.mode !== 'Constant'" },
            { name: "frameCount", caption: "Frame Count", type: "number", default: 16, min: 1, step: 1 },
        ],
    },
    {
        typeId: "screenSpaceSize",
        title: "Screen Space Size",
        category: "Output",
        affinity: ["outputBillboard", "outputMesh"],
        properties: [
            { name: "referenceSize", caption: "Reference Size (pixels)", type: "number", default: 10, min: 0 },
        ],
    },
    {
        typeId: "incrementStripIndex",
        title: "Increment Strip Index",
        category: "Attribute",
        affinity: ["initialize", "update"],
        properties: [
            { name: "step", caption: "Step", type: "number", default: 1, min: 1, step: 1 },
        ],
    },
    {
        typeId: "setPositionMesh",
        title: "Set Position (Mesh)",
        category: "Position",
        affinity: ["initialize", "update"],
        properties: [
            { name: "mesh", caption: "Mesh", type: "Mesh" },
            // Vertex: 直接采 mesh 顶点；Surface: 三角形面积加权重心采样；Volume: AABB rejection sampling 后烘焙
            // "Random" 旧值等价于 Vertex，向后兼容
            { name: "sampleMode", caption: "Sample Mode", type: "string", enumSource: ["Vertex", "Surface", "Volume"], default: "Vertex" },
            { name: "pointCount", caption: "Point Count", type: "number", default: 1024 },
            { name: "composition", caption: "Composition", type: "string", enumSource: ["Overwrite", "Add"], default: "Overwrite" },
        ],
    },
    {
        typeId: "setSpawnTime",
        title: "Set Spawn Time",
        category: "Attribute",
        affinity: ["initialize"],
        properties: [],
    },
    {
        typeId: "subpixelAA",
        title: "Subpixel AA",
        category: "Output",
        affinity: ["outputBillboard", "outputMesh"],
        properties: [],
    },
    {
        typeId: "triggerEventShape",
        title: "Trigger Event on Shape Enter",
        category: "GPUEvent",
        affinity: ["update"],
        outputs: [{ id: "evt", name: "Evt", type: "flow" }],
        properties: [
            { name: "shape", caption: "Shape", type: "string", enumSource: ["Sphere", "AABox"], default: "Sphere" },
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Solid", "Inverted"], default: "Solid" },
            { name: "center", caption: "Center", type: "position", default: { x: 0, y: 0, z: 0 } },
            { name: "radius", caption: "Radius", type: "number", default: 1, min: 0, hidden: "data.shape !== 'Sphere'" },
            { name: "size", caption: "Size", type: "vec3", default: { x: 2, y: 2, z: 2 }, hidden: "data.shape !== 'AABox'" },
            { name: "eventType", caption: "Event Type", type: "string", enumSource: ["OnDie", "Always"], default: "OnDie" },
            { name: "param", caption: "Param", type: "number", default: 1, min: 0, step: 1 },
        ],
    },

    // ── Orient ──
    {
        typeId: "orient",
        title: "Orient",
        category: "Orient",
        affinity: ["outputBillboard", "outputMesh", "outputTrail", "outputComposedParticle"],
        properties: [
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Face Camera Plane", "Face Camera Position", "Along Velocity", "Fixed Axis", "Look At Position", "Look At Line", "Advanced"], default: "Face Camera Plane" },
            { name: "upAxis", caption: "Up", type: "vector", default: { x: 0, y: 1, z: 0 }, hidden: "data.mode !== 'Fixed Axis'" },
            { name: "lookAtPosition", caption: "Position", type: "position", default: { x: 0, y: 0, z: 0 }, hidden: "data.mode !== 'Look At Position'" },
            { name: "lookAtLine", caption: "Line", type: "line", default: { start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 1, z: 0 } }, hidden: "data.mode !== 'Look At Line'" },
            { name: "axes", caption: "Axes", type: "string", enumSource: ["XY", "XZ", "YX", "YZ", "ZX", "ZY"], default: "ZY", hidden: "data.mode !== 'Advanced'" },
            { name: "customAxisA", caption: "Primary Axis", type: "vector", default: { x: 0, y: 0, z: 1 }, hidden: "data.mode !== 'Advanced'" },
            { name: "customAxisB", caption: "Secondary Axis", type: "vector", default: { x: 0, y: 1, z: 0 }, hidden: "data.mode !== 'Advanced'" },
            // Advanced 逐粒子轴来源：static=用 customAxis 字面量；velocity=粒子速度；position=径向法线 normalize(position - center)。
            { name: "axisSourceA", caption: "Primary Source", type: "string", enumSource: ["static", "velocity", "position"], default: "static", hidden: "data.mode !== 'Advanced'" },
            { name: "axisSourceB", caption: "Secondary Source", type: "string", enumSource: ["static", "velocity", "position"], default: "static", hidden: "data.mode !== 'Advanced'" },
            { name: "axisCenterA", caption: "Primary Center", type: "position", default: { x: 0, y: 0, z: 0 }, hidden: "data.axisSourceA !== 'position'" },
            { name: "axisCenterB", caption: "Secondary Center", type: "position", default: { x: 0, y: 0, z: 0 }, hidden: "data.axisSourceB !== 'position'" },
        ],
    },

];
