import type { IVfxGraphData, IVfxPropertyDef } from "../data/VfxTypes";
import { getPropSettingsRegistryId } from "../data/VfxNodeDefs";
import { propDefaultToIDE } from "../data/VfxPropValueBridge";
import { getSlotColor } from "../display/VfxSlot";
import type { IVfxHost } from "./IVfxHost";

/** "#RRGGBB" → 0xRRGGBB（gui TextField.color 需 number） */
function colorHexToNum(hex: string): number {
    return parseInt(hex.replace("#", ""), 16) || 0xCCCCCC;
}

/** 属性类型选项 */
const PROPERTY_TYPES = [
    { label: "Float", type: "number", default: 0 },
    { label: "Int", type: "int", default: 0 },
    { label: "Bool", type: "bool", default: false },
    { label: "Vector2", type: "vec2", default: { x: 0, y: 0 } },
    { label: "Vector3", type: "vec3", default: { x: 0, y: 0, z: 0 } },
    { label: "Vector4", type: "vec4", default: { x: 0, y: 0, z: 0, w: 0 } },
    { label: "Color", type: "color", default: { r: 1, g: 1, b: 1, a: 1 } },
    { label: "Gradient", type: "Gradient", default: { stops: [{ t: 0, color: { r: 1, g: 1, b: 1, a: 1 } }, { t: 1, color: { r: 1, g: 1, b: 1, a: 0 } }] } },
    { label: "Texture2D", type: "Texture2D", default: null },
    { label: "Mesh", type: "Mesh", default: null },
    { label: "Axis Aligned Box", type: "AABox", default: { center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } } },
    { label: "Graphics Buffer", type: "GraphicsBuffer", default: null },
];

const NUMERIC_TYPES = new Set(["number", "int"]);
const HEADER_H = 28;
const ROW_GAP = 4;
const BOX_PAD = 4;
const BOX_MARGIN_H = 8;
/** 行内类型标签预留宽度（容纳 "Axis Aligned Box" 等长名）*/
const TYPE_W = 104;

interface IRowEntry {
    kind: "group" | "prop";
    widget: gui.Widget;
    headerBg: gui.Shape;
    /** prop 行：在 graphData.properties 中的索引 */
    propIndex?: number;
    /** prop 行所属分组名 / group header 自身的组名（"" = 无分组，平铺不缩进） */
    groupName?: string;
    /** prop 行展开时各自的内嵌 inspector（支持多行同时展开）*/
    insp?: { widget: gui.Widget; di: IEditor.IDataInspector };
    /** inspector 实测内容高度（按真实高度收缩，避免固定高度留大片空白）*/
    inspH?: number;
}

/**
 * VFX Graph Property 组件（Blackboard）
 * 使用 DataInspector 渲染属性设置
 * 由 VfxGraphPanel 持有，嵌入左栏。
 */
export class VfxPropertyPanel {
    panel: gui.Widget;

    private _list: gui.Panel;
    private _graphData: IVfxGraphData | null = null;
    private _rows: IRowEntry[] = [];
    /** 当前展开的属性 propIndex 集合（支持多个同时展开，对齐 Unity）*/
    private _expanded: Set<number> = new Set();
    /** 分组折叠状态：组名 → 是否折叠 */
    private _groupCollapsed: Map<string, boolean> = new Map();
    /** 宿主面板（用于访问画布 stage 做属性 hover 高亮）*/
    private _host: IVfxHost | null = null;
    /** 上次 list 宽度，用于检测横向拖拽放大后重排行宽 */
    private _lastListW = 0;

    async create(parent: gui.Widget, host?: IVfxHost): Promise<void> {
        this._host = host || null;
        this.panel = gui.UIPackage.createWidgetSync("editorResources/vfx/UI/VfxPropertyPanel.widget");
        parent.addChild(this.panel);
        // 手动跟随父容器尺寸（不用 RelationType.Size：editor-ui 是 DOM，Size relation 在父容器
        // 变宽时会给子面板施加 CSS 缩放，导致文字被放大。与 VfxScenePanel 一致用显式 setSize）
        const syncToParent = () => this.panel.setSize(parent.width, parent.height);
        parent.on("size_changed", syncToParent, this);
        syncToParent();

        const header = this.panel.getChild("header", gui.Widget);
        // widget 里 title 默认 "Properties"，运行时按当前语言覆盖（通用词走全局 i18n 表）
        const titleField = header.getChild("title", gui.TextField);
        if (titleField) titleField.text = i18n.t("property");
        const addBtn = header.getChild("addBtn", gui.TextField);
        addBtn.on("pointer_down", (e: gui.Event) => {
            if (e.input.button !== 0) return;
            e.stopPropagation();
            this._showAddMenu();
        }, this);

        this._list = this.panel.getChild("list", gui.Panel);
        // 启用垂直滚动（内容超出面板高度时出现滚动条）
        try {
            this._list.scroller = new gui.Scroller();
            this._list.scroller.barDisplay = gui.ScrollBarDisplay.OnOverflow;
            try { this._list.scroller.direction = gui.ScrollDirection.Vertical; } catch { }
            try { (this._list as any).clipping = true; } catch { }
        } catch (e) { console.warn("[VfxPropertyPanel] scroller setup failed", e); }
        // 面板尺寸变化 → 同步 list 视口高度（header 占顶部 30px）；宽度变化时重排行宽
        const syncListSize = () => {
            const w = this.panel.width;
            this._list.setSize(w, Math.max(0, this.panel.height - 30));
            if (Math.abs(w - this._lastListW) > 1) {
                this._lastListW = w;
                this._applyRowWidths();
            }
        };
        this.panel.on("size_changed", syncListSize, this);
        syncListSize();
    }

    setGraphData(graphData: IVfxGraphData): void {
        this._graphData = graphData;
        if (!graphData.properties) graphData.properties = [];
        this._rebuild();
    }

    private _showAddMenu(): void {
        if (!this._graphData) return;
        const items = PROPERTY_TYPES.map(pt => ({
            label: pt.label,
            click: () => this._addProperty(pt.type, pt.default),
        }));
        IEditor.Menu.create(items).show(this.panel);
    }

    private _addProperty(type: string, defaultValue: any): void {
        if (!this._graphData) return;
        if (!this._graphData.properties) this._graphData.properties = [];

        const existingNames = new Set(this._graphData.properties.map((p: IVfxPropertyDef) => p.name));
        let name = "NewProperty";
        let idx = 0;
        while (existingNames.has(name)) { idx++; name = `NewProperty${idx}`; }

        // 新建属性的 default 也转成 IDE 编辑器格式（跟 open() 一致），存盘时再转回运行时格式
        const rawDefault = typeof defaultValue === "object" && defaultValue !== null
            ? JSON.parse(JSON.stringify(defaultValue)) : defaultValue;
        this._graphData.properties.push({
            name, type,
            default: propDefaultToIDE(type, rawDefault),
            exposed: true,
            mode: NUMERIC_TYPES.has(type) ? "Default" : undefined,
        });
        this._rebuild();
    }

    private _removeProperty(index: number): void {
        if (!this._graphData?.properties) return;
        const propName = this._graphData.properties[index].name;
        this._graphData.properties.splice(index, 1);

        // 删除引用该 property 的 getProperty operator 及其连线
        this._removeGetPropertyNodes(propName);

        this._rebuild();
    }

    /** 删除所有引用指定 property 的 getProperty operator 节点 */
    private _removeGetPropertyNodes(propName: string): void {
        if (!this._graphData) return;
        const ops = this._graphData.operators;

        // 收集要删除的 operator ID
        const removeIds = new Set<number>();
        for (const op of ops) {
            if (op.typeId === "getProperty" && op.props?.property === propName) {
                removeIds.add(op.id);
            }
        }
        if (removeIds.size === 0) return;

        // 清除其他 operator 中指向这些节点的连线
        for (const op of ops) {
            if (removeIds.has(op.id) || !op.output) continue;
            for (const sid of Object.keys(op.output)) {
                const arr = op.output[sid].infoArr;
                for (let i = arr.length - 1; i >= 0; i--) {
                    if (removeIds.has(arr[i].nodeId)) arr.splice(i, 1);
                }
            }
        }

        // 从数据数组中移除
        for (let i = ops.length - 1; i >= 0; i--) {
            if (removeIds.has(ops[i].id)) ops.splice(i, 1);
        }
    }

    // ── Layout ──

    /**
     * 宽度变化（横向拖拽放大左栏）时原地调整行宽。
     * 不重建行——避免丢失行背景/圆点/分组头、输入框失焦、展开态被收起。
     * 只更新宽度相关的子元素（行宽 + nameInput + typeLabel），其余交给 _relayout。
     */
    private _applyRowWidths(): void {
        if (this._rows.length === 0) return;
        const W = this._list.width || 250;
        const cardW = W - BOX_MARGIN_H * 2;
        for (const r of this._rows) {
            if (r.kind !== "prop") continue;
            const indent = r.groupName ? 12 : 0;
            const effW = cardW - indent;
            r.widget.setSize(effW, HEADER_H);
            const nameInput = (r.widget as any).getChild?.("nameInput", gui.TextInput);
            if (nameInput) nameInput.setSize(Math.max(60, effW - TYPE_W - 46), 20);
            const typeLabel = (r.widget as any).getChild?.("typeLabel", gui.TextField);
            if (typeLabel) { typeLabel.setSize(TYPE_W, 16); typeLabel.setPos(effW - TYPE_W - 6, 6); }
        }
        // _relayout 负责 headerBg 宽度、各行 y 定位、以及展开 inspector 的宽度/高度
        this._relayout();
    }

    private _rebuild(): void {
        for (const r of this._rows) {
            if (r.insp?.widget && r.insp.widget.parent) r.insp.widget.parent.removeChild(r.insp.widget);
            if (r.widget.parent) r.widget.parent.removeChild(r.widget);
        }
        this._rows.length = 0;
        this._expanded.clear();   // 结构性重建（增/删/改名）后收起所有

        if (!this._graphData?.properties) return;

        const W = this._list.width || 250;
        const props = this._graphData.properties;

        // 按 group 分桶（保持出现顺序）；"" = 无分组
        const order: string[] = [];
        const groups = new Map<string, number[]>();
        for (let i = 0; i < props.length; i++) {
            const g = (props[i].group || "").trim();
            if (!groups.has(g)) { groups.set(g, []); order.push(g); }
            groups.get(g)!.push(i);
        }
        // 无分组的先平铺渲染（兼容现状）
        if (groups.has("")) {
            for (const idx of groups.get("")!) this._createRow(props[idx], idx, W, "");
        }
        // 其余按出现顺序渲染为可折叠文件夹
        for (const g of order) {
            if (g === "") continue;
            this._createGroupHeader(g, W);
            for (const idx of groups.get(g)!) this._createRow(props[idx], idx, W, g);
        }
        this._relayout();
    }

    /** 创建可折叠分组文件夹标题行（▼/▶ + 组名），点击切换折叠 */
    private _createGroupHeader(groupName: string, W: number): void {
        const cardW = W - BOX_MARGIN_H * 2;
        const row = new gui.Widget();
        row.setSize(cardW, HEADER_H);

        const bg = new gui.Shape();
        bg.setSize(cardW, HEADER_H);
        bg.getGraphics(gui.SRect).fillColor.parse("#383838");
        row.addChild(bg);

        // 文字垂直居中：用 height=20 + y=4（跟属性行 nameInput 一致），
        // 不再用 height=HEADER_H + y=0（那样文字顶对齐偏高，跟下方属性行对不齐）
        const TXT_H = 20, TXT_Y = 4;
        const fold = new gui.TextField();
        fold.text = this._groupCollapsed.get(groupName) ? "▶" : "▼";
        fold.color = 0xCCCCCC;
        try { fold.style.fontSize = 12; } catch { }
        fold.setSize(16, TXT_H);
        fold.setPos(6, TXT_Y);
        row.addChild(fold);

        const label = new gui.TextField();
        label.text = groupName;
        label.color = 0xDDDDDD;
        try { label.style.fontSize = 12; } catch { }
        label.setSize(cardW - 28, TXT_H);
        label.setPos(24, TXT_Y);
        row.addChild(label);

        const onDown = (e: gui.Event) => {
            if (e.input.button !== 0) return;
            e.stopPropagation();
            const cur = this._groupCollapsed.get(groupName) === true;
            this._groupCollapsed.set(groupName, !cur);
            fold.text = !cur ? "▶" : "▼";
            this._relayout();
        };
        bg.on("pointer_down", onDown, this);
        fold.on("pointer_down", onDown, this);
        label.on("pointer_down", onDown, this);

        this._list.addChild(row);
        this._rows.push({ kind: "group", widget: row, headerBg: bg, groupName });
    }

    private _relayout(): void {
        const W = this._list.width || 250;
        const cardW = W - BOX_MARGIN_H * 2;
        let y = ROW_GAP;
        for (const r of this._rows) {
            // 折叠分组内的 prop 行隐藏（含其 inspector）
            const hiddenByGroup = r.kind === "prop" && !!r.groupName && this._groupCollapsed.get(r.groupName) === true;
            r.widget.visible = !hiddenByGroup;
            const expanded = r.kind === "prop" && this._expanded.has(r.propIndex!);
            if (r.insp) r.insp.widget.visible = !hiddenByGroup && expanded;
            if (hiddenByGroup) continue;

            const indent = (r.kind === "prop" && r.groupName) ? 12 : 0;

            // header 行固定高度；inspector 作为独立 widget 排在其下方（支持多行同时展开）
            r.widget.x = BOX_MARGIN_H + indent;
            r.widget.y = y;
            r.widget.height = HEADER_H;
            r.headerBg.setSize(cardW - indent, HEADER_H);
            y += HEADER_H;

            if (expanded && r.insp) {
                const ih = r.inspH ?? 130;   // 实测内容高度，未测出时用估计值
                r.insp.widget.setPos(BOX_MARGIN_H + indent, y + 2);
                r.insp.widget.setSize(cardW - indent, ih);
                y += ih + BOX_PAD;
            }
            y += ROW_GAP;
        }
        // 不设 list.height —— Panel 视口固定，滚动条按子节点内容自动出现
        try { (this._list.scroller as any)?.refresh?.(); } catch { }
    }

    // ── Row creation ──

    private _createRow(prop: IVfxPropertyDef, index: number, W: number, group: string = ""): void {
        const cardW = W - BOX_MARGIN_H * 2;
        const indent = group ? 12 : 0;
        const effW = cardW - indent;
        const row = gui.UIPackage.createWidgetSync("editorResources/vfx/UI/VfxPropertyRow.widget");
        row.x = BOX_MARGIN_H + indent;
        row.setSize(effW, HEADER_H);

        const headerBg = row.getChild("headerBg", gui.Shape);
        headerBg.setSize(effW, HEADER_H);

        // 彩色类型圆点（折叠箭头与名称之间）
        const dot = new gui.Shape();
        dot.setSize(8, 8);
        dot.setPos(20, Math.floor((HEADER_H - 8) / 2));
        dot.getGraphics(gui.SEllipse).fillColor.parse(getSlotColor(prop.type));
        row.addChild(dot);

        // 右键菜单
        const showContextMenu = () => {
            IEditor.Menu.create([
                { label: i18n.t("delete"), click: () => this._removeProperty(index) },
            ]).show(this.panel);
        };

        // 统一 pointer_down 处理（左键选中 / 右键菜单）
        const onPointerDown = (e: gui.Event) => {
            if (e.input.button === 0) {
                e.stopPropagation();
                this._toggleExpand(index);
            } else if (e.input.button === 2) {
                e.stopPropagation();
                showContextMenu();
            }
        };

        // fold arrow
        const foldBtn = row.getChild("foldBtn", gui.TextField);
        foldBtn.on("pointer_down", onPointerDown, this);

        // name —— 占据圆点之后到类型标签之前的全部空间（随面板放大而变长，显示完整属性名）
        const nameInput = row.getChild("nameInput", gui.TextInput);
        nameInput.text = prop.name;
        nameInput.setSize(Math.max(60, effW - TYPE_W - 46), 20);
        nameInput.setPos(32, 4);   // 右移给圆点让位
        nameInput.on("focus_out", () => {
            const n = nameInput.text.trim();
            if (n && n !== prop.name) prop.name = n;
            else nameInput.text = prop.name;
        }, this);
        nameInput.on("key_down", (e: gui.Event) => {
            if (e.input.key === "Enter") nameInput.element.blur();
        }, this);
        nameInput.on("pointer_down", onPointerDown, this);

        // type label —— 右对齐，宽度固定容纳长类型名（模板里是 relation 右贴，这里显式定位）
        const typeLabel = row.getChild("typeLabel", gui.TextField);
        typeLabel.setSize(TYPE_W, 16);
        typeLabel.setPos(effW - TYPE_W - 6, 6);
        typeLabel.text = PROPERTY_TYPES.find(t => t.type === prop.type)?.label || prop.type;
        typeLabel.color = colorHexToNum(getSlotColor(prop.type));   // 类型标签按类型配色（与圆点同色）
        typeLabel.touchable = true;
        typeLabel.on("pointer_down", onPointerDown, this);

        // header background
        headerBg.on("pointer_down", onPointerDown, this);

        // 鼠标悬停 → 高亮画布上引用该属性的 getProperty 节点（对齐 Unity）
        row.on("roll_over", () => this._host?.scene?.stage?.highlightPropertyNodes(prop.name), this);
        row.on("roll_out", () => this._host?.scene?.stage?.clearPropertyHighlight(), this);

        const entry: IRowEntry = { kind: "prop", widget: row, headerBg, propIndex: index, groupName: group };
        this._rows.push(entry);
        this._list.addChild(row);
    }

    // ── Selection & Inspector ──

    /** 切换某属性展开/收起（支持多行同时展开）*/
    private async _toggleExpand(index: number): Promise<void> {
        const entry = this._rows.find(r => r.kind === "prop" && r.propIndex === index);
        if (!entry) return;
        if (this._expanded.has(index)) {
            this._expanded.delete(index);
            this._disposeRowInspector(entry);
        } else {
            this._expanded.add(index);
            await this._createRowInspector(entry);
        }
        this._updateRowHighlights();
        this._relayout();
    }

    /** 为某属性行创建独立内嵌 inspector（每个展开行各一个，故可多行同时展开）*/
    private async _createRowInspector(entry: IRowEntry): Promise<void> {
        if (entry.insp || entry.kind !== "prop" || !this._graphData?.properties) return;
        const prop = this._graphData.properties[entry.propIndex!];
        const widget = await gui.UIPackage.createWidget("~/ui/blueprintEditor2/BPInspectorPanel.widget");
        const tree = widget.getChild("list", gui.Tree);
        const di = new IEditor.DataInspector(getPropSettingsRegistryId(prop.type));
        di.setTitle("");
        di.catalogs.forEach(node => {
            tree.rootNode.addChild(node);
            if (node.cell) { node.cell.height = 0; node.cell.alpha = 0; }
        });
        di.setData(prop);
        widget.on("pointer_down", (e: gui.Event) => {
            if (e.input.button === 2) {
                e.stopPropagation();
                IEditor.Menu.create([
                    { label: i18n.t("delete"), click: () => this._removeProperty(entry.propIndex!) },
                ]).show(this.panel);
            }
        }, this);
        this._list.addChild(widget);
        entry.insp = { widget, di };

        // 实测内容高度 → 按真实高度收缩（DataInspector 布局可能晚一帧，0/60ms 两次兜底）
        const measure = () => {
            try {
                const ch = (tree as any).scroller?.contentHeight;
                const h = (typeof ch === "number" && ch > 0) ? Math.ceil(ch) + 4 : 0;
                if (h > 0 && h !== entry.inspH) { entry.inspH = h; this._relayout(); }
            } catch { }
        };
        setTimeout(measure, 0);
        setTimeout(measure, 60);
    }

    /** 释放某属性行的内嵌 inspector */
    private _disposeRowInspector(entry: IRowEntry): void {
        if (!entry.insp) return;
        if (entry.insp.widget.parent) entry.insp.widget.parent.removeChild(entry.insp.widget);
        entry.insp = undefined;
    }

    private _updateRowHighlights(): void {
        for (const r of this._rows) {
            if (r.kind !== "prop") continue;   // \u5206\u7EC4\u6807\u9898\u4E0D\u53C2\u4E0E\u5C55\u5F00\u9AD8\u4EAE
            const open = this._expanded.has(r.propIndex!);
            r.headerBg.getGraphics(gui.SRect).fillColor.parse(open ? "#252525" : "#2e2e2e");

            const foldBtn = r.widget.getChild("foldBtn", gui.TextField);
            if (foldBtn) {
                foldBtn.text = open ? "\u25BC" : "\u25B6";
                foldBtn.color = open ? 0xDDDDDD : 0x666666;
            }
        }
    }

}
