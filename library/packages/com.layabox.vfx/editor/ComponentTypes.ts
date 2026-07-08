/**
 * VFX 组件类型描述 —— 让 IDE 在"添加组件"菜单里能找到 VisualEffect，
 * 并让 Inspector 知道 VisualEffect 的属性怎么显示。
 *
 * 引擎仓库的 VisualEffect / VFXRenderer 是纯 TS 类（没有 @regClass / @property
 * 装饰器，引擎仓库规范），所以 IDE 元数据要在这里通过 typeRegistry 手动写出来。
 * 这套写法对齐粒子的 feature-pack/particle/editor/Types.ts。
 */
export const componentTypes: IEditor.FTypeDescriptor[] = [
    {
        // VFXAsset 是 VFXLoader (扩展 lvfx, type "LVFX") 加载的 Resource 子类
        // IDE 用 type 名 "VFXAsset" 匹配运行时类，把 lvfx 文件反序列化成真实例
        // 否则 setter 拿到的是 plain 序列化对象，调 _addReference 会崩
        // 字段对齐 LayaIDE 内置 Texture2D/Material：isAsset + assetTypeFilter 必须有
        name: "VFXAsset",
        isAsset: true,
        isEngineSymbol: true,
        assetTypeFilter: "LVFX",
        properties: [],
    },
    {
        name: "VFXRenderer",
        base: "BaseRender",
        isEngineSymbol: true,
        runInEditor: true,
        requireEngineLibs: ["laya.vfx"],
        // VisualEffect.requireComponents 会自动挂上 VFXRenderer，不从菜单单独加
        properties: [], // LayaIDE TypeRegistry 直接 for...of 遍历，缺字段会报 not iterable
    },
    {
        name: "VisualEffect",
        caption: "Visual Effect",
        base: "Script",
        menu: "Rendering",
        worldType: "3d",
        inHierarchyMenu: true,
        isEngineSymbol: true,
        runInEditor: true,
        requireEngineLibs: ["laya.vfx"],
        requireComponents: ["VFXRenderer"],
        properties: [
            {
                name: "asset",
                type: "VFXAsset",
                isAsset: true,
                assetTypeFilter: "LVFX",
            },
            {
                name: "randomSeed",
                type: "number",
                default: 0,
            },
            {
                name: "resetSeedOnPlay",
                type: "boolean",
                default: true,
            },
            {
                name: "initialEvent",
                type: "string",
                default: "OnPlay",
            },
            {
                // VisualEffect.propertyOverrides 字段：存 JSON string（不能用 type=object，LayaPro 序列化层不识别动态 key map）。
                // Field UI 内部 JSON.parse → object 编辑，setValue 前 JSON.stringify → string。
                // 引擎 runtime 加载时同样 JSON.parse 还原成 object 再调 setPropertyXXX 应用。
                name: "propertyOverrides",
                caption: "Properties",
                type: "string",
                inspector: "VfxPropertyOverrides",
                default: "{}",
            } as any,
        ],
    },
];
