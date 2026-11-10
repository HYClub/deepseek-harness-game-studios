# Unreal Engine 5.8 — Optional Plugins & Systems

**Last verified:** 2026-10-17 (5.8 status flags, Mover, Iris, AI Assistant, MCP Server, Raw Input); 2026-02-13 (rest of file, written against 5.7)

This document indexes **optional plugins and systems** available in Unreal Engine 5.8.
These are NOT part of the core engine but are commonly used for specific game types.

---

## How to Use This Guide

**✅ Detailed Documentation Available** - See `plugins/` directory for comprehensive guides
**🟡 Brief Overview Only** - Links to official docs, use WebSearch for details
**⚠️ Experimental** - May have breaking changes in future versions
**📦 Plugin Required** - Must be enabled in `Edit > Plugins`

### Status flags in the UE 5.8 install

Epic's own `.uplugin` flags decide whether the Plugins window shows a plugin as
Beta or Experimental. Read from a UE 5.8.1 install (`Engine/Plugins/...`) on
2026-10-17; where a status line below and this table disagree, the table is the
engine's word.

| Plugin | `.uplugin` | 5.8 flag |
|--------|-----------|----------|
| Gameplay Abilities | `Runtime/GameplayAbilities/GameplayAbilities.uplugin` | none (not Beta/Experimental) |
| CommonUI | `Runtime/CommonUI/CommonUI.uplugin` | none |
| PCG | `PCG/PCG.uplugin` | none; enabled by default |
| Gameplay Cameras | `Cameras/GameplayCameras/GameplayCameras.uplugin` | Experimental; enabled by default |
| Mass Gameplay / Mass Crowd | `Runtime/MassGameplay/MassGameplay.uplugin`, `AI/MassCrowd/MassCrowd.uplugin` | Experimental (MassEntity itself is engine code, `Engine/Source/Runtime/MassEntity`) |
| Niagara Fluids | `FX/NiagaraFluids/NiagaraFluids.uplugin` | Beta |
| Water | `Experimental/Water/Water.uplugin` | Experimental |
| Landmass | `Experimental/Landmass/Landmass.uplugin` | Beta |
| Chaos Destruction (Geometry Collection) | `Experimental/GeometryCollectionPlugin/GeometryCollectionPlugin.uplugin` | Beta |
| Chaos Vehicles | `Experimental/ChaosVehiclesPlugin/ChaosVehiclesPlugin.uplugin` | Experimental |
| Geometry Scripting | `Runtime/GeometryScripting/GeometryScripting.uplugin` | none |
| Mover / ChaosMover | `Experimental/Mover/Mover.uplugin`, `Experimental/ChaosMover/ChaosMover.uplugin` | Experimental |
| Iris | `Experimental/Iris/Iris.uplugin` | Beta (the 5.8 release notes call Iris "production-ready for licensees") |
| Replication Graph | `Runtime/ReplicationGraph/ReplicationGraph.uplugin` | Beta (no deprecation flag) |
| AI Assistant | `Experimental/AIAssistant/AIAssistant.uplugin` | Experimental |
| Raw Input | `Experimental/RawInput/RawInput.uplugin` | `"DeprecatedEngineVersion": "5.8"` |
| Game Input (Windows) | `GameInputWindows/GameInputWindows.uplugin` | Beta |
| OpenXR | `Runtime/OpenXR/OpenXR.uplugin` | none |
| Enhanced Input, MetaSound | `EnhancedInput/EnhancedInput.uplugin`, `Runtime/Metasound/Metasound.uplugin` | none; enabled by default |

---

## Production-Ready Systems (Detailed Docs Available)

### ✅ Gameplay Ability System (GAS)
- **Purpose:** Modular ability system (abilities, attributes, effects, cooldowns, costs)
- **When to use:** RPGs, MOBAs, shooters with abilities, any ability-based gameplay
- **Knowledge Gap:** GAS stable since UE4, UE5 improvements post-cutoff
- **Status:** Production-Ready
- **Plugin:** `GameplayAbilities` (built-in, enable in Plugins)
- **Detailed Docs:** [plugins/gameplay-ability-system.md](plugins/gameplay-ability-system.md)
- **Official:** https://docs.unrealengine.com/5.7/en-US/gameplay-ability-system-for-unreal-engine/

---

### ✅ CommonUI
- **Purpose:** Cross-platform UI framework (automatic gamepad/mouse/touch input routing)
- **When to use:** Multi-platform games (console + PC), input-agnostic UI
- **Knowledge Gap:** Production-ready in UE5+, major improvements post-cutoff
- **Status:** Production-Ready
- **Plugin:** `CommonUI` (built-in, enable in Plugins)
- **Detailed Docs:** [plugins/common-ui.md](plugins/common-ui.md)
- **Official:** https://docs.unrealengine.com/5.7/en-US/commonui-plugin-for-advanced-user-interfaces-in-unreal-engine/

---

### ✅ Gameplay Camera System
- **Purpose:** Modular camera management (camera modes, blending, context-aware cameras)
- **When to use:** Games needing dynamic camera behavior (3rd person, aiming, vehicles)
- **Knowledge Gap:** NEW in UE 5.5, completely post-cutoff
- **Status:** ⚠️ Experimental (UE 5.5-5.8; still flagged Experimental in 5.8)
- **Plugin:** `GameplayCameras` (built-in, enable in Plugins)
- **Detailed Docs:** [plugins/gameplay-camera-system.md](plugins/gameplay-camera-system.md)
- **Official:** https://docs.unrealengine.com/5.7/en-US/gameplay-cameras-in-unreal-engine/

---

### ✅ PCG (Procedural Content Generation)
- **Purpose:** Node-based procedural world generation (foliage, props, terrain details)
- **When to use:** Open worlds, procedural levels, large-scale environment population
- **Knowledge Gap:** Experimental in UE 5.0-5.6, production-ready in 5.7; 5.8 adds manual editing, complex attributes and embedded subgraphs
- **Status:** Production-Ready (as of UE 5.7)
- **Plugin:** `PCG` (built-in, enable in Plugins)
- **Detailed Docs:** [plugins/pcg.md](plugins/pcg.md)
- **Official:** https://docs.unrealengine.com/5.7/en-US/procedural-content-generation-in-unreal-engine/

---

## Other Plugins (Brief Overview)

### 🟡 Mass Entity
- **Purpose:** High-performance ECS for large-scale AI/crowds (10,000+ entities)
- **When to use:** RTS, city simulators, massive crowds, large-scale AI
- **Status:** `MassGameplay` and `MassCrowd` are flagged Experimental in 5.8. 5.8 overhauled Mass: Mass Signals moved into the core engine, entities can be created off the game thread, and a new MassCore module separates the core entity system from MassGameplay
- **Plugin:** `MassGameplay`, `MassCrowd` (MassEntity is engine code in 5.8, not a plugin)
- **Official:** https://docs.unrealengine.com/5.7/en-US/mass-entity-in-unreal-engine/

---

### 🟡 Niagara Fluids
- **Purpose:** GPU fluid simulation (smoke, fire, liquids)
- **When to use:** Realistic fire/smoke effects, water simulation
- **Status:** Beta (5.8 flag)
- **Plugin:** `NiagaraFluids` (built-in)
- **Official:** https://docs.unrealengine.com/5.7/en-US/niagara-fluids-in-unreal-engine/

---

### 🟡 Water Plugin
- **Purpose:** Ocean, river, lake rendering with buoyancy
- **When to use:** Games with water bodies, boats, swimming
- **Status:** Experimental (5.8 flag)
- **Plugin:** `Water` (built-in)
- **Official:** https://docs.unrealengine.com/5.7/en-US/water-system-in-unreal-engine/

---

### 🟡 Landmass Plugin
- **Purpose:** Terrain sculpting and landscape editing
- **When to use:** Large-scale terrain modification, procedural landscapes
- **Status:** Beta (5.8 flag)
- **Plugin:** `Landmass` (built-in)
- **Official:** https://docs.unrealengine.com/5.7/en-US/landmass-plugin-in-unreal-engine/

---

### 🟡 Chaos Destruction
- **Purpose:** Real-time fracture and destruction
- **When to use:** Destructible environments (walls, buildings, objects)
- **Status:** Beta (5.8 flag on `GeometryCollectionPlugin`)
- **Plugin:** `GeometryCollectionPlugin` (built-in)
- **Official:** https://docs.unrealengine.com/5.7/en-US/destruction-in-unreal-engine/

---

### 🟡 Chaos Vehicle
- **Purpose:** Advanced vehicle physics (wheeled vehicles, suspension)
- **When to use:** Racing games, vehicle-heavy gameplay
- **Status:** Experimental (5.8 flag; replaces PhysX Vehicles)
- **Plugin:** `ChaosVehiclesPlugin` (built-in)
- **Official:** https://docs.unrealengine.com/5.7/en-US/chaos-vehicles-overview-in-unreal-engine/

---

### 🟡 Geometry Scripting
- **Purpose:** Runtime procedural mesh generation and editing
- **When to use:** Dynamic mesh creation, procedural modeling
- **Status:** Production-Ready (UE 5.1+)
- **Plugin:** `GeometryScripting` (built-in)
- **Official:** https://docs.unrealengine.com/5.7/en-US/geometry-scripting-in-unreal-engine/

---

### 🟡 Motion Design Tools
- **Purpose:** Motion graphics, procedural animation, keyframe animation
- **When to use:** UI animations, procedural motion, keyframed sequences
- **Status:** Experimental → Production-Ready (UE 5.4+)
- **Plugin:** `MotionDesign` (built-in)
- **Official:** https://docs.unrealengine.com/5.7/en-US/motion-design-mode-in-unreal-engine/

---

## Experimental Plugins (Use with Caution)

### ⚠️ AI Assistant (UE 5.7+)
- **Purpose:** In-editor AI guidance and help
- **Status:** Experimental
- **Plugin:** `AIAssistant` (Experimental, off by default in 5.8)
- **Official:** Announced in UE 5.7 release

---

### ⚠️ MCP Server (UE 5.8+)
- **Purpose:** Lets agentic AI systems connect to the Unreal Editor to understand the engine and project and help build assets or systems
- **Status:** Experimental
- **Official:** UE 5.8 release notes, *MCP Server (Experimental)*

---

### ⚠️ Mover / ChaosMover
- **Purpose:** Character and object movement framework with rollback and prediction
- **Status:** Experimental (5.8 flag). 5.8 continues "the architectural work toward moving Mover out of Experimental status"
- **5.8 change:** PhysicsMover / NetworkPhysicsLiaison code was removed from the Mover plugin; use `ChaosMover`

---

### ⚠️ OpenXR (VR/AR)
- **Purpose:** Cross-platform VR/AR support
- **When to use:** VR/AR games
- **Status:** Production-Ready for VR, Experimental for AR
- **Plugin:** `OpenXR` (built-in)
- **Official:** https://docs.unrealengine.com/5.7/en-US/openxr-in-unreal-engine/

---

### ⚠️ Online Subsystem (EOS, Steam, etc.)
- **Purpose:** Platform-agnostic online services (matchmaking, friends, achievements)
- **When to use:** Multiplayer games with online features
- **Status:** Production-Ready
- **Plugin:** `OnlineSubsystem`, `OnlineSubsystemEOS`, `OnlineSubsystemSteam`
- **Official:** https://docs.unrealengine.com/5.7/en-US/online-subsystem-in-unreal-engine/

---

## Deprecated Plugins (Avoid for New Projects)

### ❌ PhysX Vehicles
- **Deprecated:** Use Chaos Vehicles instead
- **Status:** Legacy, not recommended

---

### ❌ Old Replication Graph
- **Deprecated:** Replaced by Iris (UE 5.1+)
- **Status:** Use Iris for modern networking. Note: in 5.8 the `ReplicationGraph` plugin carries a Beta flag and no deprecation flag, so this is guidance, not an engine deprecation

---

### ❌ Raw Input
- **Deprecated:** In UE 5.8 (`"DeprecatedEngineVersion": "5.8"`)
- **Status:** Use the Game Input for Windows plugin (`GameInputWindows`, Beta)

---

## On-Demand WebSearch Strategy

For plugins NOT listed above, use the following approach when users ask:

1. **WebSearch** for latest documentation: `"Unreal Engine 5.8 [plugin name]"`
2. Verify if plugin is:
   - Post-cutoff (beyond May 2025 training data)
   - Experimental vs Production-Ready
   - Still supported in UE 5.8
3. Optionally cache findings in `plugins/[plugin-name].md` for future reference

---

## Quick Decision Guide

**I need abilities/skills/buffs** → **Gameplay Ability System (GAS)**
**I need cross-platform UI (console + PC)** → **CommonUI**
**I need dynamic cameras** → **Gameplay Camera System**
**I need procedural worlds** → **PCG**
**I need large crowds (1000s of AI)** → **Mass Entity**
**I need destructible environments** → **Chaos Destruction**
**I need vehicles** → **Chaos Vehicles**
**I need water/oceans** → **Water Plugin**
**I need VR/AR** → **OpenXR**

---

**Last Updated:** 2026-10-17
**Engine Version:** Unreal Engine 5.8
**Sources (5.8):** UE 5.8 release notes https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-5-8-release-notes?application_version=5.8 (Mass, Iris, Mover, MCP Server, Raw Input upgrade note); `.uplugin` files in a UE 5.8.1 install, paths in the status table above
**LLM Knowledge Cutoff:** May 2025
