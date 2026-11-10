# Unreal Engine 5.8 — Networking Module Reference

**Last verified:** 2026-10-18 (Iris status: release notes and plugin flag); 2026-10-17 (UE 5.8 changes block); 2026-02-13 (rest of file, written against 5.7)
**Knowledge Gap:** UE 5.7-5.8 networking improvements (Iris production-ready in 5.8)

> **UE 5.8 changes:** Iris "is now production-ready for licensees in UE
> 5.8" (the `Iris.uplugin` in a 5.8.1 install still carries a Beta flag), with
> clearer protocol-mismatch errors and RPC DoS detection re-enabled. Thread-safety
> primitives were added for parallel `NetConnection::Tick`; a target that does
> not need them can drop them with `ExcludeParallelIrisSupport` in
> `TargetRules.cs`. Network Prediction gained optional Iris support. Source: UE
> 5.8 release notes, https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-5-8-release-notes?application_version=5.8
>
> **The notes and the plugin flag disagree.** Treat Iris as production-ready,
> as the release notes say ("Iris is now production-ready for licensees in UE
> 5.8", Framework > "Iris: Production-Ready Replication System"), and expect
> the editor's plugin list to show it as Beta: `Engine/Plugins/Experimental/Iris/Iris.uplugin`
> in a 5.8.1 install (CL 56057345) has `"IsBetaVersion": true`. Both read
> 2026-10-18.

---

## Overview

UE 5.8 networking:
- **Client-Server Architecture**: Server-authoritative (RECOMMENDED)
- **Replication**: Automatic state synchronization
- **RPCs (Remote Procedure Calls)**: Call functions across network
- **Relevancy**: Optimize bandwidth by only replicating relevant actors

---

## Basic Multiplayer Setup

### Enable Replication on Actor

```cpp
UCLASS()
class AMyActor : public AActor {
    GENERATED_BODY()

public:
    AMyActor() {
        // ✅ Enable replication
        bReplicates = true;
        bAlwaysRelevant = true; // Always replicate to all clients
    }
};
```

### Network Role Checks

```cpp
// Check role
if (HasAuthority()) {
    // Running on server
}

if (GetLocalRole() == ROLE_AutonomousProxy) {
    // This is the owning client (local player)
}

if (GetRemoteRole() == ROLE_SimulatedProxy) {
    // This is a remote client (other players)
}
```

---

## Replicated Variables

### Basic Replication

```cpp
UPROPERTY(Replicated)
int32 Health;

UPROPERTY(Replicated)
FVector Position;

// ✅ Implement GetLifetimeReplicatedProps
void AMyActor::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const {
    Super::GetLifetimeReplicatedProps(OutLifetimeProps);

    DOREPLIFETIME(AMyActor, Health);
    DOREPLIFETIME(AMyActor, Position);
}
```

### Conditional Replication

```cpp
// Only replicate to owner
DOREPLIFETIME_CONDITION(AMyCharacter, Ammo, COND_OwnerOnly);

// Skip owner (replicate to everyone else)
DOREPLIFETIME_CONDITION(AMyCharacter, TeamID, COND_SkipOwner);

// Only when changed
DOREPLIFETIME_CONDITION(AMyCharacter, Score, COND_InitialOnly);
```

### RepNotify (Callback on Replication)

```cpp
UPROPERTY(ReplicatedUsing=OnRep_Health)
int32 Health;

UFUNCTION()
void OnRep_Health() {
    // Called on clients when Health changes
    UpdateHealthUI();
}

// Implement GetLifetimeReplicatedProps (same as above)
```

---

## RPCs (Remote Procedure Calls)

### Server RPC (Client → Server)

```cpp
// Client calls, server executes. WithValidation declares Server_TakeDamage_Validate.
UFUNCTION(Server, Reliable, WithValidation)
void Server_TakeDamage(int32 Damage);

void AMyCharacter::Server_TakeDamage_Implementation(int32 Damage) {
    // Runs on server only
    Health -= Damage;

    if (Health <= 0) {
        Server_Die();
    }
}

bool AMyCharacter::Server_TakeDamage_Validate(int32 Damage) {
    // Validate input (anti-cheat)
    return Damage >= 0 && Damage <= 100;
}
```

### Client RPC (Server → Client)

```cpp
// Server calls, client executes
UFUNCTION(Client, Reliable)
void Client_ShowDeathScreen();

void AMyCharacter::Client_ShowDeathScreen_Implementation() {
    // Runs on client only
    ShowDeathUI();
}
```

### Multicast RPC (Server → All Clients)

```cpp
// Server calls, all clients execute
UFUNCTION(NetMulticast, Reliable)
void Multicast_PlayExplosion(FVector Location);

void AMyActor::Multicast_PlayExplosion_Implementation(FVector Location) {
    // Runs on server and all clients
    UGameplayStatics::SpawnEmitterAtLocation(GetWorld(), ExplosionEffect, Location);
}
```

### RPC Reliability

```cpp
// Reliable: Guaranteed delivery (important events)
UFUNCTION(Server, Reliable)
void Server_FireWeapon();

// Unreliable: Best-effort delivery (frequent updates, position sync)
UFUNCTION(Server, Unreliable)
void Server_UpdateAim(FRotator AimRotation);
```

---

## Server-Authoritative Pattern (RECOMMENDED)

### Movement Example

```cpp
class AMyCharacter : public ACharacter {
    UPROPERTY(Replicated)
    FVector ServerPosition;

    void Tick(float DeltaTime) override {
        Super::Tick(DeltaTime);

        if (GetLocalRole() == ROLE_AutonomousProxy) {
            // Client: Send input to server
            FVector Input = GetMovementInput();
            Server_Move(Input);

            // Client-side prediction (move locally)
            AddMovementInput(Input);
        }

        if (HasAuthority()) {
            // Server: Authoritative position
            ServerPosition = GetActorLocation();
        } else {
            // Client: Interpolate toward server position
            FVector NewPos = FMath::VInterpTo(GetActorLocation(), ServerPosition, DeltaTime, 5.0f);
            SetActorLocation(NewPos);
        }
    }

    UFUNCTION(Server, Unreliable)
    void Server_Move(FVector Input);

    void Server_Move_Implementation(FVector Input) {
        // Server validates and applies movement
        AddMovementInput(Input);
    }
};
```

---

## Network Relevancy (Bandwidth Optimization)

### Custom Relevancy

```cpp
bool AMyActor::IsNetRelevantFor(const AActor* RealViewer, const AActor* ViewTarget, const FVector& SrcLocation) const {
    // Only replicate if within range
    float Distance = FVector::Dist(SrcLocation, GetActorLocation());
    return Distance < 5000.0f;
}
```

### Always Relevant Actors

```cpp
AMyActor() {
    bAlwaysRelevant = true; // Replicate to all clients (e.g., GameState, PlayerController)
    bOnlyRelevantToOwner = true; // Only replicate to owner (e.g., PlayerController)
}
```

---

## Ownership

### Set Owner

```cpp
// Assign owner (important for RPCs and relevancy)
MyActor->SetOwner(OwningPlayerController);
```

### Check Owner

```cpp
if (GetOwner() == PlayerController) {
    // This actor is owned by this player
}
```

---

## Game Mode & Game State

### Game Mode (Server Only)

```cpp
UCLASS()
class AMyGameMode : public AGameMode {
    GENERATED_BODY()

public:
    // Game mode only exists on server
    // Use for server-side logic (spawning, scoring, rules)
};
```

### Game State (Replicated to All Clients)

```cpp
UCLASS()
class AMyGameState : public AGameState {
    GENERATED_BODY()

public:
    // ✅ Replicate game state to all clients
    UPROPERTY(Replicated)
    int32 RedTeamScore;

    UPROPERTY(Replicated)
    int32 BlueTeamScore;

    virtual void GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const override {
        Super::GetLifetimeReplicatedProps(OutLifetimeProps);
        DOREPLIFETIME(AMyGameState, RedTeamScore);
        DOREPLIFETIME(AMyGameState, BlueTeamScore);
    }
};
```

---

## Player Controller & Player State

### Player Controller (One per Player)

```cpp
UCLASS()
class AMyPlayerController : public APlayerController {
    GENERATED_BODY()

public:
    // Exists on server and owning client
    // Use for player-specific logic, input handling
};
```

### Player State (Replicated Player Info)

```cpp
UCLASS()
class AMyPlayerState : public APlayerState {
    GENERATED_BODY()

public:
    UPROPERTY(Replicated)
    int32 Kills;

    UPROPERTY(Replicated)
    int32 Deaths;

    virtual void GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const override {
        Super::GetLifetimeReplicatedProps(OutLifetimeProps);
        DOREPLIFETIME(AMyPlayerState, Kills);
        DOREPLIFETIME(AMyPlayerState, Deaths);
    }
};
```

---

## Sessions & Matchmaking

### Create Session

```cpp
#include "OnlineSubsystem.h"
#include "OnlineSessionSettings.h"

void CreateSession() {
    IOnlineSubsystem* OnlineSub = IOnlineSubsystem::Get();
    IOnlineSessionPtr Sessions = OnlineSub->GetSessionInterface();

    TSharedPtr<FOnlineSessionSettings> SessionSettings = MakeShareable(new FOnlineSessionSettings());
    SessionSettings->bIsLANMatch = false;
    SessionSettings->NumPublicConnections = 4;
    SessionSettings->bShouldAdvertise = true;

    Sessions->CreateSession(0, FName("MySession"), *SessionSettings);
}
```

### Find Sessions

```cpp
void FindSessions() {
    IOnlineSubsystem* OnlineSub = IOnlineSubsystem::Get();
    IOnlineSessionPtr Sessions = OnlineSub->GetSessionInterface();

    TSharedRef<FOnlineSessionSearch> SearchSettings = MakeShareable(new FOnlineSessionSearch());
    SearchSettings->bIsLanQuery = false;
    SearchSettings->MaxSearchResults = 20;

    Sessions->FindSessions(0, SearchSettings);
}
```

---

## Performance Tips

### Reduce Bandwidth

```cpp
// Use unreliable RPCs for frequent updates
UFUNCTION(Server, Unreliable)
void Server_UpdatePosition(FVector Pos);

// Conditional replication (only replicate to relevant clients)
DOREPLIFETIME_CONDITION(AMyActor, Health, COND_OwnerOnly);

// Limit replication frequency
SetReplicationFrequency(10.0f); // Update 10 times per second (default 100)
```

---

## Debugging

### Network Debugging

```cpp
// Console commands:
// stat net - Show network stats
// stat netplayerupdate - Show player update stats
// NetEmulation PktLoss=10 - Simulate 10% packet loss
// NetEmulation PktLag=100 - Simulate 100ms latency

// Draw debug for replication:
UE_LOG(LogNet, Warning, TEXT("Replicating Health: %d"), Health);
```

---

## Sources
- https://docs.unrealengine.com/5.7/en-US/networking-and-multiplayer-in-unreal-engine/
- https://docs.unrealengine.com/5.7/en-US/actor-replication-in-unreal-engine/
- https://docs.unrealengine.com/5.7/en-US/rpcs-in-unreal-engine/
