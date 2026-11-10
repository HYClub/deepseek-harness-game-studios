# Unreal Engine 5.8 — Rendering Module Reference

**Last verified:** 2026-10-18 (MegaLights tooltip against the 5.8 notes and source); 2026-10-17 (UE 5.8 changes block); 2026-02-13 (rest of file, written against 5.7)
**Knowledge Gap:** UE 5.8 has production-ready MegaLights, production-ready Substrate (5.7), Lumen Lite, and Lumen improvements

> **UE 5.8 changes:** MegaLights is production-ready (enable it in Project
> Settings > Engine > Rendering > Direct Lighting > MegaLights,
> `r.MegaLights.EnableForProject`, default 0). Lumen Lite (Beta) is a
> medium-quality GI setting, about twice as fast as Lumen high quality and the
> default for current-generation handheld consoles. Mobile: multi-pass deferred
> is the default path (forward is opt-in), with SSAO, SSR, deferred decals and
> contact shadows. Lumen applies height fog to reflection ray hits by default
> (`r.Lumen.HeightFog 1`). Substrate has been on for new projects since 5.7
> (`r.Substrate`); Substrate NPR (toon) shading and Fog Screen Space Scattering
> are Experimental. Sources: UE 5.8 release notes, https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-5-8-release-notes?application_version=5.8 ;
> `Engine/Source/Runtime/Engine/Classes/Engine/RendererSettings.h` and
> `Engine/Source/Runtime/RenderCore/Private/RenderUtils.cpp` (5.8.1 install).

---

## Overview

UE 5.8 rendering stack:
- **Lumen**: Real-time global illumination (default)
- **Nanite**: Virtualized geometry for millions of triangles
- **MegaLights**: Many shadow-casting dynamic lights (NEW in 5.5+, production-ready in 5.8)
- **Substrate**: Production-ready modular material system (NEW in 5.7)

---

## Lumen (Global Illumination)

### Enable Lumen

```cpp
// Project Settings > Engine > Rendering > Dynamic Global Illumination Method = Lumen
// Real-time GI, no lightmap baking needed
```

### Lumen Quality Settings

```ini
; DefaultEngine.ini
[/Script/Engine.RendererSettings]
r.Lumen.DiffuseColorBoost=1.0
r.Lumen.ScreenProbeGather.RadianceCache.NumFramesToKeepCached=2
```

### Lumen in C++

```cpp
// Check if Lumen is enabled
bool bIsLumenEnabled = IConsoleManager::Get().FindConsoleVariable(TEXT("r.DynamicGlobalIlluminationMethod"))->GetInt() == 1;
```

---

## Nanite (Virtualized Geometry)

### Enable Nanite on Static Mesh

1. Static Mesh Editor
2. Details > Nanite Settings > Enable Nanite Support
3. Save mesh (auto-builds Nanite data)

### Nanite in C++

```cpp
// Spawn Nanite mesh
UStaticMeshComponent* MeshComp = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Mesh"));
MeshComp->SetStaticMesh(NaniteMesh); // Automatically uses Nanite if enabled
```

### Nanite Limitations
- No vertex animation (skeletal meshes)
- No world position offset (WPO) in materials
- Best for static, high-poly geometry

---

## MegaLights (UE 5.5+, production-ready in 5.8)

### Enable MegaLights

```cpp
// Project Settings > Engine > Rendering > Direct Lighting > MegaLights
//   (r.MegaLights.EnableForProject, default 0; a Post Process Volume can
//   override it, and it can be disabled per light)
// Many shadow-casting lights at a consistent, low GPU cost
```

### The editor tooltip is older than the 5.8 release notes

In a 5.8.1 install, this setting's tooltip (`RendererSettings.h`) and the
`r.MegaLights.EnableForProject` help text (`MegaLights.cpp`) still end
"Experimental feature." and say MegaLights "requires Hardware Ray Tracing, and
does not support Directional Lights". Follow the release notes and the engine
code instead:

- **Status:** "Megalights is now entering Production Ready status with Unreal
  Engine 5.8" (5.8 release notes, Rendering > Megalights).
- **Ray tracing:** the renderer accepts hardware or software ray tracing support
  (`HasRequiredTracingData` in `MegaLights.cpp`). Shadow rays use hardware ray
  tracing while `r.MegaLights.HardwareRayTracing` is 1, the default. Shadows
  come from ray tracing (the default) or Virtual Shadow Maps:
  `r.MegaLights.DefaultShadowMethod` 0 or 1.
- **Directional lights:** supported behind `r.MegaLights.DirectionalLights`,
  default 0 (off). The 5.7 release notes list Directional Light support.

Sources, read 2026-10-18: the 5.8 and 5.7 release notes (§ Sources); in a UE
5.8.1 install (CL 56057345), `Engine/Source/Runtime/Engine/Classes/Engine/RendererSettings.h`,
`Engine/Source/Runtime/Renderer/Private/MegaLights/MegaLights.cpp` and
`MegaLightsRayTracing.cpp`.

### MegaLights Usage

```cpp
// Add point lights as usual
UPointLightComponent* Light = CreateDefaultSubobject<UPointLightComponent>(TEXT("Light"));
Light->SetIntensity(5000.0f);
Light->SetAttenuationRadius(500.0f);

// MegaLights handles many of these at a consistent GPU cost
```

---

## Substrate Materials (Production-Ready in 5.7)

### Enable Substrate

```cpp
// On by default for new projects created in 5.7+.
// Existing project: Project Settings > Engine > Rendering > Substrate >
//   Substrate materials (r.Substrate), then restart the editor
```

### Substrate Material Nodes
- **Substrate Slab**: Physical material layer (diffuse, specular, etc.)
- **Substrate Blend**: Blend multiple layers
- **Substrate Thin Film**: Iridescence, soap bubbles
- **Substrate Hair**: Hair-specific shading

### Example Substrate Material Graph

```
Substrate Slab (Diffuse)
  └─ Base Color: Texture Sample
  └─ Roughness: Constant (0.5)
  └─ Metallic: Constant (0.0)
  └─ Connect to Material Output
```

---

## Materials (C++ API)

### Dynamic Material Instances

```cpp
// Create dynamic material instance
UMaterialInstanceDynamic* DynMat = UMaterialInstanceDynamic::Create(BaseMaterial, this);

// Set parameters
DynMat->SetVectorParameterValue(TEXT("BaseColor"), FLinearColor::Red);
DynMat->SetScalarParameterValue(TEXT("Metallic"), 0.8f);
DynMat->SetTextureParameterValue(TEXT("DiffuseTexture"), MyTexture);

// Apply to mesh
MeshComp->SetMaterial(0, DynMat);
```

---

## Post-Processing

### Post-Process Volume

```cpp
// Add to level
APostProcessVolume* PPV = GetWorld()->SpawnActor<APostProcessVolume>();
PPV->bUnbound = true; // Affect entire world

// Configure settings
PPV->Settings.bOverride_MotionBlurAmount = true;
PPV->Settings.MotionBlurAmount = 0.5f;

PPV->Settings.bOverride_BloomIntensity = true;
PPV->Settings.BloomIntensity = 1.0f;
```

### Post-Process in C++

```cpp
// Access camera post-process settings
APlayerController* PC = GetWorld()->GetFirstPlayerController();
if (APlayerCameraManager* CamManager = PC->PlayerCameraManager) {
    CamManager->PostProcessBlendWeight = 1.0f;
    CamManager->PostProcessSettings.BloomIntensity = 2.0f;
}
```

---

## Lighting

### Directional Light (Sun)

```cpp
ADirectionalLight* Sun = GetWorld()->SpawnActor<ADirectionalLight>();
Sun->SetActorRotation(FRotator(-45.f, 0.f, 0.f));
Sun->GetLightComponent()->SetIntensity(10.0f);
Sun->GetLightComponent()->bCastShadows = true;
```

### Point Light

```cpp
APointLight* Light = GetWorld()->SpawnActor<APointLight>();
Light->SetActorLocation(FVector(0, 0, 200));
Light->GetPointLightComponent()->SetIntensity(5000.0f);
Light->GetPointLightComponent()->SetAttenuationRadius(1000.0f);
Light->GetPointLightComponent()->SetLightColor(FLinearColor::Red);
```

### Spot Light

```cpp
ASpotLight* Spotlight = GetWorld()->SpawnActor<ASpotLight>();
Spotlight->GetSpotLightComponent()->SetInnerConeAngle(20.0f);
Spotlight->GetSpotLightComponent()->SetOuterConeAngle(40.0f);
```

---

## Render Targets (Render to Texture)

### Create Render Target

```cpp
// Create render target asset (2D texture)
UTextureRenderTarget2D* RenderTarget = NewObject<UTextureRenderTarget2D>();
RenderTarget->InitAutoFormat(512, 512); // 512x512 resolution
RenderTarget->UpdateResourceImmediate();

// Render scene to texture
UKismetRenderingLibrary::DrawMaterialToRenderTarget(
    GetWorld(),
    RenderTarget,
    MaterialToDraw
);
```

---

## Custom Render Passes (Advanced)

### Render Dependency Graph (RDG)

```cpp
// UE5 uses Render Dependency Graph for custom rendering
// Example: Custom post-process pass

#include "RenderGraphBuilder.h"

void RenderCustomPass(FRDGBuilder& GraphBuilder, const FViewInfo& View) {
    FRDGTextureRef SceneColor = /* Get scene color texture */;

    // Define pass parameters
    struct FPassParameters {
        FRDGTextureRef InputTexture;
    };

    FPassParameters* PassParams = GraphBuilder.AllocParameters<FPassParameters>();
    PassParams->InputTexture = SceneColor;

    // Add render pass
    GraphBuilder.AddPass(
        RDG_EVENT_NAME("CustomPass"),
        PassParams,
        ERDGPassFlags::Raster,
        [](FRHICommandList& RHICmdList, const FPassParameters* Params) {
            // Render commands
        }
    );
}
```

---

## Performance

### Render Stats

```cpp
// Console commands for profiling:
// stat fps - Show FPS
// stat unit - Show frame time breakdown
// stat gpu - Show GPU timings
// profilegpu - Detailed GPU profile
```

### Scalability Settings

```cpp
// Get current scalability settings
UGameUserSettings* Settings = UGameUserSettings::GetGameUserSettings();
int32 ViewDistanceQuality = Settings->GetViewDistanceQuality(); // 0-4

// Set scalability
Settings->SetViewDistanceQuality(3); // High
Settings->SetShadowQuality(2); // Medium
Settings->ApplySettings(false);
```

---

## Debugging

### Visualize Render Features

```
Console commands:
- r.Lumen.Visualize 1 - Show Lumen debug
- r.Nanite.Visualize 1 - Show Nanite triangles
- viewmode wireframe - Wireframe mode
- viewmode unlit - Disable lighting
- show collision - Show collision meshes
```

---

## Sources
- UE 5.8 release notes: https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-5-8-release-notes?application_version=5.8
- UE 5.7 release notes: https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-5-7-release-notes?application_version=5.7
- https://docs.unrealengine.com/5.7/en-US/lumen-global-illumination-and-reflections-in-unreal-engine/
- https://docs.unrealengine.com/5.7/en-US/nanite-virtualized-geometry-in-unreal-engine/
- https://docs.unrealengine.com/5.7/en-US/substrate-materials-in-unreal-engine/
