/**
 * VfxPropRow — 统一的属性行组件
 *
 * Block 和 Operator 共用，相同数据类型生成完全一致的 UI。
 * 每行 = 可选输入 Slot + 展开箭头 + 标签 + IDE 编辑控件 + 可选输出 Slot
 * 复合类型（vec3, transform, sphere 等）支持递归展开子行。
 */

type NumericInput = InstanceType<typeof IEditor.NumericInput>;
import { VfxSlot } from "./VfxSlot";
import type { VfxStage } from "./VfxStage";
import { isSpaceableType } from "../data/VfxOperatorDefs";

// ─── 属性定义 ───────────────────────────────────────

/** VFX 属性定义（统一的属性描述符） */
export interface IVfxPropDef {
    name: string;
    caption?: string;
    type: string;              // "number" | "int" | "uint" | "boolean" | "vec2" | "vec3" | "vec4" | "color" | "transform" | "sphere" | "Mesh" | "Texture2D" | enum via enumSource
    default?: any;
    min?: number;
    max?: number;
    step?: number;
    enumSource?: string[];
    /** 该属性在节点图中是否隐藏 */
    nodeHidden?: boolean;
    /** 子属性定义（复合类型自动填充） */
    children?: IVfxPropDef[];
    /** 输入 slot 类型（为 null 则不创建 slot） */
    slotType?: string;
}

// ─── 复合类型注册表 ──────────────────────────────────

/** 复合类型 → 子属性定义 */
const COMPOSITE_TYPES: Record<string, IVfxPropDef[]> = {
    vec2: [
        { name: "x", caption: "X", type: "number", default: 0, slotType: "float" },
        { name: "y", caption: "Y", type: "number", default: 0, slotType: "float" },
    ],
    vec3: [
        { name: "x", caption: "X", type: "number", default: 0, slotType: "float" },
        { name: "y", caption: "Y", type: "number", default: 0, slotType: "float" },
        { name: "z", caption: "Z", type: "number", default: 0, slotType: "float" },
    ],
    vec4: [
        { name: "x", caption: "X", type: "number", default: 0, slotType: "float" },
        { name: "y", caption: "Y", type: "number", default: 0, slotType: "float" },
        { name: "z", caption: "Z", type: "number", default: 0, slotType: "float" },
        { name: "w", caption: "W", type: "number", default: 0, slotType: "float" },
    ],
    color: [
        { name: "r", caption: "R", type: "number", default: 1, slotType: "float" },
        { name: "g", caption: "G", type: "number", default: 1, slotType: "float" },
        { name: "b", caption: "B", type: "number", default: 1, slotType: "float" },
        { name: "a", caption: "A", type: "number", default: 1, slotType: "float" },
    ],
    transform: [
        { name: "position", caption: "Position", type: "vec3", default: { x: 0, y: 0, z: 0 }, slotType: "vec3" },
        { name: "rotation", caption: "Angles", type: "vec3", default: { x: 0, y: 0, z: 0 }, slotType: "vec3" },
        { name: "scale", caption: "Scale", type: "vec3", default: { x: 1, y: 1, z: 1 }, slotType: "vec3" },
    ],
    sphere: [
        { name: "transform", caption: "Transform", type: "transform", default: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, slotType: "transform" },
        { name: "radius", caption: "Radius", type: "number", default: 1, min: 0, slotType: "float" },
    ],
    arcSphere: [
        { name: "sphere", caption: "Sphere", type: "sphere", default: { transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, radius: 1 }, slotType: "sphere" },
        { name: "arc", caption: "Arc", type: "number", default: 6.2831853, min: 0, slotType: "float" },
    ],
    aaBox: [
        { name: "center", caption: "Center", type: "position", default: { position: { x: 0, y: 0, z: 0 } }, slotType: "position" },
        { name: "size", caption: "Size", type: "vec3", default: { x: 1, y: 1, z: 1 }, slotType: "vec3" },
    ],
    plane: [
        { name: "position", caption: "Position", type: "position", default: { position: { x: 0, y: 0, z: 0 } }, slotType: "position" },
        { name: "normal", caption: "Normal", type: "vec3", default: { x: 0, y: 1, z: 0 }, slotType: "direction" },
    ],
    orientedBox: [
        { name: "center", caption: "Center", type: "vec3", default: { x: 0, y: 0, z: 0 }, slotType: "vec3" },
        { name: "angle", caption: "Angle", type: "vec3", default: { x: 0, y: 0, z: 0 }, slotType: "vec3" },
        { name: "size", caption: "Size", type: "vec3", default: { x: 1, y: 1, z: 1 }, slotType: "vec3" },
    ],
    cone: [
        { name: "transform", caption: "Transform", type: "transform", default: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, slotType: "transform" },
        { name: "baseRadius", caption: "Base Radius", type: "number", default: 1, min: 0, slotType: "float" },
        { name: "topRadius", caption: "Top Radius", type: "number", default: 0, min: 0, slotType: "float" },
        { name: "height", caption: "Height", type: "number", default: 1, min: 0, slotType: "float" },
    ],
    arcCone: [
        { name: "cone", caption: "Cone", type: "cone", default: { transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, baseRadius: 1, topRadius: 0, height: 1 }, slotType: "cone" },
        { name: "arc", caption: "Arc", type: "number", default: 6.2831853, min: 0, slotType: "float" },
    ],
    torus: [
        { name: "transform", caption: "Transform", type: "transform", default: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, slotType: "transform" },
        { name: "majorRadius", caption: "Major Radius", type: "number", default: 1, min: 0, slotType: "float" },
        { name: "minorRadius", caption: "Minor Radius", type: "number", default: 0.3, min: 0, slotType: "float" },
    ],
    arcTorus: [
        { name: "torus", caption: "Torus", type: "torus", default: { transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, majorRadius: 1, minorRadius: 0.3 }, slotType: "torus" },
        { name: "arc", caption: "Arc", type: "number", default: 6.2831853, min: 0, slotType: "float" },
    ],
    circle: [
        { name: "transform", caption: "Transform", type: "transform", default: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, slotType: "transform" },
        { name: "radius", caption: "Radius", type: "number", default: 1, min: 0, slotType: "float" },
    ],
    arcCircle: [
        { name: "circle", caption: "Circle", type: "circle", default: { transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, radius: 1 }, slotType: "circle" },
        { name: "arc", caption: "Arc", type: "number", default: 6.2831853, min: 0, slotType: "float" },
    ],
    line: [
        { name: "start", caption: "Start", type: "vec3", default: { x: 0, y: 0, z: 0 }, slotType: "vec3" },
        { name: "end", caption: "End", type: "vec3", default: { x: 0, y: 1, z: 0 }, slotType: "vec3" },
    ],
    position: [
        { name: "position", caption: "Position", type: "vec3", default: { x: 0, y: 0, z: 0 }, slotType: "vec3" },
    ],
    vector: [
        { name: "vector", caption: "Vector", type: "vec3", default: { x: 0, y: 0, z: 0 }, slotType: "vec3" },
    ],
    direction: [
        { name: "direction", caption: "Direction", type: "vec3", default: { x: 0, y: 1, z: 0 }, slotType: "vec3" },
    ],
};

/** 注册自定义复合类型 */
export function registerCompositeType(typeName: string, children: IVfxPropDef[]): void {
    COMPOSITE_TYPES[typeName] = children;
}

/** 获取复合类型子属性 */
export function getCompositeChildren(typeName: string): IVfxPropDef[] | undefined {
    return COMPOSITE_TYPES[typeName];
}

/** 枚举类型注册表：类型名 → 枚举选项 */
const ENUM_TYPES: Record<string, string[]> = {
    space: ["Local", "World", "None"],
};

/** 注册自定义枚举类型 */
export function registerEnumType(typeName: string, options: string[]): void {
    ENUM_TYPES[typeName] = options;
}

/** 获取枚举类型选项 */
export function getEnumTypeOptions(typeName: string): string[] | undefined {
    return ENUM_TYPES[typeName];
}

/** 判断是否为向量类型（主行可水平排列分量编辑器） */
function isVecType(type: string): boolean {
    return type === "vec2" || type === "vec3" || type === "vec4" || type === "color";
}

// ─── 布局常量 ───────────────────────────────────────

/** 主属性行高度（与 VfxBlock.ATTR_ROW / VfxNode.COMBO_HEIGHT 一致） */
export const ROW_HEIGHT = 26;
/** 分量子行高度（与 VfxBlock.COMP_ROW / VfxNode.SLOT_HEIGHT 一致） */
export const COMP_ROW_HEIGHT = 24;
const LABEL_FONT = 11;
const LABEL_COLOR = 0xAAAAAA;
const COMP_LABEL_FONT = 10;
const COMP_LABEL_COLOR = 0x777777;
const EXPAND_ARROW_FONT = 8;
const EXPAND_ARROW_COLOR = 0xAAAAAA;

// 向量分量水平布局参数
const VEC_CONFIGS: Record<string, { labels: string[]; fieldW: number }> = {
    vec2: { labels: ["x", "y"], fieldW: 50 },
    vec3: { labels: ["x", "y", "z"], fieldW: 40 },
    vec4: { labels: ["x", "y", "z", "w"], fieldW: 32 },
    color: { labels: ["r", "g", "b", "a"], fieldW: 32 },
};
const VEC_GAP = 4;
const VEC_LABEL_W = 10;

// ─── 配置接口 ───────────────────────────────────────

/** VfxPropRow 构建配置 */
export interface IVfxPropRowConfig {
    /** 属性定义 */
    propDef: IVfxPropDef;
    /** 父容器 widget */
    parent: gui.Widget;
    /** 所属节点 ID（Context ID / Operator ID） */
    nodeId: number;
    /** 画布引用 */
    stage: VfxStage;
    /** 读取属性值 */
    getData: () => any;
    /** 写入属性值 */
    setData: (v: any) => void;
    /** slot ID 生成器 (Block 用 buildBlockSlotId, Operator 直接用 name) */
    buildSlotId: (propName: string) => string;
    /** 写同节点的其它属性（如 ShaderBlueprint 选好后联动写 shaderName）；可选 */
    siblingSet?: (propName: string, value: any) => void;
    /** 属性标签列宽度（默认 90）。宽节点（Context 输出节点）传更大值让长标签不截断。 */
    labelWidth?: number;
    /** 是否创建输入 slot */
    hasInputSlot?: boolean;
    /** 是否创建输出 slot */
    hasOutputSlot?: boolean;
    /** 检查某 slot 是否有连线 */
    isConnected?: (slotId: string) => boolean;
    /** 需要重建 UI 时的回调（会重建内容 + 全量刷新连线，用于拓扑可能变化的场景，如下拉切换 attribute） */
    onRebuild?: () => void;
    /** 展开/折叠、[L]/[W] 空间切换专用回调：只重建内容 + 增量重定位连线（不 dispose/重建连线 → 不闪）。
     *  这类操作不改变连接拓扑，只是行高/slot 位置变化。未提供时回退到 onRebuild。 */
    onExpandToggle?: () => void;
    /** 展开状态存储对象（读写 _expand_xxx 键） */
    expandState?: Record<string, any>;
    /** 是否为 spaceable 复合类型显示 [L]/[W] 切换按钮（仅 Block 属性行使用） */
    showSpaceToggle?: boolean;

    // ── 布局参数 ──
    /** 行起始 Y 坐标 */
    startY: number;
    /** 标签左边距 */
    labelX: number;
    /** 输入控件右边界 */
    inputRight: number;
    /** 容器宽度（用于 slot 定位） */
    containerWidth: number;
    /** 缩进层级（复合子行递增） */
    indent?: number;
}

// ─── VfxPropRow 结果 ─────────────────────────────────

/** 构建结果 */
export interface IVfxPropRowResult {
    /** 本行消耗的总高度（含子行） */
    height: number;
    /** 创建的输入 slots */
    inputSlots: VfxSlot[];
    /** 创建的输出 slots */
    outputSlots: VfxSlot[];
}

// ─── 主函数 ──────────────────────────────────────────

/**
 * 创建一个属性行（及其可展开的子行）。
 * Block 和 Operator 统一调用此函数。
 */
export function createPropRow(cfg: IVfxPropRowConfig): IVfxPropRowResult {
    const { propDef } = cfg;

    // flags 类型（bitmask 多选）
    if (propDef.type === "flags" && propDef.enumSource) {
        return _createFlagsRow(cfg);
    }

    // 有 enumSource → 下拉行
    if (propDef.enumSource) {
        return _createEnumRow(cfg);
    }

    // 枚举类型（space 等）→ 自动填充 enumSource
    const enumOptions = getEnumTypeOptions(propDef.type);
    if (enumOptions) {
        return _createEnumRow({ ...cfg, propDef: { ...propDef, enumSource: enumOptions } });
    }

    // 复合类型（vec/color/transform/sphere）
    const children = getCompositeChildren(propDef.type);
    if (children) {
        // 单 vec3 子属性的 spaceable 类型（position/direction/vector）→ 扁平化为 vec3 行 + [L]/[W]
        if (children.length === 1 && isVecType(children[0].type) && isSpaceableType(propDef.type)) {
            return _createSpaceableVecRow(cfg, children[0]);
        }
        if (isVecType(propDef.type)) {
            return _createVecRow(cfg, children);
        }
        return _createCompositeRow(cfg, children);
    }

    // 基础类型
    switch (propDef.type) {
        case "number":
        case "float":
        case "int":
        case "uint":
            return _createNumericRow(cfg);
        case "boolean":
            return _createBooleanRow(cfg);
        case "string":
            return _createStringRow(cfg);
        case "curve":
        case "Curve":
            return _createLabelOnlyRow(cfg);
        case "Mesh":
        case "Material":
        case "Texture2D":
        case "Texture3D":
        case "Texture2DArray":
        case "TextureCube":
            return _createAssetRow(cfg);
        case "ShaderBlueprint":
            // 蓝图(.bps)引用：显示蓝图文件名(对齐 Unity 的名字引用)，选择器过滤 .bps，
            // 存储保留 res://uuid 形式(runtime 用 loader.load 加载，必须是可加载 URL)。
            return _createAssetRow(cfg, { assetType: "ShaderBlueprint", keepResPrefix: true, syncShaderName: true });
        default:
            return _createNumericRow(cfg);
    }
}

/**
 * 预计算属性行高度（不创建 UI，用于布局预算）。
 */
export function calcPropRowHeight(
    propDef: IVfxPropDef,
    expandState: Record<string, boolean>,
    isConnected?: (slotId: string) => boolean,
    slotIdPrefix?: string,
): number {
    // 主 slot 有连线时只占一行（不展开）
    const slotId = slotIdPrefix ? slotIdPrefix + propDef.name : propDef.name;
    if (isConnected?.(slotId)) return ROW_HEIGHT;

    const children = getCompositeChildren(propDef.type);
    if (!children) return ROW_HEIGHT;

    // 单 vec3 spaceable 类型（position/direction/vector）→ 按 vec3 计算
    if (children.length === 1 && isVecType(children[0].type) && isSpaceableType(propDef.type)) {
        const vecChildren = getCompositeChildren(children[0].type);
        if (vecChildren) {
            let h = ROW_HEIGHT;
            const expanded = !!expandState["_expand_" + propDef.name];
            if (expanded) {
                h += vecChildren.length * COMP_ROW_HEIGHT;
            } else if (isConnected) {
                for (const child of vecChildren) {
                    const childSlotId = slotIdPrefix ? slotIdPrefix + propDef.name + "_" + child.name : propDef.name + "_" + child.name;
                    if (isConnected(childSlotId)) h += COMP_ROW_HEIGHT;
                }
            }
            return h;
        }
    }

    let h = ROW_HEIGHT; // 主行

    if (isVecType(propDef.type)) {
        // 向量：展开后每个分量一行
        const expanded = !!expandState["_expand_" + propDef.name];
        if (expanded) {
            h += children.length * COMP_ROW_HEIGHT;
        } else {
            // 收起时仍显示有连线的分量行
            if (isConnected) {
                for (const child of children) {
                    const childSlotId = slotIdPrefix ? slotIdPrefix + propDef.name + "_" + child.name : propDef.name + "_" + child.name;
                    if (isConnected(childSlotId)) h += COMP_ROW_HEIGHT;
                }
            }
        }
    } else {
        // 复合类型（transform/sphere）：展开后递归
        const expanded = !!expandState["_expand_" + propDef.name];
        if (expanded) {
            for (const child of children) {
                h += calcPropRowHeight(child, expandState, isConnected, slotIdPrefix ? slotIdPrefix + propDef.name + "_" : propDef.name + "_");
            }
        }
    }

    return h;
}

// ─── 内部：数值行 ────────────────────────────────────

function _createNumericRow(cfg: IVfxPropRowConfig): IVfxPropRowResult {
    const { propDef, parent, startY, labelX, inputRight, containerWidth } = cfg;
    const result: IVfxPropRowResult = { height: ROW_HEIGHT, inputSlots: [], outputSlots: [] };

    // 标签
    _addLabel(parent, propDef.caption ?? propDef.name, labelX, startY, undefined, cfg.labelWidth);

    // 输入 slot
    if (cfg.hasInputSlot) {
        _addInputSlot(cfg, propDef, startY, result);
    }

    // 输出 slot
    if (cfg.hasOutputSlot) {
        _addOutputSlot(cfg, propDef, startY, result);
    }

    // 编辑器（有连线时隐藏）
    const slotId = cfg.buildSlotId(propDef.name);
    if (!cfg.isConnected?.(slotId)) {
        const isInt = propDef.type === "int" || propDef.type === "uint";
        // 宽节点(Context)：数值框填满值列(左缘对齐值列起点)，对齐 Unity；否则固定 70。
        const w = cfg.labelWidth ? (inputRight - (labelX + cfg.labelWidth + 4)) : 70;
        const input = createNumericInput(parent, inputRight - w, startY + 2, w, 20);
        input.value = cfg.getData() ?? propDef.default ?? 0;
        if (propDef.min != null) input.min = propDef.min;
        if (propDef.max != null) input.max = propDef.max;
        if (propDef.step != null) input.step = propDef.step;
        if (isInt) { input.step = 1; input.fractionDigits = 0; }
        input.on("submit", () => { cfg.setData(input.value); });
    }

    return result;
}

// ─── 内部：字符串行 ─────────────────────────────────
//   不带 enumSource 的纯 string 类型 → TextInput 文本输入
//   带 enumSource 的 string 走上面的 _createEnumRow（已有处理）

function _createStringRow(cfg: IVfxPropRowConfig): IVfxPropRowResult {
    const { propDef, parent, startY, labelX, inputRight } = cfg;
    const result: IVfxPropRowResult = { height: ROW_HEIGHT, inputSlots: [], outputSlots: [] };

    _addLabel(parent, propDef.caption ?? propDef.name, labelX, startY, undefined, cfg.labelWidth);

    if (cfg.hasInputSlot) _addInputSlot(cfg, propDef, startY, result);
    if (cfg.hasOutputSlot) _addOutputSlot(cfg, propDef, startY, result);

    const slotId = cfg.buildSlotId(propDef.name);
    if (!cfg.isConnected?.(slotId)) {
        const w = cfg.labelWidth ? (inputRight - (labelX + cfg.labelWidth + 4)) : 110;
        const input = gui.UIPackage.createWidgetSync("~/ui/basic/Input/TextInput.widget") as gui.TextInput;
        input.setPos(inputRight - w, startY + 2);
        input.setSize(w, 20);
        // 阻止 pointer_down 冒泡，防止父容器抢走拖拽
        input.on("pointer_down", (e: gui.Event) => { e.stopPropagation(); });
        const cur = cfg.getData();
        input.text = (cur != null ? String(cur) : (propDef.default != null ? String(propDef.default) : ""));
        // submit 事件触发：回车确认或失去焦点
        input.on("submit", () => { cfg.setData(input.text); });
        input.on("focus_out", () => { cfg.setData(input.text); });
        parent.addChild(input);
    }

    return result;
}

// ─── 内部：布尔行 ────────────────────────────────────

function _createBooleanRow(cfg: IVfxPropRowConfig): IVfxPropRowResult {
    const { propDef, parent, startY, labelX } = cfg;
    const result: IVfxPropRowResult = { height: ROW_HEIGHT, inputSlots: [], outputSlots: [] };

    _addLabel(parent, propDef.caption ?? propDef.name, labelX, startY, undefined, cfg.labelWidth);

    if (cfg.hasInputSlot) _addInputSlot(cfg, propDef, startY, result);
    if (cfg.hasOutputSlot) _addOutputSlot(cfg, propDef, startY, result);

    const slotId = cfg.buildSlotId(propDef.name);
    if (!cfg.isConnected?.(slotId)) {
        const cb = gui.UIPackage.createWidgetSync("~/ui/basic/Button/Checkbox_as.widget") as gui.Button;
        cb.mode = gui.ButtonMode.Check;
        cb.title = "";
        cb.selected = !!cfg.getData();
        cb.setPos(cfg.inputRight - 30, startY + 2);
        cb.setSize(20, 20);
        parent.addChild(cb);
        // bool 值可能驱动其它行的 hidden 条件(如 useAlphaClipping)→ 显式 onRebuild 刷新可见性。
        // (纯标量输入不调 onRebuild，靠 runFieldEdit 守卫避免整块重建闪烁；bool 是结构性变更，单次重建可接受)
        cb.on("changed", () => { cfg.setData(cb.selected); cfg.onRebuild?.(); });
    }

    return result;
}

// ─── 内部：仅标签行（curve 等纯 slot 类型）─────────────

function _createLabelOnlyRow(cfg: IVfxPropRowConfig): IVfxPropRowResult {
    const { propDef, parent, startY, labelX } = cfg;
    const result: IVfxPropRowResult = { height: ROW_HEIGHT, inputSlots: [], outputSlots: [] };

    _addLabel(parent, propDef.caption ?? propDef.name, labelX, startY, undefined, cfg.labelWidth);

    if (cfg.hasInputSlot) _addInputSlot(cfg, propDef, startY, result);
    if (cfg.hasOutputSlot) _addOutputSlot(cfg, propDef, startY, result);

    return result;
}

// ─── 内部：枚举行 ────────────────────────────────────

function _createEnumRow(cfg: IVfxPropRowConfig): IVfxPropRowResult {
    const { propDef, parent, startY, labelX, inputRight } = cfg;
    const result: IVfxPropRowResult = { height: ROW_HEIGHT, inputSlots: [], outputSlots: [] };
    const options = propDef.enumSource!;
    // 宽节点(Context)：下拉框填满值列，对齐 Unity；否则固定 120。
    const dropW = cfg.labelWidth ? (inputRight - (labelX + cfg.labelWidth + 4)) : 120;

    _addLabel(parent, propDef.caption ?? propDef.name, labelX, startY, undefined, cfg.labelWidth);

    // 下拉背景
    const dropBg = new gui.Shape();
    dropBg.setPos(inputRight - dropW, startY + 2);
    dropBg.setSize(dropW, 20);
    const gDrop = dropBg.getGraphics(gui.SRect);
    gDrop.borderRadius = [3, 3, 3, 3];
    gDrop.lineWidth = 0;
    gDrop.fillColor.parse("#2a2a2a");
    dropBg.touchable = true;
    parent.addChild(dropBg);

    // 值文字
    const valText = new gui.TextField();
    valText.text = String(cfg.getData() ?? propDef.default ?? options[0]);
    valText.style.fontSize = LABEL_FONT;
    valText.color = 0xDDDDDD;
    valText.setPos(6, 1);
    valText.setSize(dropW - 22, 18);
    dropBg.addChild(valText);

    // 下拉箭头
    const arrow = new gui.TextField();
    arrow.text = "\u25BC";
    arrow.style.fontSize = 9;
    arrow.color = 0x999999;
    arrow.setPos(dropW - 18, 2);
    arrow.setSize(14, 16);
    arrow.style.align = gui.AlignType.Right;
    dropBg.addChild(arrow);

    dropBg.on("pointer_down", (e: gui.Event) => {
        if (e.input.button !== 0) return;
        e.stopPropagation();
        const items = options.map(v => ({
            label: v,
            click: () => {
                cfg.setData(v);
                valText.text = v;
                cfg.onRebuild?.();
            },
        }));
        IEditor.Menu.create(items).show(cfg.stage);
    });

    return result;
}

// ─── 内部：flags 行（bitmask 多选） ─────────────────

function _createFlagsRow(cfg: IVfxPropRowConfig): IVfxPropRowResult {
    const { propDef, parent, startY, labelX, inputRight } = cfg;
    const result: IVfxPropRowResult = { height: ROW_HEIGHT, inputSlots: [], outputSlots: [] };
    const options = propDef.enumSource!;
    const dropW = 120;

    _addLabel(parent, propDef.caption ?? propDef.name, labelX, startY, undefined, cfg.labelWidth);

    // 下拉背景
    const dropBg = new gui.Shape();
    dropBg.setPos(inputRight - dropW, startY + 2);
    dropBg.setSize(dropW, 20);
    const gDrop = dropBg.getGraphics(gui.SRect);
    gDrop.borderRadius = [3, 3, 3, 3];
    gDrop.lineWidth = 0;
    gDrop.fillColor.parse("#2a2a2a");
    dropBg.touchable = true;
    parent.addChild(dropBg);

    // 值文字
    const valText = new gui.TextField();
    const updateText = (mask: number) => {
        const selected = options.filter((_, i) => mask & (1 << i));
        valText.text = selected.length === 0 ? "None" : selected.length === options.length ? "All" : selected.join(", ");
    };
    valText.style.fontSize = LABEL_FONT;
    valText.color = 0xDDDDDD;
    valText.setPos(6, 1);
    valText.setSize(dropW - 22, 18);
    dropBg.addChild(valText);
    updateText((cfg.getData() as number) ?? propDef.default ?? 0);

    // 下拉箭头
    const arrow = new gui.TextField();
    arrow.text = "\u25BC";
    arrow.style.fontSize = 9;
    arrow.color = 0x999999;
    arrow.setPos(dropW - 18, 2);
    arrow.setSize(14, 16);
    arrow.style.align = gui.AlignType.Right;
    dropBg.addChild(arrow);

    dropBg.on("pointer_down", (e: gui.Event) => {
        if (e.input.button !== 0) return;
        e.stopPropagation();
        let curMask = (cfg.getData() as number) ?? propDef.default ?? 0;
        const allMask = (1 << options.length) - 1;
        const items: any[] = [
            { label: "None", click: () => { cfg.setData(0); updateText(0); } },
            { label: "All", click: () => { cfg.setData(allMask); updateText(allMask); } },
            { type: "separator" },
            ...options.map((v, i) => ({
                label: v,
                type: "checkbox" as const,
                checked: !!(curMask & (1 << i)),
                click: () => {
                    curMask = (cfg.getData() as number) ?? 0;
                    curMask ^= (1 << i);
                    cfg.setData(curMask);
                    updateText(curMask);
                },
            })),
        ];
        IEditor.Menu.create(items).show(cfg.stage);
    });

    return result;
}

// ─── 内部：向量行（水平分量 + 可展开子行） ──────────

function _createVecRow(cfg: IVfxPropRowConfig, childDefs: IVfxPropDef[]): IVfxPropRowResult {
    const { propDef, parent, startY, labelX, inputRight, containerWidth } = cfg;
    const result: IVfxPropRowResult = { height: ROW_HEIGHT, inputSlots: [], outputSlots: [] };
    const vecCfg = VEC_CONFIGS[propDef.type];
    if (!vecCfg) return result;

    const mainSlotId = cfg.buildSlotId(propDef.name);
    const mainConnected = cfg.isConnected?.(mainSlotId) ?? false;

    // 输入 slot
    if (cfg.hasInputSlot) _addInputSlot(cfg, propDef, startY, result);
    if (cfg.hasOutputSlot) _addOutputSlot(cfg, propDef, startY, result);

    // 展开状态
    const expandKey = "_expand_" + propDef.name;
    const expanded = !!cfg.expandState?.[expandKey];

    // 展开箭头
    if (childDefs.length > 0) {
        _addExpandArrow(parent, labelX, startY, expanded, () => {
            if (cfg.expandState) cfg.expandState[expandKey] = !cfg.expandState[expandKey];
            (cfg.onExpandToggle ?? cfg.onRebuild)?.();
        }, expandKey, cfg);
    }

    // 标签（展开箭头占 16px）
    const actualLabelX = childDefs.length > 0 ? labelX + 16 : labelX;
    _addLabel(parent, propDef.caption ?? propDef.name, actualLabelX, startY, undefined, cfg.labelWidth);

    // 主行水平分量编辑器（未连接时显示）
    if (!mainConnected) {
        const linkedComps = new Set<string>();
        for (const child of childDefs) {
            const childSlotId = cfg.buildSlotId(propDef.name + "_" + child.name);
            if (cfg.isConnected?.(childSlotId)) linkedComps.add(child.name);
        }

        const vals = cfg.getData() ?? {};
        // 宽节点(Context 传了 labelWidth)：按可用值区宽度加宽每个分量输入框，避免 x/y/z/w 显示不全。
        let fieldWOverride: number | undefined;
        if (cfg.labelWidth) {
            const count = vecCfg.labels.length;
            const avail = inputRight - labelX - cfg.labelWidth - 8;
            const fw = Math.floor(avail / count) - VEC_LABEL_W - VEC_GAP;
            fieldWOverride = Math.max(vecCfg.fieldW, Math.min(fw, 120));
        }
        createVecNumericFields(
            parent, propDef.type, inputRight, startY,
            (c) => vals[c] ?? 0,
            (c, v) => { const cur = cfg.getData() ?? {}; cur[c] = v; cfg.setData(cur); },
            { skipComps: linkedComps.size > 0 ? linkedComps : undefined, min: propDef.min, fieldW: fieldWOverride },
        );
    }

    // 展开的分量子行
    let subY = startY + ROW_HEIGHT;
    const visibleChildren = _getVisibleChildren(childDefs, expanded, cfg, propDef.name);
    for (const child of visibleChildren) {
        const childSlotId = cfg.buildSlotId(propDef.name + "_" + child.name);
        const childConnected = cfg.isConnected?.(childSlotId) ?? false;

        // 子行输入 slot
        if (cfg.hasInputSlot) {
            const slotDef = { id: child.name, name: child.caption ?? child.name, type: child.slotType || "float" };
            const compositeId = cfg.buildSlotId(propDef.name + "_" + child.name);
            const slot = new VfxSlot(slotDef, true, cfg.nodeId, cfg.stage, compositeId);
            const slotUI = slot.createUI(24, false, true);
            slotUI.setPos(-11, subY);
            parent.addChild(slotUI);
            result.inputSlots.push(slot);
        }

        // 子行标签
        _addLabel(parent, (child.caption ?? child.name).toUpperCase(), labelX + 16, subY, COMP_LABEL_COLOR);

        // 子行输入框（主行或子行有连线时隐藏）
        if (!mainConnected && !childConnected) {
            const vals = cfg.getData() ?? {};
            const input = createNumericInput(parent, inputRight - 70, subY + 2, 70, 20);
            input.value = vals[child.name] ?? child.default ?? 0;
            const cn = child.name;
            input.on("submit", () => {
                const cur = cfg.getData() ?? {};
                cur[cn] = input.value;
                cfg.setData(cur);
            });
        }

        subY += COMP_ROW_HEIGHT;
        result.height += COMP_ROW_HEIGHT;
    }

    return result;
}

// ─── 内部：复合类型行（transform/sphere 等） ────────

function _createCompositeRow(cfg: IVfxPropRowConfig, childDefs: IVfxPropDef[]): IVfxPropRowResult {
    const { propDef, parent, startY, labelX } = cfg;
    const result: IVfxPropRowResult = { height: ROW_HEIGHT, inputSlots: [], outputSlots: [] };

    const mainSlotId = cfg.buildSlotId(propDef.name);
    const mainConnected = cfg.isConnected?.(mainSlotId) ?? false;

    // 输入 slot
    if (cfg.hasInputSlot) _addInputSlot(cfg, propDef, startY, result);
    if (cfg.hasOutputSlot) _addOutputSlot(cfg, propDef, startY, result);

    // 展开状态
    const expandKey = "_expand_" + propDef.name;
    const expanded = !!cfg.expandState?.[expandKey];

    // 展开箭头
    _addExpandArrow(parent, labelX, startY, expanded, () => {
        if (cfg.expandState) cfg.expandState[expandKey] = !cfg.expandState[expandKey];
        cfg.onRebuild?.();
    }, expandKey, cfg);

    // 标签
    _addLabel(parent, propDef.caption ?? propDef.name, labelX + 16, startY, undefined, cfg.labelWidth);

    // [L]/[W] 空间切换按钮（spaceable 复合类型，仅顶层 block 属性行）
    if (cfg.showSpaceToggle && (cfg.indent || 0) === 0 && isSpaceableType(propDef.type) && cfg.expandState) {
        const spaceKey = "_space_" + propDef.name;
        const curSpace = (cfg.expandState[spaceKey] as string) || "Local";
        const isWorld = curSpace === "World";

        const spaceBtn = new gui.Shape();
        spaceBtn.setPos(cfg.inputRight - 30, startY + 3);
        spaceBtn.setSize(22, 18);
        const gSpace = spaceBtn.getGraphics(gui.SRect);
        gSpace.borderRadius = [3, 3, 3, 3];
        gSpace.lineWidth = 0;
        gSpace.fillColor.parse(isWorld ? "#c67030" : "#3070c0");
        spaceBtn.touchable = true;
        parent.addChild(spaceBtn);

        const spaceLbl = new gui.TextField();
        spaceLbl.text = isWorld ? "W" : "L";
        spaceLbl.style.fontSize = 10;
        spaceLbl.style.bold = true;
        spaceLbl.color = 0xFFFFFF;
        spaceLbl.setPos(0, 1);
        spaceLbl.setSize(22, 16);
        spaceLbl.style.align = gui.AlignType.Center;
        spaceBtn.addChild(spaceLbl);

        spaceBtn.on("pointer_down", (e: gui.Event) => {
            if (e.input.button !== 0) return;
            e.stopPropagation();
            cfg.expandState![spaceKey] = isWorld ? "Local" : "World";
            (cfg.onExpandToggle ?? cfg.onRebuild)?.();
        });
    }

    // 展开时递归创建子行（主 slot 未连线时）
    if (!mainConnected && expanded) {
        let subY = startY + ROW_HEIGHT;
        const indent = (cfg.indent || 0) + 1;
        const subLabelX = labelX + 12;

        for (const child of childDefs) {
            const childResult = createPropRow({
                ...cfg,
                propDef: child,
                startY: subY,
                labelX: subLabelX,
                indent,
                getData: () => {
                    const parentVal = cfg.getData() ?? {};
                    return parentVal[child.name];
                },
                setData: (v: any) => {
                    const parentVal = cfg.getData() ?? {};
                    parentVal[child.name] = v;
                    cfg.setData(parentVal);
                },
                buildSlotId: (name: string) => cfg.buildSlotId(propDef.name + "_" + name),
            });

            result.inputSlots.push(...childResult.inputSlots);
            result.outputSlots.push(...childResult.outputSlots);
            subY += childResult.height;
            result.height += childResult.height;
        }
    }

    return result;
}

// ─── 内部：单 vec3 spaceable 行（position/direction/vector） ──

const SPACE_BTN_W = 22;
const SPACE_BTN_GAP = 4;

/**
 * 将 position/direction/vector 等单子属性 spaceable 类型扁平化为
 * vec3 行 + [L]/[W] 空间切换按钮，避免嵌套两层。
 * [L]/[W] 按钮占据最右侧位置，vec 分量输入框使用 vec4 的窄宽度。
 */
function _createSpaceableVecRow(cfg: IVfxPropRowConfig, childDef: IVfxPropDef): IVfxPropRowResult {
    const { propDef, parent, startY } = cfg;
    const childName = childDef.name;
    const vecChildren = getCompositeChildren(childDef.type);
    if (!vecChildren) return { height: ROW_HEIGHT, inputSlots: [], outputSlots: [] };

    // 缩减 inputRight，为 [L]/[W] 按钮留出空间
    const showSpace = cfg.showSpaceToggle && (cfg.indent || 0) === 0;
    const adjustedRight = showSpace ? cfg.inputRight - SPACE_BTN_W - SPACE_BTN_GAP : cfg.inputRight;

    // 代理数据访问到子属性层级
    const vecCfg: IVfxPropRowConfig = {
        ...cfg,
        propDef: { ...childDef, caption: propDef.caption ?? propDef.name, name: propDef.name },
        inputRight: adjustedRight,
        getData: () => {
            const parentVal = cfg.getData() ?? {};
            return parentVal[childName] ?? parentVal;
        },
        setData: (v: any) => {
            const parentVal = cfg.getData() ?? {};
            parentVal[childName] = v;
            cfg.setData(parentVal);
        },
    };

    const result = _createVecRow(vecCfg, vecChildren);

    // [L]/[W] 空间切换按钮（最右侧）
    if (showSpace && cfg.expandState) {
        const spaceKey = "_space_" + propDef.name;
        const curSpace = (cfg.expandState[spaceKey] as string) || "Local";
        const isWorld = curSpace === "World";

        const spaceBtn = new gui.Shape();
        spaceBtn.setPos(cfg.inputRight - SPACE_BTN_W, startY + 3);
        spaceBtn.setSize(SPACE_BTN_W, 18);
        const gSpace = spaceBtn.getGraphics(gui.SRect);
        gSpace.borderRadius = [3, 3, 3, 3];
        gSpace.lineWidth = 0;
        gSpace.fillColor.parse(isWorld ? "#c67030" : "#3070c0");
        spaceBtn.touchable = true;
        parent.addChild(spaceBtn);

        const spaceLbl = new gui.TextField();
        spaceLbl.text = isWorld ? "W" : "L";
        spaceLbl.style.fontSize = 10;
        spaceLbl.style.bold = true;
        spaceLbl.color = 0xFFFFFF;
        spaceLbl.setPos(0, 1);
        spaceLbl.setSize(SPACE_BTN_W, 16);
        spaceLbl.style.align = gui.AlignType.Center;
        spaceBtn.addChild(spaceLbl);

        spaceBtn.on("pointer_down", (e: gui.Event) => {
            if (e.input.button !== 0) return;
            e.stopPropagation();
            cfg.expandState![spaceKey] = isWorld ? "Local" : "World";
            (cfg.onExpandToggle ?? cfg.onRebuild)?.();
        });
    }

    return result;
}

// ─── 内部：资源行 ────────────────────────────────────

function _createAssetRow(cfg: IVfxPropRowConfig, opts?: { assetType?: string; keepResPrefix?: boolean; syncShaderName?: boolean }): IVfxPropRowResult {
    const { propDef, parent, startY, labelX, inputRight, containerWidth } = cfg;
    const result: IVfxPropRowResult = { height: ROW_HEIGHT, inputSlots: [], outputSlots: [] };

    // 把存储值（可能是 "res://uuid" / "res://uuid@lmN" / 裸 uuid）归一化成裸 uuid，用于 assetDb 查询显示名。
    const toBareUuid = (v: string): string => {
        if (!v) return "";
        let u = v.startsWith("res://") ? v.slice("res://".length) : v;
        const at = u.indexOf("@");
        if (at >= 0) u = u.slice(0, at);
        return u;
    };

    _addLabel(parent, propDef.caption ?? propDef.name, labelX, startY, undefined, cfg.labelWidth);

    if (cfg.hasInputSlot) _addInputSlot(cfg, propDef, startY, result);
    if (cfg.hasOutputSlot) _addOutputSlot(cfg, propDef, startY, result);

    const slotId = cfg.buildSlotId(propDef.name);
    if (!cfg.isConnected?.(slotId)) {
        const valueX = labelX + (cfg.labelWidth ?? 90) + 4;
        const vbW = inputRight - valueX;

        // 值背景（圆角深色条）
        const valueBg = new gui.Shape();
        valueBg.setSize(vbW, 18);
        valueBg.setPos(valueX, startY + 3);
        const gVb = valueBg.getGraphics(gui.SRect);
        gVb.borderRadius = [3, 3, 3, 3];
        gVb.lineWidth = 0;
        gVb.fillColor.parse("#2a2a2a");
        valueBg.touchable = true;
        parent.addChild(valueBg);

        // 资源名称
        const valueLabel = new gui.TextField();
        valueLabel.style.fontSize = LABEL_FONT;
        valueLabel.color = 0xFFFFFF;
        valueLabel.setPos(6, 1);
        valueLabel.setSize(vbW - 24, 16);
        valueBg.addChild(valueLabel);

        // 下拉箭头
        const arrow = new gui.TextField();
        arrow.text = "\u25BC";
        arrow.style.fontSize = 8;
        arrow.color = 0x999999;
        arrow.setPos(vbW - 16, 2);
        arrow.setSize(12, 14);
        arrow.style.align = gui.AlignType.Right;
        valueBg.addChild(arrow);

        // 显示当前资源名。ShaderBlueprint(keepResPrefix) 时把 res://uuid 归一化成裸 uuid 再查（.bps 无子资源）；
        // mesh/纹理保持原逻辑（可能带 @lmN 子资源，直接交给 assetDb 解析出子资源名）。
        const curId = cfg.getData() as string || "";
        const updateLabel = async (rawVal: string) => {
            const lookup = opts?.keepResPrefix ? toBareUuid(rawVal) : rawVal;
            if (!lookup) { valueLabel.text = "None"; return; }
            try {
                const info = await (Editor as any).assetDb.getAsset(lookup);
                valueLabel.text = info ? info.fileName : lookup;
            } catch { valueLabel.text = lookup; }
        };
        updateLabel(curId);

        // 点击打开资源选择对话框
        const assetType = opts?.assetType ?? propDef.type;
        valueBg.on("pointer_down", async (e: gui.Event) => {
            if (e.input.button !== 0) return;
            e.stopPropagation();
            const curVal = cfg.getData() as string || undefined;
            const dlg = await (Editor as any).getDialog(IEditor.SelectResourceDialog);
            dlg.show(valueBg, curVal, [assetType], true);
            dlg.contentPane.on("submit", (evt: gui.Event) => {
                const asset = evt.data;
                if (asset) {
                    // keepResPrefix：runtime 需可加载 URL（loader.load），存成 res://uuid；
                    // asset.id 若已是 res:// 形式则原样保留。
                    let stored = asset.id as string;
                    if (opts?.keepResPrefix && stored && !stored.startsWith("res://")) stored = "res://" + stored;
                    cfg.setData(stored);
                    updateLabel(stored);
                    // ShaderBlueprint：选好蓝图后把同节点隐藏的 shaderName 联动成 .bps 文件名（去扩展），
                    // build/runtime 仍读 shaderName，UI 上只暴露这一个 Shader Graph 选择器（对齐 Unity）。
                    if (opts?.keepResPrefix && opts.syncShaderName && cfg.siblingSet) {
                        (async () => {
                            let nm = (asset.fileName as string) || "";
                            if (!nm) { try { const info = await (Editor as any).assetDb.getAsset(toBareUuid(stored)); nm = info ? info.fileName : ""; } catch { } }
                            nm = (nm || "").replace(/\.bps$/i, "");
                            if (nm) cfg.siblingSet!("shaderName", nm);
                        })();
                    }
                }
            });
        }, cfg);
    }

    return result;
}

// ─── 公共辅助 ────────────────────────────────────────

/** 创建 NumericInput（IDE 标准拖拽数值输入） */
export function createNumericInput(parent: gui.Widget, x: number, y: number, w: number, h: number): NumericInput {
    const input = gui.UIPackage.createWidgetSync("~/ui/basic/Input/NumericInput.widget") as NumericInput;
    input.setPos(x, y);
    input.setSize(w, h);
    // 禁用 pointerLock，避免嵌套容器中 drag_end 无法触发
    input.enablePointerLock = false;
    // 阻止冒泡，防止父容器（Block/Node）的 capturePointer 抢走拖拽事件
    input.on("pointer_down", (e: gui.Event) => { e.stopPropagation(); });
    parent.addChild(input);
    return input;
}

/**
 * 创建水平排列的向量分量 NumericInput 编辑器。
 * Block 属性行和 Operator inline 共用。
 */
export function createVecNumericFields(
    parent: gui.Widget,
    vecType: string,
    inputRight: number,
    rowY: number,
    getValue: (comp: string) => number,
    setValue: (comp: string, v: number) => void,
    options?: { skipComps?: Set<string>; min?: number; fieldW?: number },
): NumericInput[] {
    const cfg = VEC_CONFIGS[vecType];
    if (!cfg) return [];
    const { labels } = cfg;
    const fieldW = options?.fieldW ?? cfg.fieldW;
    const count = labels.length;
    const cellW = VEC_LABEL_W + fieldW + VEC_GAP;
    const inputs: NumericInput[] = [];

    for (let i = 0; i < count; i++) {
        const comp = labels[i];
        const cellX = inputRight - (count - i) * cellW;

        const fLabel = new gui.TextField();
        fLabel.text = comp;
        fLabel.style.fontSize = COMP_LABEL_FONT;
        fLabel.color = COMP_LABEL_COLOR;
        fLabel.setPos(cellX, rowY + 5);
        fLabel.setSize(VEC_LABEL_W, 16);
        parent.addChild(fLabel);

        if (options?.skipComps?.has(comp)) continue;

        const input = createNumericInput(parent, cellX + VEC_LABEL_W, rowY + 2, fieldW, 20);
        input.value = getValue(comp);
        if (options?.min != null) input.min = options.min;
        const c = comp;
        input.on("submit", () => { setValue(c, input.value); });
        inputs.push(input);
    }
    return inputs;
}

/** 添加文字标签 */
function _addLabel(parent: gui.Widget, text: string, x: number, y: number, color: number = LABEL_COLOR, width: number = 90): gui.TextField | null {
    if (!text) return null;
    const lbl = new gui.TextField();
    lbl.text = text;
    lbl.style.fontSize = LABEL_FONT;
    lbl.color = color;
    lbl.setPos(x, y + 4);
    lbl.setSize(width, 18);
    parent.addChild(lbl);
    return lbl;
}

/** 添加展开/收起箭头 */
function _addExpandArrow(
    parent: gui.Widget,
    x: number, y: number,
    expanded: boolean,
    onToggle: () => void,
    expandKey: string,
    cfg: IVfxPropRowConfig,
): void {
    const btn = new gui.Shape();
    btn.setPos(x, y + 3);
    btn.setSize(16, 18);
    const g = btn.getGraphics(gui.SRect);
    g.borderRadius = [2, 2, 2, 2];
    g.lineWidth = 0;
    g.fillColor.parse("#00000000");
    btn.touchable = true;
    parent.addChild(btn);

    const arrow = new gui.TextField();
    arrow.text = expanded ? "\u25BC" : "\u25B6";
    arrow.style.fontSize = EXPAND_ARROW_FONT;
    arrow.color = EXPAND_ARROW_COLOR;
    arrow.setPos(2, 3);
    arrow.setSize(12, 12);
    btn.addChild(arrow);

    btn.on("pointer_down", (e: gui.Event) => {
        if (e.input.button !== 0) return;
        e.stopPropagation();
        onToggle();
    });
}

/** 添加输入 slot（左侧） */
function _addInputSlot(cfg: IVfxPropRowConfig, propDef: IVfxPropDef, y: number, result: IVfxPropRowResult): void {
    const slotType = propDef.slotType || propDef.type;
    const slotDef = { id: propDef.name, name: propDef.caption ?? propDef.name, type: slotType };
    const compositeId = cfg.buildSlotId(propDef.name);
    const slot = new VfxSlot(slotDef, true, cfg.nodeId, cfg.stage, compositeId);
    const slotUI = slot.createUI(24, false, true);
    slotUI.setPos(-11, y);
    cfg.parent.addChild(slotUI);
    result.inputSlots.push(slot);
}

/** 添加输出 slot（右侧） */
function _addOutputSlot(cfg: IVfxPropRowConfig, propDef: IVfxPropDef, y: number, result: IVfxPropRowResult): void {
    const slotType = propDef.slotType || propDef.type;
    const slotDef = { id: propDef.name, name: propDef.caption ?? propDef.name, type: slotType };
    const compositeId = cfg.buildSlotId(propDef.name);
    const slot = new VfxSlot(slotDef, false, cfg.nodeId, cfg.stage, compositeId);
    const slotUI = slot.createUI(cfg.containerWidth, undefined, true);
    slotUI.setPos(11, y);
    cfg.parent.addChild(slotUI);
    result.outputSlots.push(slot);
}

/** 获取可见子行（展开时全部，收起时只显示有连线的） */
function _getVisibleChildren(
    children: IVfxPropDef[],
    expanded: boolean,
    cfg: IVfxPropRowConfig,
    parentName: string,
): IVfxPropDef[] {
    if (expanded) return children;
    if (!cfg.isConnected) return [];
    return children.filter(child => {
        const childSlotId = cfg.buildSlotId(parentName + "_" + child.name);
        return cfg.isConnected!(childSlotId);
    });
}

/**
 * 计算向量水平分量编辑器所需宽度
 */
export function calcVecFieldsWidth(vecType: string): number {
    const cfg = VEC_CONFIGS[vecType];
    if (!cfg) return 0;
    return cfg.labels.length * (VEC_LABEL_W + cfg.fieldW + VEC_GAP);
}
