import type { IVfxOperatorData, IVfxOperatorTypeDef, IVfxSlotDef } from "../data/VfxTypes";
import { getAttributeType, getAttributeComponents, getPropertyOutputType, getPropertyComponents, isSpaceableType, TYPE_COMPONENTS } from "../data/VfxOperatorDefs";
import { VfxSlot } from "./VfxSlot";
import type { VfxStage } from "./VfxStage";
import { createPropRow, calcPropRowHeight, createNumericInput, createVecNumericFields, calcVecFieldsWidth, getCompositeChildren, type IVfxPropDef } from "./VfxPropRow";

/** 根据类型递归构建默认值对象 */
function buildTypeDefault(type: string): any {
    const children = getCompositeChildren(type);
    if (!children) return 0;
    const obj: any = {};
    for (const c of children) {
        obj[c.name] = c.default != null ? (typeof c.default === "object" ? JSON.parse(JSON.stringify(c.default)) : c.default) : buildTypeDefault(c.type);
    }
    return obj;
}

/**
 * Operator 节点 UI
 * 独立的数据计算节点，带输入/输出端口。
 */
export class VfxNode extends gui.Widget {
    public nodeData: IVfxOperatorData;
    public typeDef: IVfxOperatorTypeDef;

    private _stage: VfxStage;
    private _bg: gui.Shape;
    private _header: gui.Shape;
    private _titleLabel: gui.TextField;
    private _selectShape: gui.Shape;
    private _overSelectShape: gui.Shape;
    private _inputSlots: VfxSlot[] = [];
    private _outputSlots: VfxSlot[] = [];
    private _isSelected: boolean = false;

    private static _downXY: { x: number; y: number } | null = null;
    private _isMouseMoved: boolean = false;

    static NODE_WIDTH = 160;
    static NODE_WIDTH_WIDE = 240;
    static HEADER_HEIGHT = 28;
    static SLOT_HEIGHT = 24;
    static COMBO_HEIGHT = 26;
    static PROP_HEIGHT = 26;
    static OUT_COL_W = 36; // 右侧输出分量列宽度

    /** 计算向量内联字段所需宽度 */
    static _calcVecFieldsWidth(vecType: string): number {
        // VEC_LABEL_W(10) + fieldW + VEC_GAP(4) per component
        if (vecType === "vec2") return 2 * (10 + 50 + 4);  // 128
        if (vecType === "vec3") return 3 * (10 + 40 + 4);  // 162
        if (vecType === "vec4") return 4 * (10 + 32 + 4);  // 184
        return 0;
    }

    /** 递归查找属性类型（含复合子类型）中最宽的向量字段宽度 */
    static _getMaxNestedVecWidth(propType: string): number {
        const vecW = calcVecFieldsWidth(propType);
        if (vecW > 0) return vecW;
        const children = getCompositeChildren(propType);
        if (!children) return 0;
        let maxW = 0;
        for (const child of children) {
            maxW = Math.max(maxW, VfxNode._getMaxNestedVecWidth(child.type));
        }
        return maxW;
    }

    constructor() {
        super();
        this.on("pointer_down", this._onPointerDown, this);
    }

    get stage(): VfxStage {
        return this._stage;
    }

    get isSelected(): boolean {
        return this._isSelected;
    }

    setData(data: IVfxOperatorData, typeDef: IVfxOperatorTypeDef, stage: VfxStage): void {
        if (this.nodeData) {
            IEditor.DataWatcher.removeListener(this.nodeData, this._onDataChange, this);
        }
        this.nodeData = data;
        this.typeDef = typeDef;
        this._stage = stage;
        IEditor.DataWatcher.addListener(this.nodeData, this._onDataChange, this);
        this._buildUI();
    }

    // ---- 从 widget 模板构建节点 UI ----

    /** 公开重建入口，供 undo/redo 刷新 */
    rebuildUI(): void { this._buildUI(); }

    private _buildUI(): void {
        this.removeChildren();
        this._inputSlots.length = 0;
        this._outputSlots.length = 0;

        const hasSupportedTypes = this.typeDef.supportedTypes && this.typeDef.supportedTypes.length > 0;
        const isInline = this.typeDef.category === "Inline";
        const enumProps = (this.typeDef.properties || []).filter((p: any) => p.enumSource && !p.nodeHidden);
        const editableProps = (this.typeDef.properties || []).filter((p: any) => !p.enumSource && !p.nodeHidden);
        const comboRows = enumProps.length;

        // 宽度根据向量维度动态计算：左区(42) + 内联字段 + 输出列(OUT_COL_W)
        let W = VfxNode.NODE_WIDTH;
        {
            let maxVecW = 0;
            if (hasSupportedTypes) {
                maxVecW = VfxNode._calcVecFieldsWidth(this._getSelectedType());
            }
            if (isInline) {
                for (const prop of editableProps) {
                    maxVecW = Math.max(maxVecW, VfxNode._getMaxNestedVecWidth(prop.type as string));
                }
                // 复合类型展开时，分量编辑器也需要计算宽度
                const valInput = this.typeDef.inputs.find(i => i.id === "value");
                if (valInput) {
                    const comps = TYPE_COMPONENTS[valInput.type];
                    if (comps) {
                        for (const c of comps) {
                            maxVecW = Math.max(maxVecW, VfxNode._getMaxNestedVecWidth(c.type));
                        }
                    }
                }
            }
            // 普通 operator 节点（非 inline / 非 supportedTypes）的内联可编辑输入也需要字段宽度
            // （如 transformPosition 的 matrix:transform / position:vec3，对齐 Unity 节点内联编辑器）
            if (!isInline && !hasSupportedTypes) {
                for (const inp of this.typeDef.inputs) {
                    if (this._isInlineEditableType(inp.type)) {
                        maxVecW = Math.max(maxVecW, VfxNode._getMaxNestedVecWidth(inp.type));
                    }
                }
            }
            if (maxVecW > 0) {
                W = Math.max(VfxNode.NODE_WIDTH_WIDE, 42 + maxVecW + VfxNode.OUT_COL_W);
            }
        }

        // inline 复合节点：从 TYPE_COMPONENTS 获取分量定义
        const hasValueInput = isInline && this.typeDef.inputs.some(i => i.id === "value");
        const valueType = hasValueInput ? this.typeDef.inputs.find(i => i.id === "value")!.type : "";
        const typeComponents = hasValueInput ? (TYPE_COMPONENTS[valueType] || []) : [];
        const hasComponentInputs = typeComponents.length > 0;
        const valueConnected = hasValueInput && this._isInputSlotConnected("value");
        // 复合类型默认折叠分量，展开后显示；value 连接时强制折叠
        const componentsExpanded = hasComponentInputs && !valueConnected && !!this.nodeData.props?._expandComponents;

        // 从 TYPE_COMPONENTS 生成分量 slot 定义
        const componentInputDefs: IVfxSlotDef[] = typeComponents.map(c => ({ id: c.id, name: c.name, type: c.type }));
        let editablePropH = 0;
        if (isInline) {
            if (hasComponentInputs) {
                // 复合类型：value slot 行 + 展开时的分量属性行
                editablePropH = VfxNode.SLOT_HEIGHT;
                if (componentsExpanded) {
                    for (const comp of componentInputDefs) {
                        editablePropH += calcPropRowHeight(
                            { name: comp.id, caption: comp.name, type: comp.type } as IVfxPropDef,
                            this.nodeData.props || {},
                            (sid: string) => this._isInputSlotConnected(sid),
                        );
                    }
                }
            } else {
                // 非复合 inline 节点（Float/Int/Uint）：editable 属性通过 createPropRow 渲染
                for (const prop of editableProps) {
                    editablePropH += calcPropRowHeight(
                        prop as IVfxPropDef,
                        this.nodeData.props || {},
                        (sid: string) => this._isInputSlotConnected(sid),
                    );
                }
            }
        } else {
            for (const prop of editableProps) {
                editablePropH += this._getPropRowCount(prop) * VfxNode.PROP_HEIGHT;
            }
        }

        // 动态分量输出（getAttribute / getProperty / supportedTypes 向量类型）
        const componentSlots = this._getComponentSlots();
        const allOutputs = [...this.typeDef.outputs, ...componentSlots];

        // 有分量输出、supportedTypes、或 inline 标量节点时使用右侧独立列
        const hasOutCol = componentSlots.length > 0 || hasSupportedTypes || isInline;
        const outputExpanded = hasOutCol ? !!this.nodeData.props?._expandOutput : false;
        const outCompVisible = hasOutCol ? (outputExpanded ? componentSlots.length :
            componentSlots.filter(s => this._isOutputSlotConnected(s.id)).length) : 0;

        let H: number;
        if (isInline) {
            // inline 节点：属性行高度 vs 输出列高度取大值
            const outH = (1 + outCompVisible) * VfxNode.SLOT_HEIGHT;
            const bodyH = Math.max(editablePropH, outH);
            H = VfxNode.HEADER_HEIGHT + comboRows * VfxNode.COMBO_HEIGHT + bodyH + 16;
        } else if (hasSupportedTypes) {
            // 输入行数（独立计算）
            const curType0 = this._getSelectedType();
            const isVec0 = curType0 === "vec2" || curType0 === "vec3" || curType0 === "vec4";
            let inputRows = 0;
            for (const inp of this.typeDef.inputs) {
                inputRows += 1;
                if (isVec0) {
                    const vecComps = this._getVecCompIds(curType0);
                    const exp = !!this.nodeData.props?.[`_expand_${inp.id}`];
                    inputRows += this._getVisibleInputComps(inp.id, vecComps, exp).length;
                }
            }
            const slotsH = Math.max(inputRows, 1 + outCompVisible);
            H = VfxNode.HEADER_HEIGHT + comboRows * VfxNode.COMBO_HEIGHT + editablePropH + slotsH * VfxNode.SLOT_HEIGHT + 16;
        } else if (hasOutCol) {
            // getAttribute / getProperty / transformPosition 等有分量输出的节点
            // 输入列高度按内联可编辑输入（复合展开）实际占用计算
            const inputColH = this._calcOperatorInputColH();
            const outColH = (1 + outCompVisible) * VfxNode.SLOT_HEIGHT;
            H = VfxNode.HEADER_HEIGHT + comboRows * VfxNode.COMBO_HEIGHT + editablePropH + Math.max(inputColH, outColH) + 16;
        } else {
            const inputColH = this._calcOperatorInputColH();
            const outColH = allOutputs.length * VfxNode.SLOT_HEIGHT;
            H = VfxNode.HEADER_HEIGHT + comboRows * VfxNode.COMBO_HEIGHT + editablePropH + Math.max(inputColH, outColH) + 16;
        }
        this.setSize(W, H);

        // 从 widget 模板创建基础结构
        const tmpl = gui.UIPackage.createWidgetSync("editorResources/vfx/UI/VfxOperatorNode.widget");
        tmpl.setSize(W, H);

        // 提取命名子组件
        this._bg = tmpl.getChild("bg", gui.Shape);
        this._bg.setSize(W, H);

        this._header = tmpl.getChild("header", gui.Shape);
        this._header.setSize(W, VfxNode.HEADER_HEIGHT);
        const gHeader = this._header.getGraphics(gui.SRect);
        gHeader.fillColor.parse(this.typeDef.color);

        this._titleLabel = tmpl.getChild("title", gui.TextField);
        this._selectShape = tmpl.getChild("select", gui.Shape);
        this._selectShape.setSize(W + 4, H + 4);
        // hover 高亮：对齐 Unity 的醒目选中效果（细线框不明显）。
        // overSelect 在节点不透明背景之下，放大一圈 → 节点边缘外露出一圈琥珀色光晕 + 加粗亮边框，
        // 整体形成醒目高亮环，且不染色节点内容、无 z-order 风险。
        this._overSelectShape = tmpl.getChild("overSelect", gui.Shape);
        this._overSelectShape.setSize(W + 8, H + 8);
        this._overSelectShape.setPos(-4, -4);
        const gOver = this._overSelectShape.getGraphics(gui.SRect);
        gOver.lineWidth = 3;
        gOver.lineColor.parse("#FFB300");
        gOver.fillColor.parse("#FFB300");
        gOver.fillColor.a = 0.22;
        this._overSelectShape.visible = false;

        // 将模板子组件移动到当前节点
        while (tmpl.numChildren > 0) {
            this.addChild(tmpl.getChildAt(0));
        }

        // [L]/[W] 空间切换按钮（spaceable 输出类型的节点，getAttribute / getMainCamera 除外）
        const isSpaceable = this.typeDef.typeId !== "getAttribute"
            && this.typeDef.typeId !== "getMainCamera"
            && this.typeDef.outputs.some(o => isSpaceableType(o.type));
        if (isSpaceable) {
            if (!this.nodeData.props) this.nodeData.props = {};
            const curSpace = (this.nodeData.props._space as string) || "Local";
            const isWorld = curSpace === "World";
            const label = isWorld ? "W" : "L";

            const btn = new gui.Shape();
            btn.setSize(18, 18);
            btn.setPos(W - (hasSupportedTypes ? 50 : 24), 5);
            const gBtn = btn.getGraphics(gui.SRect);
            gBtn.borderRadius = [3, 3, 3, 3];
            gBtn.fillColor.parse(isWorld ? "#cc7722" : "#2266cc");
            gBtn.lineWidth = 0;
            btn.touchable = true;
            btn.cursor = "pointer";
            this.addChild(btn);

            const btnLabel = new gui.TextField();
            btnLabel.text = label;
            btnLabel.style.fontSize = 11;
            btnLabel.style.bold = true;
            btnLabel.color = 0xFFFFFF;
            btnLabel.style.align = gui.AlignType.Center;
            btnLabel.setPos(0, 1);
            btnLabel.setSize(18, 16);
            btn.addChild(btnLabel);

            btn.on("pointer_down", (e: gui.Event) => {
                if (e.input.button !== 0) return;
                e.stopPropagation();
                if (!this.nodeData.props) this.nodeData.props = {};
                this.nodeData.props._space = isWorld ? "Local" : "World";
                this._buildUI();
                this._stage.scheduleRefreshLines();
            }, this);
        }

        // supportedTypes: 标题含类型后缀 + 齿轮图标
        if (hasSupportedTypes) {
            const curType = this._getSelectedType();
            this._titleLabel.text = this._getDynamicTitle() + " (" + curType + ")";
            this._titleLabel.setSize(W - (isSpaceable ? 68 : 46), VfxNode.HEADER_HEIGHT);

            // 齿轮图标
            const gearBtn = new gui.TextField();
            gearBtn.text = "\u2699";
            gearBtn.style.fontSize = 14;
            gearBtn.color = 0xDDDDDD;
            gearBtn.setPos(W - 40, 5);
            gearBtn.setSize(18, 20);
            gearBtn.style.align = gui.AlignType.Center;
            gearBtn.touchable = true;
            gearBtn.cursor = "pointer";
            this.addChild(gearBtn);

            // 下拉箭头
            const arrow = new gui.TextField();
            arrow.text = "\u25BC";
            arrow.style.fontSize = 8;
            arrow.color = 0xDDDDDD;
            arrow.setPos(W - 24, 8);
            arrow.setSize(14, 14);
            arrow.touchable = true;
            arrow.cursor = "pointer";
            this.addChild(arrow);

            const showTypeMenu = (e: gui.Event) => {
                if (e.input.button !== 0) return;
                e.stopPropagation();
                const items = this.typeDef.supportedTypes!.map(t => ({
                    label: t,
                    click: () => {
                        if (!this.nodeData.props) this.nodeData.props = {};
                        this.nodeData.props._type = t;
                        this._buildUI();
                        this._stage.scheduleRefreshLines();
                    },
                }));
                IEditor.Menu.create(items).show(this._stage);
            };
            gearBtn.on("pointer_down", showTypeMenu, this);
            arrow.on("pointer_down", showTypeMenu, this);
        } else {
            this._titleLabel.text = this._getDynamicTitle();
            this._titleLabel.setSize(W - (isSpaceable ? 42 : 20), VfxNode.HEADER_HEIGHT);
        }

        // 动态内容从 slotContainer 下方开始
        let yOffset = VfxNode.HEADER_HEIGHT + 6;
        const PAD = 10;

        // 枚举属性行 + 可编辑属性行（统一使用 VfxPropRow）
        if (!this.nodeData.props) this.nodeData.props = {};

        // inline 复合节点：value 整体输入 slot + 展开/折叠箭头（仅复合类型）
        if (hasComponentInputs) {
            const valueDef = this.typeDef.inputs.find(i => i.id === "value")!;
            const slot = new VfxSlot(valueDef, true, this.nodeData.id, this._stage);
            const showExpandArrow = hasComponentInputs && !valueConnected;
            // 复合类型隐藏 slot 自带标签，手动绘制 ▶ + Value
            const ui = slot.createUI(W, undefined, showExpandArrow);
            ui.setPos(-11, yOffset);
            this.addChild(ui);
            this._inputSlots.push(slot);

            if (showExpandArrow) {
                // 展开/折叠箭头（slot 图标后方）
                const expandBtn = new gui.Shape();
                expandBtn.setPos(10, yOffset + 3);
                expandBtn.setSize(16, 18);
                const gExp = expandBtn.getGraphics(gui.SRect);
                gExp.borderRadius = [2, 2, 2, 2];
                gExp.lineWidth = 0;
                gExp.fillColor.parse("#00000000");
                expandBtn.touchable = true;
                expandBtn.cursor = "pointer";
                this.addChild(expandBtn);

                const expandArrow = new gui.TextField();
                expandArrow.text = componentsExpanded ? "\u25BC" : "\u25B6";
                expandArrow.style.fontSize = 8;
                expandArrow.color = 0xAAAAAA;
                expandArrow.setPos(2, 3);
                expandArrow.setSize(12, 12);
                expandBtn.addChild(expandArrow);

                expandBtn.on("pointer_down", (e: gui.Event) => {
                    if (e.input.button !== 0) return;
                    e.stopPropagation();
                    if (!this.nodeData.props) this.nodeData.props = {};
                    this.nodeData.props._expandComponents = !this.nodeData.props._expandComponents;
                    this._buildUI();
                    this._stage.scheduleRefreshLines();
                }, this);

                // 手动绘制 "Value" 标签（箭头右侧）
                const valLabel = new gui.TextField();
                valLabel.text = "Value";
                valLabel.style.fontSize = 12;
                valLabel.color = 0xCCCCCC;
                valLabel.touchable = false;
                valLabel.setPos(26, yOffset + 3);
                valLabel.setSize(80, 20);
                this.addChild(valLabel);
            }

            yOffset += VfxNode.SLOT_HEIGHT;
        }

        // 复合类型展开时：用 createPropRow 渲染分量（带编辑器 + input slot）
        if (componentsExpanded) {
            for (const comp of componentInputDefs) {
                const compName = comp.id;
                if (this.nodeData.props[compName] == null) {
                    this.nodeData.props[compName] = buildTypeDefault(comp.type);
                }
                const propDef: IVfxPropDef = { name: compName, caption: comp.name, type: comp.type };
                const rowResult = createPropRow({
                    propDef,
                    parent: this,
                    nodeId: this.nodeData.id,
                    stage: this._stage,
                    getData: () => this.nodeData.props![compName],
                    setData: (v: any) => { this.nodeData.props![compName] = v; },
                    buildSlotId: (name: string) => name,
                    hasInputSlot: true,
                    isConnected: (sid: string) => this._isInputSlotConnected(sid),
                    onRebuild: () => { this._buildUI(); this._stage.scheduleRefreshLines(); },
                    expandState: this.nodeData.props!,
                    startY: yOffset,
                    labelX: PAD,
                    inputRight: W - VfxNode.OUT_COL_W,
                    containerWidth: W,
                });
                this._inputSlots.push(...rowResult.inputSlots);
                this._outputSlots.push(...rowResult.outputSlots);
                yOffset += rowResult.height;
            }
        }

        // 非复合 inline / 非 inline 节点：属性行（复合类型由上方分量行处理）
        const showEditableProps = !hasComponentInputs;
        const allNodeProps = [...enumProps, ...(showEditableProps ? editableProps : [])];
        for (const prop of allNodeProps) {
            const propName = prop.name;
            if (this.nodeData.props[propName] == null) {
                this.nodeData.props[propName] = prop.default ?? ((prop as any).enumSource ? (prop as any).enumSource[0] : 0);
            }

            // inline 节点的 "value" 属性不显示标签（标题栏已表达类型）
            let propDef = prop as IVfxPropDef;
            if (isInline && propDef.name === "value") {
                propDef = { ...propDef, caption: "" };
            }

            const rowResult = createPropRow({
                propDef,
                parent: this,
                nodeId: this.nodeData.id,
                stage: this._stage,
                getData: () => this.nodeData.props![propName],
                setData: (v: any) => { this.nodeData.props![propName] = v; },
                buildSlotId: (name: string) => name,
                hasInputSlot: isInline ? true : undefined,
                isConnected: (sid: string) => this._isInputSlotConnected(sid),
                onRebuild: () => { this._buildUI(); this._stage.scheduleRefreshLines(); },
                expandState: this.nodeData.props!,
                startY: yOffset,
                labelX: PAD,
                inputRight: isInline ? W - VfxNode.OUT_COL_W : W - PAD,
                containerWidth: W,
            });
            this._inputSlots.push(...rowResult.inputSlots);
            this._outputSlots.push(...rowResult.outputSlots);
            yOffset += rowResult.height;
        }

        {
            if (isInline) {
                // inline 节点：输入 slot 已由 createPropRow 创建，只需渲染输出列
                const inlineOutStartY = VfxNode.HEADER_HEIGHT + comboRows * VfxNode.COMBO_HEIGHT + 6;
                const mainOutDef = this.typeDef.outputs.length > 0 ? this.typeDef.outputs[0] : null;
                this._buildOutputColumn(W, inlineOutStartY, mainOutDef, componentSlots, outputExpanded);
            } else {
            // 输入插槽（图标骑在左边框上）
            const resolvedType = hasSupportedTypes ? this._getSelectedType() : null;
            const isVecType = resolvedType && (resolvedType === "vec2" || resolvedType === "vec3" || resolvedType === "vec4");
            yOffset += 6;
            for (let slotDef of this.typeDef.inputs) {
                // 普通 operator 节点（非 supportedTypes）的内联可编辑输入：
                // 用 createPropRow 渲染 Unity 同款节点内联编辑器（复合类型可展开 + 自带 input slot）。
                // createPropRow 自己创建 slot，因此走此分支时不再创建裸 slot。
                if (!hasSupportedTypes && this._isInlineEditableType(slotDef.type)) {
                    yOffset = this._buildOperatorInputEditor(slotDef, yOffset, W, PAD, hasOutCol);
                    continue;
                }
                if (resolvedType) slotDef = { ...slotDef, type: resolvedType };
                const slot = new VfxSlot(slotDef, true, this.nodeData.id, this._stage);
                const ui = slot.createUI(W);
                ui.setPos(-11, yOffset);
                this.addChild(ui);
                this._inputSlots.push(slot);

                if (hasSupportedTypes && isVecType) {
                    yOffset = this._buildExpandableVecInput(slotDef, yOffset, W, PAD, resolvedType!);
                } else if (hasSupportedTypes) {
                    this._buildSlotDefaultInput(slotDef, yOffset, W);
                    yOffset += VfxNode.SLOT_HEIGHT;
                } else {
                    yOffset += VfxNode.SLOT_HEIGHT;
                }
            }

            // 输出插槽（图标骑在右边框上）
            if (this.typeDef.typeId === "getAttribute" && allOutputs.length > 0) {
                const attrName = (this.nodeData.props?.attribute as string) || "position";
                allOutputs[0] = { ...allOutputs[0], name: attrName.charAt(0).toUpperCase() + attrName.slice(1) };
            }
            if (this.typeDef.typeId === "getProperty" && allOutputs.length > 0) {
                const propName = (this.nodeData.props?.property as string) || "Property";
                const propType = this._getPropertyType();
                allOutputs[0] = { ...allOutputs[0], name: propName, type: getPropertyOutputType(propType) };
            }

            // 输出渲染：有分量时统一用右侧独立列
            {
                const outStartY = VfxNode.HEADER_HEIGHT + comboRows * VfxNode.COMBO_HEIGHT + editablePropH + 6;
                let mainOutDef = this.typeDef.outputs.length > 0 ? allOutputs[0] : null;
                if (mainOutDef && resolvedType && !mainOutDef.id.startsWith("out_")) {
                    mainOutDef = { ...mainOutDef, type: resolvedType };
                }
                if (hasOutCol) {
                    this._buildOutputColumn(W, outStartY, mainOutDef, componentSlots, outputExpanded);
                } else {
                    // 无分量的普通节点：平铺输出
                    let oy = outStartY;
                    for (let slotDef of allOutputs) {
                        if (resolvedType && !slotDef.id.startsWith("out_")) slotDef = { ...slotDef, type: resolvedType };
                        const slot = new VfxSlot(slotDef, false, this.nodeData.id, this._stage);
                        const ui = slot.createUI(W);
                        ui.setPos(11, oy);
                        this.addChild(ui);
                        this._outputSlots.push(slot);
                        oy += VfxNode.SLOT_HEIGHT;
                    }
                }
            }
            } // else !isInline
        }

        // 设置位置
        super.x = Math.floor(this.nodeData.uiData.x);
        super.y = Math.floor(this.nodeData.uiData.y);

        // 更新连接状态快照（供 checkAndRebuildIfConnectionChanged 比对）
        this._connectedSlotKeys = this._buildConnectionSnapshot();
    }

    /** supportedTypes 节点：为每个输入 slot 添加默认值输入框（有连接时隐藏） */
    private _buildSlotDefaultInput(slotDef: IVfxSlotDef, yOffset: number, W: number): void {
        if (this._isInputSlotConnected(slotDef.id)) return;

        if (!this.nodeData.props) this.nodeData.props = {};
        if (!this.nodeData.props._inputs) this.nodeData.props._inputs = {};
        const inputs = this.nodeData.props._inputs as Record<string, any>;
        const slotId = slotDef.id;
        const inputRight = W - VfxNode.OUT_COL_W;

        const curType = this._getSelectedType();
        if (curType === "vec2" || curType === "vec3" || curType === "vec4") {
            const comps = curType === "vec2" ? ["x", "y"] : curType === "vec3" ? ["x", "y", "z"] : ["x", "y", "z", "w"];
            const old = inputs[slotId];
            if (old == null || typeof old !== "object") {
                const scalar = typeof old === "number" ? old : 0;
                inputs[slotId] = {};
                for (const c of comps) inputs[slotId][c] = scalar;
            } else {
                const newVals: Record<string, number> = {};
                for (const c of comps) newVals[c] = (old as Record<string, number>)[c] ?? 0;
                inputs[slotId] = newVals;
            }
            const vals = inputs[slotId] as Record<string, number>;

            createVecNumericFields(
                this, curType, inputRight, yOffset,
                (c: string) => vals[c] ?? 0,
                (c: string, v: number) => { vals[c] = v; },
            );
        } else {
            const old = inputs[slotId];
            if (old == null || typeof old === "object") {
                inputs[slotId] = typeof old === "object" && old !== null ? ((old as Record<string, number>).x ?? 0) : 0;
            }
            const isInt = curType === "int" || curType === "uint";

            const input = createNumericInput(this, inputRight - 70, yOffset + 2, 70, 20);
            input.value = inputs[slotId] as number;
            if (isInt) { input.step = 1; input.fractionDigits = 0; }
            if (curType === "uint") input.min = 0;
            input.on("submit", () => { inputs[slotId] = input.value; });
        }
    }

    /** supportedTypes + 向量类型：可展开分量输入（仅输入侧，输出由 _buildOutputColumn 统一渲染） */
    private _buildExpandableVecInput(slotDef: IVfxSlotDef, yOffset: number, W: number, PAD: number, vecType: string): number {
        const mainConnected = this._isInputSlotConnected(slotDef.id);
        const comps = this._getVecCompIds(vecType);
        const expandKey = `_expand_${slotDef.id}`;
        const expanded = !!this.nodeData.props?.[expandKey];
        const inputRight = W - VfxNode.OUT_COL_W;

        // 展开/收起箭头
        if (comps.length > 0) {
            const expandBtn = new gui.Shape();
            expandBtn.setPos(24, yOffset + 3);
            expandBtn.setSize(16, 18);
            const gExp = expandBtn.getGraphics(gui.SRect);
            gExp.borderRadius = [2, 2, 2, 2];
            gExp.lineWidth = 0;
            gExp.fillColor.parse("#00000000");
            expandBtn.touchable = true;
            this.addChild(expandBtn);

            const expandArrow = new gui.TextField();
            expandArrow.text = expanded ? "\u25BC" : "\u25B6";
            expandArrow.style.fontSize = 8;
            expandArrow.color = 0xAAAAAA;
            expandArrow.setPos(2, 3);
            expandArrow.setSize(12, 12);
            expandBtn.addChild(expandArrow);

            expandBtn.on("pointer_down", (e: gui.Event) => {
                if (e.input.button !== 0) return;
                e.stopPropagation();
                if (!this.nodeData.props) this.nodeData.props = {};
                this.nodeData.props[expandKey] = !expanded;
                this._buildUI();
                this._stage.scheduleRefreshLines();
            }, this);
        }

        // 主行内联向量分量输入（未连接时显示）
        if (!mainConnected) {
            if (!this.nodeData.props) this.nodeData.props = {};
            if (!this.nodeData.props._inputs) this.nodeData.props._inputs = {};
            const inputs = this.nodeData.props._inputs as Record<string, any>;
            const old = inputs[slotDef.id];
            if (old == null || typeof old !== "object") {
                const scalar = typeof old === "number" ? old : 0;
                inputs[slotDef.id] = {};
                for (const c of comps) inputs[slotDef.id][c] = scalar;
            } else {
                const newVals: Record<string, number> = {};
                for (const c of comps) newVals[c] = (old as Record<string, number>)[c] ?? 0;
                inputs[slotDef.id] = newVals;
            }
            const vals = inputs[slotDef.id] as Record<string, number>;

            const linkedComps = new Set<string>();
            for (const c of comps) {
                if (this._isInputSlotConnected(`${slotDef.id}_${c}`)) linkedComps.add(c);
            }

            createVecNumericFields(
                this, vecType, inputRight, yOffset,
                (c: string) => vals[c] ?? 0,
                (c: string, v: number) => { vals[c] = v; },
                { skipComps: linkedComps.size > 0 ? linkedComps : undefined },
            );
        }

        yOffset += VfxNode.SLOT_HEIGHT;

        // 分量输入行
        const visibleComps = this._getVisibleInputComps(slotDef.id, comps, expanded);
        for (const comp of visibleComps) {
            const compSlotId = `${slotDef.id}_${comp}`;
            const compSlotDef = { id: compSlotId, name: comp.toUpperCase(), type: "float" };
            const compSlot = new VfxSlot(compSlotDef, true, this.nodeData.id, this._stage);
            const compUI = compSlot.createUI(W);
            compUI.setPos(-11, yOffset);
            this.addChild(compUI);
            this._inputSlots.push(compSlot);

            if (!mainConnected && !this._isInputSlotConnected(compSlotId)) {
                if (!this.nodeData.props._inputs) this.nodeData.props._inputs = {};
                const inputs = this.nodeData.props._inputs as Record<string, any>;
                if (!inputs[slotDef.id] || typeof inputs[slotDef.id] !== "object") {
                    inputs[slotDef.id] = {};
                }
                const vals = inputs[slotDef.id] as Record<string, number>;

                const fieldRight = inputRight - 4;
                const compInput = createNumericInput(this, fieldRight - 70, yOffset + 2, 70, 20);
                compInput.value = vals[comp] ?? 0;
                const c = comp;
                compInput.on("submit", () => { vals[c] = compInput.value; });
            }

            yOffset += VfxNode.SLOT_HEIGHT;
        }

        return yOffset;
    }

    /** 获取向量分量 ID 列表 */
    private _getVecCompIds(vecType: string): string[] {
        if (vecType === "vec2") return ["x", "y"];
        if (vecType === "vec3") return ["x", "y", "z"];
        if (vecType === "vec4") return ["x", "y", "z", "w"];
        return [];
    }

    /** 获取需要显示的分量（展开时全部，收起时只显示有连线的） */
    private _getVisibleInputComps(inputId: string, comps: string[], expanded: boolean): string[] {
        if (expanded) return comps;
        return comps.filter(c => this._isInputSlotConnected(`${inputId}_${c}`));
    }

    /**
     * 在节点右侧渲染独立的输出列：主输出 + 展开/收起箭头 + 分量输出 slots
     * 输出列宽度为 OUT_COL_W，不与输入行混排
     */
    private _buildOutputColumn(
        W: number, startY: number,
        mainOutDef: IVfxSlotDef | null,
        compSlots: IVfxSlotDef[],
        expanded: boolean,
    ): void {
        const COL_W = VfxNode.OUT_COL_W;
        let colY = startY;

        // 主输出 slot（隐藏标签，图标在右边框上）
        if (mainOutDef) {
            const slot = new VfxSlot(mainOutDef, false, this.nodeData.id, this._stage);
            const ui = slot.createUI(W, undefined, true);
            ui.setPos(11, colY);
            this.addChild(ui);
            this._outputSlots.push(slot);
        }

        // 展开/收起箭头
        if (compSlots.length > 0) {
            const toggleBtn = new gui.TextField();
            toggleBtn.text = expanded ? "\u25BC" : "\u25B6";
            toggleBtn.style.fontSize = 9;
            toggleBtn.color = 0x999999;
            toggleBtn.setPos(W - COL_W, colY + 6);
            toggleBtn.setSize(14, 14);
            toggleBtn.touchable = true;
            toggleBtn.cursor = "pointer";
            this.addChild(toggleBtn);
            toggleBtn.on("pointer_down", (e: gui.Event) => {
                if (e.input.button !== 0) return;
                e.stopPropagation();
                if (!this.nodeData.props) this.nodeData.props = {};
                this.nodeData.props._expandOutput = !this.nodeData.props._expandOutput;
                this._buildUI();
                this._stage.scheduleRefreshLines();
            }, this);
        }

        colY += VfxNode.SLOT_HEIGHT;

        // 分量输出 slots（展开时全部，收起时仅有连线的）
        const visibleSlots = expanded ? compSlots : compSlots.filter(s => this._isOutputSlotConnected(s.id));
        for (const slotDef of visibleSlots) {
            // 分量标签（手动绘制）
            const compName = slotDef.name || slotDef.id;
            const lbl = new gui.TextField();
            lbl.text = compName;
            lbl.style.fontSize = 11;
            lbl.color = 0xCCCCCC;
            lbl.style.align = gui.AlignType.Right;
            lbl.setPos(W - COL_W, colY + 4);
            lbl.setSize(COL_W - 22, 16);
            this.addChild(lbl);

            // slot 圆圈（hideLabel，仅图标）
            const slot = new VfxSlot(slotDef, false, this.nodeData.id, this._stage);
            const ui = slot.createUI(W, undefined, true);
            ui.setPos(11, colY);
            this.addChild(ui);
            this._outputSlots.push(slot);

            colY += VfxNode.SLOT_HEIGHT;
        }
    }

    /** 构建连接状态快照字符串 */
    private _buildConnectionSnapshot(): string {
        const keyParts: string[] = [];

        // 所有已创建的输入 slot 连接状态
        for (const s of this._inputSlots) {
            const sid = s.slotId;
            keyParts.push(this._isInputSlotConnected(sid) ? sid : "");
        }

        // 输出分量连接也影响布局
        const compSlots = this._getComponentSlots();
        for (const s of compSlots) {
            keyParts.push(this._isOutputSlotConnected(s.id) ? s.id : "");
        }

        return keyParts.join(",");
    }

    /** 计算属性需要的行数 */
    private _getPropRowCount(prop: IEditor.FPropertyDescriptor): number {
        if (prop.type === "vec2") return 2;
        if (prop.type === "vec3") return 3;
        if (prop.type === "vec4") return 4;
        return 1;
    }

    /** 类型是否为节点内可内联编辑的输入（标量 / 向量 / 复合类型）。
     *  Texture/Mesh/Gradient/Curve/GraphicsBuffer/flow 等保持裸 slot（暂不在节点内画选择器）。 */
    private _isInlineEditableType(type: string): boolean {
        if (type === "number" || type === "float" || type === "int" || type === "uint"
            || type === "bool" || type === "boolean") return true;
        // vec/color/transform/sphere/cone/... 复合类型
        return !!getCompositeChildren(type);
    }

    /** 归一化转换器写入的 transform 数据：转换器用 `angles` 键，IDE 复合表用 `rotation`。
     *  让 UI 显示与编译器读取一致（避免"值显示为 0 但编译用 90"的假象）。递归处理嵌套复合（sphere/cone 等）。 */
    private _normalizeTransformInput(val: any, type: string): void {
        if (!val || typeof val !== "object") return;
        if (type === "transform" && val.angles != null && val.rotation == null) {
            val.rotation = val.angles;
        }
        const children = getCompositeChildren(type);
        if (children) {
            for (const c of children) this._normalizeTransformInput(val[c.name], c.type);
        }
    }

    /** 计算普通 operator 节点输入列的总高度（内联可编辑输入按 createPropRow 实际占用，其余按一行） */
    private _calcOperatorInputColH(): number {
        let h = 0;
        for (const inp of this.typeDef.inputs) {
            if (this._isInlineEditableType(inp.type)) {
                h += calcPropRowHeight(
                    { name: inp.id, caption: inp.name, type: inp.type } as IVfxPropDef,
                    this.nodeData.props || {},
                    (sid: string) => this._isInputSlotConnected(sid),
                );
            } else {
                h += VfxNode.SLOT_HEIGHT;
            }
        }
        return h;
    }

    /** 渲染普通 operator 节点的单个内联可编辑输入（复用 createPropRow，自带 input slot + 复合展开）。
     *  返回新的 yOffset。 */
    private _buildOperatorInputEditor(slotDef: IVfxSlotDef, yOffset: number, W: number, PAD: number, hasOutCol: boolean): number {
        if (!this.nodeData.props) this.nodeData.props = {};
        if (!this.nodeData.props._inputs) this.nodeData.props._inputs = {};
        const inputs = this.nodeData.props._inputs as Record<string, any>;
        const slotId = slotDef.id;
        const slotDefault = (slotDef as any).default;
        const isScalar = slotDef.type === "number" || slotDef.type === "float" || slotDef.type === "int"
            || slotDef.type === "uint" || slotDef.type === "bool" || slotDef.type === "boolean";
        // 仅对向量/复合类型预置默认值（保证展开时 scale=1 等正确显示且与编译一致）。
        // 标量保持懒初始化：不写入 _inputs，让编译器的隐式默认（sampleCurve t→normalizedAge、
        // ageOverLifetime age/lifetime 等）继续生效——一旦写入 0 会覆盖这些默认。
        if (!isScalar && inputs[slotId] == null) {
            inputs[slotId] = slotDefault != null
                ? JSON.parse(JSON.stringify(slotDefault))
                : buildTypeDefault(slotDef.type);
        }
        // 兼容转换器的 angles 键
        this._normalizeTransformInput(inputs[slotId], slotDef.type);

        const rowResult = createPropRow({
            propDef: { name: slotId, caption: slotDef.name, type: slotDef.type, default: slotDefault },
            parent: this,
            nodeId: this.nodeData.id,
            stage: this._stage,
            getData: () => inputs[slotId],
            setData: (v: any) => { inputs[slotId] = v; },
            buildSlotId: (name: string) => name,
            hasInputSlot: true,
            isConnected: (sid: string) => this._isInputSlotConnected(sid),
            onRebuild: () => { this._buildUI(); this._stage.scheduleRefreshLines(); },
            expandState: this.nodeData.props,
            startY: yOffset,
            labelX: PAD,
            inputRight: hasOutCol ? W - VfxNode.OUT_COL_W : W - PAD,
            containerWidth: W,
        });
        this._inputSlots.push(...rowResult.inputSlots);
        this._outputSlots.push(...rowResult.outputSlots);
        return yOffset + rowResult.height;
    }

    /** 检查某个输入 slot 是否有连接 */
    private _isInputSlotConnected(slotId: string): boolean {
        const data = this._stage?.graphData;
        if (!data) return false;
        for (const op of data.operators) {
            if (!op.output) continue;
            for (const sid of Object.keys(op.output)) {
                if (op.output[sid].infoArr.some(
                    c => c.nodeId === this.nodeData.id && c.slotId === slotId
                )) return true;
            }
        }
        return false;
    }

    /** getAttribute/getProperty: 动态标题 */
    private _getDynamicTitle(): string {
        if (this.typeDef.typeId === "getAttribute" && this.nodeData.props?.attribute) {
            const attr = this.nodeData.props.attribute as string;
            return "Get " + attr.charAt(0).toUpperCase() + attr.slice(1);
        }
        if (this.typeDef.typeId === "getProperty" && this.nodeData.props?.property) {
            return this.nodeData.props.property as string;
        }
        return this.typeDef.title;
    }

    /** getAttribute/getProperty/supportedTypes/inlineVec: 根据当前类型返回分量输出插槽定义 */
    private _getComponentSlots(): IVfxSlotDef[] {
        if (this.typeDef.typeId === "getAttribute") {
            const attrName = (this.nodeData.props?.attribute as string) || "position";
            const attrType = getAttributeType(attrName);
            return getAttributeComponents(attrType);
        }
        if (this.typeDef.typeId === "getProperty") {
            const propType = this._getPropertyType();
            return getPropertyComponents(propType);
        }
        // supportedTypes 或复合输出类型节点：根据输出类型查表获取分量
        let outType: string | null = null;
        if (this.typeDef.supportedTypes && this.typeDef.supportedTypes.length > 0) {
            outType = this._getSelectedType();
        } else if (this.typeDef.outputs.length === 1) {
            outType = this.typeDef.outputs[0]?.type || null;
        }
        if (outType) {
            const comps = getPropertyComponents(outType);
            return comps.map(c => ({ id: "out_" + c.id, name: c.name.charAt(0).toUpperCase() + c.name.slice(1), type: c.type }));
        }
        return [];
    }

    /** 检查本节点的某个输出 slot 是否有连接 */
    private _isOutputSlotConnected(slotId: string): boolean {
        const out = this.nodeData.output;
        if (!out || !out[slotId]) return false;
        return out[slotId].infoArr.length > 0;
    }

    /** supportedTypes: 获取当前选定的数据类型 */
    private _getSelectedType(): string {
        const t = this.nodeData.props?._type as string;
        if (t && this.typeDef.supportedTypes?.includes(t)) return t;
        return this.typeDef.supportedTypes?.[0] || "float";
    }

    /** getProperty: 从图数据查找当前 property 的类型 */
    private _getPropertyType(): string {
        const propName = this.nodeData.props?.property as string;
        if (!propName || !this._stage?.graphData?.properties) return "number";
        const propDef = this._stage.graphData.properties.find(p => p.name === propName);
        return propDef?.type || "number";
    }

    // ---- DataWatcher 回调 ----

    private _onDataChange(sender: any, target: any, key: string, value: any): void {
        if (target === this.nodeData.uiData && (key === "x" || key === "y")) {
            if (key === "x") super.x = Math.floor(value);
            else super.y = Math.floor(value);
            this._stage.updateLineEndpoints();
        }
        // getAttribute/getProperty/_type: 属性变更时重建 UI
        if (target === this.nodeData.props && (key === "attribute" || key === "property" || key === "_type" || key === "_space")) {
            this._buildUI();
            this._stage.scheduleRefreshLines();
        }
    }

    // ---- x/y 同步到 data ----

    set x(value: number) {
        if (this.nodeData && this.nodeData.uiData.x !== value) {
            this.nodeData.uiData.x = value;
        }
        super.x = value;
    }
    get x() { return super.x; }

    set y(value: number) {
        if (this.nodeData && this.nodeData.uiData.y !== value) {
            this.nodeData.uiData.y = value;
        }
        super.y = value;
    }
    get y() { return super.y; }

    // ---- 鼠标交互（拖拽+选中） ----

    private _onPointerDown(e: gui.Event): void {
        if (e.input.button !== 0) return;
        e.stopPropagation();

        this._isMouseMoved = false;
        VfxNode._downXY = { x: e.input.x, y: e.input.y };

        if (e.input.ctrlKey || e.input.commandKey) {
            if (this._isSelected) this.unselect();
            else this.select(true);
            return;
        }

        this.select();
        e.capturePointer();
        gui.GRoot.getInst(this).on("pointer_move", this._onPointerMove, this);
        gui.GRoot.getInst(this).on("pointer_up", this._onPointerUp, this);
    }

    private _onPointerMove(e: gui.Event): void {
        if (!VfxNode._downXY) return;

        if (!this._isMouseMoved) {
            const dx = e.input.x - VfxNode._downXY.x;
            const dy = e.input.y - VfxNode._downXY.y;
            if (Math.sqrt(dx * dx + dy * dy) < 5) return;
            this._isMouseMoved = true;
        }

        const s = this._stage.scale;
        const mx = (e.input.x - VfxNode._downXY.x) / s;
        const my = (e.input.y - VfxNode._downXY.y) / s;
        VfxNode._downXY.x = e.input.x;
        VfxNode._downXY.y = e.input.y;

        this._stage.moveSelection(mx, my);
    }

    private _onPointerUp(): void {
        VfxNode._downXY = null;
        gui.GRoot.getInst(this).off("pointer_move", this._onPointerMove, this);
        gui.GRoot.getInst(this).off("pointer_up", this._onPointerUp, this);
    }

    // ---- 选中/取消选中 ----

    select(isAdditive: boolean = false): void {
        if (this._isSelected) return;
        this._isSelected = true;
        if (this.parent) this.parent.addChild(this);
        this._setSelectStyle(true);
        this._stage.addToSelection(this, isAdditive);
    }

    unselect(): void {
        if (!this._isSelected) return;
        this._isSelected = false;
        this._setSelectStyle(false);
        this._stage.removeFromSelection(this);
    }

    private _setSelectStyle(selected: boolean): void {
        if (this._selectShape) this._selectShape.visible = selected;
    }

    /** hover 高亮（鼠标悬停左侧属性时，对应 getProperty 节点高亮，对齐 Unity）*/
    setHovered(hovered: boolean): void {
        if (this._overSelectShape) this._overSelectShape.visible = hovered;
    }

    // ---- 插槽访问 ----

    private _connectedSlotKeys: string = "";

    /** 检查输入连接状态是否变更，若变更则重建 UI */
    checkAndRebuildIfConnectionChanged(): void {
        const keys = this._buildConnectionSnapshot();
        if (keys !== this._connectedSlotKeys) {
            this._connectedSlotKeys = keys;
            this._buildUI();
        }
    }

    get inputSlots(): VfxSlot[] { return this._inputSlots; }
    get outputSlots(): VfxSlot[] { return this._outputSlots; }

    getInputSlot(slotId: string): VfxSlot | null {
        return this._inputSlots.find(s => s.slotDef.id === slotId) || null;
    }

    getOutputSlot(slotId: string): VfxSlot | null {
        return this._outputSlots.find(s => s.slotDef.id === slotId) || null;
    }

    // ---- 清理 ----

    dispose(): void {
        if (this.nodeData) {
            IEditor.DataWatcher.removeListener(this.nodeData, this._onDataChange, this);
        }
        this.unselect();
        for (const s of this._inputSlots) s.dispose();
        for (const s of this._outputSlots) s.dispose();
        if (this.parent) this.parent.removeChild(this);
        this.nodeData = null;
        this._stage = null;
    }
}
