import fs from "fs";
import fpath from "path";

/**
 * VFX 资源导出器
 *
 * ⭐ 注册在 **"lvfx"**（编译产物子资产）上，而不是源 **"vfx"**：
 *   - 场景 / 预制体里的 VisualEffect.asset 字段 assetTypeFilter = "LVFX"，
 *     引用的是 VfxImporter 产出的 `.lvfx` 子资产（uuid 形如 `{父id}@0`），
 *     `.vfx` 源文件本身不进导出图。
 *   - 导出工具按【文件扩展名】查 exporter（AssetManager.getExporterEntry(asset)），
 *     被引用/入队的单元 ext = "lvfx"，所以 exporter 必须挂在 "lvfx" 上才会触发。
 *
 * 职责：把 `.lvfx` 内容带出，并把它内部引用的所有子资源（compute shader / mesh /
 * 曲线纹理 / 自定义蓝图 shader / 各类贴图）加入导出队列，否则运行时按 `res://uuid`
 * 加载这些依赖会 404。
 *
 * ⚠ 不要按固定 key 名收集依赖（旧写法只列了 mesh / *Shader / bakedTexture，
 *    漏掉 mainTexture / customShaderRes / updateStripsShader / _MainTexture /
 *    _MaskTexture / _NormalMap / _Materialize* 等一大批 shader 属性贴图）。
 *    lvfx 结构随 output / shader 变化很大，这里递归遍历整个 JSON，
 *    收集所有 `res://...` 字符串值 + `{_$uuid}` 包装引用，一网打尽。
 *
 * 同时注册在源 "vfx" 上并按 ext 分支：`.vfx` 是编辑器源图（编译成 lvfx 才是运行时
 * 产物），发布包不需要它——若它恰好落在 resources/ 下被强制导出，这里清空 contents
 * 避免把原始编辑器源塞进包；真正的运行时数据由 "lvfx" 分支带出。
 */
@IEditorEnv.regAssetExporter(["vfx", "lvfx"])
export class VfxExporter extends IEditorEnv.AssetExporter {
    async handleExport(): Promise<void> {
        // .vfx 编辑器源：不进发布包（运行时只认编译产物 .lvfx）
        if (this.asset.ext === "vfx") {
            this.exportInfo.contents.length = 0;
            return;
        }

        // this.asset 是 .lvfx 子资产（id = `{父id}@0`），其 file 指向 library 里的产物
        let fullPath = EditorEnv.assetMgr.getFullPath(this.asset);
        if (!fullPath || !fs.existsSync(fullPath)) {
            // 兜底：从父 id 拼 library 路径（子资产 id = `{父id}@0`，文件名即 `{id}.lvfx`）
            let parentId = this.asset.id.split("@")[0];
            fullPath = fpath.join(
                EditorEnv.projectPath, "library",
                parentId.substring(0, 2), this.asset.id + ".lvfx",
            );
            if (!fs.existsSync(fullPath)) return;
        }

        let content = await fs.promises.readFile(fullPath, "utf-8");

        let compiled: any;
        try {
            compiled = JSON.parse(content);
        } catch {
            // 解析失败：原样带出文本（无法收集/改写依赖）
            this.exportInfo.contents[0] = { type: "text", data: content };
            return;
        }

        // ⭐注入内置 VFX shader 引用（procedural billboard / unlit / strip / cube / distortion）。
        //   这些内置 shader 运行时按 res://uuid 加载 .shader 文件注册（VFXInit 预加载），
        //   但发布包无 uuid→路径映射 → res://uuid 404 → shader 未注册 → 纯内置效果
        //   （如 OrientAdvanced 的 procedural billboard）静默不渲染。
        //   这里把这 5 个 .shader 的 res://uuid 注入 lvfx，让导出器把它们导出并改写成相对路径
        //   （下面 collectResLinks + parseLinks），运行时 VFXAssetParser 读取
        //   data.__vfxBuiltinShaders + resolveRef 加载注册。⚠ 用 .shader 的 uuid 不是 .lmat。
        if (!Array.isArray(compiled.__vfxBuiltinShaders)) {
            compiled.__vfxBuiltinShaders = [
                "res://046c3dc9-8ef4-4e3b-bce3-df93e11bd86e", // VFXBillboardProcedural.shader
                "res://9e6cee89-5666-43e3-a064-7c26d8ce36d8", // VFXCubeProcedural.shader
                "res://7b8f3d2e-a415-4c6b-9d8f-2e1a5c3b4d6a", // VFXDistortionQuad.shader
                "res://ce815578-6547-4f83-be80-a89912dc03d0", // VFXUnlit.shader
                "res://d29a39fc-4dd9-4e3c-8451-db6a6092d17a", // VFXStrip.shader
            ];
        }

        // ⭐必须发射【解析后的对象】(type:"json")，不能发射原始字符串：
        //   导出工具在 write 阶段把每个依赖引用改写成指向产物的相对路径
        //   （ExportAssetTool: dep.data[dep.key] = relative(...)），改写作用在
        //   parseLinks 收集时记录的 obj 节点上——只有发射的正是这个被改写的对象，
        //   最终 lvfx 里的 res://uuid 才会变成运行时能解析的相对路径。
        this.exportInfo.contents[0] = { type: "json", data: compiled };

        // 递归收集内部所有 res:// 依赖，加入导出队列
        const links: { obj: any; prop: string; url: string }[] = [];
        collectResLinks(compiled, links);
        if (links.length > 0)
            this.exportInfo.deps = this.parseLinks(links);
    }
}

/**
 * 递归遍历 lvfx JSON，为每一处 `res://...` 引用（含 `{_$uuid}` 包装）收集一条 link。
 * ⚠ 不按 uuid 去重：同一 uuid 可能出现在多个 obj[prop]（如多个 system 的
 *    customShaderRes），每一处都要单独记录，write 阶段才能逐一改写成相对路径；
 *    导出队列的去重由 parseLinks → addQueue 负责，这里不需要。
 */
function collectResLinks(
    node: any,
    links: { obj: any; prop: string; url: string }[],
): void {
    if (node == null || typeof node !== "object") return;

    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
            const v = node[i];
            if (typeof v === "string")
                pushLink(node, "" + i, v, links);
            else
                collectResLinks(v, links);
        }
        return;
    }

    // LayaPro 标准资源引用包装 { _$uuid, _$type }
    if (typeof node._$uuid === "string") {
        pushLink(node, "_$uuid", node._$uuid, links);
        return; // 包装对象内不再有别的资源引用
    }

    for (const key in node) {
        const v = node[key];
        if (typeof v === "string")
            pushLink(node, key, v, links);
        else
            collectResLinks(v, links);
    }
}

function pushLink(
    obj: any,
    prop: string,
    url: string,
    links: { obj: any; prop: string; url: string }[],
): void {
    // 只收 res:// 资源引用；普通字符串（shader 名字、事件名等）不动
    if (typeof url !== "string" || !url.startsWith("res://")) return;
    if (url.length <= 6) return;
    links.push({ obj, prop, url });
}
