# Unreal Engine 5.8 — Breaking Changes

**Last verified:** 2026-10-17 (UE 5.8 Changes, Substrate/MegaLights versions, Platform-Specific, Migration Checklist); 2026-02-13 (rest of file, written against 5.7)

This document tracks breaking API changes and behavioral differences between Unreal Engine 5.3
(likely in model training) and Unreal Engine 5.8 (current version). Organized by risk level.
Changes new in 5.8 come first, under **UE 5.8 Changes**.

## UE 5.8 Changes

Sourced from the UE 5.8 release notes (Upgrade Notes and API Change entries) and
the 5.8 engine source; the sources are listed at the end of this file.

### HIGH RISK — Will Break Existing Code

| Change | What breaks | Do this |
|--------|-------------|---------|
| **C++20 is the minimum** | A target that sets `CppStandard = CppStandardVersion.Cpp17` (or `Cpp14`): both are now obsolete, "no longer allowed, code will not compile with this version" | Remove the override, or set `CppStandardVersion.Default` (= `Cpp20`) |
| **PhysicsMover removed from Mover** | Code using the unsupported PhysicsMover / NetworkPhysicsLiaison code in the Mover plugin | Use the ChaosMover plugin ("Equivalent functionality is there for every PhysicsMover feature") |
| **Deprecated animation symbols removed** | Non-reflected `UE_DEPRECATED` items from 5.0-5.6 in Animation, Control Rig, Persona and Live Link (e.g. FSmartName-taking constructors, `UMotionWarpingComponent::GetCharacterOwner`) | Use the replacements their deprecation messages named; `GetCharacterOwner` → `GetOwnerAdapter()->GetActor()` / `GetActorOwner()` |
| **`LexToString(bool)` no longer catches other types** | A type that only converted implicitly to `bool` now fails to compile in `LexToString` | Add an explicit cast, or a real `LexToString` overload for the type |
| **MetaSound node metadata** | `FNodeClassMetadata::DefaultInterface` now takes `FClassInterface`, not `FVertexInterface`; deprecated input/output node helpers removed from `IDataTypeRegistry` | Update custom MetaSound node classes |
| **Slate window type** | `EWindowType::GameWindow` | Use `EWindowType::Normal`; a module depending on `SlateRHIRender` may also need `SlateBaseRenderer` |
| **`FSharedEventRef` reset mode** | It used `EEventMode::AutoReset` whatever the constructor argument; `ManualReset` is now honoured | Check call sites that pass `ManualReset` |

### MEDIUM RISK — Behavioral Changes

- **Windows audio backend**: default switched from XAudio2 to WASAPI (also used on Xbox); XAudio2 stays available as an opt-in fallback. Epic: "No changes are required on the developers end."
- **Mobile renderer**: multi-pass deferred rendering is the default path across mobile platforms; forward rendering is opt-in. Materials with the 'Use Half Precision' override revert to Default (listed in the message log).
- **Zen cooked output**: Zenserver as Cooked Output Store is on by default; an existing project with the Zen store disabled stays off until it is enabled in project settings. `AllowRemoteNetworkService` became `RemoteNetworkService` (`None` / `Unsecured` / `GeneratedStaticKey`, not true/false).
- **Lumen**: height fog is now applied to reflection ray hits by default (`r.Lumen.HeightFog 1`).
- **Audio voice limit**: `au.EnableRelativeRenderCostVoiceLimit` is on by default, so fewer sounds may play under the same voice count; revisit voice-count tuning.
- **Enhanced Input fixes behind CVars**: held keys are ignored on flush (`EnhancedInput.IgnoreHeldKeysOnFlush`, default true) and touch bool action keys are corrected (`EnhancedInput.CorrectTouchBoolActionKeys`, default on). Both CVars "will be removed in a future release".
- **Blueprint local variables**: a function local variable with the same name as a member variable can inherit the wrong default; rename such locals.

---

## HIGH RISK — Will Break Existing Code

### Substrate Material System (Production-Ready in 5.7)
**Versions:** UE 5.5 (Beta), 5.7 (production-ready; enabled automatically for new projects)

Substrate replaces the legacy material system with a modular, physically accurate framework.

```cpp
// ❌ OLD: Legacy material nodes (still work but deprecated)
// Standard material graph with Base Color, Metallic, Roughness, etc.

// ✅ NEW: Substrate material layers
// Use Substrate nodes: Substrate Slab, Substrate Blend, etc.
// Modular material authoring with true physical accuracy
```

**Migration:** New projects created in 5.7+ start with Substrate on. An existing project keeps its setting: enable it in `Project Settings > Engine > Rendering > Substrate > Substrate materials` (`r.Substrate`, editor restart required) and rebuild materials using Substrate nodes.

---

### PCG (Procedural Content Generation) API Overhaul
**Versions:** UE 5.7 (production-ready)

PCG framework reached production-ready status with major API changes.

```cpp
// ❌ OLD: Experimental PCG API (pre-5.7)
// Old node types, unstable API

// ✅ NEW: Production PCG API (5.7+)
// Use FPCGContext, IPCGElement, new node types
// Stable API, production-ready workflow
```

**Migration:** Follow PCG migration guide in 5.7 docs. Expect significant refactoring for experimental PCG code.

---

### MegaLights Rendering System
**Versions:** UE 5.5 (introduced), 5.7 (Beta), 5.8 (production-ready)

New lighting system for many shadow-casting dynamic lights.

```cpp
// ❌ OLD: Limited dynamic lights (clustered forward shading)
// Max ~100-200 dynamic lights before performance degrades

// ✅ NEW: MegaLights (5.5+, production-ready in 5.8)
// Many shadow-casting lights at a consistent, low GPU cost
// Enable: Project Settings > Engine > Rendering > Direct Lighting > MegaLights
//   (r.MegaLights.EnableForProject, default 0)
```

**Migration:** No code changes needed, but lighting behavior may differ. Test scenes after enabling.

---

## MEDIUM RISK — Behavioral Changes

### Enhanced Input System (Now Default)
**Versions:** UE 5.1+ (recommended), 5.7 (default)

Enhanced Input is now the default input system.

```cpp
// ❌ OLD: Legacy input bindings (deprecated)
InputComponent->BindAction("Jump", IE_Pressed, this, &ACharacter::Jump);

// ✅ NEW: Enhanced Input
SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) {
    UEnhancedInputComponent* EIC = Cast<UEnhancedInputComponent>(PlayerInputComponent);
    EIC->BindAction(JumpAction, ETriggerEvent::Started, this, &ACharacter::Jump);
}
```

**Migration:** Replace legacy input bindings with Enhanced Input actions.

---

### Nanite Default Enabled
**Versions:** UE 5.0+ (optional), 5.7 (encouraged)

Nanite virtualized geometry is now the recommended workflow for static meshes.

```cpp
// Enable Nanite on static mesh:
// Static Mesh Editor > Details > Nanite Settings > Enable Nanite Support
```

**Migration:** Convert high-poly meshes to Nanite. Test performance on target platforms.

---

## LOW RISK — Deprecations (Still Functional)

### Legacy Material System
**Status:** Deprecated but supported
**Replacement:** Substrate Material System

Legacy materials still work, but Substrate is recommended for new projects.

---

### Old World Partition (UE4 Style)
**Status:** Deprecated
**Replacement:** World Partition (UE5+)

Use UE5's World Partition system for large worlds.

---

## Platform-Specific Breaking Changes

UE 5.8 toolchain and SDK requirements come from the 5.8 release notes'
*Platform SDK Upgrades* table.

### Windows
- **UE 5.8**: Visual Studio 2022 v17.14 or newer is the minimum; Visual Studio 2026 is recommended (MSVC 14.38 minimum, 14.50 recommended)
- **UE 5.8**: Windows SDK 10.0.22621.0 minimum, 10.0.26100.0 default; LLVM Clang 18.1.8 minimum
- **UE 5.7**: DirectX 12 is now default (was DX11 in older versions)
- Update shaders for DX12 compatibility

### macOS
- **UE 5.5+**: Metal 3 required (minimum macOS 13)
- **UE 5.8**: Minimum OS macOS Sonoma 14.0; Xcode 15.2 minimum, 15.4 or newer recommended (macOS target)

### Linux
- **UE 5.8**: Ubuntu 22.04, Rocky Linux 8 or Red Hat Linux 8 or newer recommended; compiler clang 20.1.8

### Mobile
- **UE 5.8**: Android minimum install SDK level 26 (Android 8.0+); NDK r27c; minimum SDK for compiling UE 34, recommended 35; Gradle 8.7, AGP 8.5.2
- **UE 5.8**: iOS / iPadOS / tvOS SDK 17 or later; Xcode 26.0 minimum, 26.1.1 recommended (iOS targets)
- **UE 5.8**: iOS Shader Model 6 is Experimental

---

## Migration Checklist

When upgrading from UE 5.3 to UE 5.8:

- [ ] Remove any `CppStandardVersion.Cpp17` / `Cpp14` override (5.8 requires C++20)
- [ ] Install a 5.8 toolchain (Visual Studio 2022 17.14+ or 2026 on Windows; Xcode 26 for iOS)
- [ ] Move PhysicsMover usage to ChaosMover
- [ ] Rebuild and fix calls to deprecated APIs removed in 5.8 (see **UE 5.8 Changes**)
- [ ] Review Substrate materials (convert if ready for new system)
- [ ] Audit PCG usage (update to production API if using experimental)
- [ ] Test MegaLights performance (enable and benchmark)
- [ ] Migrate legacy input to Enhanced Input
- [ ] Convert high-poly meshes to Nanite
- [ ] Update shaders for DX12 (Windows) or Metal 3 (macOS)
- [ ] Verify minimum platform versions (5.8: Android install SDK 26 / Android 8.0, iOS SDK 17, macOS Sonoma 14)
- [ ] Test Lumen and Nanite performance on target hardware

---

**Sources:**
- UE 5.8 release notes (Upgrade Notes, API Change entries, Platform SDK Upgrades, WASAPI, Mobile Renderer, Zenserver as Cooked Output Store): https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-5-8-release-notes?application_version=5.8
- 5.8 engine source, read from a UE 5.8.1 install on 2026-10-17: `Engine/Source/Programs/UnrealBuildTool/System/CppCompileEnvironment.cs` (`Cpp14`/`Cpp17` marked `[Obsolete("Deprecated in UE5.8 ...")]`, `Minimum = Cpp20`); `Engine/Source/Runtime/RenderCore/Private/RenderUtils.cpp` (Substrate defaults for new and existing projects); `Engine/Source/Runtime/Engine/Classes/Engine/RendererSettings.h` and `Engine/Source/Runtime/Renderer/Private/MegaLights/MegaLights.cpp` (MegaLights setting and default)
- Substrate Beta in 5.5, MegaLights Beta in 5.7: https://forums.unrealengine.com/t/unreal-engine-5-5-released/2117936 , https://forums.unrealengine.com/t/unreal-engine-5-7-released/2673913
- https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-5-7-release-notes
- https://dev.epicgames.com/documentation/en-us/unreal-engine/upgrading-projects-to-newer-versions-of-unreal-engine
