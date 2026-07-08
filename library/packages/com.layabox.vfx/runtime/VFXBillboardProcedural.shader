Shader3D Start
{
    type:Shader3D,
    name:VFXBillboardProcedural,
    enableInstancing:false,
    shaderType:D3,
    supportReflectionProbe:false,
    attributeMap: {
        // 只保留 per-instance attributes（slot 8-12），不使用 mesh vertex attributes
        'a_AttrPosition': ["Vector4", 8],
        'a_AttrColor': ["Vector4", 9],
        'a_AttrRotation': ["Vector4", 10],
        'a_AttrScale': ["Vector4", 11],
        'a_AttrPivot': ["Vector4", 12]
    },
    uniformMap:{
        u_Color: { type: Color },
        u_AlbedoTexture: { type: Texture2D },
        u_SoftParticleFactor: { type: Vector2 },
        u_FlipbookSize: { type: Vector2 },
        u_CropFactor: { type: Float },
        u_AlphaThreshold: { type: Float }
    },
    defines: {
        VFX_PRIMITIVE_QUAD: { type: bool, default: true },
        VFX_PRIMITIVE_TRIANGLE: { type: bool, default: false },
        VFX_PRIMITIVE_OCTAGON: { type: bool, default: false },
        SOFT_PARTICLE: { type: bool, default: false },
        FLIPBOOK: { type: bool, default: false },
        FLIPBOOK_BLEND: { type: bool, default: false },
        SUBPIXEL_AA: { type: bool, default: false },
        VFX_OPAQUE: { type: bool, default: false },
        VFX_ALPHA_CLIP: { type: bool, default: false }
    }
    shaderPass:[
        {
            pipeline:Forward,
            VS:billboardProceduralVS,
            FS:billboardProceduralFS
        }
    ]
}
Shader3D End

GLSL Start
#defineGLSL billboardProceduralVS

    #define SHADER_NAME VFXBillboardProcedural

    #include "Math.glsl";
    #include "Scene.glsl";
    #include "Camera.glsl";
    #include "Sprite3DVertex.glsl";
    #include "VFXRenderCommon.glsl";

    // 注意：不 include VertexCommon.glsl（它会引入对 a_Position/a_Normal 的访问）
    // 也不调用 getVertexParams —— 手动构造顶点数据

    // 复刻 VFXRenderVertex.glsl 的 instance attribute 读取和 TRS 变换
    vec3 rotateByQuat(vec3 v, vec4 q) {
        vec3 t = 2.0 * cross(q.xyz, v);
        return v + q.w * t + cross(q.xyz, t);
    }

    VFXParticle getVFXParticle() {
        VFXParticle p;
        p.position      = a_AttrPosition.xyz;
        p.normalizedAge = a_AttrPosition.w;
        p.color         = a_AttrColor;
        p.rotation      = a_AttrRotation;
        p.scale         = a_AttrScale.xyz;
        p.texIndex      = a_AttrScale.w;
        p.pivot         = a_AttrPivot.xyz;
        return p;
    }

    varying vec4 v_Color;
    varying vec2 v_Texcoord0;
    #ifdef FLIPBOOK_BLEND
    varying vec2 v_Texcoord1;
    varying float v_FlipbookBlend;
    #endif
    #ifdef SOFT_PARTICLE
    varying vec4 v_PositionCS;
    #endif

    #if defined(FLIPBOOK) || defined(FLIPBOOK_BLEND)
    vec2 flipbookUV(float frameIndex, vec2 baseUV, vec2 flipbookSize, vec2 invSize) {
        float idx = floor(frameIndex);
        float col = mod(idx, flipbookSize.x);
        float row = floor(idx * invSize.x);
        return (vec2(col, row) + baseUV) * invSize;
    }
    #endif

    // 根据 gl_VertexID 生成局部 XY 和 UV
    void getProceduralVertex(out vec2 localXY, out vec2 uv) {
        #ifdef VFX_PRIMITIVE_TRIANGLE
        // 严格对齐 Unity VFXConfigPlanarPrimitive.hlsl: 等边三角形 inscribed in unit circle (radius = 1/sqrt(3))
        // kOffsets = bl(-0.5, -0.289), top(0, 0.577), br(0.5, -0.289)
        // uv = (offsets * 0.866) + 0.5 → bl(0.067, 0.25), top(0.5, 1.0), br(0.933, 0.25)
        // 顶点顺序对齐 Unity id % 3 = [bl, top, br]
        vec2 triPos[3] = vec2[3](
            vec2(-0.5, -0.288675129413604736328125),
            vec2( 0.0,  0.57735025882720947265625),
            vec2( 0.5, -0.288675129413604736328125)
        );
        // Unity HLSL convention 直接 sample (uv y=0 atlas top)；
        // WebGPU sampler 也是 uv(0,0)=image top-left → 直接复制 Unity UV，不再反 Y
        vec2 triUV[3] = vec2[3](
            vec2(-0.5, -0.288675129413604736328125) * 0.866025388240814208984375 + vec2(0.5),
            vec2( 0.0,  0.57735025882720947265625) * 0.866025388240814208984375 + vec2(0.5),
            vec2( 0.5, -0.288675129413604736328125) * 0.866025388240814208984375 + vec2(0.5)
        );
        // Unity OpenGL convention 与 WebGPU 反 Y: 字符竖直翻转 → 反 Y 让字符正向
        triUV[0].y = 1.0 - triUV[0].y;
        triUV[1].y = 1.0 - triUV[1].y;
        triUV[2].y = 1.0 - triUV[2].y;
        localXY = triPos[gl_VertexID];
        uv = triUV[gl_VertexID];
        #elif defined(VFX_PRIMITIVE_OCTAGON)
        // 8 角 + 6 三角形（triangle fan from corner 0），共 18 顶点
        // cropFactor 控制裁角：c=0 退化为方形，c=0.5 近似圆形
        float c = u_CropFactor;
        vec2 octCorners[8] = vec2[8](
            vec2(-0.5 + c, -0.5),  // 0: bottom-left-right
            vec2( 0.5 - c, -0.5),  // 1: bottom-right-left
            vec2( 0.5, -0.5 + c),  // 2: right-bottom-up
            vec2( 0.5,  0.5 - c),  // 3: right-top-down
            vec2( 0.5 - c,  0.5),  // 4: top-right-left
            vec2(-0.5 + c,  0.5),  // 5: top-left-right
            vec2(-0.5, 0.5 - c),   // 6: left-top-down
            vec2(-0.5, -0.5 + c)   // 7: left-bottom-up
        );
        int triIdx = gl_VertexID / 3;
        int cornerIdx = gl_VertexID - triIdx * 3;
        int sel = (cornerIdx == 0) ? 0 : (cornerIdx == 1 ? triIdx + 1 : triIdx + 2);
        localXY = octCorners[sel];
        // UV.y 反向（同上对齐 Unity OpenGL）
        uv = vec2(localXY.x + 0.5, 0.5 - localXY.y);
        #else
        // Default: QUAD — 6 顶点（2 三角形）
        vec2 quadPos[6] = vec2[6](
            vec2(-0.5, -0.5), vec2( 0.5, -0.5), vec2(-0.5,  0.5),
            vec2( 0.5, -0.5), vec2( 0.5,  0.5), vec2(-0.5,  0.5)
        );
        // UV.y 反向（同上对齐 Unity OpenGL convention）
        vec2 quadUV[6] = vec2[6](
            vec2(0.0, 1.0), vec2(1.0, 1.0), vec2(0.0, 0.0),
            vec2(1.0, 1.0), vec2(1.0, 0.0), vec2(0.0, 0.0)
        );
        localXY = quadPos[gl_VertexID];
        uv = quadUV[gl_VertexID];
        #endif
    }

    void main() {
        // 从 gl_VertexID 生成局部顶点和 UV
        vec2 localXY;
        vec2 uv;
        getProceduralVertex(localXY, uv);

        // 粒子数据 + TRS 变换（复刻 vfxProcessVertex）
        VFXParticle p = getVFXParticle();
        vec3 posOS = vec3(localXY, 0.0);
        vec3 v = posOS - p.pivot;
        v = v * p.scale;
        v = rotateByQuat(v, p.rotation);
        vec3 localAfterTRS = v + p.position;

        // Local → World
        mat4 worldMat = getWorldMatrix();
        vec4 pos = worldMat * vec4(localAfterTRS, 1.0);
        vec3 positionWS = pos.xyz / pos.w;

        v_Color = p.color;

        #if defined(FLIPBOOK) || defined(FLIPBOOK_BLEND)
        vec2 fbSize = max(u_FlipbookSize, vec2(1.0));
        vec2 invSize = 1.0 / fbSize;
        float totalFrames = fbSize.x * fbSize.y;
        float frameF = mod(p.texIndex, totalFrames);
        v_Texcoord0 = flipbookUV(frameF, uv, fbSize, invSize);
        #ifdef FLIPBOOK_BLEND
        float nextFrame = mod(floor(frameF) + 1.0, totalFrames);
        v_Texcoord1 = flipbookUV(nextFrame, uv, fbSize, invSize);
        v_FlipbookBlend = fract(frameF);
        #endif
        #else
        v_Texcoord0 = uv;
        #endif

        gl_Position = getPositionCS(positionWS);
        gl_Position = remapPositionZ(gl_Position);

        #ifdef SOFT_PARTICLE
        v_PositionCS = gl_Position;
        #endif
    }
#endGLSL

#defineGLSL billboardProceduralFS

    #define SHADER_NAME VFXBillboardProcedural

    #include "Color.glsl";
    #include "Scene.glsl";
    #include "Camera.glsl";
    #include "Sprite3DFrag.glsl";

    #ifdef SOFT_PARTICLE
    #include "DepthNormalUtil.glsl";
    #endif

    varying vec4 v_Color;
    varying vec2 v_Texcoord0;
    #ifdef FLIPBOOK_BLEND
    varying vec2 v_Texcoord1;
    varying float v_FlipbookBlend;
    #endif
    #ifdef SOFT_PARTICLE
    varying vec4 v_PositionCS;
    #endif

    void main() {
        #ifdef FLIPBOOK_BLEND
        vec4 texColor0 = texture2D(u_AlbedoTexture, v_Texcoord0);
        vec4 texColor1 = texture2D(u_AlbedoTexture, v_Texcoord1);
        vec4 texColor = mix(texColor0, texColor1, v_FlipbookBlend);
        #else
        vec4 texColor = texture2D(u_AlbedoTexture, v_Texcoord0);
        #endif
        // Alpha Clipping (对齐 Unity VFXPlanarPrimitiveOutput useAlphaClipping):
        // 当 texColor.a < threshold 时 discard, atlas 非字符部分透明，背景方块消失。
        // 字符 mask + 背景 alpha=0 的 atlas 必备 (TX_Flipbook_example 数字字符就是这种).
        #ifdef VFX_ALPHA_CLIP
        if (texColor.a < u_AlphaThreshold) discard;
        #endif
        #ifdef VFX_OPAQUE
        // Opaque 模式：对齐 Unity VFX — 粒子颜色 tint 纹理（multiply），不是 mix
        // 之前用 mix(particleColor, texColor.rgb, texColor.a) 让 alpha=1 区完全显示纹理 RGB
        // 忽略粒子颜色 → TX_Brush 这种白色 mask 纹理在 cyan 粒子上渲染成白色不是 tinted cyan
        vec4 finalColor = vec4(u_Color.rgb * v_Color.rgb * texColor.rgb, 1.0);
        #else
        vec4 finalColor = u_Color * texColor * v_Color;
        #endif

        #ifdef SOFT_PARTICLE
        vec2 screenUV = (v_PositionCS.xy / v_PositionCS.w) * 0.5 + 0.5;
        float sceneDepthRaw = SAMPLE_DEPTH_TEXTURE(u_CameraDepthTexture, screenUV);
        float sceneEye = LinearEyeDepth(sceneDepthRaw, u_ZBufferParams);
        float particleEye = v_PositionCS.w;
        float softness = max(u_SoftParticleFactor.x, 1e-4);
        float fade = clamp((sceneEye - particleEye) / softness, 0.0, 1.0);
        finalColor.a *= fade;
        #endif

        #ifdef SUBPIXEL_AA
        vec2 _aaW = fwidth(v_Texcoord0) * 0.5;
        vec2 _aaCov = smoothstep(vec2(0.0), _aaW, v_Texcoord0) * smoothstep(vec2(0.0), _aaW, vec2(1.0) - v_Texcoord0);
        finalColor.a *= _aaCov.x * _aaCov.y;
        #endif

        gl_FragColor = finalColor;
        gl_FragColor = outputTransform(gl_FragColor);
    }
#endGLSL
GLSL End
