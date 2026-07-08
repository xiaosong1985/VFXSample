# VFX Graph 插件 — Laya VFX 使用指南

> 本 README 与示例项目 `LayaVFXSample/docs/VFX-Guide.md` 保持同步。插件单独安装后可独立阅读。

LayaAir 3.x 的 VFX Graph 是一套基于 Compute Shader 的 GPU 驱动视觉特效系统，通过可视化节点图编辑大规模粒子 / Mesh / 拖尾等特效。本文档面向首次接触 Laya VFX 的开发者，从「整体链路 → 单节点职责 → 示例拆解」三层带你跑通最小用例。

> 运行依赖：WebGPU（VFX 模块需要 Compute Shader 支持，需开启 WebGPU 渲染后端）。

---

## 1. 整体架构

VFX 在引擎里由两块构成：

| 层 | 职责 |
|---|---|
| **运行时引擎模块** (`laya.vfx`) | 解析编译产物 `.lvfx`，驱动 GPU 计算 + 渲染 |
| **IDE 插件** (`com.layabox.vfx`，VFX Graph 编辑器) | 可视化编辑 `.vfx` 源文件，import 时编译成 `.lvfx` + 一组 compute shader 子资产 |

资源链：

```
.vfx (节点图源文件)  ─── 编辑器编译 ───►  .lvfx (运行时资源) + *.computeshader
                                                │
                                                ▼
                                  VisualEffect 组件加载 (运行时)
```

---

## 2. 快速开始 — 在场景中挂一个 VFX

最少 3 步：

1. **新建 `.vfx` 资源**：项目资源面板右键 → 创建 → VFX Graph。双击打开「VFX Graph」面板编辑节点。
2. **新建场景节点**：往 3D 场景里拖一个 `Sprite3D`（空节点）。
3. **挂组件**：选中节点 → 增加组件 → `Rendering / Visual Effect`。组件会自动连带创建 `VFXRenderer`（实际负责绘制的 Render Component）。

设置 `Visual Effect` 组件的字段：

| 字段 | 说明 |
|---|---|
| **Asset** | 引用一个 `.vfx` / `.lvfx` 资源 |
| **Random Seed** | 粒子随机种子。同种子+同时间序列复现完全一致的随机粒子 |
| **Reset Seed On Play** | 每次 `Play()` 重置 seed |
| **Initial Event** | 初始触发的事件名，默认 `OnPlay` —— 跟 .vfx 里的 Spawn Event 名字对得上才会启动 |

运行后 `VisualEffect` 自动开始模拟，`VFXRenderer` 把每个 Output 节点对应的粒子绘制出来。

---

## 3. 执行链路：Event → Spawn → Initialize → Update → Output

每个 vfx graph 由若干 **Context** 串成一条数据流：

```
┌─────────┐         ┌──────────┐         ┌────────────┐         ┌────────┐         ┌──────────┐
│  Event  ├────────►│  Spawn   ├────────►│ Initialize ├────────►│ Update ├────────►│  Output  │
│ OnPlay  │ trigger │ rate=10  │ spawnEvt│ pos/vel/.. │ flow    │ /tick  │ flow    │ Mesh/... │
└─────────┘         └──────────┘         └────────────┘         └────────┘         └──────────┘
                       (每秒生成 N 个)        (诞生时一次性)         (每帧全部活粒子)        (每帧绘制)
```

### 3.1 Event Context — 事件触发

驱动整个 graph 启动 / 停止的入口。

- **`OnPlay`**：组件 `Play()` 触发；默认 Initial Event
- **`OnStop`**：组件 `Stop()` 触发
- 自定义事件：在 .vfx 里加 Event 节点并自己命名，代码里 `vfx.sendEvent("MyEvent")` 触发

事件可以同时连多个 Spawn —— 一个事件触发多组生成器。

### 3.2 Spawn Context — 生成节奏

决定**何时生成多少粒子**。**注意：Spawn 不知道粒子长什么样，只决定数量节奏**。Spawn 通过 `spawnEvt` flow 输出连接到下游的 Initialize。

常用属性：

| 字段 | 含义 |
|---|---|
| `Loop Duration` | 一次循环时长。`Infinite` 表示无限不停 |
| `Loop Count` | 循环次数。`Infinite` 持续循环 |
| `Delay Before/After Loop` | 循环前/后的间隔 |

常用 Spawn Block（具体生成规则）：

- **Constant Rate**：固定速率，每秒 N 个（最常用）
- **Single Burst**：一次性爆发 N 个
- **Periodic Burst**：每隔 T 秒爆发 N 个
- **Custom Spawner**：脚本回调驱动 spawn count

### 3.3 Initialize Context — 诞生时一次性初始化

新粒子诞生**当帧执行一次**，给粒子设置初始位置、速度、颜色、大小、生命周期等属性。结束后这些值就被「烘」到了粒子上，不再每帧改动（除非 Update Context 再写）。

Context 自身属性：

| 字段 | 含义 |
|---|---|
| `Space` | `Local` 表示属性是相对组件节点的本地坐标；`World` 表示世界坐标 |
| `Capacity` | 系统的粒子池容量。同时存在的活粒子数 ≤ 此值。超过会被 spawn 直接丢弃 |
| `Bounds Mode` | `Automatic` 引擎自动算包围盒（用于视锥剔除）；`Manual` 手填中心和尺寸 |

常用 Block：

- **Set Attribute**：直接给属性赋值（position / velocity / color / size / lifetime / ...）
- **Set Position (Shape)**：在球 / 立方体 / 圆锥 / 圆环 / 平面等形状上随机生成位置
- **Set Velocity from Direction & Speed**：按方向 + 速度初始化速度
- **Set Attribute (Curve / Map)**：用曲线 / 纹理采样作为初始值（受 Random / OverLife 影响）

### 3.4 Update Context — 每帧更新

针对**所有活粒子**每帧执行的逻辑。最常见用途：

- **Force / Gravity**：施加重力、风力、引力
- **Drag / Turbulence**：阻力、湍流扰动
- **Collision**：和平面 / 球 / AABox / SDF 碰撞
- **Conform To Sphere/Box**：把粒子吸附到某个形状表面
- **Kill (Plane / Sphere / ...)**：粒子进入某区域就死亡
- **Trigger Event**：粒子死亡时触发 GPU Event 给另一个 system（粒子链式产生粒子）

Context 自身属性（默认全开即可）：

| 字段 | 含义 |
|---|---|
| `Update Position` | 自动按速度更新位置 (`position += velocity * dt`) |
| `Age Particles` | 自动累加 age |
| `Reap Particles` | 自动按 age >= lifetime 杀死粒子 |

> Update Context 没有 Block 也能正常跑 —— 上述「位置积分 / 老化 / 死亡」是自带的。Block 是「在自带行为上再加自定义逻辑」。

### 3.5 Output Context — 绘制

把活粒子按选定的几何形态绘制出来。每个 Output Context 对应一个 draw call。

常用 Output 类型：

| 类型 | 几何 | 典型用途 |
|---|---|---|
| **Output Billboard** | 朝向相机的 quad | 烟雾、火焰、闪光等贴图特效 |
| **Output Mesh** | 任意 mesh | 飞镖、子弹、碎片 |
| **Output Trail** | 沿粒子轨迹的拖尾 strip | 子弹拖尾、刀光 |
| **Output Line / LineStrip** | 线段 / 折线 | 雷电、能量束 |
| **Output Distortion** | 屏幕扭曲 quad | 爆炸冲击波折射 |
| **Output ShaderGraph (Quad/Mesh)** | 自定义 ShaderGraph 接管 fragment 着色 |
| **Output Static Mesh** | 单次绘制静态 Mesh（非粒子）| 由 graph 驱动 transform/color 的固定几何 |

常用属性（不同 Output 略有差异）：

- `Mesh` / `Texture` — 几何或贴图引用
- `Blend Mode` — `Alpha` / `Additive` / `AlphaPremultiplied`
- `Use Alpha Clipping` + `Alpha Threshold` — 像素 alpha 测试
- `Soft Particle Fade` — 与场景深度相交时柔化淡出
- `UV Mode` — `Default` / `Flipbook` 等
- `Camera Sort` — 是否按距离相机排序（半透明前后正确遮挡）
- `Frustum Culling` — 视锥剔除

Output 也可以挂 Block：

- **Color over Life / Alpha over Life** — 生命周期渐变
- **Orient** — 朝向控制（Face Camera / Along Velocity / Look At ...）
- **Flipbook Play** — 序列帧动画
- **Camera Fade** — 远近相机距离淡入淡出

---

## 4. 示例讲解 — 最简单的 VFX

项目里的最小示例位于 `LayaVFXSample/assets/resources/VfxGraph.vfx`，IDE 中打开它即可看到完整节点图。

链路（顶到底）：

```
OnPlay (Initial Event)
   │
   ▼
┌──────────────────────────────┐
│  Spawn                       │
│  Loop Duration:  Infinite    │
│  Loop Count:     Infinite    │
│  ┌────────────────────────┐  │
│  │ Constant Rate          │  │
│  │   Rate = 10            │  │  →  每秒生成 10 个粒子
│  └────────────────────────┘  │
└──────────────┬───────────────┘
               │ spawnEvt
               ▼
┌──────────────────────────────────────────────┐
│  System 1                                    │  (Initialize → Update → Output 同一组)
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │  Initialize                            │  │
│  │  Space:    Local                       │  │  ← 粒子坐标参考组件节点本地坐标
│  │  Capacity: 64                          │  │  ← 同时最多 64 个活粒子
│  │  ┌──────────────────────────────────┐  │  │
│  │  │ Set Position (attribute)         │  │  │  ← 初始位置 (0,0,0)
│  │  │   position = (0, 0, 0)           │  │  │
│  │  └──────────────────────────────────┘  │  │
│  │  ┌──────────────────────────────────┐  │  │
│  │  │ Set Velocity (attribute)         │  │  │  ← 初始速度 (0, 5, 0) 向上
│  │  │   velocity = (0, 5, 0)           │  │  │
│  │  └──────────────────────────────────┘  │  │
│  └────────────────┬───────────────────────┘  │
│                   │ output flow              │
│                   ▼                          │
│  ┌────────────────────────────────────────┐  │
│  │  Update                                │  │  ← 空 Block，默认行为：
│  │   (无自定义 Block)                     │  │     - 自动积分位置 (pos += vel * dt)
│  └────────────────┬───────────────────────┘  │     - 自动老化 + reap
│                   │ output flow              │
│                   ▼                          │
│  ┌────────────────────────────────────────┐  │
│  │  Output Mesh                           │  │  ← 每帧把活粒子用 Sphere.lm 绘制
│  │  Mesh:       Sphere.lm                 │  │
│  │  Blend Mode: Alpha                     │  │
│  │  UV Mode:    Default                   │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

**执行效果**：

1. 组件 `Play()` 触发 `OnPlay` 事件 → Spawn 启动
2. Spawn 每秒生成 10 个粒子事件，发给 Initialize
3. Initialize 给每个新粒子一次性写入 `position=(0,0,0)`、`velocity=(0,5,0)`
4. Update 没自定义逻辑，依靠默认 `position += velocity * dt` 让粒子向上飘
5. Output Mesh 把所有活粒子用 Sphere 网格画出来 → 看到一串向上飞的球

**右侧 Inspector 的图级属性**（无节点选中时）：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `Fixed Delta Time` | false | 是否用固定 dt（不随帧率波动） |
| `Exact Fixed Time` | false | Fixed Delta 是否严格不丢帧 |
| `Ignore Time Scale` | false | 忽略 `Time.timeScale`（VFX 不受暂停影响） |
| `PreWarm Total Time` | 0 | 预热总时间（粒子在场景初始时已存在的"预演"时长）|
| `PreWarm Step Count` | 0 | 预热步数 |
| `PreWarm Delta Time` | 0 | 预热单步 dt（三者满足 Total = Step × Delta） |
| `Initial Event Name` | OnPlay | 启动事件名 |

---

## 5. 进阶链路：Properties / Operator / GPU Event

### Properties（图级变量）

左下角「属性」面板里可以加图级 Property（int / float / Vec2 / Color / Texture2D / Mesh 等），代码里可以动态读写：

```ts
const vfx = sprite.getComponent(VisualEffect);
vfx.setFloat("MyEmissionRate", 25);
vfx.setVector3("WindDir", new Vector3(1, 0, 0));
vfx.setTexture("RampTex", rampTex);
```

`Property Settings` 面板可控制 `exposed`（是否对外暴露）、`min/max`（Range mode）、`default` 等。

### Operator（独立计算节点）

不挂在 Context 内、独立的纯计算节点，输出值可以接到 Block 的输入插槽。常用类型：

- **数学**：add / multiply / lerp / smoothstep / clamp / power...
- **向量**：dot / cross / length / normalize / reflect / refract
- **采样**：sampleCurve / sampleGradient / sampleTexture2D / sampleSDF
- **属性读取**：Get Attribute（age / lifetime / velocity / ...）/ Get Property（图级属性）
- **噪声**：noise / curlNoise / worleyNoise
- **几何**：rotate2D / rotate3D / lookAt / Conform Shape

典型用法：在 Initialize 的 Set Velocity Block 上接一个 `multiply(Get Property("Speed"), Get Attribute("randomDir"))`，让初速度同时受图级 `Speed` 属性和粒子随机方向影响。

### GPU Event

让粒子在 update 阶段（比如死亡 / 进入区域）触发**另一个 system 生成新粒子**，纯 GPU 处理无 CPU 往返。例子：烟花主弹粒子死亡时触发子弹爆开。

在 Update Context 加 `Trigger Event` Block（或 `Trigger Event on Shape Enter`），输出连一个 `GPUEvent` 节点，再把它的 `SpawnEvent` 输出连接到新的 system 的 Initialize。

---

## 6. 调试与排查

| 现象 | 排查 |
|---|---|
| 粒子不出来 | 1. 浏览器/设备是否开 WebGPU；2. `Initial Event` 是否对得上 .vfx 里的事件名 |
| 粒子能出但不动 | 检查 Initialize 是否设了 velocity；Update 的 `Update Position` 是否勾选 |
| 数量达不到预期 | Initialize 的 `Capacity` 是否太小（默认 64，密集场景调到几百~几千） |
| Inspector 标签被截断 | VFX Graph 面板右栏当前 380px，可继续调整 `VfxGraphPanel.ts:RIGHT_W` |
| .vfx 没生成 .lvfx 子资产 | LayaPro dev 模式需 `npm run install-nativetools` 装 KtxPixelTool 等工具链 |

---

## 7. 参考资源

- 示例项目：`LayaVFXSample/assets/resources/LearningTemplates/vfx/` —— 90+ 个完整示例，覆盖常见粒子 / Mesh / 拖尾 / SDF / GPU Event 等场景
- 引擎源码：`LayaAir/src/layaAir/laya/vfx/`
- 编辑器源码：`VfxEditor/`（已发布为 `com.layabox.vfx` 插件包）

---

*文档版本：v1.0 / 2026-05-20*
