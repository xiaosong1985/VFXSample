Shader3D Start
{
    type:Shader3D,
    name:VFXCubeProcedural,
    enableInstancing:false,
    shaderType:D3,
    supportReflectionProbe:false,
    attributeMap: {
        // Per-instance attributes（slot 8-12），无 mesh vertex attributes
        'a_AttrPosition': ["Vector4", 8],
        'a_AttrColor': ["Vector4", 9],
        'a_AttrRotation': ["Vector4", 10],
        'a_AttrScale': ["Vector4", 11],
        'a_AttrPivot': ["Vector4", 12]
    },
    uniformMap:{
        u_Color: { type: Color },
        u_AlbedoTexture: { type: Texture2D }
    },
    defines: {
        VFX_OPAQUE: { type: bool, default: false }
    }
    shaderPass:[
        {
            pipeline:Forward,
            VS:cubeProceduralVS,
            FS:cubeProceduralFS
        }
    ]
}
Shader3D End

GLSL Start
#defineGLSL cubeProceduralVS

    #define SHADER_NAME VFXCubeProcedural

    #include "Math.glsl";
    #include "Scene.glsl";
    #include "Camera.glsl";
    #include "Sprite3DVertex.glsl";
    #include "VFXRenderCommon.glsl";

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
    varying vec3 v_NormalWS;

    // Cube 36 顶点：6 面 × 2 三角形 × 3 顶点
    // 面顺序：+Z (0..5), -Z (6..11), +X (12..17), -X (18..23), +Y (24..29), -Y (30..35)
    // 每面 CCW 绕法线
    void getCubeVertex(int id, out vec3 localPos, out vec2 uv, out vec3 normal) {
        // 单位 cube（[-0.5, 0.5]），各面 quad 通过 2 三角形 6 顶点展开
        // face 索引 f = id/6，面内 sub = id%6（quad 6 顶点：BL, BR, TL, BR, TR, TL）
        int f = id / 6;
        int sub = id - f * 6;
        // 2D 内顶点 (x, y) 分别对应面局部坐标，映射到 UV
        vec2 quadPos[6] = vec2[6](
            vec2(-0.5, -0.5), vec2( 0.5, -0.5), vec2(-0.5, 0.5),
            vec2( 0.5, -0.5), vec2( 0.5, 0.5),  vec2(-0.5, 0.5)
        );
        vec2 quadUV[6] = vec2[6](
            vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
            vec2(1.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0)
        );
        vec2 p2 = quadPos[sub];
        uv = quadUV[sub];

        if (f == 0)      { normal = vec3( 0, 0, 1); localPos = vec3(p2.x, p2.y,  0.5); }  // +Z
        else if (f == 1) { normal = vec3( 0, 0,-1); localPos = vec3(-p2.x, p2.y, -0.5); } // -Z
        else if (f == 2) { normal = vec3( 1, 0, 0); localPos = vec3( 0.5, p2.y, -p2.x); } // +X
        else if (f == 3) { normal = vec3(-1, 0, 0); localPos = vec3(-0.5, p2.y,  p2.x); } // -X
        else if (f == 4) { normal = vec3( 0, 1, 0); localPos = vec3(p2.x,  0.5, -p2.y); } // +Y
        else             { normal = vec3( 0,-1, 0); localPos = vec3(p2.x, -0.5,  p2.y); } // -Y
    }

    void main() {
        vec3 localPos;
        vec2 uv;
        vec3 normal;
        getCubeVertex(gl_VertexID, localPos, uv, normal);

        // 粒子 TRS 变换
        VFXParticle p = getVFXParticle();
        vec3 v = localPos - p.pivot;
        v = v * p.scale;
        vec3 vRot = rotateByQuat(v, p.rotation);
        vec3 local = vRot + p.position;

        // 法线旋转（忽略 pivot/scale）
        vec3 nRot = rotateByQuat(normal, p.rotation);

        mat4 worldMat = getWorldMatrix();
        vec4 pos = worldMat * vec4(local, 1.0);
        vec3 positionWS = pos.xyz / pos.w;
        vec3 normalWS = normalize((worldMat * vec4(nRot, 0.0)).xyz);

        v_Color = p.color;
        v_Texcoord0 = uv;
        v_NormalWS = normalWS;

        gl_Position = getPositionCS(positionWS);
        gl_Position = remapPositionZ(gl_Position);
    }
#endGLSL

#defineGLSL cubeProceduralFS

    #define SHADER_NAME VFXCubeProcedural

    #include "Color.glsl";
    #include "Scene.glsl";
    #include "Camera.glsl";
    #include "Sprite3DFrag.glsl";

    varying vec4 v_Color;
    varying vec2 v_Texcoord0;
    varying vec3 v_NormalWS;

    void main() {
        vec4 texColor = texture2D(u_AlbedoTexture, v_Texcoord0);
        #ifdef VFX_OPAQUE
        vec3 _baseColor = u_Color.rgb * v_Color.rgb;
        vec4 finalColor = vec4(mix(_baseColor, texColor.rgb, texColor.a), 1.0);
        #else
        vec4 finalColor = u_Color * texColor * v_Color;
        #endif

        // 简易 Lambert 光照，让 cube 看出立体感（假定光从右上方）
        vec3 lightDir = normalize(vec3(0.5, 1.0, 0.4));
        float ndl = max(dot(normalize(v_NormalWS), lightDir), 0.0);
        vec3 ambient = vec3(0.3);
        finalColor.rgb *= (ambient + ndl * 0.8);

        gl_FragColor = finalColor;
        gl_FragColor = outputTransform(gl_FragColor);
    }
#endGLSL
GLSL End
