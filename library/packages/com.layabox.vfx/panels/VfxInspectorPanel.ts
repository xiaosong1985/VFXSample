import type { IVfxGraphData } from "../data/VfxTypes";
import {
    VFX_GRAPH_TYPE_ID, VFX_GRAPH_PROPERTIES,
    getEventRegistryId, getContextRegistryId, getBlockRegistryId, getOperatorRegistryId,
} from "../data/VfxNodeDefs";
import type { VfxSelectable } from "../display/VfxStage";
import { VfxEvent } from "../display/VfxEvent";
import { VfxContext } from "../display/VfxContext";
import { VfxNode } from "../display/VfxNode";
import { VfxBlock } from "../display/VfxBlock";

/**
 * VFX Graph Inspector 组件
 * 支持 Context、Block、Operator、图级属性显示
 * 由 VfxGraphPanel 持有，嵌入右栏。
 */
export class VfxInspectorPanel {
    panel: gui.Widget;

    private _tree: gui.Tree;
    private _graphProps: Record<string, any> | null = null;
    private _graphDI: IEditor.IDataInspector | null = null;
    private _linkaging: boolean = false;
    private _blockCtx: VfxContext | null = null;
    private _blockProps: Record<string, any> | null = null;

    async create(parent: gui.Widget): Promise<void> {
        this.panel = await gui.UIPackage.createWidget("~/ui/blueprintEditor2/BPInspectorPanel.widget");
        this.panel.addRelation(parent, gui.RelationType.Size);
        this.panel.setSize(parent.width, parent.height);
        parent.addChild(this.panel);
        this._tree = this.panel.getChild("list", gui.Tree);
    }

    /** 选中节点时调用 */
    show(node: VfxSelectable): void {
        this._unwatchGraphProps();
        this._unwatchBlockProps();
        this._tree.rootNode.removeChildren();
        if (!node) return;

        if (node instanceof VfxContext) {
            // 优先显示选中的 Block
            if (node.selectedBlock) {
                this._showBlock(node.selectedBlock, node);
            } else {
                this._showProps(getContextRegistryId(node.typeDef.typeId), node.typeDef.title, node.typeDef.properties, node.contextData);
            }
        } else if (node instanceof VfxEvent) {
            this._showProps(getEventRegistryId(node.typeDef.typeId), node.typeDef.title, node.typeDef.properties, node.eventData);
        } else if (node instanceof VfxNode) {
            this._showProps(getOperatorRegistryId(node.typeDef.typeId), node.typeDef.title, node.typeDef.properties, node.nodeData);
        }
    }

    /** 显示 Block 属性 */
    showBlock(block: VfxBlock): void {
        this._unwatchGraphProps();
        this._unwatchBlockProps();
        this._tree.rootNode.removeChildren();
        if (!block) return;
        this._showBlock(block);
    }

    private _showBlock(block: VfxBlock, ctx?: VfxContext): void {
        this._showProps(getBlockRegistryId(block.typeDef.typeId), block.typeDef.title, block.typeDef.properties, block.blockData);
        // 监听 block 属性变更，触发 UI 重建
        if (block.blockData.props && ctx) {
            this._blockCtx = ctx;
            this._blockProps = block.blockData.props;
            IEditor.DataWatcher.addListener(block.blockData.props, this._onBlockPropsChanged, this);
        }
    }

    private _unwatchBlockProps(): void {
        if (this._blockProps) {
            IEditor.DataWatcher.removeListener(this._blockProps, this._onBlockPropsChanged, this);
            this._blockProps = null;
            this._blockCtx = null;
        }
    }

    /** block 属性变更 → 影响布局的属性改变时重建 Block UI */
    private _onBlockPropsChanged(_sender: any, _target: any, key: string): void {
        if (!this._blockCtx) return;
        if (key === "random" || key === "source" || key === "composition" || key === "attribute") {
            this._blockCtx.rebuildBlocks();
            this._blockCtx.stage?.refreshAllLines();
        }
    }

    /** 通用：根据 typeRegistry ID 显示属性 */
    private _showProps(registryId: string, title: string, properties: any[] | undefined, dataObj: { props?: Record<string, any> }): void {
        if (!properties?.length) return;

        // 确保 props 对象存在 & 填充默认值
        if (!dataObj.props) dataObj.props = {};
        for (const prop of properties) {
            if (prop.default != null && dataObj.props[prop.name] == null) {
                // 对象型默认值（曲线/渐变/AABox 等）深拷贝，避免多个节点共享同一引用 → 改一个全改
                dataObj.props[prop.name] = (typeof prop.default === "object")
                    ? JSON.parse(JSON.stringify(prop.default)) : prop.default;
            }
        }

        const di = new IEditor.DataInspector(registryId);
        di.setTitle(title);
        di.catalogs.forEach(treeNode => this._tree.rootNode.addChild(treeNode));
        di.setData(dataObj.props);
    }

    /** 无节点选中时，显示图级属性 */
    showGraph(graphData: IVfxGraphData): void {
        this._unwatchGraphProps();
        this._tree.rootNode.removeChildren();
        if (!graphData) return;

        if (!graphData.props) graphData.props = {};
        for (const prop of VFX_GRAPH_PROPERTIES) {
            if (prop.default != null && graphData.props[prop.name] == null) {
                graphData.props[prop.name] = prop.default;
            }
        }

        const di = new IEditor.DataInspector(VFX_GRAPH_TYPE_ID);
        di.setTitle("VFX Graph");
        di.catalogs.forEach(treeNode => this._tree.rootNode.addChild(treeNode));
        di.setData(graphData.props);

        // 监听 preWarm 联动
        this._graphProps = graphData.props;
        this._graphDI = di;
        IEditor.DataWatcher.addListener(graphData.props, this._onGraphPropsChanged, this);
    }

    /** 移除图级属性变更监听 */
    private _unwatchGraphProps(): void {
        if (this._graphProps) {
            IEditor.DataWatcher.removeListener(this._graphProps, this._onGraphPropsChanged, this);
            this._graphProps = null;
            this._graphDI = null;
        }
    }

    /**
     * preWarm 三属性联动：
     *   preWarmTotalTime = preWarmStepCount * preWarmDeltaTime
     * - 改 totalTime  → 算 deltaTime  (若 stepCount==0 自动设为1)
     * - 改 stepCount  → 算 deltaTime
     * - 改 deltaTime  → 算 totalTime
     */
    private _onGraphPropsChanged(_sender: any, _target: any, key: string): void {
        const p = this._graphProps;
        if (!p || this._linkaging) return;

        if (key !== "preWarmTotalTime" && key !== "preWarmStepCount" && key !== "preWarmDeltaTime") return;

        this._linkaging = true;
        try {
            if (key === "preWarmTotalTime") {
                const total = p.preWarmTotalTime || 0;
                if (total !== 0 && !p.preWarmStepCount) {
                    p.preWarmStepCount = 1;
                }
                const steps = p.preWarmStepCount || 0;
                p.preWarmDeltaTime = steps > 0 ? total / steps : 0;
            } else if (key === "preWarmStepCount") {
                const total = p.preWarmTotalTime || 0;
                const steps = p.preWarmStepCount || 0;
                p.preWarmDeltaTime = steps > 0 ? total / steps : 0;
            } else if (key === "preWarmDeltaTime") {
                const steps = p.preWarmStepCount || 0;
                const dt = p.preWarmDeltaTime || 0;
                p.preWarmTotalTime = steps * dt;
            }
        } finally {
            this._linkaging = false;
        }
        this._graphDI?.refresh();
    }
}
