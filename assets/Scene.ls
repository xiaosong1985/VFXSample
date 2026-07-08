{
  "_$ver": 1,
  "_$id": "er2lfkwr",
  "_$type": "Scene",
  "left": 0,
  "right": 0,
  "top": 0,
  "bottom": 0,
  "name": "Scene2D",
  "width": 1334,
  "height": 750,
  "_$child": [
    {
      "_$id": "n9gjxcltvl",
      "_$type": "Scene3D",
      "name": "Scene3D",
      "skyRenderer": {
        "meshType": "dome",
        "material": {
          "_$uuid": "793cffc6-730a-4756-a658-efe98c230292",
          "_$type": "Material"
        }
      },
      "ambientColor": {
        "_$type": "Color",
        "r": 0.424308,
        "g": 0.4578516,
        "b": 0.5294118
      },
      "fogStart": 0,
      "fogEnd": 300,
      "fogColor": {
        "_$type": "Color",
        "r": 0.5,
        "g": 0.5,
        "b": 0.5
      },
      "_$child": [
        {
          "_$id": "6jx8h8bvc6",
          "_$type": "Camera",
          "name": "Main Camera",
          "transform": {
            "localPosition": {
              "_$type": "Vector3",
              "y": 1,
              "z": 5
            }
          },
          "nearPlane": 0.3,
          "farPlane": 1000,
          "clearColor": {
            "_$type": "Color",
            "r": 0,
            "g": 0,
            "b": 0
          },
          "enableHDR": true
        },
        {
          "_$id": "6ni3p096l5",
          "_$type": "Sprite3D",
          "name": "Direction Light",
          "transform": {
            "localPosition": {
              "_$type": "Vector3",
              "x": 5,
              "y": 5,
              "z": 5
            },
            "localRotation": {
              "_$type": "Quaternion",
              "x": -0.40821789367673483,
              "y": 0.23456971600980447,
              "z": 0.109381654946615,
              "w": 0.875426098065593
            }
          },
          "_$comp": [
            {
              "_$type": "DirectionLightCom",
              "color": {
                "_$type": "Color",
                "r": 0.6,
                "g": 0.6,
                "b": 0.6
              }
            }
          ]
        },
        {
          "_$id": "ggg8fzr4",
          "_$type": "Sprite3D",
          "name": "Gateway Bronze with Light",
          "transform": {
            "localPosition": {
              "_$type": "Vector3",
              "x": 1.75
            }
          },
          "_$comp": [
            {
              "_$type": "VFXRenderer",
              "lightmapScaleOffset": {
                "_$type": "Vector4"
              },
              "sharedMaterials": []
            },
            {
              "_$type": "VisualEffect",
              "asset": {
                "_$uuid": "8fc9c976-2cf1-4716-b14d-d01b2bff6937@0",
                "_$type": "VFXAsset"
              },
              "initialEvent": "end"
            }
          ]
        },
        {
          "_$id": "vasj9uf1",
          "_$type": "Sprite3D",
          "name": "Gateway Crimson with Light",
          "transform": {
            "localPosition": {
              "_$type": "Vector3",
              "x": -1.6366885
            }
          },
          "_$comp": [
            {
              "_$type": "VFXRenderer",
              "lightmapScaleOffset": {
                "_$type": "Vector4"
              },
              "sharedMaterials": []
            },
            {
              "_$type": "VisualEffect",
              "asset": {
                "_$uuid": "de507f41-f763-41d0-98d9-fb0600a2790a@0",
                "_$type": "VFXAsset"
              },
              "initialEvent": "end"
            }
          ]
        },
        {
          "_$id": "q3mixq1m",
          "_$type": "Sprite3D",
          "name": "OrientAdvanced",
          "transform": {
            "localPosition": {
              "_$type": "Vector3",
              "y": 1.6299973
            },
            "localScale": {
              "_$type": "Vector3",
              "x": 0.8,
              "y": 0.8,
              "z": 0.8
            }
          },
          "_$comp": [
            {
              "_$type": "VFXRenderer",
              "lightmapScaleOffset": {
                "_$type": "Vector4"
              },
              "sharedMaterials": []
            },
            {
              "_$type": "VisualEffect",
              "asset": {
                "_$uuid": "4a68d729-2b01-489b-a081-241019190cfc@0",
                "_$type": "VFXAsset"
              }
            }
          ]
        },
        {
          "_$id": "et9edz58",
          "_$type": "Sprite3D",
          "name": "Energy DM White Skinned Mesh",
          "_$comp": [
            {
              "_$type": "VFXRenderer",
              "lightmapScaleOffset": {
                "_$type": "Vector4"
              },
              "sharedMaterials": []
            },
            {
              "_$type": "VisualEffect",
              "asset": {
                "_$uuid": "28d03733-c699-42a1-89ed-a3e57e1783fa@0",
                "_$type": "VFXAsset"
              },
              "initialEvent": "in"
            },
            {
              "_$type": "243da170-52aa-41de-83e1-4720f32e0620",
              "scriptPath": "../src/SampleSkinnedMeshDemo.ts",
              "targetSkinnedMesh": {
                "_$ref": "bqz07lrb"
              },
              "sourceName": "SkinnedMesh",
              "transformSourceName": "SkinnedMeshTransform",
              "transformBoneName": "Ellen_Hips"
            }
          ],
          "_$child": [
            {
              "_$id": "bqz07lrb",
              "_$prefab": "e38d2d0d-ea52-4bc0-ae3f-09506c2cde20",
              "name": "Ellen",
              "active": true,
              "layer": 0,
              "transform": {
                "localPosition": {
                  "_$type": "Vector3"
                },
                "localRotation": {
                  "_$type": "Quaternion"
                }
              },
              "_$comp": [
                {
                  "_$override": "Animator",
                  "controller": {
                    "_$uuid": "2be99d6c-1b9d-4f10-913c-9f8f0163a8b1",
                    "_$type": "AnimationController"
                  }
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}