/**
 * VFX Graph 数据类型定义
 *
 * 四层节点层级：
 *   Event    — 事件触发节点
 *   Context  — 生命周期容器 (Spawn / Initialize / Update / Output)
 *   Block    — 堆叠在 Context 内的具体操作
 *   Operator — 独立数据计算节点
 */

// ─── 保存数据 ──────────────────────────────────────

/** 整个图的保存数据 */
export interface IVfxGraphData {
    autoID: number;
    events: IVfxEventData[];
    contexts: IVfxContextData[];
    operators: IVfxOperatorData[];
    /** 图级属性值 */
    props?: Record<string, any>;
    /** 用户定义的暴露属性列表 */
    properties?: IVfxPropertyDef[];
    /** Unity 自定义粒子 attribute（如 Vector2 "Sequential"），跟内置 VFX_PARTICLE_ATTRIBUTES 一起决定 Particle struct 字段 */
    customAttributes?: IVfxCustomAttribute[];
}

/** 自定义粒子属性 — 用户在 Blackboard 声明，跟内置 attribute 一起组成 Particle struct */
export interface IVfxCustomAttribute {
    /** 属性名（normalize 首字母小写后），跟 setAttribute/getAttribute attribute 字段一致 */
    name: string;
    /** GLSL 类型：float / vec2 / vec3 / vec4 / bool / uint / int / color */
    type: string;
}

/** 暴露属性定义 */
export interface IVfxPropertyDef {
    name: string;
    type: string;
    default: any;
    /** 是否暴露给外部（运行时可通过组件设置） */
    exposed: boolean;
    /** 提示文字 */
    tooltip?: string;
    /** 值模式: Default（无约束）、Range（min/max）*/
    mode?: "Default" | "Range";
    min?: number;
    max?: number;
    /** 分组名，用于 VisualEffect 组件 Inspector 折叠展示；空/未设视为 "Default" 组 */
    group?: string;
    /** Inspector 友好显示名；未设回退到 name */
    displayName?: string;
}

/** Event 实例数据（独立节点，flow 输出连接到 Context） */
export interface IVfxEventData {
    id: number;
    typeId: string;
    uiData: { x: number; y: number };
    /** flow 输出连接，keyed by output slotId */
    flowLinks?: Record<string, { targetId: number; targetSlotId: string }>;
    props?: Record<string, any>;
}

/** Context 实例数据 */
export interface IVfxContextData {
    id: number;
    typeId: string;
    uiData: { x: number; y: number };
    /** 内部 Block 有序列表 */
    blocks: IVfxBlockData[];
    /** flow 连接：keyed by 本 Context 的输出 slotId，value 为目标 Context 信息 */
    flowLinks?: Record<string, { targetId: number; targetSlotId: string }>;
    props?: Record<string, any>;
}

/** Block 实例数据（嵌入 Context 内，无画布坐标） */
export interface IVfxBlockData {
    id: number;
    typeId: string;
    enabled: boolean;
    props?: Record<string, any>;
}

/** Operator 实例数据（独立节点） */
export interface IVfxOperatorData {
    id: number;
    typeId: string;
    uiData: { x: number; y: number };
    /** 输出连接，keyed by output slotId */
    output?: Record<string, { infoArr: IVfxConnectionData[] }>;
    props?: Record<string, any>;
}

/** 一条连接（从输出插槽到输入插槽） */
export interface IVfxConnectionData {
    nodeId: number;
    slotId: string;
}

// ─── 插槽定义 ──────────────────────────────────────

/** 插槽定义 */
export interface IVfxSlotDef {
    id: string;
    name: string;
    type: string;
    /** 无连线时的默认值（编译器 fallback） */
    default?: any;
}

// ─── 类型定义（注册表条目） ─────────────────────────

/** Context 类型定义 */
export interface IVfxContextTypeDef {
    typeId: string;
    title: string;
    color: string;
    /** 命名 flow 输入端口（显示在 Context 顶部） */
    flowInputs: IVfxSlotDef[];
    /** 命名 flow 输出端口（显示在 Context 底部） */
    flowOutputs: IVfxSlotDef[];
    /** 此 Context 可添加的 Block typeId 列表 */
    compatibleBlocks: string[];
    properties?: IEditor.FPropertyDescriptor[];
}

/** Block 类型定义 */
export interface IVfxBlockTypeDef {
    typeId: string;
    title: string;
    category: string;
    /** 可所属的 Context typeId 列表 */
    affinity: string[];
    /** 可接收 Operator 连接的输入端口 */
    inputs?: IVfxSlotDef[];
    /** 输出端口（如 Trigger Event 的事件输出） */
    outputs?: IVfxSlotDef[];
    properties?: IEditor.FPropertyDescriptor[];
}

/** Event 类型定义 */
export interface IVfxEventTypeDef {
    typeId: string;
    title: string;
    color: string;
    /** flow 输入端口（如 GPU Event 左侧输入） */
    flowInputs?: IVfxSlotDef[];
    /** flow 输出端口 */
    flowOutputs: IVfxSlotDef[];
    properties?: IEditor.FPropertyDescriptor[];
}

/** Operator 类型定义 */
export interface IVfxOperatorTypeDef {
    typeId: string;
    title: string;
    color: string;
    category: string;
    inputs: IVfxSlotDef[];
    outputs: IVfxSlotDef[];
    properties?: IEditor.FPropertyDescriptor[];
    /** 支持的数据类型列表（齿轮菜单切换） */
    supportedTypes?: string[];
    /** 在节点选择器中隐藏（仅由系统自动创建） */
    hidden?: boolean;
}
