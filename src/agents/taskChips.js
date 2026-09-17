import * as THREE from 'three'
import { mdiCog } from '@mdi/js'
import { OVERLAY_LAYER } from '../core/engine.js'
import { withCurve } from '../core/curve.js'
import { hashString } from '../world/plots.js'
import { buildIconAtlas } from './iconAtlas.js'
import { HEAD_CLEAR } from './indicators.js'

/**
 * Task chips: one small badge per background call an astronaut is currently waiting on — a
 * Dagster job it triggered, a subagent it spawned, an MCP call in flight — stacked directly
 * above the status badge rather than folded into that single badge.
 *
 * A status badge answers "what is this thread doing"; a task chip answers "what is it *also*
 * waiting on right now", and there can be several at once. So unlike `Indicators`, which
 * rebuilds its instance buffer fresh from `agents` every frame, chips need to persist across
 * the frame a call disappears from the transcript so they can fade rather than vanish — the
 * same `Map` + `hold` lifecycle `MCPPipeField` uses for its pipes, rendered through one shared
 * instanced mesh instead of one mesh per connection since there can be several per astronaut.
 */

const FADE_SECONDS = 0.6
/** How many of one astronaut's tasks get a chip before the rest simply go undrawn. */
const MAX_PER_AGENT = 4
const CAPACITY = 96

/** Single-cell atlas: one glyph stands for "a call is out", colour carries which kind. */
const COLS = 1
const ROWS = 1
const ICON_PATHS = [mdiCog]

/** A chip's own `aSize` — its full height once the quad's own ±0.5 geometry is applied. */
const CHIP_SIZE = 0.09
/** The status badge's normal (non-urgent) `aSize` — see `sizes[n] = ... : 0.126` in indicators.js. */
const BADGE_SIZE = 0.126
/**
 * How far above the badge the nearest chip sits, and how much each further one adds.
 *
 * Both the badge and a chip anchor their own *bottom* edge at their `aCenter` (see the
 * half-height lift below and the matching one in indicators.js), so this offset is measured
 * from bottom-edge to bottom-edge, not centre to centre: shifting a chip's anchor up by the
 * badge's full height puts the chip's bottom edge exactly on the badge's top edge, and each
 * further chip only needs its own full height added on top of that to keep stacking flush.
 */
const STACK_BASE = BADGE_SIZE
const STACK_STEP = CHIP_SIZE

export class TaskChips {
  constructor(scene, capacity = CAPACITY) {
    this.capacity = capacity
    this.texture = buildIconAtlas(ICON_PATHS, COLS, ROWS, 256)
    /** `${agentId}:${taskId}` -> { hold, x, y, z, hue, slot } */
    this.chips = new Map()

    const geo = new THREE.PlaneGeometry(1, 1)
    this.centers = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    this.offsets = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2)
    this.sizes = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
    this.fades = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
    for (const a of [this.centers, this.offsets, this.sizes, this.fades]) a.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aCenter', this.centers)
    geo.setAttribute('aOffset', this.offsets)
    geo.setAttribute('aSize', this.sizes)
    geo.setAttribute('aFade', this.fades)

    this.material = this._material()
    this.mesh = new THREE.InstancedMesh(geo, this.material, capacity)
    this.mesh.layers.set(OVERLAY_LAYER)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 10
    scene.add(this.mesh)
    this.scene = scene

    const white = new THREE.Color(1, 1, 1)
    for (let i = 0; i < capacity; i++) this.mesh.setColorAt(i, white)
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    this._color = new THREE.Color()
  }

  /** Same billboard-in-view-space trick as the status badges, plus a lateral `aOffset`. */
  _material() {
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      toneMapped: true,
    })

    material.onBeforeCompile = (shader) => {
      withCurve(shader)
      this.uniforms = shader.uniforms

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute vec3 aCenter;
           attribute vec2 aOffset;
           attribute float aSize;
           attribute float aFade;
           varying float vFade;`
        )
        .replace(
          '#include <project_vertex>',
          `vec4 mvPosition = viewMatrix * vec4( bcBend( ( modelMatrix * vec4( aCenter, 1.0 ) ).xyz ), 1.0 );
           float dist = -mvPosition.z;
           float distScale = 2.0 + dist * 0.22;
           // Same lift as the status badge (see indicators.js): anchor the quad's *bottom*
           // edge at aCenter rather than its middle, so a chip sits level with the badge
           // instead of hanging half a chip-height below it.
           mvPosition.y += ( aSize * distScale ) * 0.5;
           mvPosition.xy += aOffset * distScale;
           mvPosition.xy += position.xy * ( aSize * distScale );
           vFade = aFade;
           gl_Position = projectionMatrix * mvPosition;`
        )
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n varying float vFade;`)
        .replace(
          '#include <map_fragment>',
          `vec4 chip = texture2D( map, vMapUv );
           float body = max( chip.g, chip.b );
           float shadow = texture2D( map, vMapUv + vec2( -0.006, 0.010 ), 2.0 ).g;
           vec3 plate = vec3( 0.045, 0.05, 0.07 );
           vec3 col = mix( plate, vColor.rgb * 0.85, chip.b );
           col = mix( col, vColor.rgb, chip.r );
           diffuseColor.rgb = col * body;
           diffuseColor.a = max( body, shadow * ( 1.0 - body ) * 0.55 ) * vFade;`
        )
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '')
    }
    return material
  }

  /**
   * `agents` is `Astronauts.agents` — anyone whose `thread.activeTasks` names calls in flight
   * gets a chip per call, fanned out beside the shoulder in the order the transcript listed them.
   */
  update(dt, elapsed, agents) {
    const active = new Set()
    for (const agent of agents) {
      if (agent.scale < 0.4 || agent.state === 'gone') continue
      const tasks = agent.thread?.activeTasks
      if (!tasks || !tasks.length) continue
      const slots = Math.min(tasks.length, MAX_PER_AGENT)
      for (let slot = 0; slot < slots; slot++) {
        const task = tasks[slot]
        if (!task?.id) continue
        const key = `${agent.id}:${task.id}`
        active.add(key)
        let chip = this.chips.get(key)
        if (!chip) {
          const hue = hashString(task.mcpServer || task.tool || task.id) % 360
          chip = { hold: 0, x: agent.pos.x, y: agent.pos.y, z: agent.pos.z, hue, slot }
          this.chips.set(key, chip)
        }
        chip.slot = slot
        chip.x = agent.pos.x
        chip.y = agent.pos.y
        chip.z = agent.pos.z
        chip.hold = Math.min(1, chip.hold + dt * 6)
      }
    }

    for (const [key, chip] of this.chips) {
      if (active.has(key)) continue
      chip.hold -= dt / FADE_SECONDS
      if (chip.hold <= 0) this.chips.delete(key)
    }

    const centers = this.centers.array
    const offsets = this.offsets.array
    const sizes = this.sizes.array
    const fades = this.fades.array
    let n = 0
    for (const chip of this.chips.values()) {
      if (n >= this.capacity) break
      centers[n * 3] = chip.x
      centers[n * 3 + 1] = chip.y + HEAD_CLEAR
      centers[n * 3 + 2] = chip.z
      offsets[n * 2] = 0
      offsets[n * 2 + 1] = STACK_BASE + chip.slot * STACK_STEP
      sizes[n] = 0.09 + Math.sin(elapsed * 3.6 + chip.slot) * 0.006
      fades[n] = Math.max(0, chip.hold)
      this._color.setHSL(chip.hue / 360, 0.6, 0.6)
      this.mesh.setColorAt(n, this._color)
      n++
    }

    this.mesh.count = n
    this.centers.needsUpdate = true
    this.offsets.needsUpdate = true
    this.sizes.needsUpdate = true
    this.fades.needsUpdate = true
    this.mesh.instanceColor.needsUpdate = true
    this.mesh.instanceMatrix.needsUpdate = false
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.texture.dispose()
    this.scene.remove(this.mesh)
  }
}
