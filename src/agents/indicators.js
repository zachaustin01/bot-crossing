import * as THREE from 'three'
import { OVERLAY_LAYER } from '../core/engine.js'
import { withCurve } from '../core/curve.js'
import {
  mdiHelpCircle,
  mdiAlert,
  mdiHammer,
  mdiCheckBold,
  mdiPause,
  mdiSleep,
  mdiCreation,
  mdiLogout,
} from '@mdi/js'
import { buildIconAtlas } from './iconAtlas.js'

/**
 * The status badges that float above each astronaut's head.
 *
 * These are the one thing that stays on screen when every panel is dismissed, so they are
 * drawn in the world rather than in the DOM: a single instanced quad per agent, billboarded
 * in the vertex shader and sampled from a small icon atlas. One draw call for the whole
 * colony, and they keep a constant on-screen size as you zoom so a badge is still readable
 * when you have pulled the camera right out.
 */

const COLS = 4
const ROWS = 2

/** Where the badge's bottom edge sits: a shade above the crown of the helmet. */
const HEAD_CLEAR = 1.42

export const BADGE = {
  none: -1,
  waiting: 0, // waiting on you — the one that matters most
  blocked: 1, // errored
  working: 2,
  done: 3,
  paused: 4,
  sleeping: 5,
  spawning: 6,
  leaving: 7,
}

/** HDR badge tint, tone-mapped with the scene after bloom and depth of field. */
const BADGE_COLOR = {
  0: [0.42, 1.35, 2.9],
  1: [2.9, 0.6, 0.5],
  2: [0.4, 1.9, 0.95],
  3: [1.5, 2.4, 0.8],
  4: [2.5, 1.9, 0.65],
  5: [0.9, 1.0, 1.7],
  6: [2.4, 1.4, 0.75],
  7: [1.2, 1.3, 1.35],
}

/**
 * How readily a badge gives up its space, 0 = never fades. Ranked by how much the thing it
 * reports actually wants you: a blocked session always shows, forty sleeping ones do not.
 */
const FADE_BY_BADGE = {
  [BADGE.waiting]: 0,
  [BADGE.blocked]: 0,
  [BADGE.done]: 0.15,
  [BADGE.working]: 0.4,
  [BADGE.spawning]: 0.5,
  [BADGE.leaving]: 0.5,
  [BADGE.paused]: 0.6,
  [BADGE.sleeping]: 1,
}

export class Indicators {
  constructor(scene, settings, capacity) {
    this.settings = settings
    this.capacity = capacity
    // 512 texels per badge, not per atlas — sized against the closest the camera ever gets,
    // which buildIconAtlas works through.
    this.texture = buildIconAtlas(ICON_PATHS, COLS, ROWS, 512)

    const geo = new THREE.PlaneGeometry(1, 1)
    this.frames = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2)
    this.centers = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    this.sizes = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
    // 1 = a badge that may fade out at distance, 0 = one that must always be readable.
    this.fades = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
    for (const a of [this.frames, this.centers, this.sizes, this.fades]) a.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aFrame', this.frames)
    geo.setAttribute('aCenter', this.centers)
    geo.setAttribute('aSize', this.sizes)
    geo.setAttribute('aFade', this.fades)

    this.material = this._material()
    this.mesh = new THREE.InstancedMesh(geo, this.material, capacity)
    // Drawn after bloom and tilt-shift, so the symbol stays readable over any scene depth.
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

  /**
   * Billboarding is done on the GPU: the quad's corner offset is applied in *view* space
   * after the centre has been transformed, which makes every badge face the camera without
   * a per-badge matrix update on the CPU. `aSize` carries a perspective-cancelling scale so
   * the badge holds its pixel size at any zoom.
   */
  _material() {
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      depthTest: false, // a badge is a HUD element: never hidden behind terrain
      toneMapped: true,
    })

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uFrameScale = { value: new THREE.Vector2(1 / COLS, 1 / ROWS) }
      withCurve(shader)
      this.uniforms = shader.uniforms

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute vec2 aFrame;
           attribute vec3 aCenter;
           attribute float aSize;
           attribute float aFade;
           varying float vFade;
           uniform vec2 uFrameScale;`
        )
        .replace('#include <uv_vertex>', `#include <uv_vertex>\n vMapUv = uv * uFrameScale + aFrame;`)
        .replace(
          '#include <project_vertex>',
          `vec4 mvPosition = viewMatrix * vec4( bcBend( ( modelMatrix * vec4( aCenter, 1.0 ) ).xyz ), 1.0 );
           float dist = -mvPosition.z;
           // Mostly-constant screen size: the linear term cancels perspective so a badge
           // stays readable when the camera is pulled right out, while the constant term
           // lets it grow a little as you lean in, which stops it feeling pasted on.
           float scale = aSize * ( 2.0 + dist * 0.22 );
           // Lift by half the badge's own height, so what is pinned above the helmet is the
           // badge's *bottom edge* rather than its centre. The badge holds a near-constant
           // size on screen while a world-space offset does not, so a centre that clears the
           // head when you are leaning in sits right on top of it when you pull out — the
           // gap shrinks with distance while the thing it has to clear does not.
           mvPosition.y += scale * 0.5;
           mvPosition.xy += position.xy * scale;
           // Low-priority badges (asleep, idle) thin out quickly so a wide shot shows only
           // what actually wants you, while a close look still reports everything. Urgent
           // badges carry aFade 0 and never fade at all.
           vFade = 1.0 - aFade * smoothstep( 19.0, 44.0, dist );
           gl_Position = projectionMatrix * mvPosition;`
        )
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>\n varying float vFade;\n uniform vec2 uFrameScale;`
      )
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `vec4 badge = texture2D( map, vMapUv );
         // One texture, three masks: the plate's silhouette in green, a ring straddling its
         // edge in blue, the symbol in red. A badge is the one thing in the colony you are
         // meant to spot across a busy plot and click, so it is built like a pin — a solid
         // card, a ring in its own status colour, and a shadow holding it off the ground.
         float body = max( badge.g, badge.b );

         // The shadow is the same silhouette read from a blurred mip and offset down-right,
         // which costs one extra sample instead of a second texture. The plate is inset far
         // enough inside its cell that neither the offset nor the blur reaches a neighbour.
         float shadow = texture2D( map, vMapUv + vec2( -0.006, 0.010 ) * uFrameScale, 2.2 ).g;

         vec3 plate = vec3( 0.045, 0.05, 0.07 );
         vec3 col = mix( plate, vColor.rgb * 0.85, badge.b );
         col = mix( col, vColor.rgb, badge.r );

         // Where the badge is solid it is the badge; where it is not, what is left of the
         // offset silhouette is the shadow, and multiplying by alpha takes the colour to
         // black there without a second branch.
         diffuseColor.rgb = col * body;
         diffuseColor.a = max( body, shadow * ( 1.0 - body ) * 0.55 ) * vFade;`
      )
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '')
    }
    return material
  }

  /** Rebuild the instance buffers from the agents that currently want a badge. */
  update(agents, elapsed, statusFor) {
    const frames = this.frames.array
    const centers = this.centers.array
    const sizes = this.sizes.array
    const fades = this.fades.array
    let n = 0

    for (const agent of agents) {
      // Cleared for everyone first: an agent that loses its badge this frame must lose its
      // hit box with it, or the picker keeps offering a bubble that is no longer drawn.
      agent.badgeSize = 0
      if (n >= this.capacity) break
      if (agent.scale < 0.4 || agent.state === 'gone') continue
      const badge = statusFor(agent)
      if (badge < 0) continue

      // A gentle bob, and an urgent one for the states that want your attention.
      const urgent = badge === BADGE.waiting || badge === BADGE.blocked
      const bobRate = urgent ? 3.4 : 1.6
      const bobAmp = urgent ? 0.075 : 0.035
      const bob = Math.sin(elapsed * bobRate + agent.phase) * bobAmp

      centers[n * 3] = agent.pos.x
      // Just clear of the helmet: the shader lifts the quad the rest of the way by its own
      // half-height, which is the part that has to change with the camera.
      centers[n * 3 + 1] = agent.pos.y + HEAD_CLEAR + bob
      centers[n * 3 + 2] = agent.pos.z

      frames[n * 2] = (badge % COLS) / COLS
      frames[n * 2 + 1] = 1 - (Math.floor(badge / COLS) + 1) / ROWS

      // Urgent badges breathe a little so they pull the eye across a busy colony.
      sizes[n] = urgent ? 0.166 + Math.sin(elapsed * 4.2 + agent.phase) * 0.013 : 0.126
      fades[n] = FADE_BY_BADGE[badge] ?? 1

      // Handed to the picker so a click can hit the bubble itself rather than the head under
      // it. It cannot be derived over there: the lift and the size are decided in view space
      // by the vertex shader above, and only this loop knows which frame each agent got.
      agent.badgeSize = sizes[n]
      agent.badgeY = centers[n * 3 + 1]

      const c = BADGE_COLOR[badge] || [1, 1, 1]
      this._color.setRGB(c[0], c[1], c[2])
      this.mesh.setColorAt(n, this._color)
      n++
    }

    this.mesh.count = n
    this.frames.needsUpdate = true
    this.centers.needsUpdate = true
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

/**
 * The badge symbols, in atlas order. Solid rather than outlined: a badge is a lit chip seen
 * at a glance across a colony, and an outline at that size is mostly the hole in the middle
 * — the glyph has to carry as a silhouette. Material's set is drawn filled to begin with,
 * one closed path per icon, so there is nothing to stroke and nothing to parse.
 */
const ICON_PATHS = [mdiHelpCircle, mdiAlert, mdiHammer, mdiCheckBold, mdiPause, mdiSleep, mdiCreation, mdiLogout]

/**
 * The eight symbols, in atlas order: waiting, blocked, working, done, paused, sleeping,
 * spawning, leaving.
 *
 * Material Design Icons, imported as path data rather than drawn here. Eight symbols that have
 * to look like one family is a type problem — one weight, one optical size, one set of
 * terminals — and a set somebody has already balanced beats one assembled a curve at a time.
 * The atlas itself — plate, ring and glyph compositing — lives in `iconAtlas.js`, shared with
 * the task chips beside an astronaut's shoulder so the two read as one family.
 */
