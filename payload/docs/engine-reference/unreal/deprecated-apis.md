# Unreal Engine 5.8 — Deprecated APIs

**Last verified:** 2026-10-17 (Deprecated in UE 5.8, Gameplay Ability System row, summary); 2026-02-13 (rest of file, written against 5.7)

Quick lookup table for deprecated APIs and their replacements.
Format: **Don't use X** → **Use Y instead**

---

## Deprecated in UE 5.8

From the 5.8 release notes' Upgrade Notes and the 5.8 engine headers (sources at
the end of this file). Deprecated items still compile with a warning unless the
Notes column says otherwise.

| Deprecated | Replacement | Notes |
|------------|-------------|-------|
| `UE_LOG(...)` | `UE_LOGF(Category, Verbosity, "fmt", ...)` | Not deprecated yet: Epic says UE_LOG "will eventually be deprecated" and asks for `UE_LOGF`. The header documents the format as a printf-style literal given as `"..."` or `UTF8TEXT("...")`. 5.8 ships `ConvertUELog.py` for most uses |
| `#if PLATFORM_IOS` (and other `PLATFORM_*`) | `#if UE_PLATFORM_IOS` (`UE_PLATFORM_*`) | Optional migration; `PLATFORM_IOS` can be stomped by Apple framework headers |
| `CppStandardVersion.Cpp17` / `Cpp14` | `CppStandardVersion.Default` (C++20) | Obsolete in 5.8: code no longer compiles with them |
| Raw Input plugin (`RawInput`) | Game Input for Windows plugin (`GameInputWindows`, Beta) | `"DeprecatedEngineVersion": "5.8"` in `RawInput.uplugin` |
| PhysicsMover (Mover plugin) | ChaosMover plugin | Removed in 5.8, not just deprecated |
| `FActiveGameplayEffectHandle(int32)` | `FActiveGameplayEffectHandle::GenerateNewHandle` or `GetInstantExecutedHandle()` | `UE_DEPRECATED(5.8, ...)` |
| `FSmartName`, `FSmartNameMapping`, `FSmartNameContainer` | None: remove the use | `UE_DEPRECATED(5.8, "Smart names and their mappings are no longer used")` |
| `UFadeFunction`, `FFadeFunctionData`, `EWaveEditorFadeMode` | `UTransformationFadeFunction`, `UWaveformTransformationFade` | Waveform Editor |
| `URigHierarchy::FindBone` / `FindControl` / `FindNull` in Blueprint | `Contains(Key)`, `GetBoneType(Key)`, `GetControlSettings(Key)`, `IsSelected(Key)`, `GetIndex(Key)` | Control Rig; existing graphs keep working with warnings |
| `PluginName.ini` / `BasePluginName.ini` in a plugin | `DefaultPluginName.ini` | Plugin config files |
| `r.Water.SingleLayer.ForceVelocity` | `r.Water.SingleLayer.VelocityOutputPass` (or the project setting) | Rendering CVar |
| `EWindowType::GameWindow` | `EWindowType::Normal` | Slate |

---

## Input

| Deprecated | Replacement | Notes |
|------------|-------------|-------|
| `InputComponent->BindAction()` | Enhanced Input `BindAction()` | New input system |
| `InputComponent->BindAxis()` | Enhanced Input `BindAxis()` | New input system |
| `PlayerController->GetInputAxisValue()` | Enhanced Input Action Values | New input system |

**Migration:** Install Enhanced Input plugin, create Input Actions and Input Mapping Contexts.

---

## Rendering

| Deprecated | Replacement | Notes |
|------------|-------------|-------|
| Legacy material nodes | Substrate material nodes | Substrate is production-ready in 5.7 and on by default for new projects |
| Forward shading (default) | Deferred + Lumen | Lumen is default in UE5 |
| Old lighting workflow | Lumen Global Illumination | Real-time GI |

---

## World Building

| Deprecated | Replacement | Notes |
|------------|-------------|-------|
| UE4 World Composition | World Partition (UE5) | Streaming large worlds |
| Level Streaming Volumes | World Partition Data Layers | Better level streaming |

---

## Animation

| Deprecated | Replacement | Notes |
|------------|-------------|-------|
| Old animation retargeting | IK Rig + IK Retargeter | UE5 retargeting system |
| Legacy control rig | Control Rig 2.0 | Production-ready rigging |

---

## Gameplay

| Deprecated | Replacement | Notes |
|------------|-------------|-------|
| `UGameplayStatics::LoadStreamLevel()` | World Partition streaming | Use Data Layers |
| Hardcoded input bindings | Enhanced Input system | Rebindable, modular input |

---

## Gameplay Ability System

| Deprecated | Replacement | Notes |
|------------|-------------|-------|
| `UGameplayAbility::AbilityTags` (direct access) | `GetAssetTags()` to read; `SetAssetTags()` in the constructor to set | `UE_DEPRECATED_FORGAME(5.5, ...)` in the 5.8 header: "This is being made non-mutable, private and renamed to AssetTags in the future" |
| `FActiveGameplayEffectHandle(int32)` | `GenerateNewHandle` / `GetInstantExecutedHandle()` | Deprecated in 5.8 |

---

## Niagara (VFX)

| Deprecated | Replacement | Notes |
|------------|-------------|-------|
| Cascade particle system | Niagara | Cascade is fully deprecated |

---

## Audio

| Deprecated | Replacement | Notes |
|------------|-------------|-------|
| Old audio mixer | MetaSounds | Procedural audio system |
| Sound Cue (for complex logic) | MetaSounds | More powerful, node-based |

---

## Networking

| Deprecated | Replacement | Notes |
|------------|-------------|-------|
| `DOREPLIFETIME()` (basic) | `DOREPLIFETIME_CONDITION()` | Conditional replication for optimization |

---

## C++ Scripting

| Deprecated | Replacement | Notes |
|------------|-------------|-------|
| `TSharedPtr<T>` for UObjects | `TObjectPtr<T>` | UE5 type-safe pointers |
| Manual RTTI checks | `Cast<T>()` / `IsA<T>()` | Type-safe casting |

---

## Quick Migration Patterns

### Input Example
```cpp
// ❌ Deprecated
void AMyCharacter::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) {
    PlayerInputComponent->BindAction("Jump", IE_Pressed, this, &ACharacter::Jump);
}

// ✅ Enhanced Input
#include "EnhancedInputComponent.h"

void AMyCharacter::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) {
    UEnhancedInputComponent* EIC = Cast<UEnhancedInputComponent>(PlayerInputComponent);
    if (EIC) {
        EIC->BindAction(JumpAction, ETriggerEvent::Started, this, &ACharacter::Jump);
    }
}
```

### Material Example
```cpp
// ❌ Deprecated: Legacy material
// Use standard material graph (still works but not recommended)

// ✅ Substrate Material
// Enable: Project Settings > Engine > Substrate > Enable Substrate
// Use Substrate nodes in material editor
```

### World Partition Example
```cpp
// ❌ Deprecated: Level streaming volumes
// Load/unload levels manually

// ✅ World Partition
// Enable: World Settings > Enable World Partition
// Use Data Layers for streaming
```

### Particle System Example
```cpp
// ❌ Deprecated: Cascade
UParticleSystemComponent* PSC = CreateDefaultSubobject<UParticleSystemComponent>(TEXT("Particles"));

// ✅ Niagara
UNiagaraComponent* NiagaraComp = CreateDefaultSubobject<UNiagaraComponent>(TEXT("Niagara"));
```

### Audio Example
```cpp
// ❌ Deprecated: Sound Cue for complex logic
// Use Sound Cue editor nodes

// ✅ MetaSounds
// Create MetaSound Source asset, use node-based audio
```

---

## Summary: UE 5.8 Tech Stack

| Feature | Use This (2026) | Avoid This (Legacy) |
|---------|------------------|----------------------|
| **Input** | Enhanced Input | Legacy Input Bindings |
| **Materials** | Substrate | Legacy Material System |
| **Lighting** | Lumen + MegaLights | Lightmaps + Limited Lights |
| **Particles** | Niagara | Cascade |
| **Audio** | MetaSounds | Sound Cue (for logic) |
| **World Streaming** | World Partition | World Composition |
| **Animation Retarget** | IK Rig + Retargeter | Old Retargeting |
| **Geometry** | Nanite (high-poly) | Standard Static Mesh LODs |
| **Logging** | `UE_LOGF` (5.8) | `UE_LOG` (still supported) |
| **Windows device input** | Game Input for Windows | Raw Input plugin (deprecated 5.8) |

---

**Sources:**
- UE 5.8 release notes, Upgrade Notes and API Change entries: https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-5-8-release-notes?application_version=5.8
- 5.8 engine headers, read from a UE 5.8.1 install on 2026-10-17: `Engine/Source/Runtime/Core/Public/Logging/LogMacros.h` (`UE_LOGF`); `Engine/Source/Runtime/Core/Public/HAL/Platform.h` (`UE_PLATFORM_*`); `Engine/Source/Programs/UnrealBuildTool/System/CppCompileEnvironment.cs`; `Engine/Plugins/Experimental/RawInput/RawInput.uplugin` and `Engine/Plugins/GameInputWindows/GameInputWindows.uplugin`; `Engine/Plugins/Runtime/GameplayAbilities/Source/GameplayAbilities/Public/ActiveGameplayEffectHandle.h` and `.../Public/Abilities/GameplayAbility.h`; `Engine/Source/Runtime/Engine/Classes/Animation/SmartName.h`
- https://docs.unrealengine.com/5.7/en-US/deprecated-and-removed-features/
- https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-5-7-release-notes
