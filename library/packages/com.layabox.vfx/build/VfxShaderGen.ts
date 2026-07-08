import type { IVfxContextData, IVfxOperatorData, IVfxPropertyDef } from "../data/VfxTypes";
import type { IVfxAttributeUsage } from "./VfxBuild";
import { generateVFXCommon, generateSourcePackInfo, type IUpdateFlags } from "./templates/VFXCommon";
import { generateInitialize, generateGPUInitialize } from "./templates/Initialize";
import { generateUpdate, type ITriggerEventInfo, type IOutputEventInfo } from "./templates/Update";
import { generateOutput } from "./templates/Output";
import { genBlockCode } from "./templates/BlockCodeGenCommon";
import { generatePrepareDispatch } from "./templates/PrepareDispatch";
import { generateStripOutput } from "./templates/OutputStrip";
import { generateUpdateStrips } from "./templates/UpdateStrips";
import { generateOutputUpdate } from "./templates/OutputUpdate";
import { generateLineOutput } from "./templates/OutputLine";
import { generatePointOutput } from "./templates/OutputPoint";
import { VfxExprCompiler } from "./VfxExprCompiler";
import { VFX_NOISE_GLSL } from "./templates/VFXNoise";

/** customGlsl 用户代码 → GLSL function 注入。函数签名固定 vec4(a,b,c,d)→vec4 */
function _generateCustomCodeFunctions(funcs: Map<number, string>): string {
    if (!funcs || funcs.size === 0) return "";
    const chunks: string[] = [];
    funcs.forEach((code, opId) => {
        chunks.push(`
// CustomGLSL function (operator id=${opId})
vec4 _userCustom_${opId}(vec4 a, vec4 b, vec4 c, vec4 d) {
    ${code}
}
`);
    });
    return chunks.join("\n");
}

/** 为每个 SkinnedMesh sourceName 生成 GLSL helper function（4 骨骼 skinning + bones texture 拼装 mat4）
 *  bones texture 是 256×1 RGBA32F，每 4 像素 = 1 mat4，最多 64 bones */
function _generateSkinnedMeshHelpers(sources: Set<string>): string {
    if (!sources || sources.size === 0) return "";
    const codeChunks: string[] = [];

    // 收集 unique sourceName（去掉 |role 后缀）
    const sourceNames = new Set<string>();
    const needsNormal = new Set<string>();
    sources.forEach(s => {
        const [src, role] = s.split("|");
        sourceNames.add(src);
        if (role === "normal") needsNormal.add(src);
    });

    sourceNames.forEach(src => {
        const posU = `u_VfxProp_SkinnedMeshPos_${src}`;
        const idxU = `u_VfxProp_SkinnedMeshIdx_${src}`;
        const wgtU = `u_VfxProp_SkinnedMeshWeight_${src}`;
        const bonesU = `u_VfxProp_SkinnedMeshBones_${src}`;

        codeChunks.push(`
// SkinnedMesh helper for source "${src}"
mat4 _readBoneMtx_${src}(int boneIdx) {
    float u0 = (float(boneIdx * 4 + 0) + 0.5) / 256.0;
    float u1 = (float(boneIdx * 4 + 1) + 0.5) / 256.0;
    float u2 = (float(boneIdx * 4 + 2) + 0.5) / 256.0;
    float u3 = (float(boneIdx * 4 + 3) + 0.5) / 256.0;
    return mat4(
        textureLod(${bonesU}, vec2(u0, 0.5), 0.0),
        textureLod(${bonesU}, vec2(u1, 0.5), 0.0),
        textureLod(${bonesU}, vec2(u2, 0.5), 0.0),
        textureLod(${bonesU}, vec2(u3, 0.5), 0.0)
    );
}

vec3 _sampleSkinnedMeshPos_${src}(int vIdx) {
    float w = float(textureSize(${posU}, 0).x);
    float u = (mod(float(vIdx), w) + 0.5) / w;
    vec4 p = textureLod(${posU}, vec2(u, 0.5), 0.0);
    vec4 bI = textureLod(${idxU}, vec2(u, 0.5), 0.0);
    vec4 bW = textureLod(${wgtU}, vec2(u, 0.5), 0.0);
    mat4 m = _readBoneMtx_${src}(int(bI.x)) * bW.x
           + _readBoneMtx_${src}(int(bI.y)) * bW.y
           + _readBoneMtx_${src}(int(bI.z)) * bW.z
           + _readBoneMtx_${src}(int(bI.w)) * bW.w;
    return (m * vec4(p.xyz, 1.0)).xyz;
}
`);
        if (needsNormal.has(src)) {
            const normU = `u_VfxProp_SkinnedMeshNormal_${src}`;
            codeChunks.push(`
vec3 _sampleSkinnedMeshNormal_${src}(int vIdx) {
    float w = float(textureSize(${posU}, 0).x);
    float u = (mod(float(vIdx), w) + 0.5) / w;
    vec4 n = textureLod(${normU}, vec2(u, 0.5), 0.0);
    vec4 bI = textureLod(${idxU}, vec2(u, 0.5), 0.0);
    vec4 bW = textureLod(${wgtU}, vec2(u, 0.5), 0.0);
    mat4 m = _readBoneMtx_${src}(int(bI.x)) * bW.x
           + _readBoneMtx_${src}(int(bI.y)) * bW.y
           + _readBoneMtx_${src}(int(bI.z)) * bW.z
           + _readBoneMtx_${src}(int(bI.w)) * bW.w;
    return normalize((m * vec4(n.xyz, 0.0)).xyz);
}
`);
        }
    });

    return codeChunks.join("\n");
}

function glslTypeToUniformMap(glslType: string | { type: string; [key: string]: any }): string {
    // texture uniform entries are objects { type: "Texture2D" | "Texture3D" | "Texture2DArray" | "TextureCube", textureProp?, gradientData? }
    if (typeof glslType === "object" && glslType !== null) {
        if (glslType.type === "Texture2D") return "Texture2D";
        if (glslType.type === "Texture3D") return "Texture3D";
        if (glslType.type === "Texture2DArray") return "Texture2DArray";
        if (glslType.type === "TextureCube") return "TextureCube";
        if (glslType.type === "Mat4") return "Matrix4x4"; // SkinnedMeshTransform 骨骼矩阵
        return "Float";
    }
    switch (glslType) {
        case "float": return "Float";
        case "int": return "Int";
        case "uint": return "Int";
        case "vec2": return "Vector2";
        case "vec3": return "Vector3";
        case "vec4": return "Vector4";
        case "mat4": return "Matrix4x4";
        default: return "Float";
    }
}

export interface IShaderGenResult {
    initializeShader: string;
    updateShader: string;
    outputShader: string;
    outputUpdateShader?: string;
    prepareDispatchShader?: string;
    updateStripsShader?: string;
    attributeBytesPerParticle: number;
    needsCamera?: boolean;
    /** 此 system 收集到的曲线 entries（opId → frameData），由上层统一烘焙 */
    curveEntries?: Map<number, number[]>;
    /** 本 system 收集到的 Texture2D/Texture3D uniform → texture UUID 映射 */
    textureUniforms?: Array<{ uniformName: string; uuid: string; textureType: string }>;
    /** 本 system 收集到的 StorageBuffer uniform → property name 映射 (mesh 点云走 meshProp 烘焙) */
    bufferUniforms?: Array<{ uniformName: string; propertyName?: string; meshProp?: string; meshRole?: string; pointCount?: number; meshScale?: number }>;
}

/**
 * VFX compute shader 代码生成器
 * 根据 per-system attributes 生成 common 代码，嵌入各 stage 模板
 */
export class VfxShaderGen {
    /**
     * 一次性生成 compute shader + attributeBytesPerParticle
     * @param triggerEvents 此系统 Update 中的 triggerEvent blocks（源系统产生事件）
     * @param isGPUEvent    此系统是否为 GPU Event 接收端
     */
    static generateAll(
        initCtx: IVfxContextData,
        updateCtx: IVfxContextData,
        _outputCtx: IVfxContextData,
        id: string,
        attributes: IVfxAttributeUsage[],
        operators: IVfxOperatorData[],
        graphProperties: IVfxPropertyDef[],
        isGPUEvent?: boolean,
        triggerEvents?: ITriggerEventInfo[],
        sourceAttrs?: IVfxAttributeUsage[],
        simulateSpace?: string,
        sourceSimulateSpace?: string,
        outputEvents?: IOutputEventInfo[],
    ): IShaderGenResult {
        const space = simulateSpace ?? "Local";
        const updateProps = updateCtx.props || {};
        const updateFlags: IUpdateFlags = {
            updatePosition: updateProps.updatePosition ?? true,
            ageParticles: updateProps.ageParticles ?? true,
            reapParticles: updateProps.reapParticles ?? true,
        };
        const skipZeroDeltaTime = updateProps.skipZeroDeltaTime ?? false;

        const { code: common, stride, packEntries } = generateVFXCommon(attributes, updateFlags);
        const name = "VFX_" + id.replace(/-/g, "_");
        const attrNames = new Set(attributes.map(a => a.name));

        // 为每个 shader stage 创建独立的表达式编译器
        const initCompiler = new VfxExprCompiler(operators, "particle", graphProperties, space, "init");
        const updateCompiler = new VfxExprCompiler(operators, "p", graphProperties, space, "update");
        const outputCompiler = new VfxExprCompiler(operators, "p", graphProperties, space, "output");

        // Detect strip mode for ring buffer
        const isNone = _outputCtx.typeId === "none";
        const isStrip = _outputCtx.typeId === "outputTrail";
        const useStripRingBuffer = isStrip;

        // 判断是否有 source attribute (init 块或 op 链使用 location=Source / source=Source)
        // 让 generateInitialize 决定是否生成 srcCode (SourceEventData src = ...)
        const hasSourceAttrs = attributes.some(a =>
            (a.usage === "set" && a.source === "Source") ||
            (a.usage === "get" && a.location === "Source")
        );
        // 收集 source 中真实存在的 attribute names（让 strip alloc 等代码精确判断 events[0].<attr> 字段是否存在）
        const sourceAttrNames = new Set<string>();
        for (const a of attributes) {
            if ((a.usage === "set" && a.source === "Source") ||
                (a.usage === "get" && a.location === "Source")) {
                sourceAttrNames.add(a.name);
            }
        }

        let initializeShader: string;
        if (isGPUEvent) {
            // GPU Event 接收端: readSourceParticle 需要源系统的布局
            const srcPack = sourceAttrs ? generateSourcePackInfo(sourceAttrs) : { entries: packEntries, stride };
            initializeShader = generateGPUInitialize(`${name}_GPUInitialize`, common, initCtx.blocks || [], attrNames, srcPack.entries, srcPack.stride, initCtx.id, initCompiler, space, sourceSimulateSpace ?? "Local", useStripRingBuffer, hasSourceAttrs);
        } else {
            initializeShader = generateInitialize(`${name}_Initialize`, common, initCtx.blocks || [], attrNames, triggerEvents, initCtx.id, initCompiler, space, useStripRingBuffer, hasSourceAttrs, operators, sourceAttrNames);
        }

        // Update shader 也用 common（编译器在生成过程中收集 property uniforms）
        const updateShader = generateUpdate(`${name}_Update`, common, updateCtx.blocks || [], triggerEvents, updateCtx.id, updateCompiler, skipZeroDeltaTime, space, useStripRingBuffer, outputEvents, attrNames);

        // Output shader（编译器在生成过程中收集 property uniforms）
        let outputShader: string;
        if (isNone) {
            // Heads 系统（无 Output）：不需要 Output shader，生成空占位
            outputShader = "";
        } else if (isStrip) {
            // Strip Output: 生成 strip 几何（粒子连成四边形面片）
            const blockCode = genBlockCode(_outputCtx.blocks || [], { particleVar: "p", includeShape: false }, _outputCtx.id, outputCompiler, space);
            const stripCapacity = Number(_outputCtx.props?.stripCapacity) || 1;
            const particlePerStripCount = Number(_outputCtx.props?.particlePerStripCount) || 128;
            outputShader = generateStripOutput(common, {
                needsCamera: outputCompiler.needsCamera,
                hasColor: attrNames.has("color"),
                hasAlpha: attrNames.has("alpha"),
                hasSize: attrNames.has("size"),
                blockCode,
                extraUniforms: "",
                simulateSpace: space,
                attrNames,
                stripCapacity,
                particlePerStripCount,
                isGPUEvent: !!isGPUEvent,
                uvBiasScrollX: _outputCtx.props?.uvBiasScrollX,
                uvBiasScrollY: _outputCtx.props?.uvBiasScrollY,
            });
        } else if (_outputCtx.typeId === "outputLine") {
            const blockCode = genBlockCode(_outputCtx.blocks || [], { particleVar: "p", includeShape: false }, _outputCtx.id, outputCompiler, space);
            const targetOffset = _outputCtx.props?.targetOffset || { x: 0, y: 0.1, z: 0 };
            outputShader = generateLineOutput(common, {
                hasColor: attrNames.has("color"),
                hasAlpha: attrNames.has("alpha"),
                hasSize: attrNames.has("size"),
                blockCode,
                extraUniforms: "",
                simulateSpace: space,
                attrNames,
                targetOffset: targetOffset as { x: number; y: number; z: number },
            });
        } else if (_outputCtx.typeId === "outputPoint" || _outputCtx.typeId === "outputLineStrip") {
            // outputPoint 和 outputLineStrip 共用 OutputPoint compute（每粒子 1 vertex）
            // 区别仅在 runtime geometry 的 topology（Points vs LineStrip）
            const blockCode = genBlockCode(_outputCtx.blocks || [], { particleVar: "p", includeShape: false }, _outputCtx.id, outputCompiler, space);
            outputShader = generatePointOutput(common, {
                hasColor: attrNames.has("color"),
                hasAlpha: attrNames.has("alpha"),
                hasSize: attrNames.has("size"),
                blockCode,
                extraUniforms: "",
                simulateSpace: space,
                attrNames,
            });
        } else {
            outputShader = generateOutput(`${name}_Output`, common, attrNames, space, _outputCtx.blocks, _outputCtx.id, outputCompiler);
        }

        // 收集所有阶段的 Property uniform 声明
        const allPropertyUniforms = new Map<string, string>();
        initCompiler.propertyUniforms.forEach((v, k) => allPropertyUniforms.set(k, v));
        updateCompiler.propertyUniforms.forEach((v, k) => allPropertyUniforms.set(k, v));
        outputCompiler.propertyUniforms.forEach((v, k) => allPropertyUniforms.set(k, v));

        // ── 收集曲线 entries（不烘焙，由上层统一处理） ──
        const allCurveEntries = new Map<number, number[]>();
        initCompiler.curveEntries.forEach((v, k) => allCurveEntries.set(k, v));
        updateCompiler.curveEntries.forEach((v, k) => allCurveEntries.set(k, v));
        outputCompiler.curveEntries.forEach((v, k) => allCurveEntries.set(k, v));

        const hasCurves = allCurveEntries.size > 0;

        // 将 Property uniform 注入到 uniformMaps 中（替换模板占位符 /*VFX_EXTRA_UNIFORMS*/）
        const cameraEntries = [
            `u_VfxCameraParams: { type: "Vector4" }`,
            `u_VfxCameraParams2: { type: "Vector4" }`,
            `u_VfxCameraParams3: { type: "Vector4" }`,
        ];

        const buildInjection = (needsCam: boolean): string => {
            const entries: string[] = [];
            allPropertyUniforms.forEach((glslType: any, propName: string) => {
                // StorageBuffer 通过 GLSL body 的 buffer 声明注入，不进 uniformMap
                if (glslType && typeof glslType === "object" && glslType.type === "StorageBuffer") return;
                // _rawUniformName 用原始 uniform 名（引擎预定义的 u_CameraDepthTexture 等），
                // 不加 u_VfxProp_ 前缀
                if (glslType && typeof glslType === "object" && glslType._rawUniformName) {
                    const rawName = glslType._rawUniformName as string;
                    const ut = glslType.type === "Texture2D" ? "Texture2D"
                        : glslType.type === "Texture3D" ? "Texture3D"
                        : glslTypeToUniformMap(glslType._glslType || "float");
                    entries.push(`${rawName}: { type: "${ut}" }`);
                } else if (propName.startsWith("u_")) {
                    // 已是完整 shader uniform 名（如 sampleTexture2D 的 u_VfxTex_<id>、
                    // sampleGradient 的 u_VfxGradient_<id>），直接用原名
                    entries.push(`${propName}: { type: "${glslTypeToUniformMap(glslType)}" }`);
                } else {
                    entries.push(`u_VfxProp_${propName}: { type: "${glslTypeToUniformMap(glslType)}" }`);
                }
            });
            // 曲线 uniforms: 共享纹理 + 每条曲线的 curveData
            if (hasCurves) {
                entries.push(`u_VfxBakedTex: { type: "Texture2D" }`);
                for (const opId of allCurveEntries.keys()) {
                    entries.push(`u_VfxCurve_${opId}: { type: "Vector4" }`);
                }
            }
            if (needsCam) entries.push(...cameraEntries);
            if (entries.length === 0) return "";
            return ",\n            " + entries.join(",\n            ");
        };

        const PLACEHOLDER = "/*VFX_EXTRA_UNIFORMS*/";
        const CURVE_FUNC_PLACEHOLDER = "/*VFX_CURVE_FUNC*/";
        const STORAGE_BUFFER_PLACEHOLDER = "/*VFX_STORAGE_BUFFERS*/";

        // 收集 StorageBuffer 声明（注入到 GLSL body，不是 uniformMap）
        const storageBufferDecls: string[] = [];
        const bufferUniforms: Array<{ uniformName: string; propertyName?: string; meshProp?: string; meshRole?: string; pointCount?: number; meshScale?: number }> = [];
        allPropertyUniforms.forEach((val: any, propName: string) => {
            if (val && typeof val === "object" && val.type === "StorageBuffer" && val._bufferProperty) {
                const bufName = val._rawUniformName as string;
                storageBufferDecls.push(`buffer ${bufName}Buffer { vec4 data[]; } ${bufName};`);
                bufferUniforms.push({ uniformName: bufName, propertyName: val._bufferProperty });
            } else if (val && typeof val === "object" && val.type === "StorageBuffer" && val._meshBake) {
                // setPositionMesh 点云: storage buffer + 引擎烘焙(对齐 Unity, 绕开 WebGPU compute 纹理绑定 bug)
                const bufName = val._rawUniformName as string;
                storageBufferDecls.push(`buffer ${bufName}Buffer { vec4 data[]; } ${bufName};`);
                bufferUniforms.push({ uniformName: bufName, meshProp: val._meshBake.meshProp, meshRole: val._meshBake.meshRole, pointCount: val._meshBake.pointCount, meshScale: val._meshBake.meshScale });
            }
        });
        const storageBufferCode = storageBufferDecls.length > 0 ? "\n" + storageBufferDecls.join("\n") + "\n" : "";

        // 曲线采样 GLSL 辅助函数
        const curveFuncCode = hasCurves ? `
float HalfTexelOffset(float f) {
    const float a = 127.0 / 128.0;
    const float b = 0.5 / 128.0;
    return a * f + b;
}

float SampleCurve(sampler2D bakedTex, vec4 curveData, float t) {
    float uNorm = t * curveData.x + curveData.y;
    uNorm = HalfTexelOffset(clamp(uNorm, 0.0, 1.0));
    vec4 texVal = texture(bakedTex, vec2(uNorm, curveData.z));
    int channel = floatBitsToInt(curveData.w) & 0x3;
    return channel == 0 ? texVal.r : channel == 1 ? texVal.g : channel == 2 ? texVal.b : texVal.a;
}
` : "";

        let finalInitShader = initializeShader.replace(PLACEHOLDER, buildInjection(initCompiler.needsCamera));
        let finalUpdateShader = updateShader.replace(PLACEHOLDER, buildInjection(updateCompiler.needsCamera));
        let finalOutputShader = outputShader.replace(PLACEHOLDER, buildInjection(outputCompiler.needsCamera));

        // 注入 StorageBuffer 声明到 GLSL body（replaceAll 处理多个占位符）
        finalInitShader = finalInitShader.split(STORAGE_BUFFER_PLACEHOLDER).join(storageBufferCode);
        finalUpdateShader = finalUpdateShader.split(STORAGE_BUFFER_PLACEHOLDER).join(storageBufferCode);
        finalOutputShader = finalOutputShader.split(STORAGE_BUFFER_PLACEHOLDER).join(storageBufferCode);

        // 检测是否需要噪声库（operator 或 turbulence block）
        const hasTurbulence = (updateCtx.blocks || []).some(b => b.typeId === "turbulence" && b.enabled);
        const needsNoiseLib = initCompiler.needsNoise || updateCompiler.needsNoise || outputCompiler.needsNoise || hasTurbulence;
        const noiseLibCode = needsNoiseLib ? VFX_NOISE_GLSL : "";

        // skinning helper 必须按 stage 单独注入：helper 引用全局 uniform，naga 验证时
        // 即使死代码也会要求 uniform 在 stage uniform map 中声明 → 把 helper 限定到实际用到的 shader
        const initSkinnedHelper = _generateSkinnedMeshHelpers(initCompiler.skinnedMeshSources);
        const updateSkinnedHelper = _generateSkinnedMeshHelpers(updateCompiler.skinnedMeshSources);
        const outputSkinnedHelper = _generateSkinnedMeshHelpers(outputCompiler.skinnedMeshSources);

        // customGlsl 用户代码也按 stage 注入：用户 code 可能引用 stage-specific uniform，跨 stage 注入会编译错
        const initCustomCode = _generateCustomCodeFunctions(initCompiler.customCodeFunctions);
        const updateCustomCode = _generateCustomCodeFunctions(updateCompiler.customCodeFunctions);
        const outputCustomCode = _generateCustomCodeFunctions(outputCompiler.customCodeFunctions);

        // 注入曲线采样函数 + 噪声库 + skinning helper + customGlsl（noise 自包含可共用，其余按 stage）
        const baseLib = curveFuncCode + noiseLibCode;
        finalInitShader = finalInitShader.replace(CURVE_FUNC_PLACEHOLDER, baseLib + initSkinnedHelper + initCustomCode);
        finalUpdateShader = finalUpdateShader.replace(CURVE_FUNC_PLACEHOLDER, baseLib + updateSkinnedHelper + updateCustomCode);
        finalOutputShader = finalOutputShader.replace(CURVE_FUNC_PLACEHOLDER, baseLib + outputSkinnedHelper + outputCustomCode);
        // Orient camera: 部分模式需要 camera position / direction
        const orientBlock = (_outputCtx.blocks || []).find(b => b.typeId === "orient" && b.enabled);
        const orientMode = (orientBlock?.props?.mode as string) || "Face Camera Plane";
        const orientNeedsCamera = !!orientBlock && (orientMode === "Face Camera Plane" || orientMode === "Face Camera Position" || orientMode === "Fixed Axis"
            // Along Velocity (Y primary, Unity faceRay): axisZ = position - cameraPos
            || (orientMode === "Along Velocity" && (((orientBlock.props?.axes as string) || "YX")[0] === "Y")));
        const needsCamera = initCompiler.needsCamera || updateCompiler.needsCamera || outputCompiler.needsCamera || orientNeedsCamera;

        // OutputUpdate pass: camera sort / frustum cull
        const enableCameraSort = !!_outputCtx.props?.cameraSort;
        const enableFrustumCull = !!_outputCtx.props?.frustumCull;
        let finalOutputUpdateShader: string | undefined;
        if (enableCameraSort || enableFrustumCull) {
            let ouShader = generateOutputUpdate(common, {
                cameraSort: enableCameraSort,
                frustumCull: enableFrustumCull,
                hasMotionVectors: false,
            });
            ouShader = ouShader.replace(PLACEHOLDER, "");
            ouShader = ouShader.replace(CURVE_FUNC_PLACEHOLDER, "");
            finalOutputUpdateShader = ouShader;
        }

        // 收集 Texture2D/Texture3D uniform 条目，映射到最终 shader uniform 名
        // 同一逻辑被 generateOutputOnly (Multi-Output extra output 路径) 复用，避免 inline gradient/mesh
        // 等 uniform 在 extra output 路径漏写让 runtime 绑默认空纹理（u_VfxGradient_<id> 拿不到 stops → 粒子全白色）
        const textureUniforms = _collectTextureUniformsFromPropertyMap(allPropertyUniforms);

        const result: IShaderGenResult = {
            initializeShader: finalInitShader,
            updateShader: finalUpdateShader,
            outputShader: finalOutputShader,
            outputUpdateShader: finalOutputUpdateShader,
            attributeBytesPerParticle: stride * 16,
            needsCamera,
            curveEntries: hasCurves ? allCurveEntries : undefined,
            textureUniforms: textureUniforms.length > 0 ? textureUniforms : undefined,
            bufferUniforms: bufferUniforms.length > 0 ? bufferUniforms : undefined,
        };

        // GPU Event 接收端需要 PrepareDispatch shader
        if (isGPUEvent) {
            result.prepareDispatchShader = generatePrepareDispatch(`${name}_PrepareDispatch`);
        }

        // Strip ring buffer: generate UpdateStrips shader (separate pass to compact ring buffer)
        if (useStripRingBuffer) {
            // Find alive attribute's slot and swizzle in the packed layout
            const aliveEntry = packEntries.find(e => e.name === "alive");
            if (aliveEntry) {
                const swizzleMap: Record<string, number> = { ".x": 0, ".y": 1, ".z": 2, ".w": 3 };
                result.updateStripsShader = generateUpdateStrips(stride, aliveEntry.slot, swizzleMap[aliveEntry.swizzle] ?? 0);
            }
        }

        return result;
    }

    /**
     * 仅生成 Output shader（Multi-Output 用：共享 init/update，只需额外 output）
     */
    static generateOutputOnly(
        updateCtx: IVfxContextData,
        outputCtx: IVfxContextData,
        id: string,
        attributes: IVfxAttributeUsage[],
        operators: IVfxOperatorData[],
        graphProperties: IVfxPropertyDef[],
        simulateSpace?: string,
    ): { outputShader: string; textureUniforms?: Array<{ uniformName: string; uuid: string; textureType: string }> } {
        const space = simulateSpace ?? "Local";
        const updateProps = updateCtx.props || {};
        const updateFlags: IUpdateFlags = {
            updatePosition: updateProps.updatePosition ?? true,
            ageParticles: updateProps.ageParticles ?? true,
            reapParticles: updateProps.reapParticles ?? true,
        };

        const { code: common } = generateVFXCommon(attributes, updateFlags);
        const name = "VFX_" + id.replace(/-/g, "_");
        const attrNames = new Set(attributes.map(a => a.name));
        const outputCompiler = new VfxExprCompiler(operators, "p", graphProperties, space);

        // outputTrail/strip extra output 必须用 generateStripOutput 写 2 vert × 4 vec4 strip vertex (不是 Mesh/Billboard 的 5 vec4 instance data)
        // 之前 extra outputTrail 走 generateOutput 让 shader 写错布局, strip geometry 顶点全是 mesh data, color/alpha 也 mis-aligned → ribbon 全白色不对
        const isStripExtra = outputCtx.typeId === "outputTrail" || outputCtx.typeId === "outputParticleStripSGQuad";
        let outputShader: string;
        if (isStripExtra) {
            const { genBlockCode } = require("./templates/BlockCodeGenCommon");
            const blockCode = genBlockCode(outputCtx.blocks || [], { particleVar: "p", includeShape: false }, outputCtx.id, outputCompiler, space);
            const stripCapacity = Number(outputCtx.props?.stripCapacity) || 1;
            const particlePerStripCount = Number(outputCtx.props?.particlePerStripCount) || 128;
            outputShader = generateStripOutput(common, {
                needsCamera: outputCompiler.needsCamera,
                hasColor: attrNames.has("color"),
                hasAlpha: attrNames.has("alpha"),
                hasSize: attrNames.has("size"),
                blockCode,
                extraUniforms: "",
                simulateSpace: space,
                attrNames,
                stripCapacity,
                particlePerStripCount,
                isGPUEvent: false,
                uvBiasScrollX: outputCtx.props?.uvBiasScrollX,
                uvBiasScrollY: outputCtx.props?.uvBiasScrollY,
            });
        } else {
            outputShader = generateOutput(`${name}_Output`, common, attrNames, space, outputCtx.blocks, outputCtx.id, outputCompiler);
        }

        // Property uniforms injection
        const entries: string[] = [];
        const cameraEntries = [
            `u_VfxCameraParams: { type: "Vector4" }`,
            `u_VfxCameraParams2: { type: "Vector4" }`,
            `u_VfxCameraParams3: { type: "Vector4" }`,
        ];
        outputCompiler.propertyUniforms.forEach((glslType: any, propName: string) => {
            if (glslType && typeof glslType === "object" && glslType._rawUniformName) {
                entries.push(`${glslType._rawUniformName}: { type: "${glslType.type === "Texture2D" ? "Texture2D" : "Float"}" }`);
            } else {
                // propName 已 u_ 开头时直接用（如 attributeFromMap 的 u_VfxAttrMap_<id>），否则加 u_VfxProp_ 前缀
                const finalName = propName.startsWith("u_") ? propName : `u_VfxProp_${propName}`;
                entries.push(`${finalName}: { type: "${glslTypeToUniformMap(glslType)}" }`);
            }
        });
        if (outputCompiler.needsCamera) entries.push(...cameraEntries);
        const injection = entries.length > 0 ? ",\n            " + entries.join(",\n            ") : "";
        outputShader = outputShader.replace("/*VFX_EXTRA_UNIFORMS*/", injection);

        // 注入 StorageBuffer 声明到 GLSL body（跟主 output 路径 generateAll 保持一致），
        // 否则 sub-particle attribute / point cache 等 StorageBuffer 类型 propertyUniforms 缺声明 → shader 编译失败
        const storageBufferDecls: string[] = [];
        outputCompiler.propertyUniforms.forEach((val: any, propName: string) => {
            if (val && typeof val === "object" && val.type === "StorageBuffer" && val._bufferProperty) {
                const bufName = val._rawUniformName as string;
                storageBufferDecls.push(`buffer ${bufName}Buffer { vec4 data[]; } ${bufName};`);
            }
        });
        const storageBufferCode = storageBufferDecls.length > 0 ? "\n" + storageBufferDecls.join("\n") + "\n" : "";
        outputShader = outputShader.split("/*VFX_STORAGE_BUFFERS*/").join(storageBufferCode);

        // 注入 curve sampler + noise lib + skinned helper + customGlsl helpers，
        // 跟主 output 路径 (generateAll) 保持一致。之前直接替换成空让 extra output 用 noise/curve op 时
        // GeneratePerlinNoise/SampleCurve 等函数 undefined → shader 编译失败。
        const hasCurves = outputCompiler.curveEntries && outputCompiler.curveEntries.size > 0;
        const curveFuncCode = hasCurves ? `
float HalfTexelOffset(float f) {
    const float a = 127.0 / 128.0;
    const float b = 0.5 / 128.0;
    return a * f + b;
}

float SampleCurve(sampler2D bakedTex, vec4 curveData, float t) {
    float uNorm = t * curveData.x + curveData.y;
    uNorm = HalfTexelOffset(clamp(uNorm, 0.0, 1.0));
    vec4 texVal = texture(bakedTex, vec2(uNorm, curveData.z));
    int channel = floatBitsToInt(curveData.w) & 0x3;
    return channel == 0 ? texVal.r : channel == 1 ? texVal.g : channel == 2 ? texVal.b : texVal.a;
}
` : "";
        const needsNoiseLib = !!outputCompiler.needsNoise;
        const noiseLibCode = needsNoiseLib ? VFX_NOISE_GLSL : "";
        const skinnedHelper = _generateSkinnedMeshHelpers(outputCompiler.skinnedMeshSources);
        const customCode = _generateCustomCodeFunctions(outputCompiler.customCodeFunctions);
        outputShader = outputShader.replace("/*VFX_CURVE_FUNC*/", curveFuncCode + noiseLibCode + skinnedHelper + customCode);

        // Texture uniforms — 用跟 generateAll 同一份收集逻辑，让 Multi-Output extra 也能拿到 inline gradient / mesh-baked / pcache / skinnedMesh / 空纹理 fallback 条目
        // 之前只看 val.textureProp 让 sampleGradient 等 inline gradient uniform (val.gradientData) 完全漏，导致 extra 输出的粒子全白色（TexIndexAdvanced Cube Background 2 sphere 全白色根因）
        const textureUniforms = _collectTextureUniformsFromPropertyMap(outputCompiler.propertyUniforms);

        return { outputShader, textureUniforms: textureUniforms.length > 0 ? textureUniforms : undefined };
    }
}

// ─── 共用：propertyUniforms map → textureUniforms 序列化条目 ───
// generateAll 跟 generateOutputOnly 同走这条，保证 Multi-Output extra output 跟 primary 同语义。
// 支持：meshProp(顶点/采样点烘焙) / skinnedMeshSource / pcacheProp / gradientData(inline) / graphGradient (skip) / 普通 Texture2D/3D/2DArray/Cube
function _collectTextureUniformsFromPropertyMap(propertyUniforms: Map<string, any>): Array<{ uniformName: string; uuid: string; textureType: string; gradientStops?: any; pointCount?: number }> {
    const textureUniforms: Array<{ uniformName: string; uuid: string; textureType: string; gradientStops?: any; pointCount?: number }> = [];
    propertyUniforms.forEach((val: any, propName: string) => {
        if (val && typeof val === "object" && val._rawUniformName) {
            // 引擎预定义 uniform（如 u_CameraDepthTexture），runtime 自己绑定，不进 textureUniforms
            return;
        }
        // propName 如果已以 u_ 开头（如 u_VfxTex_<id>），表示 compiler 给出的就是最终 uniform 名；
        // 否则按逻辑 property 名处理，加 u_VfxProp_ 前缀
        const finalUniformName = propName.startsWith("u_") ? propName : `u_VfxProp_${propName}`;
        if (val && typeof val === "object" && val.type === "Texture2D" && val.meshProp) {
            const role = String(val.meshRole || "position");
            const roleUpper = role.charAt(0).toUpperCase() + role.slice(1);
            const entry: any = {
                uniformName: finalUniformName,
                uuid: String(val.meshProp),
                textureType: `Mesh${roleUpper}`,
            };
            if (val.pointCount) entry.pointCount = val.pointCount;
            if (val.meshScale != null && val.meshScale !== 1) entry.meshScale = val.meshScale;  // 点云顶点缩放(缺省1.0,替代引擎×0.01硬编码)
            textureUniforms.push(entry);
        } else if (val && typeof val === "object" && val.type === "Texture2D" && val.skinnedMeshSource) {
            textureUniforms.push({
                uniformName: finalUniformName,
                uuid: String(val.skinnedMeshSource),
                textureType: `SkinnedMesh_${val.skinnedMeshRole}`,
            });
        } else if (val && typeof val === "object" && val.type === "Mat4" && val.transformSource) {
            // SkinnedMeshTransform: 不是纹理,但复用 textureUniforms 通道把 transformSource 元数据带给引擎;
            // 引擎 _updateTransformSources 每帧把骨骼世界矩阵绑到该 Mat4 uniform(VFXAssetParser 不为其建纹理)
            textureUniforms.push({
                uniformName: finalUniformName,
                uuid: String(val.transformSource),
                textureType: `Transform`,
            } as any);
        } else if (val && typeof val === "object" && val.type === "Texture2D" && val.pcacheProp !== undefined) {
            const attr = String(val.pcacheAttr || "position");
            textureUniforms.push({
                uniformName: finalUniformName,
                uuid: String(val.pcacheProp || ""),
                textureType: `PointCache_${attr}`,
            });
        } else if (val && typeof val === "object" && val.type === "Texture2D" && val.gradientData) {
            // 内联 Gradient：把 stops 数据透传给 runtime，VFXAssetParser 会烘焙成 256×1 Texture2D
            // 兼容两种格式：
            //  1) IDE GradientField 格式 {_rgbElements, _alphaElements, _colorRGBKeysCount, _colorAlphaKeysCount}
            //  2) 转换器/外部工具 stops 格式 {stops: [{t, color: {r,g,b,a}}, ...]}
            const g = val.gradientData;
            let rawStops: Array<{ t: number; color: { r: number; g: number; b: number; a: number } }> = [];
            if (g && Array.isArray(g._rgbElements) && typeof g._colorRGBKeysCount === "number") {
                const rgbCount = g._colorRGBKeysCount;
                const alphaCount = g._colorAlphaKeysCount || 0;
                const rgbArr = g._rgbElements;
                const alphaArr = g._alphaElements || [];
                const tSet = new Set<number>();
                for (let i = 0; i < rgbCount; i++) tSet.add(rgbArr[i * 4]);
                for (let i = 0; i < alphaCount; i++) tSet.add(alphaArr[i * 2]);
                const tList = Array.from(tSet).sort((a, b) => a - b);
                const _sampleRgb = (t: number): [number, number, number] => {
                    if (rgbCount === 0) return [1, 1, 1];
                    if (rgbCount === 1) return [rgbArr[1], rgbArr[2], rgbArr[3]];
                    for (let i = 0; i < rgbCount - 1; i++) {
                        const t1 = rgbArr[i * 4], t2 = rgbArr[(i + 1) * 4];
                        if (t >= t1 && t <= t2) {
                            const u = (t - t1) / Math.max(t2 - t1, 1e-6);
                            return [
                                rgbArr[i * 4 + 1] + (rgbArr[(i + 1) * 4 + 1] - rgbArr[i * 4 + 1]) * u,
                                rgbArr[i * 4 + 2] + (rgbArr[(i + 1) * 4 + 2] - rgbArr[i * 4 + 2]) * u,
                                rgbArr[i * 4 + 3] + (rgbArr[(i + 1) * 4 + 3] - rgbArr[i * 4 + 3]) * u,
                            ];
                        }
                    }
                    const last = rgbCount - 1;
                    return [rgbArr[last * 4 + 1], rgbArr[last * 4 + 2], rgbArr[last * 4 + 3]];
                };
                const _sampleAlpha = (t: number): number => {
                    if (alphaCount === 0) return 1;
                    if (alphaCount === 1) return alphaArr[1];
                    for (let i = 0; i < alphaCount - 1; i++) {
                        const t1 = alphaArr[i * 2], t2 = alphaArr[(i + 1) * 2];
                        if (t >= t1 && t <= t2) {
                            const u = (t - t1) / Math.max(t2 - t1, 1e-6);
                            return alphaArr[i * 2 + 1] + (alphaArr[(i + 1) * 2 + 1] - alphaArr[i * 2 + 1]) * u;
                        }
                    }
                    return alphaArr[(alphaCount - 1) * 2 + 1];
                };
                rawStops = tList.map(t => {
                    const rgb = _sampleRgb(t);
                    return { t, color: { r: rgb[0], g: rgb[1], b: rgb[2], a: _sampleAlpha(t) } };
                });
            } else if (Array.isArray(g?.stops)) {
                rawStops = g.stops;
            }
            textureUniforms.push({
                uniformName: finalUniformName,
                uuid: "",
                textureType: "InlineGradient",
                gradientStops: rawStops,
            });
        } else if (val && typeof val === "object" && val.type === "Texture2D" && val.graphGradient) {
            // Graph Gradient property: uniform declaration only. Texture binding is done by VisualEffect.bakeGradientTexture + applyProperties.
        } else if (val && typeof val === "object" && (val.type === "Texture2D" || val.type === "Texture3D" || val.type === "Texture2DArray" || val.type === "TextureCube")) {
            textureUniforms.push({
                uniformName: finalUniformName,
                uuid: String(val.textureProp || ""),
                textureType: val.type,
            });
        }
    });
    return textureUniforms;
}
