import { VFX_EVENT_DEFS, VFX_CONTEXT_DEFS, VFX_OPERATOR_DEFS } from "../data/VfxNodeDefs";
import { VFX_PARTICLE_ATTRIBUTES } from "../data/VfxOperatorDefs";
import type { IVfxGraphData } from "../data/VfxTypes";
import type { VfxStage } from "./VfxStage";

interface INodeEntry {
    category: string;
    label: string;
    action: () => void;
}

/**
 * 带搜索框的节点选择弹窗
 */
export class VfxNodePicker {
    private _widget: gui.Widget;
    private _tree: gui.Tree;
    private _input: gui.TextInput;
    private _stage: VfxStage;
    private _entries: INodeEntry[] = [];
    private _categoryNodes: Map<string, gui.TreeNode> = new Map();
    private _blockLayer: gui.Shape;

    constructor(stage: VfxStage) {
        this._stage = stage;
    }

    async create(): Promise<void> {
        this._widget = gui.UIPackage.createWidgetSync("editorResources/vfx/UI/VfxNodePicker.widget");
        this._widget.visible = false;
        this._widget.zOrder = 10000;

        this._input = this._widget.getChild("searchInput", gui.TextInput);
        this._tree = this._widget.getChild("tree", gui.Tree);

        // 加载 TreeItem 模板
        const treeItemRes = await gui.UIPackage.resourceMgr.load("~/ui/basic/Tree/TreeItem.widget");
        this._tree.itemTemplate = treeItemRes as gui.Prefab;

        this._tree.treeNodeRender = this._renderNode.bind(this);
        this._tree.on("click_item", this._onClickItem, this);

        this._input.on("changed", () => {
            gui.Timers.callLater(this._doSearch, this);
        });
        this._input.on("key_down", (e: gui.Event) => {
            if (e.input.key === "Escape") this.hide();
        }, this);

        // 遮挡层：点击外部关闭
        this._blockLayer = new gui.Shape();
        this._blockLayer.name = "nodePickerBlock";
        this._blockLayer.zOrder = 9999;
        this._blockLayer.focusable = false;
        this._blockLayer.drawRect(0, gui.Color.CLEAR, gui.Color.CLEAR);
        this._blockLayer.on("pointer_down", () => this.hide(), this);
    }

    show(graphData: IVfxGraphData, worldX: number, worldY: number): void {
        this._buildEntries(graphData, worldX, worldY);
        this._buildTree();

        const groot = gui.GRoot.getInst(this._stage);
        if (!groot) return;

        // 遮挡层
        this._blockLayer.setSize(groot.width, groot.height);
        groot.addChild(this._blockLayer);

        // 定位弹窗
        const local = groot.globalToLocal(worldX, worldY);
        this._widget.setPos(
            Math.min(local.x, groot.width - this._widget.width - 4),
            Math.min(local.y, groot.height - this._widget.height - 4),
        );
        groot.addChild(this._widget);
        this._widget.visible = true;

        // 聚焦搜索框
        this._input.text = "";
        this._input.element?.focus();
    }

    hide(): void {
        this._widget.visible = false;
        this._widget.removeSelf();
        this._blockLayer.removeSelf();
        this._tree.rootNode.removeChildren();
        this._categoryNodes.clear();
    }

    get isShowing(): boolean {
        return this._widget.visible;
    }

    // ── 构建数据 ──

    private _buildEntries(graphData: IVfxGraphData, gx: number, gy: number): void {
        this._entries.length = 0;
        const stage = this._stage;
        const cont = stage.cont;
        const local = cont.globalToLocal(gx, gy);
        const cx = local.x, cy = local.y;

        // Event —— 菜单 label 用英文原名（节点头部 def.title 已被翻译覆盖，搜索按英文更直觉）
        for (const def of VFX_EVENT_DEFS) {
            this._entries.push({
                category: "Event",
                label: (def as any)._enTitle ?? def.title,
                action: () => stage.createEvent(def.typeId, cx, cy),
            });
        }

        // Context
        for (const def of VFX_CONTEXT_DEFS) {
            this._entries.push({
                category: "Context",
                label: (def as any)._enTitle ?? def.title,
                action: () => stage.createContext(def.typeId, cx, cy),
            });
        }

        // Operator（排除 getAttribute / getProperty）
        for (const def of VFX_OPERATOR_DEFS) {
            if (def.typeId === "getAttribute" || def.typeId === "getProperty" || def.hidden) continue;
            const cat = "Operator" + (def.category ? "/" + def.category : "");
            this._entries.push({
                category: cat,
                label: (def as any)._enTitle ?? def.title,
                action: () => stage.createOperator(def.typeId, cx, cy),
            });
        }

        // Attribute（Operator 下级）
        for (const attr of VFX_PARTICLE_ATTRIBUTES) {
            this._entries.push({
                category: "Operator/Attribute",
                label: "Get " + attr.name.charAt(0).toUpperCase() + attr.name.slice(1),
                action: () => stage.createAttributeNode(attr.name, cx, cy),
            });
        }

        // Property（Operator 下级）
        if (graphData?.properties?.length) {
            for (const prop of graphData.properties) {
                this._entries.push({
                    category: "Operator/Property",
                    label: prop.name,
                    action: () => stage.createPropertyNode(prop.name, cx, cy),
                });
            }
        }
    }

    private _buildTree(): void {
        this._tree.rootNode.removeChildren();
        this._categoryNodes.clear();

        for (const entry of this._entries) {
            const parts = entry.category.split("/");
            let parentNode: gui.TreeNode = this._tree.rootNode;
            let keyPath = "";

            // 逐级创建分类文件夹
            for (const part of parts) {
                keyPath += (keyPath ? "/" : "") + part;
                let node = this._categoryNodes.get(keyPath);
                if (!node) {
                    node = new gui.TreeNode(true);
                    node.expanded = false;
                    node.data = { isFolder: true, label: part };
                    parentNode.addChild(node);
                    this._categoryNodes.set(keyPath, node);
                }
                parentNode = node;
            }

            const itemNode = new gui.TreeNode();
            itemNode.data = { isFolder: false, label: entry.label, entry };
            parentNode.addChild(itemNode);
        }
    }

    // ── 搜索 ──

    private _doSearch(): void {
        const keyword = this._input.text.trim().toLowerCase();
        const isAll = keyword === "";

        this._searchNode(this._tree.rootNode, keyword, isAll);
    }

    /** 递归搜索：叶子节点按关键词过滤，文件夹节点在搜索时自动展开 */
    private _searchNode(node: gui.TreeNode, keyword: string, isAll: boolean): void {
        for (let i = 0; i < node.numChildren; i++) {
            const child = node.getChildAt(i);
            if (child.isFolder) {
                // 先展开父文件夹再递归 —— 否则叶子节点的 cell 还没被 Tree 实例化，
                // 下面 child.cell.visible 会 throw "Cannot set properties of undefined"
                if (!isAll) child.expanded = true;
                this._searchNode(child, keyword, isAll);
            } else if (child.cell) {
                // cell 仍可能 undefined（虚拟滚动 / 父级未真正可见时），加 guard 兜底
                child.cell.visible = isAll || child.data.label.toLowerCase().indexOf(keyword) >= 0;
            }
        }
    }

    // ── 渲染 & 交互 ──

    private _renderNode(node: gui.TreeNode, cell: gui.Widget): void {
        if (node.data.isFolder) {
            cell.icon = node.expanded
                ? "~/ui/type-icons/folder/default_opened.svg"
                : "~/ui/type-icons/folder/default.svg";
            cell.text = node.data.label;
        } else {
            cell.icon = "";
            cell.text = node.data.label;
        }
    }

    private _onClickItem(e: gui.Event): void {
        const node: gui.TreeNode = e.data.treeNode;
        if (!node || node.data.isFolder) return;

        const entry: INodeEntry = node.data.entry;
        if (entry) {
            entry.action();
            this.hide();
        }
    }
}
