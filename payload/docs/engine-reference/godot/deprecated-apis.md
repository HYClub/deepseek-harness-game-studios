# Godot — Deprecated APIs

Last verified: 2026-10-17 (4.7 rows); 2026-02-12 (rest)

The 4.7 migration guide lists no formal deprecations; the 4.7 rows below are
renames and removals from it
(https://docs.godotengine.org/en/stable/tutorials/migrating/upgrading_to_godot_4.7.html).

If an agent suggests any API in the "Deprecated" column, it MUST be replaced
with the "Use Instead" column.

## Nodes & Classes

| Deprecated | Use Instead | Since | Notes |
|------------|-------------|-------|-------|
| `TileMap` | `TileMapLayer` | 4.3 | One node per layer instead of multi-layer node |
| `VisibilityNotifier2D` | `VisibleOnScreenNotifier2D` | 4.0 | Renamed for clarity |
| `VisibilityNotifier3D` | `VisibleOnScreenNotifier3D` | 4.0 | Renamed for clarity |
| `YSort` | `Node2D.y_sort_enabled` | 4.0 | Property on Node2D, not a separate node |
| `Navigation2D` / `Navigation3D` | `NavigationServer2D` / `NavigationServer3D` | 4.0 | Server-based API |
| `EditorSceneFormatImporterFBX` | `EditorSceneFormatImporterFBX2GLTF` | 4.3 | Renamed |

## Methods & Properties

| Deprecated | Use Instead | Since | Notes |
|------------|-------------|-------|-------|
| `yield()` | `await signal` | 4.0 | GDScript 2.0 coroutine syntax |
| `connect("signal", obj, "method")` | `signal.connect(callable)` | 4.0 | Callable-based connections |
| `instance()` | `instantiate()` | 4.0 | Renamed |
| `PackedScene.instance()` | `PackedScene.instantiate()` | 4.0 | Renamed |
| `get_world()` | `get_world_3d()` | 4.0 | Explicit 2D/3D split |
| `OS.get_ticks_msec()` | `Time.get_ticks_msec()` | 4.0 | Time singleton preferred |
| `duplicate()` for nested resources | `duplicate_deep()` | 4.5 | Explicit deep copy control |
| `Skeleton3D` signal `bone_pose_updated` | `skeleton_updated` | 4.3 | Renamed |
| `AnimationPlayer.method_call_mode` | `AnimationMixer.callback_mode_method` | 4.3 | Moved to base class |
| `AnimationPlayer.playback_active` | `AnimationMixer.active` | 4.3 | Moved to base class |
| `RichTextLabel.ImageUpdateMask.UPDATE_WIDTH_IN_PERCENT` | `ImageUpdateMask.UPDATE_WIDTH_UNIT` | 4.7 | Renamed; GDScript using the old name breaks |
| `add_image()` / `update_image()` `width_in_percent`, `height_in_percent` (`bool`) | `width_unit`, `height_unit` (`RichTextLabel.ImageUnit`) | 4.7 | Renamed and retyped |
| `DisplayServer.AccessibilityLiveMode` for `Control.accessibility_live` | `AccessibilityServer.AccessibilityLiveMode` | 4.7 | Enum moved to `AccessibilityServer` |
| `AudioEffectSpectrumAnalyzer.tap_back_pos` | — | 4.7 | Removed |
| `EditorSceneFormatImporter.IMPORT_*` constants | `EditorSceneFormatImporter.ImportFlags` enum | 4.7 | Same names, now in an enum |

## Patterns (Not Just APIs)

| Deprecated Pattern | Use Instead | Why |
|--------------------|-------------|-----|
| String-based `connect()` | Typed signal connections | Type-safe, refactor-friendly |
| `$NodePath` in `_process()` | `@onready var` cached reference | Performance: path lookup every frame |
| Untyped `Array` / `Dictionary` | `Array[Type]`, typed variables | GDScript compiler optimizations |
| `Texture2D` in `Shader.set_default_texture_parameter()` / `get_default_texture_parameter()` | `Texture` base type | Changed in 4.4; the shading language's `sampler2D` / `texture()` did not change |
| Manual post-process viewport chains | `Compositor` + `CompositorEffect` | Structured post-processing (4.3+) |
| GodotPhysics3D for new projects | Jolt Physics 3D | Default since 4.6; better stability |
| `event.device == 0` to detect mouse or keyboard | `event is InputEventMouse` / `InputEventKey`, or `InputEvent.DEVICE_ID_MOUSE` / `DEVICE_ID_KEYBOARD` | Since 4.7 mouse and keyboard no longer report device `0`, which some joypads use |
| Installing addons from the editor's AssetLib tab | The editor's Asset Store workspace (4.7+) | 4.7 replaced the Asset Library with the Asset Store |
