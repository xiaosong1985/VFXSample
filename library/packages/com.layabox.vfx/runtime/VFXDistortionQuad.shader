Shader3D Start
{
    type:Shader3D,
    name:VFXDistortionQuad,
    enableInstancing:false,
    shaderType:D3,
    supportReflectionProbe:false,
    attributeMap: {
        'a_AttrPosition': ["Vector4", 8],
        'a_AttrColor': ["Vector4", 9],
        'a_AttrRotation': ["Vector4", 10],
        'a_AttrScale': ["Vector4", 11],
        'a_AttrPivot': ["Vector4", 12]
    },
    uniformMap:{
        u_Color: { type: Color },
        u_AlbedoTexture: { type: Texture2D },
        u_DistortionStrength: { type: Float },
        u_FlipbookSize: { type: Vector2 }
    },
    defines: {
        FLIPBOOK: { type: bool, default: false },
        USE_NORMAL_MAP: { type: bool, default: false }
    }
    shaderPass:[
        {
            pipeline:Forward,
            VS:distortionVS,
            FS:distortionFS
        }
    ]
}
Shader3D End

GLSL Start
#defineGLSL distortionVS

    #define SHADER_NAME VFXDistortionQuad

    #include "Math.glsl";
    #include "Scene.glsl";
    #include "Camera.glsl";
    #include "Sprite3DVertex.glsl";
    #include "VFXRenderCommon.glsl";

    // 不 include VertexCommon.glsl，手动构造 Quad 顶点数据

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
    varying float v_NormalizedAge;

    #ifdef FLIPBOOK
    vec2 flipbookUV(float frameIndex, vec2 baseUV, vec2 flipbookSize, vec2 invSize) {
        float idx = floor(frameIndex);
        float col = mod(idx, flipbookSize.x);
        float row = floor(idx * invSize.x);
        return (vec2(col, row) + baseUV) * invSize;
    }
    #endif

    void main() {
        // Quad 6 顶点（2 三角形）
        vec2 quadPos[6] = vec2[6](
            vec2(-0.5, -0.5), vec2( 0.5, -0.5), vec2(-0.5,  0.5),
            vec2( 0.5, -0.5), vec2( 0.5,  0.5), vec2(-0.5,  0.5)
        );
        vec2 quadUV[6] = vec2[6](
            vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
            vec2(1.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0)
        );
        vec2 localXY = quadPos[gl_VertexID];
        vec2 uv = quadUV[gl_VertexID];

        VFXParticle p = getVFXParticle();
        vec3 posOS = vec3(localXY, 0.0);
        vec3 v = posOS - p.pivot;
        v = v * p.scale;
        v = rotateByQuat(v, p.rotation);
        vec3 localAfterTRS = v + p.position;

        mat4 worldMat = getWorldMatrix();
        vec4 pos = worldMat * vec4(localAfterTRS, 1.0);
        vec3 positionWS = pos.xyz / pos.w;

        v_Color = p.color;
        v_NormalizedAge = p.normalizedAge;

        #ifdef FLIPBOOK
        vec2 fbSize = max(u_FlipbookSize, vec2(1.0));
        vec2 invSize = 1.0 / fbSize;
        float totalFrames = fbSize.x * fbSize.y;
        float frameF = mod(p.texIndex, totalFrames);
        v_Texcoord0 = flipbookUV(frameF, uv, fbSize, invSize);
        #else
        v_Texcoord0 = uv;
        #endif

        gl_Position = getPositionCS(positionWS);
        gl_Position = remapPositionZ(gl_Position);
    }
#endGLSL

#defineGLSL distortionFS

    #define SHADER_NAME VFXDistortionQuad

    #include "Color.glsl";
    #include "Scene.glsl";
    #include "Camera.glsl";
    #include "Sprite3DFrag.glsl";

    varying vec4 v_Color;
    varying vec2 v_Texcoord0;
    varying float v_NormalizedAge;

    // ─────────────────────────────────────────────────────────────
    // Heat Shimmer 效果（自包含，不采场景 opaque texture）
    //
    // 原本 outputDistortion 需要采 u_CameraOpaqueTexture 做 UV 偏移实现真折射，
    // 但 Laya 引擎的 opaque blit 未实现（详见 feedback_engine_opaque_blit_fix.md）。
    // 临时改为径向动画波纹 + 噪声的装饰效果，视觉上像"热浪/能量光斑"。
    //
    // u_DistortionStrength 重用为亮度/密度控制：0~0.3 典型值
    // ─────────────────────────────────────────────────────────────

    // Hash 函数：生成 per-pixel 随机值
    float hash21(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
        // 径向坐标
        vec2 centered = v_Texcoord0 - vec2(0.5);
        float r = length(centered) * 2.0;  // 0 center, 1 at axis-edge, ~1.414 at corner

        // 圆形 edge mask（quad 范围内衰减到 0）
        float edgeMask = clamp(1.0 - r, 0.0, 1.0);
        edgeMask = edgeMask * edgeMask * (3.0 - 2.0 * edgeMask);

        // 动画径向波纹：正弦波沿半径方向外扩，时间推进
        // 用 u_Time 驱动动画
        float waveFreq = 12.0;
        float waveSpeed = 2.5;
        float wavePhase = r * waveFreq - u_Time * waveSpeed;
        float wave = sin(wavePhase) * 0.5 + 0.5;
        wave = pow(wave, 2.0);  // 压缩到亮带 + 细节更锐利

        // 角度噪声：让波纹不是完美同心，带"气流"感
        float angle = atan(centered.y, centered.x);
        float angNoise = hash21(vec2(floor(angle * 6.0), floor(u_Time * 2.0)));
        float shimmer = mix(0.65, 1.0, angNoise);

        // 粒子生命周期衰减（刚出生→强，临死→弱）
        float lifeFade = 1.0 - v_NormalizedAge * 0.6;

        // 组合：粒子 tint × 波纹亮度 × shimmer × lifeFade × 强度因子
        vec3 tint = v_Color.rgb * u_Color.rgb;
        // 兜底白色（v_Color 全 0 时）
        float hasColor = step(0.01, max(tint.r, max(tint.g, tint.b)));
        vec3 baseColor = mix(vec3(1.0), tint, hasColor);

        float intensity = wave * shimmer * lifeFade;
        vec3 col = baseColor * intensity;

        // 透明度：edge mask × 粒子 alpha × 基础不透明度
        // DistortionStrength 放大 wave alpha 贡献（越大越醒目）
        float baseAlpha = edgeMask * v_Color.a * u_Color.a;
        float waveAlpha = baseAlpha * (0.2 + wave * 0.8) * (1.0 + u_DistortionStrength * 4.0);

        gl_FragColor = vec4(col, clamp(waveAlpha, 0.0, 1.0));
        gl_FragColor = outputTransform(gl_FragColor);
    }
#endGLSL
GLSL End
