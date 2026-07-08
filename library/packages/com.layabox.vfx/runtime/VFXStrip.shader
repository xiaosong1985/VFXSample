Shader3D Start
{
    type:Shader3D,
    name:VFXStrip,
    enableInstancing:false,
    shaderType:D3,
    supportReflectionProbe:false,
    attributeMap: {
        'a_Position': ["Vector4", 0],
        'a_Color': ["Vector4", 1],
        'a_Texcoord0': ["Vector2", 2],
        'a_Normal': ["Vector3", 3]
    },
    uniformMap:{
        u_Color: { type: Color },
        u_AlbedoTexture: { type: Texture2D },
        u_VfxStripGradient: { type: Texture2D },
        u_VfxUVScale: { type: Vector2 },
        u_VfxUVBias: { type: Vector2 },
        u_VfxStripTilingSegments: { type: Float }
    },
    defines: {
        VFX_STRIP_GRADIENT_MAPPED: { type: bool, default: false },
        VFX_STRIP_UV_SCALE_BIAS: { type: bool, default: false },
        VFX_STRIP_REPEAT_PER_SEGMENT: { type: bool, default: false }
    }
    shaderPass:[
        {
            pipeline:Forward,
            VS:stripVS,
            FS:stripPS
        }
    ]
}
Shader3D End

GLSL Start
#defineGLSL stripVS

    #define SHADER_NAME VFXStrip
    #define COLOR

    #include "Scene.glsl";
    #include "Camera.glsl";
    #include "Sprite3DVertex.glsl";

    varying vec4 v_Color;
    varying vec2 v_Texcoord0;

    void main()
    {
        mat4 worldMat = getWorldMatrix();
        vec4 posWS = worldMat * a_Position;

        v_Color = a_Color;
        v_Texcoord0 = a_Texcoord0;

        gl_Position = getPositionCS(posWS.xyz);
        gl_Position = remapPositionZ(gl_Position);
    }
#endGLSL

#defineGLSL stripPS

    #define SHADER_NAME VFXStrip

    #include "Color.glsl";
    #include "Scene.glsl";
    #include "Camera.glsl";

    varying vec4 v_Color;
    varying vec2 v_Texcoord0;

    void main()
    {
        vec2 _uv = v_Texcoord0;
        // tilingMode=RepeatPerSegment (Unity): 每 segment 内 tile 一次 texture, 让 outline/pattern 沿 strip 重复
        // vertex 输出 uv.x = stripRatio (0..1 沿整 strip), 这里乘 segments (ppsc-1) 后 fract 自动 tile
        #ifdef VFX_STRIP_REPEAT_PER_SEGMENT
            _uv.x = fract(_uv.x * u_VfxStripTilingSegments);
        #endif
        #ifdef VFX_STRIP_UV_SCALE_BIAS
            _uv = _uv * u_VfxUVScale + u_VfxUVBias;
        #endif

        vec4 baseColor = u_Color * v_Color;
        vec4 texColor = texture2D(u_AlbedoTexture, _uv);

        #ifdef VFX_STRIP_GRADIENT_MAPPED
            // ColorMapping = GradientMapped (对齐 Unity VFXParticleCommon.template):
            //   o.color = SampleGradient(gradient, VFX_TEXTURE_COLOR.a * color.a) * float4(color.rgb, 1.0)
            // t = texture.a * vertex.a 让 alpha overlife 调制 t, 让 ribbon 沿长度方向显示 gradient 不同色。
            float gradT = texColor.a * baseColor.a;
            vec4 gradColor = texture2D(u_VfxStripGradient, vec2(gradT, 0.5));
            baseColor.rgb *= gradColor.rgb;
            baseColor.a = gradColor.a;
        #else
            baseColor *= texColor;
        #endif

        gl_FragColor = baseColor;
        gl_FragColor = outputTransform(gl_FragColor);
    }
#endGLSL
GLSL End
