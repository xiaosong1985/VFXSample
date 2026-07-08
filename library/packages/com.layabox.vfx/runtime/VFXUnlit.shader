Shader3D Start
{
    type:Shader3D,
    name:VFXUnlit,
    enableInstancing:false,
    shaderType:D3,
    supportReflectionProbe:false,
    attributeMap: {
        'a_Position': ["Vector4", 0],
        'a_Color': ["Vector4", 1],
        'a_Texcoord0': ["Vector2", 2],
        'a_Normal': ["Vector3", 3],
        'a_Tangent0': ["Vector4", 4],
        'a_Texcoord1': ["Vector2", 7],

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
        u_FlipbookSize: { type: Vector2 }
    },
    defines: {
        SOFT_PARTICLE: { type: bool, default: false },
        FLIPBOOK: { type: bool, default: false },
        FLIPBOOK_BLEND: { type: bool, default: false },
        SUBPIXEL_AA: { type: bool, default: false },
        VFX_OPAQUE: { type: bool, default: false }
    }
    shaderPass:[
        {
            pipeline:Forward,
            VS:unlitVS,
            FS:unlitPS
        },
        {
            pipeline:ShadowCaster,
            VS:vfxShadowVS,
            FS:vfxShadowFS
        }
    ]
}
Shader3D End

GLSL Start
#defineGLSL unlitVS

    #define SHADER_NAME VFXUnlit

    #include "Math.glsl";

    #include "Scene.glsl";

    #include "Camera.glsl";
    #include "Sprite3DVertex.glsl";

    #include "VertexCommon.glsl";
    #include "VFXRenderVertex.glsl";

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
    // 对齐 Unity VFXCommon.hlsl VFXGetFlipBookUV
    vec2 flipbookUV(float frameIndex, vec2 baseUV, vec2 flipbookSize, vec2 invSize)
    {
        float idx = floor(frameIndex);
        float col = mod(idx, flipbookSize.x);
        float row = floor(idx * invSize.x);
        return (vec2(col, row) + baseUV) * invSize;
    }
    #endif

    void main()
    {
        Vertex vertex;
        getVertexParams(vertex);
        VFXParticle p = vfxProcessVertex(vertex);

        mat4 worldMat = getWorldMatrix();
        vec3 positionWS = vfxWorldPosition(vertex, worldMat);

        v_Color = p.color;

        #if defined(FLIPBOOK) || defined(FLIPBOOK_BLEND)
        vec2 fbSize = max(u_FlipbookSize, vec2(1.0));
        vec2 invSize = 1.0 / fbSize;
        float totalFrames = fbSize.x * fbSize.y;
        float frameF = mod(p.texIndex, totalFrames);
        v_Texcoord0 = flipbookUV(frameF, a_Texcoord0, fbSize, invSize);
        #ifdef FLIPBOOK_BLEND
        float nextFrame = mod(floor(frameF) + 1.0, totalFrames);
        v_Texcoord1 = flipbookUV(nextFrame, a_Texcoord0, fbSize, invSize);
        v_FlipbookBlend = fract(frameF);
        #endif
        #else
        v_Texcoord0 = a_Texcoord0;
        #endif

        gl_Position = getPositionCS(positionWS);
        gl_Position = remapPositionZ(gl_Position);

        #ifdef SOFT_PARTICLE
        v_PositionCS = gl_Position;
        #endif
    }
#endGLSL

#defineGLSL unlitPS

    #define SHADER_NAME VFXUnlit

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

    void main()
    {
        #ifdef FLIPBOOK_BLEND
        vec4 texColor0 = texture2D(u_AlbedoTexture, v_Texcoord0);
        vec4 texColor1 = texture2D(u_AlbedoTexture, v_Texcoord1);
        vec4 texColor = mix(texColor0, texColor1, v_FlipbookBlend);
        #else
        vec4 texColor = texture2D(u_AlbedoTexture, v_Texcoord0);
        #endif
        #ifdef VFX_OPAQUE
        // Opaque 模式：对齐 Unity VFX — 粒子颜色 tint 纹理（multiply），不是 mix
        // 之前用 mix(particleColor, texColor.rgb, texColor.a) 让 alpha=1 区完全显示纹理 RGB
        // 忽略粒子颜色 → TX_Brush 这种白色 mask + alpha 通道纹理在 cyan 粒子上渲染成白色不是 tinted cyan
        // multiply 让 white texture × cyan particle = cyan brush stroke，跟 Additive 分支一致
        vec4 finalColor = vec4(u_Color.rgb * v_Color.rgb * texColor.rgb, 1.0);
        #else
        vec4 finalColor = u_Color * texColor * v_Color;
        #endif

        #ifdef SOFT_PARTICLE
        // 屏幕 UV（NDC -> [0,1]）
        vec2 screenUV = (v_PositionCS.xy / v_PositionCS.w) * 0.5 + 0.5;
        // Laya 某些后端 Y 需翻转，通过 Scene/Camera 常量统一；这里按标准 GL 处理
        float sceneDepthRaw = SAMPLE_DEPTH_TEXTURE(u_CameraDepthTexture, screenUV);
        float sceneEye = LinearEyeDepth(sceneDepthRaw, u_ZBufferParams);
        // 粒子片元 eye-space 深度：clip.w 在透视投影下 ≈ eye-space Z
        float particleEye = v_PositionCS.w;
        float softness = max(u_SoftParticleFactor.x, 1e-4);
        float fade = clamp((sceneEye - particleEye) / softness, 0.0, 1.0);
        finalColor.a *= fade;
        #endif

        #ifdef SUBPIXEL_AA
        // 对齐 Unity VFX subpixelAA：alpha 按片段覆盖率（基于 UV fwidth）衰减，解决亚像素闪烁
        vec2 _aaW = fwidth(v_Texcoord0) * 0.5;
        vec2 _aaCov = smoothstep(vec2(0.0), _aaW, v_Texcoord0) * smoothstep(vec2(0.0), _aaW, vec2(1.0) - v_Texcoord0);
        finalColor.a *= _aaCov.x * _aaCov.y;
        #endif

        gl_FragColor = finalColor;

        gl_FragColor = outputTransform(gl_FragColor);
    }
#endGLSL

#defineGLSL vfxShadowVS

    #define SHADER_NAME VFXShadowCaster

    #include "DepthVertex.glsl";
    #include "VFXRenderVertex.glsl";

    void main()
    {
        Vertex vertex;
        getVertexParams(vertex);
        VFXParticle p = vfxProcessVertex(vertex);

        mat4 worldMat = getWorldMatrix();
        vec3 positionWS = vfxWorldPosition(vertex, worldMat);

        // 使用粒子面朝方向作为法线（简化）
        vec3 normalWS = normalize(u_CameraPos - positionWS);

        vec4 positionCS = DepthPositionCS(positionWS, normalWS);
        gl_Position = remapPositionZ(positionCS);
    }
#endGLSL

#defineGLSL vfxShadowFS

    #define SHADER_NAME VFXShadowCaster

    #include "DepthFrag.glsl";

    void main()
    {
        gl_FragColor = getDepthColor();
    }
#endGLSL
GLSL End

