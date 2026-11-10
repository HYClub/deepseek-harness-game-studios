# Unreal Engine 5.8 — Current Best Practices

**Last verified:** 2026-10-17 (5.8 pin: project setup, C++ standard, Blueprint Nativization, MegaLights, Substrate, Object Pooling sample, logging); 2026-02-13 (rest of file, written against 5.7)

Modern UE5 patterns that may not be in the LLM's training data.
These are production-ready recommendations as of UE 5.8.

---

## Project Setup

### Use UE 5.8 for New Projects
- Latest release: 5.8 (latest hotfix 5.8.3, September 2026)
- MegaLights and Iris are production-ready in 5.8 (per the release notes; the Iris plugin still carries a Beta flag); Substrate and PCG have been since 5.7
- Needs a C++20 toolchain: Visual Studio 2022 17.14 or newer on Windows (2026 recommended), see `breaking-changes.md` → Platform-Specific

### Choose the Right Rendering Features
- **Lumen**: Real-time global illumination (RECOMMENDED for most projects)
- **Nanite**: Virtualized geometry for high-poly meshes (RECOMMENDED for detailed environments)
- **MegaLights**: Many shadow-casting dynamic lights at a consistent GPU cost (production-ready in 5.8; RECOMMENDED for complex lighting)
- **Substrate**: Modular material system (RECOMMENDED; enabled automatically for new projects since 5.7)

---

## Command Line — Build and Automation Tests (per platform)

Build the project's own editor target before running tests (a fresh checkout has
no compiled game module), then run the automation tests with the editor. Epic
recommends building `<Project>Editor` rather than `UnrealEditor`, so the modules
the `.uproject` disables stay disabled. Give the project as an absolute path.

| Step | Windows | Linux | macOS |
|------|---------|-------|-------|
| Build the editor target | `Engine/Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.exe <Project>Editor Win64 Development -Project="<abs>/<Project>.uproject"` | `Engine/Build/BatchFiles/Linux/Build.sh <Project>Editor Linux Development -Project="<abs>/<Project>.uproject"` | `Engine/Build/BatchFiles/Mac/Build.sh <Project>Editor Mac Development -Project="<abs>/<Project>.uproject"` |
| Editor executable for a command-line run | `Engine/Binaries/Win64/UnrealEditor-Cmd.exe` | `Engine/Binaries/Linux/UnrealEditor` | **NOT SOURCEABLE** — Epic documents only the `Engine/Binaries/Mac/UnrealEditor.app` bundle, not a command-line editor inside it |
| Packaged build | `Engine/Binaries/DotNET/AutomationTool/AutomationTool.exe BuildCookRun … -platform=Win64` | `Engine/Build/BatchFiles/RunUAT.sh BuildCookRun … -platform=Linux` | `Engine/Build/BatchFiles/RunUAT.sh BuildCookRun … -platform=Mac` |

The automation arguments are the same on every platform:
`"<abs>/<Project>.uproject" -ExecCmds="Automation RunTests <Project>.; Quit" -unattended -nullrhi -stdout -FullStdOutLogOutput`.
`RunTests` is a partial (substring) match. Each test prints
`Test Completed. Result={<status>}`, and the run ends with
`**** TEST COMPLETE. EXIT CODE: <n> ****` — exit code 0 means no test failed.
Only one `Automation` run request is allowed per `-ExecCmds`, and `-testexit=` is
legacy.

The Windows column was run on UE 5.7. The Linux and macOS columns come from
Epic's documentation and forum answers by Epic staff (sources below); Epic never
prints the full Linux test line, so it is assembled from the executable and the
platform-neutral arguments.

Sources:
- Build.sh on Linux and Mac, platform names — *Create an Installed Build*: https://dev.epicgames.com/documentation/en-us/unreal-engine/create-an-installed-build-of-unreal-engine?application_version=5.7
- `RunUBT.sh <Target> [Linux|Mac] Development` — *Unreal Insights*: https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-insights-in-unreal-engine?application_version=5.7
- `Engine/Binaries/Linux/UnrealEditor`, `Engine/Binaries/Mac/UnrealEditor.app` — *Onboarding Licensees*: https://dev.epicgames.com/documentation/en-us/unreal-engine/onboarding-licensees-in-unreal-engine?application_version=5.7 and *Linux Development Quickstart*: https://dev.epicgames.com/documentation/en-us/unreal-engine/linux-development-quickstart-for-unreal-engine?application_version=5.7
- `-nullrhi`, `-unattended`, `-stdout`, `-ExecCmds` — *Command-Line Arguments Reference*: https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-command-line-arguments-reference?application_version=5.7
- Running tests from the command line — *Run Automation Tests*: https://dev.epicgames.com/documentation/en-us/unreal-engine/run-automation-tests-in-unreal-engine?application_version=5.7 ; result lines and exit code — *Review Test Results*: https://dev.epicgames.com/documentation/en-us/unreal-engine/review-test-results-in-unreal-engine?application_version=5.7
- `RunUAT.sh` from `Engine/Build/BatchFiles` on Mac/Linux — *Unreal Automation Tool Overview*: https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-automation-tool-overview-for-unreal-engine?application_version=5.7

---

## C++ Coding

### Use Modern C++ Features (C++20, the minimum in UE 5.8)

UE 5.8 makes C++20 the floor: `CppStandardVersion.Cpp14` and `Cpp17` are marked
obsolete ("no longer allowed, code will not compile with this version") and
`Minimum = Cpp20`. C++23 is selectable but marked experimental.

```cpp
// ✅ Use TObjectPtr<T> (UE5 type-safe pointers)
UPROPERTY()
TObjectPtr<UStaticMeshComponent> MeshComp;

// ✅ Structured bindings
if (auto [bSuccess, Value] = TryGetValue(); bSuccess) {
    // Use Value
}

// ✅ Concepts and constraints (C++20)
template<typename T>
concept Damageable = requires(T t, float damage) {
    { t.TakeDamage(damage) } -> std::same_as<void>;
};
```

### Use UPROPERTY() for Garbage Collection

```cpp
// ✅ UPROPERTY ensures GC doesn't delete this
UPROPERTY()
TObjectPtr<AActor> MyActor;

// ❌ Raw pointers can become dangling
AActor* MyActor; // Dangerous! May be garbage collected
```

### Use UFUNCTION() for Blueprint Exposure

```cpp
// ✅ Callable from Blueprint
UFUNCTION(BlueprintCallable, Category="Combat")
void TakeDamage(float Damage);

// ✅ Implementable in Blueprint
UFUNCTION(BlueprintImplementableEvent, Category="Combat")
void OnDeath();
```

---

## Blueprint Best Practices

### Use Blueprint vs C++

- **C++**: Core gameplay systems, performance-critical code, low-level engine interaction
- **Blueprint**: Rapid prototyping, content creation, data-driven logic, designer workflows

### Blueprint Performance Tips

```cpp
// ✅ Use Event Tick sparingly (expensive)
// Prefer timers or events

// ✅ Move hot Blueprint logic to C++ by hand
// (Blueprint Nativization is gone: UE 5.8's packaging settings keep only an
// unused EProjectPackagingBlueprintNativizationMethod enum, no setting)

// ✅ Cache frequently accessed components
// Don't call GetComponent every tick
```

---

## Rendering (UE 5.8)

### Use Lumen for Global Illumination

```cpp
// Enable: Project Settings > Engine > Rendering > Dynamic Global Illumination Method = Lumen
// Real-time GI, no lightmap baking needed (RECOMMENDED)
```

### Use Nanite for High-Poly Meshes

```cpp
// Enable on Static Mesh: Details > Nanite Settings > Enable Nanite Support
// Automatically LODs millions of triangles (RECOMMENDED for detailed meshes)
```

### Use MegaLights for Complex Lighting (UE 5.5+, production-ready in 5.8)

```cpp
// Enable: Project Settings > Engine > Rendering > Direct Lighting > MegaLights
//   (r.MegaLights.EnableForProject, default 0; a Post Process Volume can
//   override it, and it can be disabled per light)
// Many shadow-casting lights at a consistent, low GPU cost
```

### Use Substrate Materials (Production-Ready in 5.7)

```cpp
// New projects created in 5.7+ have Substrate enabled automatically.
// Existing projects keep their setting; to enable it:
//   Project Settings > Engine > Rendering > Substrate > Substrate materials
//   (r.Substrate, read-only at runtime, editor restart required)
// Modular, physically accurate materials (RECOMMENDED for new projects)
```

---

## Enhanced Input System

### Setup Enhanced Input

```cpp
// 1. Create Input Action (IA_Jump)
// 2. Create Input Mapping Context (IMC_Default)
// 3. Add mapping: IA_Jump → Space Bar

// C++ Setup:
#include "EnhancedInputComponent.h"
#include "EnhancedInputSubsystems.h"

void AMyCharacter::BeginPlay() {
    Super::BeginPlay();

    if (APlayerController* PC = Cast<APlayerController>(GetController())) {
        if (UEnhancedInputLocalPlayerSubsystem* Subsystem =
            ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(PC->GetLocalPlayer())) {
            Subsystem->AddMappingContext(DefaultMappingContext, 0);
        }
    }
}

void AMyCharacter::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) {
    UEnhancedInputComponent* EIC = Cast<UEnhancedInputComponent>(PlayerInputComponent);
    EIC->BindAction(JumpAction, ETriggerEvent::Started, this, &ACharacter::Jump);
    EIC->BindAction(MoveAction, ETriggerEvent::Triggered, this, &AMyCharacter::Move);
}

void AMyCharacter::Move(const FInputActionValue& Value) {
    FVector2D MoveVector = Value.Get<FVector2D>();
    AddMovementInput(GetActorForwardVector(), MoveVector.Y);
    AddMovementInput(GetActorRightVector(), MoveVector.X);
}
```

---

## Gameplay Ability System (GAS)

### Use GAS for Complex Gameplay

```cpp
// ✅ Use GAS for: Abilities, buffs, damage calculation, cooldowns
// Modular, scalable, multiplayer-ready

// Install: Enable "Gameplay Abilities" plugin

// Example Ability:
UCLASS()
class UGA_Fireball : public UGameplayAbility {
    GENERATED_BODY()

public:
    virtual void ActivateAbility(...) override {
        // Ability logic
        SpawnFireball();
        CommitAbility(); // Commit cost/cooldown
    }
};
```

---

## World Partition (Large Worlds)

### Use World Partition for Open Worlds

```cpp
// Enable: World Settings > Enable World Partition
// Automatically streams world cells based on player location

// Data Layers: Organize content (e.g., "Gameplay", "Audio", "Lighting")
// Runtime Data Layers: Load/unload at runtime
```

---

## Niagara (VFX)

### Use Niagara (Not Cascade)

```cpp
// Create: Content Browser > Right Click > FX > Niagara System
// GPU-accelerated, node-based particle system (RECOMMENDED)

// Spawn particles:
UNiagaraComponent* NiagaraComp = UNiagaraFunctionLibrary::SpawnSystemAtLocation(
    GetWorld(),
    ExplosionSystem,
    GetActorLocation()
);
```

---

## MetaSounds (Audio)

### Use MetaSounds for Procedural Audio

```cpp
// Create: Content Browser > Right Click > Sounds > MetaSound Source
// Node-based audio, replaces Sound Cue for complex logic (RECOMMENDED)

// Play MetaSound:
UAudioComponent* AudioComp = UGameplayStatics::SpawnSound2D(
    GetWorld(),
    MetaSoundSource
);
```

---

## Replication (Multiplayer)

### Server-Authoritative Pattern

```cpp
// ✅ Client sends input, server validates and replicates
UFUNCTION(Server, Reliable)
void Server_Move(FVector Direction);

void AMyCharacter::Server_Move_Implementation(FVector Direction) {
    // Server validates and applies movement
    AddMovementInput(Direction);
}

// ✅ Replicate important state
UPROPERTY(Replicated)
int32 Health;

void AMyCharacter::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const {
    Super::GetLifetimeReplicatedProps(OutLifetimeProps);
    DOREPLIFETIME(AMyCharacter, Health);
}
```

---

## Performance Optimization

### Use Object Pooling

```cpp
// ✅ Reuse objects instead of Spawn/Destroy
// The pool is a member of a UCLASS. UPROPERTY() makes the container a GC
// reference, so inactive pooled actors are not collected (same rule as the
// GC section above).
UPROPERTY()
TArray<TObjectPtr<AActor>> ProjectilePool;

//
// AActor has no IsActive()/SetActive() -- those are UActorComponent members.
// A parked actor is hidden, has no collision and does not tick.
AActor* GetPooledProjectile() {
    for (AActor* Proj : ProjectilePool) {
        if (Proj && Proj->IsHidden()) {
            Proj->SetActorHiddenInGame(false);
            Proj->SetActorEnableCollision(true);
            Proj->SetActorTickEnabled(true);
            return Proj;
        }
    }
    // Pool exhausted, spawn new
    return SpawnNewProjectile();
}

void ReturnToPool(AActor* Proj) {
    Proj->SetActorHiddenInGame(true);
    Proj->SetActorEnableCollision(false);
    Proj->SetActorTickEnabled(false);
}
```

### Use Instanced Static Meshes

```cpp
// ✅ Hierarchical Instanced Static Mesh Component (HISM)
// Render thousands of identical meshes in one draw call
UHierarchicalInstancedStaticMeshComponent* HISM = CreateDefaultSubobject<UHierarchicalInstancedStaticMeshComponent>(TEXT("Trees"));
for (int i = 0; i < 1000; i++) {
    HISM->AddInstance(FTransform(RandomLocation));
}
```

---

## Debugging

### Use Logging

```cpp
// ✅ Structured logging
UE_LOG(LogTemp, Warning, TEXT("Player health: %d"), Health);

// Custom log category
DECLARE_LOG_CATEGORY_EXTERN(LogMyGame, Log, All);
DEFINE_LOG_CATEGORY(LogMyGame);
UE_LOG(LogMyGame, Error, TEXT("Critical error!"));

// UE 5.8: UE_LOGF takes a printf-style format literal given as "..." or
// UTF8TEXT("...") (LogMacros.h). Epic asks new code to use it: UE_LOG "will
// eventually be deprecated", and 5.8 ships ConvertUELog.py to convert most uses.
UE_LOGF(LogMyGame, Warning, "Player health: %d", Health);
```

### Use Visual Logger

```cpp
// ✅ Visual debugging
#include "VisualLogger/VisualLogger.h"

UE_VLOG_SEGMENT(this, LogTemp, Log, StartPos, EndPos, FColor::Red, TEXT("Raycast"));
UE_VLOG_LOCATION(this, LogTemp, Log, TargetLocation, 50.f, FColor::Green, TEXT("Target"));
```

---

## Summary: UE 5.8 Recommended Stack

| Feature | Use This (2026) | Notes |
|---------|------------------|-------|
| **Lighting** | Lumen + MegaLights | Real-time GI, many shadow-casting lights |
| **Geometry** | Nanite | High-poly meshes, automatic LOD |
| **Materials** | Substrate | Modular, physically accurate |
| **Input** | Enhanced Input | Rebindable, modular |
| **VFX** | Niagara | GPU-accelerated |
| **Audio** | MetaSounds | Procedural audio |
| **World Streaming** | World Partition | Large open worlds |
| **Gameplay** | Gameplay Ability System | Complex abilities, buffs |

---

**Sources:**
- https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-5-8-documentation?application_version=5.8
- UE 5.8 release notes (MegaLights production-ready, Iris production-ready, Platform SDK Upgrades, `UE_LOGF` upgrade note): https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-5-8-release-notes?application_version=5.8
- 5.8 engine source, read from a UE 5.8.1 install on 2026-10-17: C++ standard — `Engine/Source/Programs/UnrealBuildTool/System/CppCompileEnvironment.cs` (`enum CppStandardVersion`); Blueprint Nativization — `Engine/Source/Developer/DeveloperToolSettings/Classes/Settings/ProjectPackagingSettings.h` (the enum is the only reference left in engine source); MegaLights setting — `Engine/Source/Runtime/Engine/Classes/Engine/RendererSettings.h` (`bEnableMegaLights`, category DirectLighting) and `Engine/Source/Runtime/Renderer/Private/MegaLights/MegaLights.cpp` (default 0); Substrate — `RendererSettings.h` (`bEnableSubstrate`, category Substrate) and `Engine/Source/Runtime/RenderCore/Private/RenderUtils.cpp` ("New projects created with 5.7, will have Substrate enabled automatically"); `UE_LOGF` — `Engine/Source/Runtime/Core/Public/Logging/LogMacros.h`
- Object pooling calls — `Engine/Source/Runtime/Engine/Classes/GameFramework/Actor.h` (UE 5.8.1: `SetActorHiddenInGame`, `SetActorEnableCollision`, `SetActorTickEnabled`, `IsHidden`; no `IsActive`/`SetActive`) and `Engine/Source/Runtime/Engine/Classes/Components/ActorComponent.h` (`UActorComponent::SetActive`/`IsActive`); `AActor` API, UE 5.8: https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Engine/AActor?application_version=5.8
- https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-5-7-release-notes
- Object pooling container (`UPROPERTY() TArray<TObjectPtr<AActor>>`) — *Unreal Object Handling* (a UPROPERTY reference keeps an object alive "whether it's a simple Object pointer or an Unreal Engine container class"; a raw pointer "will not be automatically nulled, nor will it prevent garbage collection"): https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-object-handling-in-unreal-engine?application_version=5.7 ; *Object Pointers* ("TObjectPtr is only garbage collection safe if it is marked as a UPROPERTY"; use it in place of raw pointers): https://dev.epicgames.com/documentation/en-us/unreal-engine/object-pointers-in-unreal-engine?application_version=5.7
