/**
 * VFX Graph 节点类型 — 聚合入口
 *
 * 具体定义分布在各自文件中：
 *   VfxContextDefs.ts  — Context 类型（生命周期容器）
 *   VfxBlockDefs.ts    — Block 类型（Context 内的操作）
 *   VfxOperatorDefs.ts — Operator 类型（独立数据计算节点）
 *
 * 本文件负责：
 *   1. 聚合 re-export 三类定义数组
 *   2. 图级属性定义
 *   3. 查找辅助函数
 *   4. typeRegistry 批量注册
 */

import { FlagsField } from "../display/FlagsField";
import { VfxCurveField } from "../display/VfxCurveField";
import type { IVfxEventTypeDef, IVfxContextTypeDef, IVfxBlockTypeDef, IVfxOperatorTypeDef } from "./VfxTypes";

// ─── Re-export 三类定义 ──────────────────────────────

export { VFX_EVENT_DEFS } from "./VfxEventDefs";
export { VFX_CONTEXT_DEFS } from "./VfxContextDefs";
export { VFX_BLOCK_DEFS } from "./VfxBlockDefs";
export { VFX_OPERATOR_DEFS } from "./VfxOperatorDefs";

import { VFX_EVENT_DEFS } from "./VfxEventDefs";
import { VFX_CONTEXT_DEFS } from "./VfxContextDefs";
import { VFX_BLOCK_DEFS } from "./VfxBlockDefs";
import { VFX_OPERATOR_DEFS } from "./VfxOperatorDefs";
import { getEnumTypeOptions } from "../display/VfxPropRow";

// ═══════════════════════════════════════════════════
//  图级属性
// ═══════════════════════════════════════════════════

/** 图级属性 typeRegistry ID */
export const VFX_GRAPH_TYPE_ID = "vfx_graph";

/** 图级属性定义 — 添加新属性只需在此数组追加 */
export const VFX_GRAPH_PROPERTIES: IEditor.FPropertyDescriptor[] = [
    { name: "fixedDeltaTime", caption: "Fixed Delta Time", type: "boolean", default: false },
    { name: "exactFixedTime", caption: "Exact Fixed Time", type: "boolean", default: false },
    { name: "ignoreTimeScale", caption: "Ignore Time Scale", type: "boolean", default: false },
    { name: "preWarmTotalTime", caption: "PreWarm Total Time", type: "number", default: 0, min: 0 },
    { name: "preWarmStepCount", caption: "PreWarm Step Count", type: "number", default: 0, min: 0, step: 1 },
    { name: "preWarmDeltaTime", caption: "PreWarm Delta Time", type: "number", default: 0, min: 0 },
    { name: "initialEventName", caption: "Initial Event Name", type: "string", default: "OnPlay" },
];

// ─── 查找辅助 ──────────────────────────────────────

const _eventDefMap = new Map(VFX_EVENT_DEFS.map(d => [d.typeId, d]));
const _contextDefMap = new Map(VFX_CONTEXT_DEFS.map(d => [d.typeId, d]));
const _blockDefMap = new Map(VFX_BLOCK_DEFS.map(d => [d.typeId, d]));
const _operatorDefMap = new Map(VFX_OPERATOR_DEFS.map(d => [d.typeId, d]));

export function getEventDef(typeId: string): IVfxEventTypeDef | undefined {
    return _eventDefMap.get(typeId);
}

export function getContextDef(typeId: string): IVfxContextTypeDef | undefined {
    return _contextDefMap.get(typeId);
}

export function getBlockDef(typeId: string): IVfxBlockTypeDef | undefined {
    return _blockDefMap.get(typeId);
}

export function getOperatorDef(typeId: string): IVfxOperatorTypeDef | undefined {
    return _operatorDefMap.get(typeId);
}

/** 获取指定 Context 可添加的 Block 定义列表 */
export function getBlocksForContext(contextTypeId: string): IVfxBlockTypeDef[] {
    return VFX_BLOCK_DEFS.filter(b => b.affinity.includes(contextTypeId));
}

// ─── Property Settings 类型定义 ──────────────────────

/** Property 设置面板的 typeRegistry ID */
export function getPropSettingsRegistryId(vfxType: string): string { return "vfx_propset_" + vfxType; }

/** AABox 值的嵌套对象类型 ID（center/size 两组 vec3，catalogBarStyle:hidden 内联渲染） */
export const VFX_AABOX_VALUE_TYPE_ID = "vfx_aabox_value";

/** 根据 VFX 属性类型生成 Property 设置面板的属性描述符 */
function buildPropSettingsDescriptors(vfxType: string): IEditor.FPropertyDescriptor[] {
    const props: IEditor.FPropertyDescriptor[] = [
        { name: "exposed", caption: "Exposed", type: "boolean", default: true },
        { name: "group", caption: "Group", type: "string", default: "" },
        // displayName 已从属性详情移除（对齐 Unity，Unity 用属性名本身；组件 Properties 面板缺它时回退属性名）
    ];

    switch (vfxType) {
        case "number":
        case "float":  // .vfx 文件里实际存的是 "float"，editor PROPERTY_TYPES 用 "number"，两者等价
            props.push({ name: "default", caption: "Value", type: "number", default: 0 });
            break;
        case "int":
            props.push({ name: "default", caption: "Value", type: "number", default: 0, step: 1 });
            break;
        case "bool":
            props.push({ name: "default", caption: "Value", type: "boolean", default: false });
            break;
        case "vec2":
            props.push({ name: "default", caption: "Value", type: "vec2", default: { x: 0, y: 0 } } as any);
            break;
        case "vec3":
            props.push({ name: "default", caption: "Value", type: "vec3", default: { x: 0, y: 0, z: 0 } } as any);
            break;
        case "vec4":
            props.push({ name: "default", caption: "Value", type: "vec4", default: { x: 0, y: 0, z: 0, w: 0 } } as any);
            break;
        case "color":
            props.push({ name: "default", caption: "Value", inspector: "color", default: { r: 1, g: 1, b: 1, a: 1 } } as any);
            break;
        case "Gradient":
            // LayaIDE 内置 type "Gradient"（Particle.ts:5），复用其 inspector 渲染关键帧编辑
            props.push({ name: "default", caption: "Value", type: "Gradient" } as any);
            break;
        case "Curve":
            // 复用 VfxCurveField（桥接 frames/frameData ↔ 内置 CurveInput）
            props.push({ name: "default", caption: "Value", inspector: "vfxCurve" } as any);
            break;
        case "Texture2D":
        case "Mesh":
            // IDE Asset.ts 已注册 Texture2D/Mesh 为 isAsset 类型，AssetField 自动渲染资源选择框。
            // 值在内存里是 { _$uuid }（IDE 格式），存盘时由 VfxPropValueBridge 转回 ["res://uuid"]
            props.push({ name: "default", caption: "Value", type: vfxType } as any);
            break;
        case "AABox":
            // 轴对齐包围盒（对齐 Unity "Axis Aligned Box"）：default = { center:{x,y,z}, size:{x,y,z} }。
            // 用嵌套类型 vfx_aabox_value（catalogBarStyle:hidden）让 Center/Size 两组 vec3 内联平铺。
            props.push({ name: "default", caption: "Value", type: VFX_AABOX_VALUE_TYPE_ID, nullable: false } as any);
            break;
    }

    props.push({ name: "tooltip", caption: "Tooltip", type: "string", default: "" });

    if (vfxType === "number" || vfxType === "int") {
        props.push(
            { name: "mode", caption: "Mode", type: "string", enumSource: ["Default", "Range"] as any, default: "Default" },
            { name: "min", caption: "Min", type: "number", default: 0, hidden: "data.mode !== 'Range'" },
            { name: "max", caption: "Max", type: "number", default: 0, hidden: "data.mode !== 'Range'" },
        );
    }

    return props;
}

/** Property 设置面板支持的 VFX 属性类型 */
const VFX_PROPSET_TYPES = ["number", "float", "int", "bool", "vec2", "vec3", "vec4", "color", "Gradient", "Curve", "Texture2D", "Mesh", "AABox"];

// ─── typeRegistry 批量注册 ─────────────────────────

/** typeRegistry 中 Event 类型 ID 前缀 */
export function getEventRegistryId(typeId: string): string { return "vfx_evt_" + typeId; }
/** typeRegistry 中 Context 类型 ID 前缀 */
export function getContextRegistryId(typeId: string): string { return "vfx_ctx_" + typeId; }
/** typeRegistry 中 Block 类型 ID 前缀 */
export function getBlockRegistryId(typeId: string): string { return "vfx_block_" + typeId; }
/** typeRegistry 中 Operator 类型 ID 前缀 */
export function getOperatorRegistryId(typeId: string): string { return "vfx_op_" + typeId; }

/**
 * 将所有 VFX 类型一次性注册到 typeRegistry。
 * 在编辑器启动时调用一次即可。
 */
/** 将 VFX 属性定义转为 Inspector FPropertyDescriptor（自动解析枚举类型如 space） */
function resolveProps(props: IEditor.FPropertyDescriptor[]): IEditor.FPropertyDescriptor[] {
    return props.map(p => {
        const enumOpts = getEnumTypeOptions(p.type as string);
        if (enumOpts) return { ...p, type: "string", enumSource: enumOpts };
        if (p.type === "flags") return { ...p, type: "number", inspector: "flags" };
        return p;
    });
}

/**
 * 注册所有 vfx 节点类型到 IDE typeRegistry。
 * @param captionTrans 可选 typeId → 本地化 caption 表（key 用 typeId，不带 prefix），
 *                     来自 editorResources/locales/<lang>/typeCaption.json
 * @param tipsTrans    可选 typeId → 本地化 tips 表（同上格式，来自 typeTips.json）
 */
export function registerAllVfxTypes(captionTrans?: Record<string, string>, tipsTrans?: Record<string, string>): void {
    // 注册自定义 Inspector 控件
    IEditor.InspectorRegistry.registerFieldClass("flags", FlagsField as any);
    // VFX 曲线编辑器（桥接 frameData/frames ↔ 内置 CurveInput），属性定义用 inspector:"vfxCurve" 选用
    IEditor.InspectorRegistry.registerFieldClass("vfxCurve", VfxCurveField as any);

    // 把翻译直接写回 def.title —— VfxContext/Block/Event 节点头部直接读 def.title，
    // 不走 typeRegistry。Add Node / Add Block 菜单刻意保留英文原名 (def._enTitle)，
    // 用户按英文搜节点更直觉，混中文菜单观感反而怪。
    if (captionTrans) {
        const applyTitle = (defs: any[]) => {
            for (const def of defs) {
                const t = captionTrans[def.typeId];
                if (t) {
                    def._enTitle = def.title;
                    def.title = t;
                }
            }
        };
        applyTitle(VFX_EVENT_DEFS as any);
        applyTitle(VFX_CONTEXT_DEFS as any);
        applyTitle(VFX_BLOCK_DEFS as any);
        applyTitle(VFX_OPERATOR_DEFS as any);
    }

    const types: Array<any> = [];
    const trans = (typeId: string) => {
        const out: any = {};
        if (captionTrans && captionTrans[typeId]) out.captionTranslation = captionTrans[typeId];
        if (tipsTrans && tipsTrans[typeId]) out.tipsTranslation = tipsTrans[typeId];
        return out;
    };

    // 图级属性
    types.push({ name: VFX_GRAPH_TYPE_ID, caption: "VFX Graph", properties: VFX_GRAPH_PROPERTIES, ...trans("__graph__") });

    // AABox 值的嵌套对象类型（Center/Size 两组 vec3）。catalogBarStyle:hidden → 子属性内联平铺，
    // 不出额外折叠头，效果对齐 Unity "Axis Aligned Box" 的 Center / Size 布局。
    types.push({
        name: VFX_AABOX_VALUE_TYPE_ID,
        caption: "Axis Aligned Box",
        catalogBarStyle: "hidden",
        properties: [
            { name: "center", caption: "Center", type: "vec3", default: { x: 0, y: 0, z: 0 } },
            { name: "size", caption: "Size", type: "vec3", default: { x: 0, y: 0, z: 0 } },
        ],
    } as any);

    // Event
    for (const def of VFX_EVENT_DEFS) {
        if (def.properties?.length) {
            types.push({ name: getEventRegistryId(def.typeId), caption: def.title, properties: resolveProps(def.properties), ...trans(def.typeId) });
        }
    }

    // Context
    for (const def of VFX_CONTEXT_DEFS) {
        if (def.properties?.length) {
            types.push({ name: getContextRegistryId(def.typeId), caption: def.title, properties: resolveProps(def.properties), ...trans(def.typeId) });
        }
    }

    // Block
    for (const def of VFX_BLOCK_DEFS) {
        if (def.properties?.length) {
            types.push({ name: getBlockRegistryId(def.typeId), caption: def.title, properties: resolveProps(def.properties), ...trans(def.typeId) });
        }
    }

    // Operator
    for (const def of VFX_OPERATOR_DEFS) {
        if (def.properties?.length) {
            types.push({ name: getOperatorRegistryId(def.typeId), caption: def.title, properties: resolveProps(def.properties), ...trans(def.typeId) });
        }
    }

    // Property Settings
    for (const vfxType of VFX_PROPSET_TYPES) {
        const descs = buildPropSettingsDescriptors(vfxType);
        if (descs.length > 0) {
            types.push({ name: getPropSettingsRegistryId(vfxType), caption: "Property Settings", properties: descs });
        }
    }

    // 过滤已注册的，避免重复
    const newTypes = types.filter(t => !Editor.typeRegistry.types[t.name]);
    if (newTypes.length > 0) {
        Editor.typeRegistry.addTypes(newTypes);
    }
}
